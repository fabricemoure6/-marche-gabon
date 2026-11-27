// Marché Gabon : galerie marchande (Cloudflare Workers + D1).
import {
  json, bad, rand, uid, now, sha256, safeEqual, hashPassword, createSession, clearCookie, currentUser, destroySession,
  CATEGORIES, ORDER_STATUS, ensureSchema, loadSettings, saveSettings, toBase64, fromBase64, sniffImage, sniffDocument, DOC_KINDS,
  withSecurityHeaders, recentCount, recordEvent, cached, clearCache, PUBLIC_TTL,
  validCoord, distanceKm, slugify, EFFECTIVE_PRICE, promoActive, publicProduct, voucherDiscount, loyaltyProgram, LOW_STOCK, photoList, SOLD, EXPENSE_CATS, period, UNITS, r3, unitOf, stepOf, fmtQty, lineTotal, cleanAccount, METHOD_LABEL, lookOf, SERVICE_CATEGORIES, isServiceCat, docKindsFor, SITE_TEMPLATES, templateOf, cleanSite, parseSite } from './lib.js';
import { serviceCustomerRoutes, serviceSellerRoutes, servicesOfShop, itemsOfShop, verifiedDocs } from './services.js';
import { backupStep, backupStatus, backupStream, backupWatch } from './backup.js';
import { notify, confirmCheckout, rejectCheckout, cancelOrders, releaseVoucher, restock, createVoucher, awardLoyalty, startOnlinePayment, singpayVerify, singpayOn, singpayCall, sp } from './pay.js';
import { botReply, searchProducts } from './bot.js';
import { seoRoute } from './seo.js';
import { subSweep, subRoutes, subAdminRoutes, subState, isBlocked } from './subs.js';
import { pushRoutes, flushPush } from './push.js';

const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const validEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e) && e.length <= 254;
const readJson = async request => { try { return await request.json(); } catch { return null; } };
const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
const ROLES_PUBLIC = ['customer', 'seller', 'courier'];

// Limite des essais de connexion : 5 échecs par e-mail et 20 par adresse IP sur 15 minutes
const LOGIN_WINDOW = 15 * 60000, MAX_FAIL_EMAIL = 5, MAX_FAIL_IP = 20;
const failCount = async (env, key, since) =>
  ((await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE key=?1 AND at>?2').bind(key, since).first()) || { n: 0 }).n;

// Photos envoyées par l'utilisateur lui-même, sans doublon, 6 au plus
async function ownPhotos(env, user, list) {
  const ids = [...new Set((list || []).map(String).filter(x => /^[a-f0-9]{16}$/.test(x)))].slice(0, 6);
  if (!ids.length) return [];
  const { results } = await env.DB.prepare(`SELECT id FROM photos WHERE owner_id=?1 AND id IN (${ids.map((_, i) => '?' + (i + 2)).join(',')})`).bind(user.id, ...ids).all();
  const ok = new Set(results.map(r => r.id));
  return ids.filter(x => ok.has(x));
}


// ---------- Comptabilité d'une boutique ----------
async function shopAccounting(env, shopId, per) {
  const S = (q, ...a) => env.DB.prepare(q).bind(...a);
  const sum = await S(`SELECT COUNT(*) AS orders, COALESCE(SUM(subtotal),0) AS gross, COALESCE(SUM(discount),0) AS discounts,
      COALESCE(SUM(commission),0) AS commission, COALESCE(SUM(delivery_fee),0) AS delivery,
      COALESCE(SUM(CASE WHEN status='delivered' THEN subtotal-discount-commission ELSE 0 END),0) AS net_delivered,
      COALESCE(SUM(CASE WHEN status!='delivered' THEN subtotal-discount-commission ELSE 0 END),0) AS net_pending
    FROM orders WHERE shop_id=?1 AND status IN ${SOLD} AND created_at BETWEEN ?2 AND ?3`, shopId, per.fromIso, per.toIso).first();
  const cancelled = await S(`SELECT COUNT(*) AS n, COALESCE(SUM(subtotal),0) AS v FROM orders WHERE shop_id=?1 AND status='cancelled' AND created_at BETWEEN ?2 AND ?3`, shopId, per.fromIso, per.toIso).first();
  const exp = await S(`SELECT COALESCE(SUM(amount),0) AS v FROM expenses WHERE shop_id=?1 AND day BETWEEN ?2 AND ?3`, shopId, per.from, per.to).first();
  const { results: daily } = await S(`SELECT substr(created_at,1,10) AS day, SUM(subtotal-discount-commission) AS net, COUNT(*) AS n
    FROM orders WHERE shop_id=?1 AND status IN ${SOLD} AND created_at BETWEEN ?2 AND ?3 GROUP BY day ORDER BY day`, shopId, per.fromIso, per.toIso).all();
  const { results: top } = await S(`SELECT i.name, SUM(i.qty) AS qty, SUM(i.qty*i.price) AS total FROM order_items i JOIN orders o ON o.id=i.order_id
    WHERE o.shop_id=?1 AND o.status IN ${SOLD} AND o.created_at BETWEEN ?2 AND ?3 GROUP BY i.name ORDER BY total DESC LIMIT 8`, shopId, per.fromIso, per.toIso).all();
  const { results: orders } = await S(`SELECT o.ref,o.status,o.created_at,o.subtotal,o.discount,o.commission,o.delivery_fee,u.name AS customer
    FROM orders o JOIN users u ON u.id=o.customer_id WHERE o.shop_id=?1 AND o.status IN ${SOLD} AND o.created_at BETWEEN ?2 AND ?3 ORDER BY o.created_at DESC LIMIT 500`, shopId, per.fromIso, per.toIso).all();
  const { results: expenses } = await S(`SELECT id,day,category,label,amount FROM expenses WHERE shop_id=?1 AND day BETWEEN ?2 AND ?3 ORDER BY day DESC, created_at DESC`, shopId, per.from, per.to).all();
  // Solde depuis l'ouverture : ventes livrées (nettes) moins versements reçus
  const earned = await S(`SELECT COALESCE(SUM(subtotal-discount-commission),0) AS v FROM orders WHERE shop_id=?1 AND status='delivered' AND pay_direct=0`, shopId).first();
  // Ventes encaissées directement par la boutique (le marché n'a pas touché cet argent) et commission qu'elle lui doit
  const direct = await S(`SELECT COALESCE(SUM(CASE WHEN status='delivered' THEN subtotal-discount-commission ELSE 0 END),0) AS net, COALESCE(SUM(commission),0) AS commission, COUNT(*) AS n FROM orders WHERE shop_id=?1 AND pay_direct=1 AND status IN ${SOLD}`, shopId).first();
  const paid = await S(`SELECT COALESCE(SUM(amount),0) AS v FROM payouts WHERE shop_id=?1`, shopId).first();
  const { results: payouts } = await S(`SELECT amount,method,reference,note,created_at FROM payouts WHERE shop_id=?1 ORDER BY created_at DESC LIMIT 50`, shopId).all();
  const net = sum.gross - sum.discounts - sum.commission;
  return {
    period: { from: per.from, to: per.to },
    summary: { ...sum, net, expenses: exp.v, profit: net - exp.v, avg: sum.orders ? Math.round((sum.gross - sum.discounts) / sum.orders) : 0, cancelled: cancelled.n, cancelled_value: cancelled.v },
    daily, top, orders, expenses, payouts, balance: { earned: earned.v, paid: paid.v, due: earned.v - paid.v, direct_net: direct.net, direct_orders: direct.n, commission_owed: direct.commission }
  };
}
// Un texte qui commence par = + - @ serait exécuté comme une formule par Excel : on le préfixe d'une apostrophe
const csvCell = v => {
  let t = String(v ?? '');
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[;"\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
};
function accountingCsv(shopName, a) {
  const rows = [['Date', 'Type', 'Référence / catégorie', 'Libellé', 'Recette (FCFA)', 'Dépense (FCFA)', 'Détail']];
  for (const o of a.orders) rows.push([o.created_at.slice(0, 10), 'Vente', o.ref, 'Client : ' + o.customer, o.subtotal - o.discount - o.commission, '',
    `brut ${o.subtotal} - remise ${o.discount} - commission ${o.commission}${o.status === 'delivered' ? '' : ' (non livrée)'}`]);
  for (const e of a.expenses) rows.push([e.day, 'Dépense', e.category, e.label || '', '', e.amount, '']);
  rows.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const s = a.summary;
  rows.push([], ['Total', '', '', '', s.net, s.expenses, `Bénéfice : ${s.profit} FCFA`]);
  return '﻿' + `${shopName} — comptabilité du ${a.period.from} au ${a.period.to}\n` + rows.map(r => r.map(csvCell).join(';')).join('\n') + '\n';
}

// ---------- Invitations ----------
const INVITE_RE = /^[a-f0-9]{12}$/;
const inviteState = inv => !inv ? 'introuvable' : inv.revoked ? 'révoqué' : (inv.expires_at && inv.expires_at < Date.now()) ? 'expiré'
  : (inv.max_uses != null && inv.uses >= inv.max_uses) ? 'épuisé' : 'valide';
const inviteNeeded = (settings, role) => settings.invite_required === 'all' || (settings.invite_required === 'pro' && role !== 'customer');

// ---------- Confirmation d'une action sensible (mot de passe de l'admin) ----------
const MAX_FAIL_CONFIRM = 5;
async function confirmAdmin(env, user, password) {
  const key = 'a:' + user.id, t = Date.now();
  if ((await failCount(env, key, t - LOGIN_WINDOW)) >= MAX_FAIL_CONFIRM) return 'Trop d\'essais. Réessayez dans 15 minutes.';
  const u = await env.DB.prepare('SELECT pass_hash,salt FROM users WHERE id=?1').bind(user.id).first();
  const { hash } = await hashPassword(String(password || ''), u.salt);
  if (!safeEqual(hash, u.pass_hash)) {
    await env.DB.prepare('INSERT INTO login_attempts (key,at) VALUES (?1,?2)').bind(key, t).run();
    return 'Mot de passe incorrect : action annulée.';
  }
  await env.DB.prepare('DELETE FROM login_attempts WHERE key=?1').bind(key).run();
  return null;
}
async function logAction(env, user, action, type, id, name, reason) {
  await env.DB.prepare('INSERT INTO admin_actions (id,admin_id,admin_name,action,target_type,target_id,target_name,reason,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)')
    .bind(uid(), user.id, user.name, action, type, id, name || '', reason || '', now()).run();
}

// ---------- Comptes ----------
async function register(request, env, secure) {
  const b = await readJson(request);
  if (!b) return bad('Requête invalide');
  // Anti-robots : 20 comptes par heure et par adresse IP (large, car les opérateurs mobiles partagent souvent une même IP)
  const kReg = 'r:' + await sha256(request.headers.get('cf-connecting-ip') || 'local');
  if ((await recentCount(env, kReg, 3600000)) >= 20) return bad('Trop d\'inscriptions depuis cette connexion. Réessayez dans une heure.', 429);
  const email = cleanText(b.email, 254).toLowerCase();
  const name = cleanText(b.name, 80), phone = cleanText(b.phone, 30), password = String(b.password || '');
  const code = String(b.invite || '').toLowerCase();
  let invite = null;
  if (code) {
    if (!INVITE_RE.test(code)) return bad('Lien d\'invitation invalide');
    invite = await env.DB.prepare('SELECT * FROM invites WHERE code=?1').bind(code).first();
    const st = inviteState(invite);
    if (st !== 'valide') return bad(`Ce lien d'invitation est ${st}. Demandez-en un nouveau à l'équipe.`, 403);
  }
  const role = invite ? invite.role : ROLES_PUBLIC.includes(b.role) ? b.role : 'customer';
  if (!invite && inviteNeeded(await loadSettings(env), role))
    return bad('L\'inscription ' + (role === 'customer' ? '' : role === 'seller' ? 'des boutiques ' : 'des livreurs ') + 'se fait sur invitation : demandez un lien à l\'équipe.', 403);
  if (!validEmail(email)) return bad('Adresse e-mail invalide');
  if (name.length < 2) return bad('Indiquez votre nom');
  if (phone.length < 8) return bad('Indiquez un numéro de téléphone');
  if (password.length < 8 || password.length > 200) return bad('Le mot de passe doit contenir au moins 8 caractères');
  let shopName = '', category = '', address = '';
  if (role === 'seller') {
    shopName = cleanText(b.shopName, 80); category = String(b.category || ''); address = cleanText(b.address, 200);
    if (shopName.length < 2) return bad('Indiquez le nom de votre boutique');
    if (!CATEGORIES.some(c => c[0] === category) && !isServiceCat(category)) return bad('Choisissez la catégorie de la boutique');
    if (invite && invite.kind === 'services' && !isServiceCat(category)) return bad('Ce lien est réservé aux prestataires de services : choisissez votre type de service.');
  }
  if (await env.DB.prepare('SELECT 1 FROM users WHERE email=?1').bind(email).first()) return bad('Un compte existe déjà avec cet e-mail', 409);
  if (invite) {
    // Réserve une utilisation de façon atomique (deux inscriptions simultanées ne dépassent pas la limite)
    const r = await env.DB.prepare(`UPDATE invites SET uses=uses+1 WHERE id=?1 AND revoked=0 AND (max_uses IS NULL OR uses<max_uses) AND (expires_at IS NULL OR expires_at>?2)`)
      .bind(invite.id, Date.now()).run();
    if (!r.meta || !r.meta.changes) return bad('Ce lien d\'invitation vient d\'être utilisé jusqu\'au bout. Demandez-en un nouveau.', 403);
  }
  const { hash, salt } = await hashPassword(password);
  const id = uid();
  await env.DB.prepare('INSERT INTO users (id,email,name,phone,pass_hash,salt,role,status,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,\'active\',?8)')
    .bind(id, email, name, phone, hash, salt, role, now()).run();
  if (role === 'seller') {
    const slug = slugify(shopName) + '-' + rand(2);
    const approved = !!(invite && invite.auto_approve);
    await env.DB.prepare(`INSERT INTO shops (id,owner_id,name,slug,category,address,phone,status,created_at,template) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`)
      .bind(uid(), id, shopName, slug, category, address, phone, approved ? 'active' : 'pending', now(), isServiceCat(category) ? templateOf(b.template, category) : null).run();
    const { results: admins } = await env.DB.prepare(`SELECT id FROM users WHERE role='admin'`).all();
    for (const a of admins) await notify(env, a.id, approved ? 'Nouvelle boutique (invitation)' : 'Nouvelle boutique à valider', `${shopName} (${name})`, '/admin.html');
  }
  if (invite) await env.DB.prepare('INSERT INTO invite_uses (invite_id,user_id,created_at) VALUES (?1,?2,?3)').bind(invite.id, id, now()).run();
  if (role === 'courier') await env.DB.prepare('INSERT INTO couriers (user_id,available) VALUES (?1,0)').bind(id).run();
  await recordEvent(env, kReg);
  const cookie = await createSession(env, id, secure);
  return json({ ok: true, user: { id, email, name, role } }, 201, { 'set-cookie': cookie });
}

async function login(request, env, secure) {
  const b = await readJson(request);
  if (!b) return bad('Requête invalide');
  const email = cleanText(b.email, 254).toLowerCase();
  const t = Date.now(), since = t - LOGIN_WINDOW;
  const kEmail = 'e:' + await sha256(email), kIp = 'i:' + await sha256(request.headers.get('cf-connecting-ip') || 'local');
  if ((await failCount(env, kEmail, since)) >= MAX_FAIL_EMAIL || (await failCount(env, kIp, since)) >= MAX_FAIL_IP)
    return bad('Trop d\'essais de connexion. Réessayez dans 15 minutes ou demandez un lien de réinitialisation.', 429);
  const u = await env.DB.prepare('SELECT * FROM users WHERE email=?1').bind(email).first();
  const { hash } = await hashPassword(String(b.password || ''), u ? u.salt : 'x'.repeat(32));
  if (!u || !safeEqual(hash, u.pass_hash)) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO login_attempts (key,at) VALUES (?1,?2),(?3,?2)').bind(kEmail, t, kIp),
      env.DB.prepare('DELETE FROM login_attempts WHERE at<?1').bind(t - 86400000)
    ]);
    return bad('E-mail ou mot de passe incorrect', 401);
  }
  if (u.status !== 'active') return bad('Ce compte est suspendu', 403);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_attempts WHERE key=?1').bind(kEmail),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<?1').bind(t) // ménage des sessions expirées
  ]);
  return json({ ok: true, user: { id: u.id, email: u.email, name: u.name, role: u.role } }, 200, { 'set-cookie': await createSession(env, u.id, secure) });
}

async function resetPassword(request, env) {
  const b = await readJson(request);
  if (!b) return bad('Requête invalide');
  const password = String(b.password || '');
  if (password.length < 8 || password.length > 200) return bad('Le mot de passe doit contenir au moins 8 caractères');
  const t = await env.DB.prepare('SELECT user_id FROM reset_tokens WHERE token_hash=?1 AND expires_at>?2').bind(await sha256(String(b.token || '')), Date.now()).first();
  if (!t) return bad('Lien invalide ou expiré. Demandez-en un nouveau à l\'administrateur.');
  const { hash, salt } = await hashPassword(password);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pass_hash=?2, salt=?3 WHERE id=?1').bind(t.user_id, hash, salt),
    env.DB.prepare('DELETE FROM reset_tokens WHERE user_id=?1').bind(t.user_id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id=?1').bind(t.user_id)
  ]);
  return json({ ok: true });
}

// ---------- Comptes de paiement verrouillés ----------
// Toute saisie d'un compte (première fois, modification ou suppression) devient une demande que l'administrateur accepte.
// L'ancien compte (s'il existe) reste actif tant que la demande n'est pas acceptée ; tout est gardé dans account_changes.
const sameAcc = (a, b) => ['method', 'number', 'name', 'code', 'bank'].every(k => (a[k] || null) === (b[k] || null));
async function requestAccount(env, user, ownerType, ownerId, ownerName, cur, acc) {
  const old = { method: cur.method || null, number: cur.number || null, name: cur.name || null, code: cur.code || null, bank: cur.bank || null };
  const next = { method: acc.method, number: acc.number, name: acc.name, code: acc.code, bank: acc.bank };
  if (sameAcc(old, next)) return 'unchanged';
    await env.DB.prepare(`UPDATE account_changes SET status='replaced', decided_at=?3, note='remplacée par une demande plus récente' WHERE owner_type=?1 AND owner_id=?2 AND status='pending'`).bind(ownerType, ownerId, now()).run(); // une seule demande en attente, les anciennes restent dans l'historique
  await env.DB.prepare(`INSERT INTO account_changes (id,owner_type,owner_id,user_id,old_data,new_data,status,created_at) VALUES (?1,?2,?3,?4,?5,?6,'pending',?7)`)
    .bind(uid(), ownerType, ownerId, user.id, JSON.stringify(old), JSON.stringify(next), now()).run();
  const { results: admins } = await env.DB.prepare(`SELECT id FROM users WHERE role='admin'`).all();
  for (const a of admins) await notify(env, a.id, 'Compte de paiement à valider', `${ownerName} (${ownerType === 'shop' ? 'boutique' : 'livreur'}) ${old.number ? 'demande à modifier' : 'a indiqué'} son compte de paiement : à valider.`, '/admin.html');
  return 'pending';
}
async function pendingAccount(env, ownerType, ownerId) {
  const r = await env.DB.prepare(`SELECT id,new_data,created_at FROM account_changes WHERE owner_type=?1 AND owner_id=?2 AND status='pending'`).bind(ownerType, ownerId).first();
  return r ? { id: r.id, created_at: r.created_at, ...JSON.parse(r.new_data) } : null;
}
const snap = r => JSON.stringify({ method: r.method, methodLabel: METHOD_LABEL[r.method], number: r.number, name: r.name, code: r.code, bank: r.bank });

// ---------- Aides communes ----------
async function itemsOf(env, orderId) {
  const { results } = await env.DB.prepare('SELECT name,price,qty,unit FROM order_items WHERE order_id=?1').bind(orderId).all();
  return results;
}

// Accès à une commande : client, vendeur de la boutique, livreur attribué, administrateur
async function loadOrderFor(env, user, ref) {
  const o = await env.DB.prepare(
    `SELECT o.*, s.name AS shop_name, s.owner_id AS shop_owner, s.address AS shop_address, s.lat AS shop_lat, s.lng AS shop_lng,
            s.phone AS shop_phone, s.whatsapp AS shop_whatsapp, c.name AS customer_name, c.phone AS customer_phone, c.avatar_id AS customer_avatar,
            k.name AS courier_name, k.avatar_id AS courier_avatar
     FROM orders o JOIN shops s ON s.id=o.shop_id JOIN users c ON c.id=o.customer_id LEFT JOIN users k ON k.id=o.courier_id WHERE o.ref=?1`).bind(ref).first();
  if (!o) return null;
  const role = user.role === 'admin' ? 'admin' : o.customer_id === user.id ? 'customer' : o.shop_owner === user.id ? 'seller' : o.courier_id === user.id ? 'courier' : null;
  return role ? { o, role } : null;
}

function orderPublic(o, role) {
  const waDigits = p => String(p || '').replace(/\D/g, '');
  const out = {
    ref: o.ref, status: o.status, statusLabel: ORDER_STATUS[o.status], subtotal: o.subtotal, discount: o.discount || 0, delivery_fee: o.delivery_fee, total: o.total,
    address: o.address, note: o.note, distance_km: o.distance_km, created_at: o.created_at, shop: { name: o.shop_name, address: o.shop_address },
    customer: { name: o.customer_name, avatar_id: o.customer_avatar || null }, hasCourier: !!o.courier_id, role,
    courier: o.courier_id ? { name: o.courier_name, avatar_id: o.courier_avatar || null } : null
  };
  // Les numéros ne sont montrés qu'aux personnes qui ont besoin d'appeler ou d'écrire sur WhatsApp
  if (role !== 'courier' || o.status === 'delivering') out.customer.phone = o.phone || o.customer_phone;
  if (role === 'courier') { out.shop.phone = o.shop_phone; out.shop.lat = o.shop_lat; out.shop.lng = o.shop_lng; out.dest = { lat: o.lat, lng: o.lng }; }
  if (role === 'customer' || role === 'seller') out.shop.phone = o.shop_whatsapp || o.shop_phone;
  out.waShop = waDigits(o.shop_whatsapp || o.shop_phone); out.waCustomer = waDigits(o.phone || o.customer_phone);
  return out;
}

// Zone de livraison montrée aux livreurs avant qu'ils prennent une course : le début de l'adresse (le quartier),
// sans numéro ni repère précis. Ex. « Quartier Louis, pharmacie, portail bleu » → « Quartier Louis ».
function zoneOf(address) {
  const first = String(address || '').split(/[,;:(\n]| - /)[0];
  const words = first.split(/\s+/).filter(w => w && !/\d/.test(w)).slice(0, 4);
  const z = words.join(' ').slice(0, 30).trim();
  return z.length >= 3 ? z : null;
}

async function pushCouriers(env, shop, order, settings) {
  const { results } = await env.DB.prepare(
    `SELECT c.user_id,c.lat,c.lng FROM couriers c JOIN users u ON u.id=c.user_id WHERE c.available=1 AND u.status='active'`).all();
  for (const c of results) {
    const near = !validCoord(shop.lat, shop.lng) || !validCoord(c.lat, c.lng) ||
      distanceKm(shop.lat, shop.lng, c.lat, c.lng) <= settings.courier_radius_km;
    if (near) await notify(env, c.user_id, 'Course disponible', `${shop.name} : commande ${order.ref} à livrer.`, '/livreur.html');
  }
}

// ---------- Worker ----------
export default {
  // Déclencheur planifié (toutes les 15 min) : fait avancer la sauvegarde du jour puis surveille qu'elle ne prend pas de retard
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try { await ensureSchema(env.DB); await subSweep(env, true); await flushPush(env, null, true); } catch (e) { console.error('abonnements', e && e.message); }
      try { if (!env.BACKUPS) return; await backupStep(env); await backupWatch(env); }
      catch (e) { console.error('sauvegarde', e && e.message); }
    })());
  },
  async fetch(request, env, ctx) {
    const res = await route(request, env);
    if (!['GET', 'HEAD'].includes(request.method)) clearCache(); // une écriture : la mémoire courte repart de zéro
    // Abonnements : échéances, rappels et boutiques à masquer, vérifiés au plus toutes les 10 minutes, après la réponse
    // Puis les notifications nouvelles partent sur les téléphones abonnés (notifications push)
    if (ctx && ctx.waitUntil) ctx.waitUntil(ensureSchema(env.DB).then(() => subSweep(env)).catch(e => console.error('abonnements', e && e.message))
      .then(() => flushPush(env, new URL(request.url).origin)).catch(e => console.error('push', e && e.message)));
    return withSecurityHeaders(res);
  }
};

async function route(request, env) {
    const url = new URL(request.url);
    const p = url.pathname, method = request.method;
    if (!p.startsWith('/api/')) {
      // Pages publiques rendues côté serveur pour les moteurs de recherche et les aperçus de partage
      try { await ensureSchema(env.DB); const r = await seoRoute(request, env, url); if (r) return r; }
      catch (e) { console.error('seo', e && e.message); }
      return env.ASSETS.fetch(request);
    }
    const secure = url.protocol === 'https:';
    try {
      await ensureSchema(env.DB);
      const isWebhook = p === '/api/payments/singpay';
      if (!['GET', 'HEAD'].includes(method) && !isWebhook && request.headers.get('x-csrf') !== '1') return bad('Requête refusée', 403);
      let m;

      // ===== Public =====
      if (method === 'GET' && p === '/api/config') {
        const s = await loadSettings(env);
        return json({
          site_name: s.site_name, tagline: s.tagline, categories: CATEGORIES, service_categories: SERVICE_CATEGORIES, delivery_base: s.delivery_base,
          delivery_per_km: s.delivery_per_km, online_payment: singpayOn(env), invite_required: s.invite_required,
          promo_max_pct: s.promo_max_pct, promo_max_days: s.promo_max_days, loyalty_max_pct: s.loyalty_max_pct ?? 30
        });
      }
      if (method === 'GET' && p === '/api/shops') {
        const cat = url.searchParams.get('cat') || '', q = cleanText(url.searchParams.get('q'), 60).toLowerCase();
        const results = await cached('shops', PUBLIC_TTL, async () => (await env.DB.prepare(
          `SELECT s.id,s.name,s.slug,s.category,s.description,s.address,s.photo_id,
                  (SELECT COUNT(*) FROM products p WHERE p.shop_id=s.id AND p.active=1) AS products,
                  (SELECT COUNT(*) FROM products p WHERE p.shop_id=s.id AND p.active=1 AND p.stock>0 AND ${EFFECTIVE_PRICE} < p.price) AS promos,
                  (SELECT MAX(ROUND(100 - 100.0 * p.promo_price / p.price)) FROM products p WHERE p.shop_id=s.id AND p.active=1 AND p.stock>0 AND ${EFFECTIVE_PRICE} < p.price) AS best_pct,
                  COALESCE(s.cover_photo, (SELECT p.photo_id FROM products p WHERE p.shop_id=s.id AND p.active=1 AND p.photo_id IS NOT NULL ORDER BY p.created_at DESC LIMIT 1)) AS cover_id,
                  s.loyalty_enabled, s.pro, (SELECT COUNT(*) FROM services sv WHERE sv.shop_id=s.id AND sv.active=1) AS services
           FROM shops s WHERE s.status='active' ORDER BY s.pro DESC, promos > 0 DESC, s.name`).all()).results);
        return json(results.filter(s => (!cat || s.category === cat) && (!q || (s.name + ' ' + (s.description || '')).toLowerCase().includes(q))));
      }
      if (method === 'GET' && p === '/api/by-weight') { // produits vendus au kilo, au litre, au tas…
        const results = await cached('by-weight', PUBLIC_TTL, async () => (await env.DB.prepare(
          `SELECT p.id,p.name,p.description,p.price,p.promo_price,p.promo_until,p.stock,p.unit,p.qty_step,p.photo_id,p.photos,s.name AS shop_name,s.slug,s.category
           FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.active=1 AND p.stock>0 AND s.status='active' AND p.unit!='piece' ORDER BY p.created_at DESC LIMIT 24`).all()).results);
        return json(results.map(publicProduct));
      }
      if (method === 'GET' && p === '/api/promotions') {
        const results = await cached('promotions', PUBLIC_TTL, async () => (await env.DB.prepare(
          `SELECT p.id,p.name,p.description,p.price,p.promo_price,p.promo_until,p.stock,p.unit,p.qty_step,p.photo_id,p.photos,s.name AS shop_name,s.slug,s.category
           FROM products p JOIN shops s ON s.id=p.shop_id
           WHERE p.active=1 AND p.stock>0 AND s.status='active' AND ${EFFECTIVE_PRICE} < p.price
           ORDER BY (1.0 * p.promo_price / p.price) ASC, p.promo_until ASC LIMIT 24`).all()).results);
        return json(results.map(publicProduct));
      }
      if (method === 'GET' && p === '/api/products') {
        const cat = url.searchParams.get('cat') || '', q = cleanText(url.searchParams.get('q'), 60);
        const limit = Math.min(48, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 24));
        return json(await searchProducts(env, { cat, q, limit }));
      }
      if (method === 'GET' && (m = p.match(/^\/api\/shops\/([a-z0-9-]{1,60})$/))) {
        const shopRow = await cached('shop:' + m[1], PUBLIC_TTL, () => env.DB.prepare(`SELECT id,name,slug,category,description,address,photo_id,cover_photo,look,template,site,phone,loyalty_enabled,loyalty_every,loyalty_kind,loyalty_value,loyalty_min,loyalty_days
          FROM shops WHERE slug=?1 AND status='active'`).bind(m[1]).first());
        if (!shopRow) return bad('Boutique introuvable', 404);
        const s = { ...shopRow }; // copie : l'original reste intact dans la mémoire courte
        if (!isServiceCat(s.category)) { delete s.template; delete s.site; }
        if (isServiceCat(s.category)) { // prestataire de services : ses prestations, pas de produits ni de fidélité
          for (const k of ['loyalty_enabled', 'loyalty_every', 'loyalty_kind', 'loyalty_value', 'loyalty_min', 'loyalty_days']) delete s[k];
          return json({ shop: { ...s, kind: 'services', template: templateOf(s.template, s.category), site: parseSite(s.site), verified: await verifiedDocs(env, s.id) }, products: [], services: await cached('shop-services:' + s.id, PUBLIC_TTL, () => servicesOfShop(env, s.id)),
            items: await cached('shop-items:' + s.id, PUBLIC_TTL, () => itemsOfShop(env, s.id)), mine: null });
        }
        const loyalty = loyaltyProgram(s);
        for (const k of ['loyalty_enabled', 'loyalty_every', 'loyalty_kind', 'loyalty_value', 'loyalty_min', 'loyalty_days']) delete s[k];
        let mine = null;
        const viewer = await currentUser(request, env);
        if (viewer && viewer.role === 'customer') {
          const card = await env.DB.prepare('SELECT stamps,orders FROM loyalty_cards WHERE user_id=?1 AND shop_id=?2').bind(viewer.id, s.id).first();
          const v = await env.DB.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE user_id=?1 AND shop_id=?2 AND used_at IS NULL AND expires_at>?3').bind(viewer.id, s.id, Date.now()).first();
          const { results: al } = await env.DB.prepare('SELECT a.product_id FROM stock_alerts a JOIN products p ON p.id=a.product_id WHERE a.user_id=?1 AND p.shop_id=?2').bind(viewer.id, s.id).all();
          mine = { stamps: card ? card.stamps : 0, orders: card ? card.orders : 0, vouchers: v.n, alerts: al.map(x => x.product_id) };
        }
        const results = await cached('shop-products:' + s.id, PUBLIC_TTL, async () => (await env.DB.prepare(
          `SELECT id,name,description,price,promo_price,promo_until,stock,unit,qty_step,photo_id,photos,created_at FROM products WHERE shop_id=?1 AND active=1 ORDER BY created_at DESC`).bind(s.id).all()).results);
        const list = results.map(publicProduct).sort((a, b) => (b.promo_pct ? 1 : 0) - (a.promo_pct ? 1 : 0) || (b.stock > 0) - (a.stock > 0));
        return json({ shop: { ...s, loyalty }, products: list, mine });
      }
      if (method === 'GET' && (m = p.match(/^\/api\/invites\/([a-f0-9]{12})$/))) {
        const inv = await env.DB.prepare('SELECT role,kind,label,max_uses,uses,expires_at,auto_approve,revoked FROM invites WHERE code=?1').bind(m[1]).first();
        const state = inviteState(inv);
        return json(state === 'valide' ? { state, role: inv.role, kind: inv.kind || null, autoApprove: !!inv.auto_approve, expiresAt: inv.expires_at } : { state });
      }
      if (method === 'GET' && (m = p.match(/^\/api\/photos\/([a-f0-9]{16})$/))) {
        const ph = await env.DB.prepare('SELECT mime,data FROM photos WHERE id=?1').bind(m[1]).first();
        if (!ph) return bad('Photo introuvable', 404);
        return new Response(fromBase64(ph.data), { headers: { 'content-type': ph.mime, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
      }

      // ===== Authentification =====
      if (method === 'POST' && p === '/api/auth/register') return register(request, env, secure);
      if (method === 'POST' && p === '/api/auth/login') return login(request, env, secure);
      if (method === 'POST' && p === '/api/auth/reset') return resetPassword(request, env);
      if (method === 'POST' && p === '/api/auth/logout') {
        await destroySession(request, env);
        return json({ ok: true }, 200, { 'set-cookie': clearCookie(secure) });
      }
      if (method === 'GET' && p === '/api/admin/setup') {
        const a = await env.DB.prepare(`SELECT 1 FROM users WHERE role='admin'`).first();
        return json({ needed: !a, configured: !!env.ADMIN_SETUP_CODE });
      }
      if (method === 'POST' && p === '/api/admin/setup') {
        if (await env.DB.prepare(`SELECT 1 FROM users WHERE role='admin'`).first()) return bad('Un administrateur existe déjà', 409);
        if (!env.ADMIN_SETUP_CODE) return bad('Le code secret ADMIN_SETUP_CODE n\'est pas configuré dans Cloudflare', 503);
        const b = await readJson(request);
        if (!b || !safeEqual(String(b.code || ''), env.ADMIN_SETUP_CODE)) return bad('Code incorrect', 403);
        const email = cleanText(b.email, 254).toLowerCase(), password = String(b.password || '');
        if (!validEmail(email) || password.length < 10) return bad('E-mail invalide ou mot de passe trop court (10 caractères minimum)');
        const { hash, salt } = await hashPassword(password);
        const id = uid();
        await env.DB.prepare(`INSERT INTO users (id,email,name,phone,pass_hash,salt,role,status,created_at) VALUES (?1,?2,?3,'',?4,?5,'admin','active',?6)`)
          .bind(id, email, cleanText(b.name, 80) || 'Administrateur', hash, salt, now()).run();
        return json({ ok: true }, 201, { 'set-cookie': await createSession(env, id, secure) });
      }

      // Notification SingPay (non signée) : simple déclencheur, l'état est revérifié auprès de SingPay
      if (method === 'POST' && isWebhook) {
        const b = await readJson(request) || {};
        const ref = String(b.reference || (b.data && b.data.reference) || (b.transaction && b.transaction.reference) || '').slice(0, 40);
        const co = ref && await env.DB.prepare('SELECT * FROM checkouts WHERE ref=?1').bind(ref).first();
        if (co) await singpayVerify(env, co);
        return json({ ok: true });
      }

      // ===== Assistant (visiteurs et connectés) =====
      const user = await currentUser(request, env);
      if (method === 'POST' && p === '/api/bot') {
        const b = await readJson(request);
        if (!b || !cleanText(b.message, 300)) return bad('Message vide');
        return json(await botReply(env, user, await loadSettings(env), b.message));
      }
      if (method === 'GET' && p === '/api/me') return json({ user });

      // ===== Connecté =====
      if (!user) return bad('Connexion requise', 401);
      const subRes = await subRoutes(env, request, user, p, method, { readJson, cleanText });
      if (subRes) return subRes;
      const svcRes = await serviceCustomerRoutes(env, request, user, p, method, { readJson, cleanText });
      if (svcRes) return svcRes;
      const pushRes = await pushRoutes(env, request, user, p, method, { readJson });
      if (pushRes) return pushRes;

      if (method === 'GET' && p === '/api/notifications') {
        const { results } = await env.DB.prepare('SELECT id,title,body,url,read,created_at,kind FROM notifications WHERE user_id=?1 ORDER BY created_at DESC LIMIT 30').bind(user.id).all();
        return json({ items: results, unread: results.filter(n => !n.read).length });
      }
      if (method === 'POST' && p === '/api/notifications/read') {
        await env.DB.prepare('UPDATE notifications SET read=1 WHERE user_id=?1').bind(user.id).run();
        return json({ ok: true });
      }

      if (method === 'POST' && p === '/api/photos') {
        const buf = await request.arrayBuffer();
        if (!buf.byteLength || buf.byteLength > 700 * 1024) return bad('Photo trop lourde (700 Ko maximum)');
        const mime = sniffImage(buf);
        if (!mime) return bad('Format non pris en charge (JPEG, PNG ou WebP)');
        // Quotas : un client ou un livreur n'a besoin que de sa photo de profil ; une boutique, de ses produits
        const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM photos WHERE owner_id=?1').bind(user.id).first()).n;
        const maxTotal = user.role === 'seller' || user.role === 'admin' ? 400 : 20;
        if (n >= maxTotal) return bad('Limite de photos atteinte');
        const kPh = 'p:' + user.id;
        if ((await recentCount(env, kPh, 86400000)) >= (user.role === 'seller' || user.role === 'admin' ? 120 : 10)) return bad('Trop de photos envoyées aujourd\'hui. Réessayez demain.', 429);
        await recordEvent(env, kPh);
        const id = uid();
        await env.DB.prepare('INSERT INTO photos (id,owner_id,mime,data,size,created_at) VALUES (?1,?2,?3,?4,?5,?6)').bind(id, user.id, mime, toBase64(buf), buf.byteLength, now()).run();
        return json({ id }, 201);
      }
      // ----- Pièces justificatives (privées : propriétaire et administrateur uniquement) -----
      if (method === 'GET' && p === '/api/me/documents') {
        const { results } = await env.DB.prepare('SELECT id,kind,status,note,size,mime,created_at FROM documents WHERE user_id=?1').bind(user.id).all();
        const myShop = user.role === 'seller' ? await env.DB.prepare('SELECT category FROM shops WHERE owner_id=?1').bind(user.id).first() : null;
        const kinds = docKindsFor(user.role, myShop && myShop.category).map(([id, k]) => ({ id, label: k.label }));
        return json({ kinds, documents: results.map(d => ({ ...d, label: (DOC_KINDS[d.kind] || {}).label || d.kind })) });
      }
      if (method === 'POST' && (m = p.match(/^\/api\/me\/documents\/([a-z_]{2,30})$/)) && DOC_KINDS[m[1]]) {
        const myShop = user.role === 'seller' ? await env.DB.prepare('SELECT category FROM shops WHERE owner_id=?1').bind(user.id).first() : null;
        if (!docKindsFor(user.role, myShop && myShop.category).some(([id]) => id === m[1])) return bad('Cette pièce ne concerne pas votre type de compte', 403);
        const buf = await request.arrayBuffer();
        if (!buf.byteLength || buf.byteLength > 1024 * 1024) return bad('Fichier trop lourd (1 Mo maximum)');
        const mime = sniffDocument(buf);
        if (!mime) return bad('Format non pris en charge (photo JPEG, PNG, WebP ou PDF)');
        const id = uid();
        await env.DB.prepare(`INSERT INTO documents (id,user_id,kind,mime,data,size,status,created_at) VALUES (?1,?2,?3,?4,?5,?6,'pending',?7)
          ON CONFLICT(user_id,kind) DO UPDATE SET id=excluded.id,mime=excluded.mime,data=excluded.data,size=excluded.size,status='pending',note=NULL,created_at=excluded.created_at,reviewed_at=NULL,reviewed_by=NULL`)
          .bind(id, user.id, m[1], mime, toBase64(buf), buf.byteLength, now()).run();
        const { results: admins } = await env.DB.prepare(`SELECT id FROM users WHERE role='admin'`).all();
        for (const a of admins) await notify(env, a.id, 'Pièce à vérifier', `${user.name} a ajouté : ${DOC_KINDS[m[1]].label}.`, '/admin.html');
        return json({ id }, 201);
      }
      if (method === 'DELETE' && (m = p.match(/^\/api\/me\/documents\/([a-f0-9]{16})$/))) {
        await env.DB.prepare('DELETE FROM documents WHERE id=?1 AND user_id=?2').bind(m[1], user.id).run();
        return json({ ok: true });
      }
      if (method === 'GET' && (m = p.match(/^\/api\/documents\/([a-f0-9]{16})$/))) {
        const d = await env.DB.prepare('SELECT d.mime,d.data,d.kind,d.user_id,u.name FROM documents d JOIN users u ON u.id=d.user_id WHERE d.id=?1').bind(m[1]).first();
        if (!d || (d.user_id !== user.id && user.role !== 'admin')) return bad('Document introuvable', 404);
        if (user.role === 'admin' && d.user_id !== user.id) await logAction(env, user, 'Pièce consultée', 'document', m[1], d.name, (DOC_KINDS[d.kind] || {}).label || d.kind);
        return new Response(fromBase64(d.data), { headers: { 'content-type': d.mime, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'", 'x-robots-tag': 'noindex', 'content-disposition': 'inline' } });
      }
      if (method === 'PUT' && p === '/api/me/photo') {
        const b = await readJson(request) || {};
        let photo = null;
        if (b.photo_id) {
          photo = String(b.photo_id);
          if (!/^[a-f0-9]{16}$/.test(photo) || !await env.DB.prepare('SELECT 1 FROM photos WHERE id=?1 AND owner_id=?2').bind(photo, user.id).first()) return bad('Photo introuvable');
        }
        await env.DB.prepare('UPDATE users SET avatar_id=?2 WHERE id=?1').bind(user.id, photo).run();
        return json({ ok: true, avatar_id: photo });
      }

      // ----- Panier -----
      if (method === 'GET' && p === '/api/cart') {
        const { results } = await env.DB.prepare(
          `SELECT c.product_id,c.qty,p.name,${EFFECTIVE_PRICE} AS price,p.price AS base_price,p.stock,p.unit,p.qty_step,p.photo_id,p.active,s.id AS shop_id,s.name AS shop_name,s.slug,s.status AS shop_status
           FROM cart_items c JOIN products p ON p.id=c.product_id JOIN shops s ON s.id=p.shop_id WHERE c.user_id=?1`).bind(user.id).all();
        const { results: vouchers } = await env.DB.prepare(
          `SELECT id,code,shop_id,kind,value,min_order,expires_at FROM vouchers WHERE user_id=?1 AND used_at IS NULL AND expires_at>?2 ORDER BY expires_at`).bind(user.id, Date.now()).all();
        return json({ items: results, vouchers: vouchers.filter(v => results.some(i => i.shop_id === v.shop_id)) });
      }
      if (method === 'PUT' && p === '/api/cart') {
        const b = await readJson(request);
        const prod = b && await env.DB.prepare(`SELECT p.id,p.stock,p.unit,p.qty_step FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.id=?1 AND p.active=1 AND s.status='active'`).bind(String(b.productId || '')).first();
        if (!prod) return bad('Produit introuvable', 404);
        const dec = UNITS[prod.unit].decimal, step = prod.qty_step || 1;
        let qty = dec ? r3(Math.round(num(b.qty) / step) * step) : Math.floor(num(b.qty));
        if (!Number.isFinite(qty) || qty < 0 || qty > 99) return bad('Quantité invalide');
        if (qty === 0) await env.DB.prepare('DELETE FROM cart_items WHERE user_id=?1 AND product_id=?2').bind(user.id, prod.id).run();
        else {
          if (prod.stock <= 0) return bad('Ce produit est épuisé. Activez « Me prévenir » pour savoir quand il revient.', 409, { stock: 0 });
          let q = Math.min(qty, prod.stock); // jamais plus que le stock : on ajuste et on prévient
          if (dec) q = r3(Math.floor(q / step + 1e-9) * step);
          if (q <= 0) return bad(`Il ne reste que ${fmtQty(prod.stock, prod.unit)} : moins que la quantité minimale (${fmtQty(step, prod.unit)}).`, 409, { stock: prod.stock });
          await env.DB.prepare('INSERT INTO cart_items (user_id,product_id,qty) VALUES (?1,?2,?3) ON CONFLICT(user_id,product_id) DO UPDATE SET qty=excluded.qty').bind(user.id, prod.id, q).run();
          return json({ ok: true, qty: q, stock: prod.stock, adjusted: q < qty });
        }
        return json({ ok: true, qty: 0 });
      }

      // ----- Alerte « me prévenir quand le produit revient » -----
      if ((method === 'POST' || method === 'DELETE') && (m = p.match(/^\/api\/products\/([a-f0-9]{16})\/alert$/))) {
        if (method === 'DELETE') { await env.DB.prepare('DELETE FROM stock_alerts WHERE user_id=?1 AND product_id=?2').bind(user.id, m[1]).run(); return json({ ok: true, on: false }); }
        const prod = await env.DB.prepare('SELECT stock FROM products WHERE id=?1 AND active=1').bind(m[1]).first();
        if (!prod) return bad('Produit introuvable', 404);
        if (prod.stock > 0) return bad('Ce produit est disponible : vous pouvez le commander.');
        const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM stock_alerts WHERE user_id=?1').bind(user.id).first()).n;
        if (n >= 50) return bad('Vous suivez déjà 50 produits');
        await env.DB.prepare('INSERT OR IGNORE INTO stock_alerts (user_id,product_id,created_at) VALUES (?1,?2,?3)').bind(user.id, m[1], now()).run();
        return json({ ok: true, on: true });
      }

      // ----- Validation du panier : une commande par boutique, un seul paiement -----
      if (method === 'POST' && p === '/api/checkout') {
        const b = await readJson(request);
        if (!b) return bad('Requête invalide');
        const address = cleanText(b.address, 250), phone = cleanText(b.phone, 30), note = cleanText(b.note, 300);
        const lat = num(b.lat), lng = num(b.lng), hasPos = validCoord(lat, lng);
        if (address.length < 5) return bad('Indiquez votre adresse de livraison (quartier, repère)');
        if (phone.length < 8) return bad('Indiquez un numéro de téléphone joignable');
        const { results: lines } = await env.DB.prepare(
          `SELECT c.product_id,c.qty,p.name,${EFFECTIVE_PRICE} AS price,p.stock,p.unit,p.active,s.id AS shop_id,s.name AS shop_name,s.status AS shop_status,s.lat AS slat,s.lng AS slng
           FROM cart_items c JOIN products p ON p.id=c.product_id JOIN shops s ON s.id=p.shop_id WHERE c.user_id=?1`).bind(user.id).all();
        if (!lines.length) return bad('Votre panier est vide');
        for (const l of lines) {
          if (!l.active || l.shop_status !== 'active') return bad(`« ${l.name} » n'est plus disponible. Retirez-le du panier.`);
          if (l.stock <= 0) return bad(`« ${l.name} » vient d'être épuisé. Retirez-le du panier pour continuer.`, 409);
          if (l.qty > l.stock) return bad(`« ${l.name} » : il n'en reste que ${fmtQty(l.stock, l.unit)}. Ajustez la quantité dans le panier.`, 409);
        }
        const settings = await loadSettings(env);
        const byShop = new Map();
        for (const l of lines) { if (!byShop.has(l.shop_id)) byShop.set(l.shop_id, []); byShop.get(l.shop_id).push(l); }
        // Paiement direct : le client paie chaque boutique sur son propre compte, à condition que TOUTES les boutiques du panier en aient indiqué un.
        // Sinon ce panier suit l'ancien parcours (paiement au marché), pour que personne ne soit bloqué.
        const accounts = new Map();
        const sids = [...byShop.keys()];
        const { results: sh } = await env.DB.prepare(`SELECT id,name,owner_id,payout_method,payout_number,payout_name,payout_code,payout_bank FROM shops WHERE id IN (${sids.map((_, i) => '?' + (i + 1)).join(',')})`).bind(...sids).all();
        for (const s of sh) accounts.set(s.id, s);
        const direct = (settings.payment_mode || 'direct') === 'direct' && sh.length === sids.length && sh.every(s => s.payout_number);
        if ((settings.payment_mode || 'direct') === 'direct' && !direct) {
          for (const s of sh) if (!s.payout_number) await notify(env, s.owner_id, 'Un client veut vous payer directement', 'Indiquez votre numéro Mobile Money ou votre compte bancaire dans Ma boutique : vos clients pourront vous payer directement.', '/vendeur.html#boutique');
        }
        const payList = [];
        const checkoutId = uid(), ref = 'MG-' + rand(4).toUpperCase();
        const stmts = [], orderRefs = [];
        let amount = 0;
        // Bons d'achat choisis : un par boutique, réservés avant la création des commandes
        const wanted = [...new Set((Array.isArray(b.vouchers) ? b.vouchers : []).map(String).filter(x => /^[a-f0-9]{16}$/.test(x)))].slice(0, 20);
        const useVoucher = new Map(), orderIds = new Map([...byShop.keys()].map(k => [k, uid()]));
        for (const vid of wanted) {
          const v = await env.DB.prepare('SELECT * FROM vouchers WHERE id=?1 AND user_id=?2 AND used_at IS NULL AND expires_at>?3').bind(vid, user.id, Date.now()).first();
          if (!v || !byShop.has(v.shop_id) || useVoucher.has(v.shop_id)) continue;
          const sub = byShop.get(v.shop_id).reduce((t, l) => t + lineTotal(l.price, l.qty), 0);
          if (!voucherDiscount(v, sub)) return bad(`Le bon ${v.code} demande au moins ${v.min_order.toLocaleString('fr-FR')} FCFA d'achats dans cette boutique`);
          useVoucher.set(v.shop_id, v);
        }
        const reserved = [];
        for (const [shopId, v] of useVoucher) {
          const r = await env.DB.prepare('UPDATE vouchers SET used_at=?3, order_id=?4 WHERE id=?1 AND user_id=?2 AND used_at IS NULL').bind(v.id, user.id, now(), orderIds.get(shopId)).run();
          if (!r.meta.changes) { for (const o of reserved) await releaseVoucher(env, o); return bad(`Le bon ${v.code} vient d'être utilisé. Réessayez.`, 409); }
          reserved.push(orderIds.get(shopId));
        }
        for (const [shopId, ls] of byShop) {
          const subtotal = ls.reduce((t, l) => t + lineTotal(l.price, l.qty), 0);
          const voucher = useVoucher.get(shopId) || null, discount = voucher ? voucherDiscount(voucher, subtotal) : 0;
          const commission = Math.round(((subtotal - discount) * (settings.commission_pct || 0)) / 100);
          let km = null, fee = settings.delivery_base;
          if (hasPos && validCoord(ls[0].slat, ls[0].slng)) {
            km = Math.round(distanceKm(lat, lng, ls[0].slat, ls[0].slng) * 10) / 10;
            fee = Math.round((settings.delivery_base + settings.delivery_per_km * Math.ceil(km)) / 50) * 50;
          }
          const orderId = orderIds.get(shopId), oref = 'CMD-' + rand(3).toUpperCase();
          orderRefs.push(oref); amount += subtotal - discount + fee;
          stmts.push(env.DB.prepare(
            `INSERT INTO orders (id,ref,checkout_id,customer_id,shop_id,status,subtotal,delivery_fee,total,address,lat,lng,phone,note,distance_km,created_at,updated_at,discount,voucher_id,commission,pay_direct,pay_account)
             VALUES (?1,?2,?3,?4,?5,'awaiting_payment',?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?15,?16,?17,?18,?19,?20)`)
            .bind(orderId, oref, checkoutId, user.id, shopId, subtotal, fee, subtotal - discount + fee, address, hasPos ? lat : null, hasPos ? lng : null, phone, note, km, now(), discount, voucher ? voucher.id : null, commission, direct ? 1 : 0, direct ? (a => snap({ method: a.payout_method, number: a.payout_number, name: a.payout_name, code: a.payout_code, bank: a.payout_bank }))(accounts.get(shopId)) : null));
          if (direct) payList.push({ ref: oref, shop: accounts.get(shopId).name, shopId, amount: subtotal - discount, delivery: fee });
          for (const l of ls) {
            stmts.push(env.DB.prepare('INSERT INTO order_items (id,order_id,product_id,name,price,qty,unit) VALUES (?1,?2,?3,?4,?5,?6,?7)').bind(uid(), orderId, l.product_id, l.name, l.price, l.qty, l.unit));
            stmts.push(env.DB.prepare('UPDATE products SET stock = ROUND(stock - ?2, 3), stock_updated_at=?3 WHERE id=?1').bind(l.product_id, l.qty, Date.now()));
          }
        }
        const method2 = ['airtel_money', 'moov_money', 'card'].includes(b.method) ? b.method : 'airtel_money';
        stmts.unshift(env.DB.prepare(`INSERT INTO checkouts (id,ref,user_id,amount,method,provider,status,created_at) VALUES (?1,?2,?3,?4,?5,?7,'pending',?6)`)
          .bind(checkoutId, ref, user.id, amount, method2, now(), direct ? 'direct' : 'manual'));
        stmts.push(env.DB.prepare('DELETE FROM cart_items WHERE user_id=?1').bind(user.id));
        try { await env.DB.batch(stmts); }
        catch (e) {
          for (const o of reserved) await releaseVoucher(env, o);
          if (/stock_insuffisant/.test(String(e && e.message))) return bad('Un article vient d\'être acheté par quelqu\'un d\'autre et le stock a changé. Vérifiez votre panier.', 409);
          throw e;
        }
        // Alerte au vendeur : stock faible ou épuisé après cette commande
        const ids = [...new Set(lines.map(l => l.product_id))];
        const { results: after } = await env.DB.prepare(`SELECT p.name,p.stock,p.unit,s.owner_id FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.id IN (${ids.map((_, i) => '?' + (i + 1)).join(',')})`).bind(...ids).all();
        for (const a of after) {
          if (a.stock <= 0) await notify(env, a.owner_id, 'Produit épuisé', `« ${a.name} » n'a plus de stock : il n'est plus commandable. Réapprovisionnez-le dans Ma boutique → Produits.`, '/vendeur.html#produits');
          else if (a.stock <= LOW_STOCK) await notify(env, a.owner_id, 'Stock faible', `Il ne reste que ${fmtQty(a.stock, a.unit)} de « ${a.name} ». Pensez à mettre le stock à jour.`, '/vendeur.html#produits');
        }
        const co = { id: checkoutId, ref, amount };
        if (direct) {
          const payments = payList.map(x => { const a = accounts.get(x.shopId); return { ref: x.ref, shop: x.shop, amount: x.amount, account: { method: a.payout_method, methodLabel: METHOD_LABEL[a.payout_method], number: a.payout_number, name: a.payout_name, code: a.payout_code, bank: a.payout_bank } }; });
          return json({ ref, amount, orders: orderRefs, id: checkoutId, direct: true, payments, deliveryTotal: payList.reduce((t, x) => t + x.delivery, 0), redirectUrl: null, manual: false }, 201);
        }
        const online = await startOnlinePayment(env, co, url.origin);
        return json({
          ref, amount, orders: orderRefs, id: checkoutId,
          redirectUrl: online ? online.redirectUrl : null, manual: !online,
          airtelNumber: settings.airtel_number, merchantName: settings.merchant_name, instructions: settings.payment_instructions
        }, 201);
      }
      if (method === 'POST' && (m = p.match(/^\/api\/my\/checkouts\/([a-f0-9]{16})\/proof$/))) {
        const b = await readJson(request);
        const txn = cleanText(b && b.txnRef, 60);
        if (txn.length < 4) return bad('Saisissez la référence de la transaction reçue par SMS');
        const r = await env.DB.prepare(`UPDATE checkouts SET txn_ref=?3, status='submitted' WHERE id=?1 AND user_id=?2 AND status IN ('pending','submitted')`).bind(m[1], user.id, txn).run();
        if (!r.meta.changes) return bad('Paiement introuvable', 404);
        const { results: admins } = await env.DB.prepare(`SELECT id FROM users WHERE role='admin'`).all();
        for (const a of admins) await notify(env, a.id, 'Paiement à vérifier', `Référence ${txn}`, '/admin.html');
        return json({ ok: true });
      }
      // ----- Paiement direct : le client indique la référence de sa transaction (boutique, puis frais de livraison au livreur) -----
      if (method === 'POST' && (m = p.match(/^\/api\/my\/orders\/(CMD-[A-F0-9]{6})\/(proof|fee-proof)$/))) {
        const b = await readJson(request), txn = cleanText(b && b.txnRef, 60);
        if (txn.length < 4) return bad('Saisissez la référence de la transaction (SMS de confirmation)');
        const r = await loadOrderFor(env, user, m[1]);
        if (!r || r.role !== 'customer' || !r.o.pay_direct) return bad('Commande introuvable', 404);
        if (m[2] === 'proof') {
          if (r.o.status !== 'awaiting_payment') return bad('Cette commande est déjà réglée ou annulée');
          await env.DB.prepare('UPDATE orders SET pay_ref=?2, pay_submitted_at=?3, updated_at=?3 WHERE id=?1').bind(r.o.id, txn, now()).run();
          await notify(env, r.o.shop_owner, 'Paiement à confirmer', `${r.o.customer_name} dit avoir payé ${r.o.subtotal - (r.o.discount || 0)} FCFA (commande ${r.o.ref}, réf. ${txn}). Vérifiez votre compte, puis confirmez.`, '/vendeur.html');
        } else {
          if (!r.o.courier_id) return bad('Un livreur n\'a pas encore pris votre commande');
          if (r.o.fee_state === 'paid') return bad('Les frais de livraison sont déjà confirmés');
          await env.DB.prepare(`UPDATE orders SET fee_ref=?2, fee_state='submitted' WHERE id=?1`).bind(r.o.id, txn).run();
          await notify(env, r.o.courier_id, 'Frais de livraison payés', `${r.o.customer_name} dit avoir payé ${r.o.delivery_fee} FCFA (commande ${r.o.ref}, réf. ${txn}). Confirmez quand vous les avez reçus.`, '/livreur.html');
        }
        return json({ ok: true });
      }
      if (method === 'GET' && (m = p.match(/^\/api\/my\/checkouts\/(MG-[A-F0-9]{8})\/check$/))) {
        const co = await env.DB.prepare('SELECT * FROM checkouts WHERE ref=?1 AND user_id=?2').bind(m[1], user.id).first();
        if (!co) return bad('Paiement introuvable', 404);
        return json({ status: await singpayVerify(env, co) });
      }

      // ----- Commandes (client) -----
      if (method === 'GET' && p === '/api/my/orders') {
        const { results } = await env.DB.prepare(
          `SELECT o.ref,o.status,o.total,o.created_at,s.name AS shop_name,co.id AS checkout_id,co.status AS pay_status
           FROM orders o JOIN shops s ON s.id=o.shop_id JOIN checkouts co ON co.id=o.checkout_id
           WHERE o.customer_id=?1 ORDER BY o.created_at DESC LIMIT 50`).bind(user.id).all();
        return json(results.map(o => ({ ...o, statusLabel: ORDER_STATUS[o.status] })));
      }
      if (method === 'GET' && p === '/api/my/loyalty') {
        const { results: cards } = await env.DB.prepare(
          `SELECT c.stamps,c.orders,c.spent,s.id AS shop_id,s.name,s.slug,s.category,s.photo_id,s.loyalty_enabled,s.loyalty_every,s.loyalty_kind,s.loyalty_value,s.loyalty_min,s.loyalty_days
           FROM loyalty_cards c JOIN shops s ON s.id=c.shop_id WHERE c.user_id=?1 AND s.status='active' ORDER BY c.updated_at DESC`).bind(user.id).all();
        const { results: vouchers } = await env.DB.prepare(
          `SELECT v.id,v.code,v.kind,v.value,v.min_order,v.expires_at,v.origin,v.note,v.used_at,v.shop_id,s.name AS shop_name,s.slug FROM vouchers v JOIN shops s ON s.id=v.shop_id
           WHERE v.user_id=?1 AND (v.used_at IS NULL AND v.expires_at>?2 OR v.used_at > ?3) ORDER BY v.used_at IS NOT NULL, v.expires_at`)
          .bind(user.id, Date.now(), new Date(Date.now() - 60 * 86400000).toISOString()).all();
        return json({
          cards: cards.map(c => ({ shop_id: c.shop_id, name: c.name, slug: c.slug, category: c.category, photo_id: c.photo_id, stamps: c.stamps, orders: c.orders, spent: c.spent, program: loyaltyProgram(c) })),
          vouchers
        });
      }
      if (method === 'GET' && (m = p.match(/^\/api\/orders\/(CMD-[A-F0-9]{6})$/))) {
        const r = await loadOrderFor(env, user, m[1]);
        if (!r) return bad('Commande introuvable', 404);
        const order = orderPublic(r.o, r.role);
        if (r.o.pay_direct) {
          const acc = (m_, n, nm, cd, bk) => (n ? { method: m_, methodLabel: METHOD_LABEL[m_], number: n, name: nm, code: cd, bank: bk } : null);
          const sh = await env.DB.prepare('SELECT payout_method,payout_number,payout_name,payout_code,payout_bank FROM shops WHERE id=?1').bind(r.o.shop_id).first();
          const shopState = r.o.status === 'cancelled' ? 'cancelled' : r.o.status !== 'awaiting_payment' ? 'paid' : r.o.pay_ref ? 'submitted' : 'to_pay';
          let fee = null;
          if (r.role !== 'seller') {
            if (!r.o.courier_id) fee = { amount: r.o.delivery_fee, state: 'waiting_courier' };
            else {
              const k = await env.DB.prepare('SELECT pay_method,pay_number,pay_name,pay_code,pay_bank FROM couriers WHERE user_id=?1').bind(r.o.courier_id).first() || {};
              fee = { amount: r.o.delivery_fee, state: r.o.fee_state === 'paid' ? 'paid' : r.o.fee_state === 'submitted' ? 'submitted' : 'to_pay', ref: r.o.fee_ref,
                account: r.role === 'courier' ? null : (r.o.fee_account ? JSON.parse(r.o.fee_account) : acc(k.pay_method, k.pay_number, k.pay_name, k.pay_code, k.pay_bank)), courier: r.o.courier_name, dispute: !!r.o.fee_dispute };
            }
          }
          order.pay = { direct: true, shop: { amount: r.o.subtotal - (r.o.discount || 0), state: shopState, ref: r.o.pay_ref,
            account: r.role === 'customer' || r.role === 'admin' ? (r.o.pay_account ? JSON.parse(r.o.pay_account) : acc(sh.payout_method, sh.payout_number, sh.payout_name, sh.payout_code, sh.payout_bank)) : null, dispute: !!r.o.pay_dispute }, fee };
        }
        return json({ order, items: await itemsOf(env, r.o.id) });
      }
      if (method === 'POST' && (m = p.match(/^\/api\/orders\/(CMD-[A-F0-9]{6})\/cancel$/))) {
        const r = await loadOrderFor(env, user, m[1]);
        if (!r || r.role !== 'customer') return bad('Commande introuvable', 404);
        if (r.o.status !== 'awaiting_payment') return bad('Seule une commande non payée peut être annulée ici. Écrivez à la boutique.');
        // Annulation atomique d'abord : deux demandes simultanées (ou un paiement confirmé au même moment) ne remettent pas le stock deux fois
        const upd = await env.DB.prepare(`UPDATE orders SET status='cancelled', updated_at=?2 WHERE id=?1 AND status='awaiting_payment'`).bind(r.o.id, now()).run();
        if (!upd.meta.changes) return bad('Cette commande vient de changer d\'état. Rechargez la page.', 409);
        await restock(env, r.o.id);
        await releaseVoucher(env, r.o.id);
        return json({ ok: true });
      }
      // Position du livreur (client, vendeur ou administrateur, pendant la livraison)
      if (method === 'GET' && (m = p.match(/^\/api\/orders\/(CMD-[A-F0-9]{6})\/track$/))) {
        const r = await loadOrderFor(env, user, m[1]);
        if (!r || r.role === 'courier') return bad('Commande introuvable', 404);
        if (!r.o.courier_id || !['ready', 'delivering'].includes(r.o.status)) return json({ courier: null });
        const c = await env.DB.prepare(
          `SELECT c.lat,c.lng,c.updated_at,u.name,u.phone,u.avatar_id FROM couriers c JOIN users u ON u.id=c.user_id WHERE c.user_id=?1`).bind(r.o.courier_id).first();
        return json({ courier: c && validCoord(c.lat, c.lng) ? { ...c, ageSec: Math.round((Date.now() - c.updated_at) / 1000) } : (c ? { name: c.name, phone: c.phone, avatar_id: c.avatar_id, lat: null } : null), dest: { lat: r.o.lat, lng: r.o.lng } });
      }

      // ----- Discussion de commande (client, boutique, livreur) -----
      if (method === 'GET' && (m = p.match(/^\/api\/orders\/(CMD-[A-F0-9]{6})\/messages$/))) {
        const r = await loadOrderFor(env, user, m[1]);
        if (!r) return bad('Commande introuvable', 404);
        const after = url.searchParams.get('after') || '';
        const { results } = await env.DB.prepare(
          `SELECT m.id,m.sender_id,m.sender_name,m.sender_role,m.body,m.created_at,u.avatar_id FROM chat_messages m LEFT JOIN users u ON u.id=m.sender_id WHERE m.order_id=?1 AND m.created_at>?2 ORDER BY m.created_at LIMIT 100`).bind(r.o.id, after).all();
        return json({ me: user.id, items: results });
      }
      if (method === 'POST' && (m = p.match(/^\/api\/orders\/(CMD-[A-F0-9]{6})\/messages$/))) {
        const r = await loadOrderFor(env, user, m[1]);
        if (!r) return bad('Commande introuvable', 404);
        const b = await readJson(request);
        const body = cleanText(b && b.body, 500);
        if (!body) return bad('Message vide');
        const recent = (await env.DB.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE sender_id=?1 AND created_at>?2').bind(user.id, new Date(Date.now() - 60000).toISOString()).first()).n;
        if (recent >= 20) return bad('Trop de messages, patientez un instant.', 429);
        await env.DB.prepare('INSERT INTO chat_messages (id,order_id,sender_id,sender_name,sender_role,body,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)')
          .bind(uid(), r.o.id, user.id, user.name, r.role, body, now()).run();
        const targets = new Set([r.o.customer_id, r.o.shop_owner, r.o.courier_id]);
        targets.delete(user.id); targets.delete(null);
        for (const t of targets) await notify(env, t, `Message (${r.o.ref})`, `${user.name} : ${body.slice(0, 100)}`, t === r.o.customer_id ? `/commandes.html?ref=${r.o.ref}` : t === r.o.shop_owner ? '/vendeur.html' : '/livreur.html');
        return json({ ok: true }, 201);
      }

      // ===== Vendeur =====
      if (p.startsWith('/api/seller/')) {
        if (user.role !== 'seller') return bad('Réservé aux gestionnaires de boutique', 403);
        const shop = await env.DB.prepare('SELECT * FROM shops WHERE owner_id=?1').bind(user.id).first();
        if (!shop) return bad('Boutique introuvable', 404);

        const svcSeller = await serviceSellerRoutes(env, request, user, shop, p, method, { readJson, cleanText });
        if (svcSeller) return svcSeller;
        if (method === 'GET' && p === '/api/seller/shop') return json({ shop: { ...shop, kind: isServiceCat(shop.category) ? 'services' : 'products', template: isServiceCat(shop.category) ? templateOf(shop.template, shop.category) : null, site: parseSite(shop.site) }, categories: isServiceCat(shop.category) ? SERVICE_CATEGORIES : CATEGORIES, pending_account: await pendingAccount(env, 'shop', shop.id) });
        if (method === 'PUT' && p === '/api/seller/shop') {
          const b = await readJson(request);
          if (!b) return bad('Requête invalide');
          const name = cleanText(b.name, 80);
          if (name.length < 2) return bad('Indiquez le nom de la boutique');
          // On reste dans le même univers (produits ou services) : les prestations et les produits ne se mélangent pas
          const sameKind = isServiceCat(b.category) === isServiceCat(shop.category);
          const cat = sameKind && (CATEGORIES.some(c => c[0] === b.category) || isServiceCat(b.category)) ? b.category : shop.category;
          const lat = num(b.lat), lng = num(b.lng), pos = validCoord(lat, lng);
          let photo = shop.photo_id;
          if (b.photo_id !== undefined) {
            photo = null;
            if (b.photo_id && await env.DB.prepare('SELECT 1 FROM photos WHERE id=?1 AND owner_id=?2').bind(String(b.photo_id), user.id).first()) photo = String(b.photo_id);
          }
          let cover = shop.cover_photo || null;
          if (b.cover_photo !== undefined) {
            cover = null;
            if (b.cover_photo && await env.DB.prepare('SELECT 1 FROM photos WHERE id=?1 AND owner_id=?2').bind(String(b.cover_photo), user.id).first()) cover = String(b.cover_photo);
          }
          // Design de la page boutique : seulement un nom de la liste, sinon on garde l'actuel ('' revient au design du marché)
          const look = b.look === undefined ? shop.look || null : b.look === '' || b.look === null ? null : lookOf(b.look);
          if (b.look && !look) return bad('Design inconnu');
          // Compte où les clients paient la boutique : toute saisie ou modification est soumise à l'administrateur
          let accState = null;
          if (b.payout_number !== undefined) {
            const acc = cleanAccount({ method: b.payout_method, number: b.payout_number, name: b.payout_name, code: b.payout_code, bank: b.payout_bank }, cleanText);
            if (acc.error) return bad(acc.error);
            accState = await requestAccount(env, user, 'shop', shop.id, shop.name, { method: shop.payout_method, number: shop.payout_number, name: shop.payout_name, code: shop.payout_code, bank: shop.payout_bank }, acc);
          }
          // Prestataires : modèle de site (liste fermée) et contenu du site
          if (b.template !== undefined && !SITE_TEMPLATES.includes(b.template)) return bad('Modèle de site inconnu');
          const template = isServiceCat(cat) ? (b.template !== undefined ? b.template : shop.template || templateOf(null, cat)) : shop.template;
          const site = isServiceCat(cat) && b.site !== undefined ? JSON.stringify(cleanSite(b.site, cleanText)) : shop.site;
          await env.DB.prepare('UPDATE shops SET name=?2,category=?3,description=?4,address=?5,phone=?6,whatsapp=?7,lat=?8,lng=?9,photo_id=?10,cover_photo=?11,look=?12,template=?13,site=?14 WHERE id=?1')
            .bind(shop.id, name, cat, cleanText(b.description, 600), cleanText(b.address, 200), cleanText(b.phone, 30), cleanText(b.whatsapp, 30),
              pos ? lat : shop.lat, pos ? lng : shop.lng, photo, cover, look, template, site).run();
          return json({ ok: true, account: accState });
        }
        if (method === 'GET' && p === '/api/seller/products') {
          const { results } = await env.DB.prepare(`SELECT p.*, (SELECT COUNT(*) FROM stock_alerts a WHERE a.product_id=p.id) AS waiting FROM products p WHERE p.shop_id=?1 ORDER BY p.created_at DESC`).bind(shop.id).all();
          return json(results.map(r => ({ ...r, photos: photoList(r), promo_active: promoActive(r), promo_pct: promoActive(r) ? Math.round(100 - (100 * r.promo_price) / r.price) : null })));
        }
        if ((method === 'POST' || method === 'DELETE') && (m = p.match(/^\/api\/seller\/products\/([a-f0-9]{16})\/promo$/))) {
          const prod = await env.DB.prepare('SELECT * FROM products WHERE id=?1 AND shop_id=?2 AND active=1').bind(m[1], shop.id).first();
          if (!prod) return bad('Produit introuvable', 404);
          if (method === 'DELETE') {
            await env.DB.prepare('UPDATE products SET promo_price=NULL,promo_until=NULL,promo_start=NULL WHERE id=?1').bind(prod.id).run();
            return json({ ok: true });
          }
          const st = await loadSettings(env), b = await readJson(request) || {};
          const maxPct = st.promo_max_pct ?? 70, maxDays = st.promo_max_days ?? 30;
          let promo = Number.isFinite(num(b.promoPrice)) ? Math.round(num(b.promoPrice)) : Math.round(prod.price * (1 - num(b.pct) / 100));
          promo = Math.round(promo / 5) * 5; // arrondi à 5 FCFA
          const pct = 100 - (100 * promo) / prod.price, days = Math.round(num(b.days));
          if (!Number.isFinite(promo) || promo < 50) return bad('Prix promotionnel invalide (50 FCFA minimum)');
          if (pct < 5) return bad('La remise doit être d\'au moins 5 % du prix normal');
          if (pct > maxPct) return bad(`La remise ne peut pas dépasser ${maxPct} % (règle du marché)`);
          if (!(days >= 1 && days <= maxDays)) return bad(`Durée de 1 à ${maxDays} jours`);
          if (prod.stock < 1) return bad('Ajoutez du stock avant de mettre ce produit en promotion');
          await env.DB.prepare('UPDATE products SET promo_price=?2,promo_until=?3,promo_start=?4 WHERE id=?1').bind(prod.id, promo, Date.now() + days * 86400000, Date.now()).run();
          return json({ ok: true, promoPrice: promo, pct: Math.round(pct) });
        }
        if (method === 'POST' && p === '/api/seller/products') {
          const b = await readJson(request);
          const unit = unitOf(b && b.unit), step = stepOf(unit, b && b.qty_step);
          const name = cleanText(b && b.name, 100), price = Math.round(num(b && b.price)), stock = UNITS[unit].decimal ? r3(num(b && b.stock)) : Math.floor(num(b && b.stock));
          if (name.length < 2) return bad('Indiquez le nom du produit');
          { // formule Essentiel : nombre de produits en ligne limité (Pro : illimité)
            const st = await loadSettings(env);
            if (st.sub_enabled && !shop.pro) {
              const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM products WHERE shop_id=?1 AND active=1').bind(shop.id).first()).n;
              if (n >= st.sub_product_limit) return bad(`Vous avez atteint ${st.sub_product_limit} produits en ligne, la limite de la formule Essentiel. Passez à la formule Pro (onglet Abonnement) pour en ajouter sans limite, ou retirez un ancien produit.`, 403);
            }
          }
          if (!Number.isFinite(price) || price < 50 || price > 50000000) return bad('Prix invalide');
          if (!Number.isFinite(stock) || stock < 0 || stock > 100000) return bad('Stock invalide');
          const pics = await ownPhotos(env, user, Array.isArray(b.photos) ? b.photos : b.photo_id ? [b.photo_id] : []);
          const photo = pics[0] || null;
          const id = uid();
          await env.DB.prepare('INSERT INTO products (id,shop_id,name,description,price,stock,photo_id,active,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,1,?8)')
            .bind(id, shop.id, name, cleanText(b.description, 500), price, stock, photo, now()).run();
          await env.DB.prepare('UPDATE products SET stock_updated_at=?2, photos=?3, unit=?4, qty_step=?5 WHERE id=?1').bind(id, Date.now(), JSON.stringify(pics), unit, step).run();
          return json({ id }, 201);
        }
        if ((method === 'PUT' || method === 'DELETE') && (m = p.match(/^\/api\/seller\/products\/([a-f0-9]{16})$/))) {
          const prod = await env.DB.prepare('SELECT * FROM products WHERE id=?1 AND shop_id=?2').bind(m[1], shop.id).first();
          if (!prod) return bad('Produit introuvable', 404);
          if (method === 'DELETE') {
            await env.DB.batch([env.DB.prepare('UPDATE products SET active=0, stock=0 WHERE id=?1').bind(prod.id), env.DB.prepare('DELETE FROM cart_items WHERE product_id=?1').bind(prod.id)]);
            return json({ ok: true });
          }
          const b = await readJson(request);
          const name = cleanText(b && b.name, 100) || prod.name, price = Number.isFinite(num(b && b.price)) ? Math.round(num(b.price)) : prod.price;
          const unit = b && b.unit !== undefined ? unitOf(b.unit) : prod.unit, step = stepOf(unit, b && b.qty_step !== undefined ? b.qty_step : prod.qty_step);
          const stock = Number.isFinite(num(b && b.stock)) ? (UNITS[unit].decimal ? r3(num(b.stock)) : Math.floor(num(b.stock))) : prod.stock;
          if (price < 50 || price > 50000000 || stock < 0 || stock > 100000) return bad('Prix ou stock invalide');
          if (promoActive(prod) && price !== prod.price) return bad('Arrêtez la promotion avant de changer le prix normal (le prix barré doit rester honnête)');
          let photo = prod.photo_id, pics = photoList(prod);
          if (b && Array.isArray(b.photos)) { pics = await ownPhotos(env, user, b.photos); photo = pics[0] || null; }
          else if (b && b.photo_id !== undefined) { const one = await ownPhotos(env, user, b.photo_id ? [b.photo_id] : []); pics = one.length ? [one[0], ...pics.filter(x => x !== one[0])].slice(0, 6) : []; photo = pics[0] || null; }
          await env.DB.prepare('UPDATE products SET name=?2,description=?3,price=?4,stock=?5,photo_id=?6,active=?7,stock_updated_at=?8,photos=?9,unit=?10,qty_step=?11 WHERE id=?1')
            .bind(prod.id, name, b && b.description !== undefined ? cleanText(b.description, 500) : prod.description, price, stock, photo, b && b.active === 0 ? 0 : 1, stock !== prod.stock ? Date.now() : prod.stock_updated_at, JSON.stringify(pics), unit, step).run();
          if (unit !== prod.unit || step !== prod.qty_step) await env.DB.prepare('DELETE FROM cart_items WHERE product_id=?1').bind(prod.id).run(); // les quantités des paniers ne correspondent plus
          if (prod.stock <= 0 && stock > 0) { // de retour en stock : on prévient les clients qui attendaient
            const { results: wait } = await env.DB.prepare('SELECT user_id FROM stock_alerts WHERE product_id=?1').bind(prod.id).all();
            for (const w of wait) await notify(env, w.user_id, 'De retour en stock', `« ${name} » est de nouveau disponible chez ${shop.name}. Faites vite !`, `/boutique/${shop.slug}`);
            await env.DB.prepare('DELETE FROM stock_alerts WHERE product_id=?1').bind(prod.id).run();
          }
          return json({ ok: true });
        }
        if (method === 'GET' && p === '/api/seller/loyalty') {
          const sh = await env.DB.prepare('SELECT loyalty_enabled,loyalty_every,loyalty_kind,loyalty_value,loyalty_min,loyalty_days FROM shops WHERE id=?1').bind(shop.id).first();
          const st = await env.DB.prepare(`SELECT
              (SELECT COUNT(*) FROM loyalty_cards WHERE shop_id=?1) AS customers,
              (SELECT COUNT(*) FROM vouchers WHERE shop_id=?1) AS issued,
              (SELECT COUNT(*) FROM vouchers WHERE shop_id=?1 AND used_at IS NOT NULL) AS used,
              (SELECT COALESCE(SUM(o.discount),0) FROM orders o WHERE o.shop_id=?1 AND o.status!='cancelled') AS discounted`).bind(shop.id).first();
          return json({ program: { enabled: !!sh.loyalty_enabled, every: sh.loyalty_every || 3, kind: sh.loyalty_kind || 'percent', value: sh.loyalty_value || 10, min: sh.loyalty_min || 0, days: sh.loyalty_days || 30 }, stats: st });
        }
        if (method === 'PUT' && p === '/api/seller/loyalty') {
          const b = await readJson(request) || {}, st = await loadSettings(env), maxPct = st.loyalty_max_pct ?? 30;
          const enabled = b.enabled ? 1 : 0, every = Math.round(num(b.every)), kind = b.kind === 'amount' ? 'amount' : 'percent';
          const value = Math.round(num(b.value)), min = Math.max(0, Math.round(num(b.min) || 0)), days = Math.round(num(b.days));
          if (enabled) {
            if (!(every >= 2 && every <= 20)) return bad('Un bon toutes les 2 à 20 commandes');
            if (kind === 'percent' && !(value >= 5 && value <= maxPct)) return bad(`Bon en pourcentage : de 5 à ${maxPct} %`);
            if (kind === 'amount' && !(value >= 500 && value <= 50000)) return bad('Bon en montant : de 500 à 50 000 FCFA');
            if (min > 1000000) return bad('Montant minimum trop élevé');
            if (!(days >= 7 && days <= 180)) return bad('Validité du bon : de 7 à 180 jours');
          }
          await env.DB.prepare('UPDATE shops SET loyalty_enabled=?2,loyalty_every=?3,loyalty_kind=?4,loyalty_value=?5,loyalty_min=?6,loyalty_days=?7 WHERE id=?1')
            .bind(shop.id, enabled, enabled ? every : null, enabled ? kind : null, enabled ? value : null, enabled ? min : null, enabled ? days : null).run();
          return json({ ok: true });
        }
        if (method === 'GET' && p === '/api/seller/customers') {
          const { results } = await env.DB.prepare(
            `SELECT c.user_id,c.stamps,c.orders,c.spent,c.updated_at,u.name,u.phone,u.avatar_id,
                    (SELECT COUNT(*) FROM vouchers v WHERE v.user_id=c.user_id AND v.shop_id=c.shop_id AND v.used_at IS NULL AND v.expires_at>?2) AS vouchers
             FROM loyalty_cards c JOIN users u ON u.id=c.user_id WHERE c.shop_id=?1 ORDER BY c.orders DESC, c.spent DESC LIMIT 200`).bind(shop.id, Date.now()).all();
          return json(results);
        }
        if (method === 'POST' && p === '/api/seller/vouchers') {
          const b = await readJson(request) || {}, st = await loadSettings(env), maxPct = st.loyalty_max_pct ?? 30;
          const uidT = String(b.userId || '');
          const card = /^[a-f0-9]{16}$/.test(uidT) && await env.DB.prepare('SELECT orders FROM loyalty_cards WHERE user_id=?1 AND shop_id=?2').bind(uidT, shop.id).first();
          if (!card || card.orders < 1) return bad('Seuls vos clients déjà livrés peuvent recevoir un bon');
          const kind = b.kind === 'amount' ? 'amount' : 'percent', value = Math.round(num(b.value)), days = Math.round(num(b.days)), min = Math.max(0, Math.round(num(b.min) || 0));
          if (kind === 'percent' && !(value >= 5 && value <= maxPct)) return bad(`Bon en pourcentage : de 5 à ${maxPct} %`);
          if (kind === 'amount' && !(value >= 500 && value <= 50000)) return bad('Bon en montant : de 500 à 50 000 FCFA');
          if (!(days >= 7 && days <= 180)) return bad('Validité du bon : de 7 à 180 jours');
          // Limite anti-abus : 3 bons offerts par client et par mois
          const recent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM vouchers WHERE user_id=?1 AND shop_id=?2 AND origin='gift' AND created_at>?3`)
            .bind(uidT, shop.id, new Date(Date.now() - 30 * 86400000).toISOString()).first();
          if (recent.n >= 3) return bad('Ce client a déjà reçu 3 bons offerts ce mois-ci');
          const v = await createVoucher(env, { userId: uidT, shopId: shop.id, shopName: shop.name, kind, value, minOrder: min, days, origin: 'gift', note: cleanText(b.note, 120) });
          return json(v, 201);
        }
        if (method === 'GET' && (p === '/api/seller/accounting' || p === '/api/seller/accounting.csv')) {
          const a = await shopAccounting(env, shop.id, period(url));
          if (p.endsWith('.csv')) return new Response(accountingCsv(shop.name, a), { headers: { 'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="comptabilite-${shop.slug}-${a.period.from}-${a.period.to}.csv"`, 'cache-control': 'no-store' } });
          return json({ ...a, categories: EXPENSE_CATS, commission_pct: (await loadSettings(env)).commission_pct || 0, payout_set: !!shop.payout_number });
        }
        if (method === 'POST' && p === '/api/seller/expenses') {
          const b = await readJson(request) || {};
          const day = /^\d{4}-\d{2}-\d{2}$/.test(b.day || '') ? b.day : now().slice(0, 10), amount = Math.round(num(b.amount));
          if (!EXPENSE_CATS.includes(b.category)) return bad('Choisissez une catégorie');
          if (!(amount >= 1 && amount <= 100000000)) return bad('Montant invalide');
          if (day > now().slice(0, 10)) return bad('La date ne peut pas être dans le futur');
          const id = uid();
          await env.DB.prepare('INSERT INTO expenses (id,shop_id,day,category,label,amount,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)').bind(id, shop.id, day, b.category, cleanText(b.label, 120), amount, now()).run();
          return json({ id }, 201);
        }
        if (method === 'DELETE' && (m = p.match(/^\/api\/seller\/expenses\/([a-f0-9]{16})$/))) {
          const r = await env.DB.prepare('DELETE FROM expenses WHERE id=?1 AND shop_id=?2').bind(m[1], shop.id).run();
          if (!r.meta.changes) return bad('Dépense introuvable', 404);
          return json({ ok: true });
        }
        if (method === 'GET' && p === '/api/seller/orders') {
          const { results } = await env.DB.prepare(
            `SELECT o.id,o.ref,o.status,o.total,o.subtotal,o.discount,o.delivery_fee,o.address,o.note,o.created_at,o.pay_direct,o.pay_ref,o.pay_submitted_at,o.pay_dispute,u.name AS customer_name
             FROM orders o JOIN users u ON u.id=o.customer_id WHERE o.shop_id=?1 AND (o.status!='awaiting_payment' OR o.pay_direct=1) ORDER BY o.created_at DESC LIMIT 60`).bind(shop.id).all();
          for (const o of results) { o.items = await itemsOf(env, o.id); o.statusLabel = ORDER_STATUS[o.status]; delete o.id; }
          return json(results);
        }
        if (method === 'POST' && (m = p.match(/^\/api\/seller\/orders\/(CMD-[A-F0-9]{6})\/payment$/))) {
          const b = await readJson(request) || {};
          const o = await env.DB.prepare('SELECT * FROM orders WHERE ref=?1 AND shop_id=?2 AND pay_direct=1').bind(m[1], shop.id).first();
          if (!o) return bad('Commande introuvable', 404);
          if (o.status !== 'awaiting_payment') return bad('Cette commande est déjà réglée ou annulée');
          if (b.action === 'confirm') {
            const r = await env.DB.prepare(`UPDATE orders SET status='paid', pay_dispute=NULL, updated_at=?2 WHERE id=?1 AND status='awaiting_payment'`).bind(o.id, now()).run();
            if (!r.meta.changes) return bad('Cette commande vient d\'être modifiée');
            await env.DB.prepare(`UPDATE checkouts SET status='confirmed', confirmed_at=?2 WHERE id=?1 AND status!='confirmed' AND NOT EXISTS (SELECT 1 FROM orders WHERE checkout_id=?1 AND status='awaiting_payment')`).bind(o.checkout_id, now()).run();
            await notify(env, o.customer_id, 'Paiement reçu', `${shop.name} a bien reçu votre paiement pour la commande ${o.ref}. Elle est en préparation. Votre reçu est disponible.`, `/recu.html?ref=${o.ref}`);
            return json({ ok: true });
          }
          if (b.action === 'reject') { // la boutique ne peut pas annuler seule : elle ouvre un litige que l'administrateur tranche
            const reason = cleanText(b.reason, 200) || 'paiement non retrouvé sur le compte';
            if (o.pay_dispute) return bad('Un litige est déjà ouvert : l\'équipe du marché va trancher.');
            await env.DB.prepare('UPDATE orders SET pay_dispute=?2, updated_at=?3 WHERE id=?1').bind(o.id, reason, now()).run();
            const { results: admins } = await env.DB.prepare(`SELECT id FROM users WHERE role='admin'`).all();
            for (const ad of admins) await notify(env, ad.id, 'Litige de paiement', `${shop.name} ne retrouve pas le paiement de la commande ${o.ref} (réf. client : ${o.pay_ref || '—'}) : ${reason}.`, '/admin.html');
            await notify(env, o.customer_id, 'Votre paiement est vérifié par l\'équipe', `${shop.name} ne retrouve pas encore votre paiement (commande ${o.ref}). L'équipe du marché vérifie avec vous : gardez votre SMS de confirmation.`, `/commandes.html?ref=${o.ref}`);
            return json({ ok: true, dispute: true });
          }
          return bad('Action invalide');
        }
        if (method === 'POST' && (m = p.match(/^\/api\/seller\/orders\/(CMD-[A-F0-9]{6})\/status$/))) {
          const b = await readJson(request);
          const o = await env.DB.prepare('SELECT * FROM orders WHERE ref=?1 AND shop_id=?2').bind(m[1], shop.id).first();
          if (!o) return bad('Commande introuvable', 404);
          const next = b && b.status, allowed = { paid: ['preparing', 'cancelled'], preparing: ['ready', 'cancelled'] }[o.status] || [];
          if (!allowed.includes(next)) return bad('Changement de statut impossible');
          const upd = await env.DB.prepare('UPDATE orders SET status=?2, updated_at=?3 WHERE id=?1 AND status=?4').bind(o.id, next, now(), o.status).run();
          if (!upd.meta.changes) return bad('Cette commande vient de changer d\'état. Rechargez la page.', 409);
          const outOfStock = next === 'cancelled' && b.reason === 'out_of_stock';
          if (next === 'cancelled') {
            if (outOfStock) { // le vendeur n'avait plus l'article : le stock passe à 0 pour éviter d'autres commandes
              await env.DB.prepare(`UPDATE products SET stock=0, stock_updated_at=?2 WHERE id IN (SELECT product_id FROM order_items WHERE order_id=?1)`).bind(o.id, Date.now()).run();
            } else {
              await restock(env, o.id);
            }
            await releaseVoucher(env, o.id);
          }
          await notify(env, o.customer_id, 'Votre commande ' + o.ref, outOfStock
            ? `Désolé, ${shop.name} n'a plus cet article en stock : la commande est annulée. Le remboursement vous sera versé par l'équipe du marché.` : ORDER_STATUS[next], `/commandes.html?ref=${o.ref}`);
          if (outOfStock) {
            const { results: admins } = await env.DB.prepare(`SELECT id FROM users WHERE role='admin'`).all();
            for (const a of admins) await notify(env, a.id, 'Rupture : remboursement à faire', `Commande ${o.ref} (${shop.name}) annulée pour rupture de stock, ${o.total} FCFA à rembourser.`, '/admin.html');
          }
          if (next === 'ready' && !o.courier_id) await pushCouriers(env, shop, o, await loadSettings(env));
          return json({ ok: true });
        }
      }

      // ===== Livreur =====
      if (p.startsWith('/api/courier/')) {
        if (user.role !== 'courier') return bad('Réservé aux livreurs', 403);
        await env.DB.prepare('INSERT OR IGNORE INTO couriers (user_id,available) VALUES (?1,0)').bind(user.id).run();
        const me = await env.DB.prepare('SELECT * FROM couriers WHERE user_id=?1').bind(user.id).first();

        if (method === 'GET' && p === '/api/courier/me') return json({ ...me, pending_account: await pendingAccount(env, 'courier', user.id) });
        const courierSub = subState(await loadSettings(env), await env.DB.prepare('SELECT role,sub_until,sub_trial,sub_plan FROM users WHERE id=?1').bind(user.id).first());
        const SUB_OFF = 'Votre abonnement livreur n\'est pas réglé : payez-le dans « Mon abonnement » pour recevoir à nouveau des courses.';
        if (method === 'POST' && p === '/api/courier/availability') {
          const b = await readJson(request);
          if (b && b.available && isBlocked(courierSub)) return bad(SUB_OFF, 402);
          await env.DB.prepare('UPDATE couriers SET available=?2 WHERE user_id=?1').bind(user.id, b && b.available ? 1 : 0).run();
          return json({ ok: true });
        }
        if (method === 'POST' && p === '/api/courier/location') {
          const b = await readJson(request);
          const lat = num(b && b.lat), lng = num(b && b.lng);
          if (!validCoord(lat, lng)) return bad('Position invalide');
          await env.DB.prepare('UPDATE couriers SET lat=?2,lng=?3,updated_at=?4 WHERE user_id=?1').bind(user.id, lat, lng, Date.now()).run();
          return json({ ok: true });
        }
        if (method === 'POST' && p === '/api/courier/account') {
          const b = await readJson(request) || {};
          const acc = cleanAccount({ method: b.method, number: b.number, name: b.name, code: b.code, bank: b.bank }, cleanText);
          if (acc.error) return bad(acc.error);
          const state = await requestAccount(env, user, 'courier', user.id, user.name, { method: me.pay_method, number: me.pay_number, name: me.pay_name, code: me.pay_code, bank: me.pay_bank }, acc);
          return json({ ok: true, account: state });
        }
        if (method === 'POST' && (m = p.match(/^\/api\/courier\/orders\/(CMD-[A-F0-9]{6})\/fee$/))) {
          const o = await env.DB.prepare('SELECT id,ref,customer_id,pay_direct,fee_state FROM orders WHERE ref=?1 AND courier_id=?2').bind(m[1], user.id).first();
          if (!o || !o.pay_direct) return bad('Commande introuvable', 404);
          await env.DB.prepare(`UPDATE orders SET fee_state='paid', fee_dispute=NULL WHERE id=?1`).bind(o.id).run();
          await notify(env, o.customer_id, 'Frais de livraison reçus', `${user.name} a bien reçu les frais de livraison de la commande ${o.ref}. Merci !`, `/commandes.html?ref=${o.ref}`);
          return json({ ok: true });
        }
        if (method === 'POST' && (m = p.match(/^\/api\/courier\/orders\/(CMD-[A-F0-9]{6})\/(remind|fee-report)$/))) {
          const o = await env.DB.prepare('SELECT id,ref,customer_id,pay_direct,fee_state,delivery_fee FROM orders WHERE ref=?1 AND courier_id=?2').bind(m[1], user.id).first();
          if (!o || !o.pay_direct) return bad('Commande introuvable', 404);
          if (o.fee_state === 'paid') return bad('Les frais sont déjà confirmés');
          if (m[2] === 'remind') { await notify(env, o.customer_id, 'Frais de livraison à payer', `${user.name}, votre livreur, attend les frais de livraison (${o.delivery_fee} FCFA) de la commande ${o.ref}. Ouvrez la commande pour voir où payer.`, `/commandes.html?ref=${o.ref}`); return json({ ok: true }); }
          await env.DB.prepare(`UPDATE orders SET fee_dispute='Frais non reçus par le livreur' WHERE id=?1`).bind(o.id).run();
          const { results: admins } = await env.DB.prepare(`SELECT id FROM users WHERE role='admin'`).all();
          for (const ad of admins) await notify(env, ad.id, 'Litige sur les frais de livraison', `${user.name} (livreur) n'a pas reçu les frais de la commande ${o.ref} (${o.delivery_fee} FCFA).`, '/admin.html');
          await notify(env, o.customer_id, 'Frais de livraison non reçus', `Le livreur ne retrouve pas votre paiement des frais (commande ${o.ref}). L'équipe du marché vous contactera : gardez votre SMS de confirmation.`, `/commandes.html?ref=${o.ref}`);
          return json({ ok: true });
        }
        if (method === 'GET' && p === '/api/courier/jobs') {
          const settings = await loadSettings(env);
          const { results } = await env.DB.prepare(
            `SELECT o.ref,o.total,o.delivery_fee,o.address,o.distance_km,o.lat AS dlat,o.lng AS dlng,s.name AS shop_name,s.address AS shop_address,s.lat AS slat,s.lng AS slng,o.status,o.created_at,
               (SELECT COALESCE(SUM(qty),0) FROM order_items WHERE order_id=o.id) AS items
             FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.status IN ('paid','preparing','ready') AND o.courier_id IS NULL ORDER BY o.created_at`).all();
          // Destination avant acceptation : le centre d'une case d'environ 650 m, jamais le point exact du client
          const G = 0.006, snap = v => Math.round(Math.round(v / G) * G * 1e4) / 1e4;
          const jobs = results.map(j => {
            const d = validCoord(me.lat, me.lng) && validCoord(j.slat, j.slng) ? Math.round(distanceKm(me.lat, me.lng, j.slat, j.slng) * 10) / 10 : null;
            // Avant acceptation, le livreur ne voit que la zone (le quartier), jamais l'adresse précise du client
            return { ref: j.ref, shop: j.shop_name, shopAddress: j.shop_address, zone: zoneOf(j.address), fee: j.delivery_fee, tripKm: j.distance_km, toShopKm: d,
              status: j.status, statusLabel: { paid: 'Commande reçue', preparing: 'En préparation', ready: 'Prête à récupérer' }[j.status], items: j.items, slat: j.slat, slng: j.slng,
              dest: validCoord(j.dlat, j.dlng) ? { lat: snap(j.dlat), lng: snap(j.dlng), r: 700 } : null,
              far: d !== null && d > settings.courier_radius_km };
          }).sort((a, b) => (b.status === 'ready') - (a.status === 'ready') || (a.toShopKm ?? 1e9) - (b.toShopKm ?? 1e9));
          return json({ jobs, available: !!me.available, hasPosition: validCoord(me.lat, me.lng), sub: courierSub });
        }
        if (method === 'POST' && (m = p.match(/^\/api\/courier\/jobs\/(CMD-[A-F0-9]{6})\/accept$/))) {
          if (isBlocked(courierSub)) return bad(SUB_OFF, 402);
          if (!me.available) return bad('Activez d\'abord votre disponibilité');
          const r = await env.DB.prepare(`UPDATE orders SET courier_id=?2, updated_at=?3 WHERE ref=?1 AND status IN ('paid','preparing','ready') AND courier_id IS NULL`).bind(m[1], user.id, now()).run();
          if (!r.meta.changes) return bad('Cette course vient d\'être prise par un autre livreur', 409);
          const o = await env.DB.prepare('SELECT o.customer_id,o.ref,s.owner_id FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.ref=?1').bind(m[1]).first();
          const dir = await env.DB.prepare('SELECT pay_direct,delivery_fee FROM orders WHERE ref=?1').bind(o.ref).first();
          if (dir && dir.pay_direct && me.pay_number) await env.DB.prepare('UPDATE orders SET fee_account=?2 WHERE ref=?1').bind(o.ref, snap({ method: me.pay_method, number: me.pay_number, name: me.pay_name, code: me.pay_code, bank: me.pay_bank })).run();
          await notify(env, o.customer_id, 'Un livreur arrive à la boutique', `${user.name} va récupérer votre commande ${o.ref}.${dir && dir.pay_direct ? ` Vous pouvez payer les frais de livraison (${dir.delivery_fee} FCFA) : ouvrez la commande pour voir son numéro.` : ''}`, `/commandes.html?ref=${o.ref}`);
          await notify(env, o.owner_id, 'Livreur en route', `${user.name} vient chercher la commande ${o.ref}.`, '/vendeur.html');
          return json({ ok: true });
        }
        if (method === 'GET' && p === '/api/courier/orders') {
          const { results } = await env.DB.prepare(
            `SELECT o.ref,o.status,o.address,o.delivery_fee,o.pay_direct,o.fee_state,o.fee_ref,o.fee_dispute,o.lat,o.lng,s.name AS shop_name,s.address AS shop_address,s.lat AS slat,s.lng AS slng,s.phone AS shop_phone
             FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.courier_id=?1 ORDER BY o.updated_at DESC LIMIT 30`).bind(user.id).all();
          return json(results.map(o => ({ ...o, statusLabel: ORDER_STATUS[o.status] })));
        }
        if (method === 'POST' && (m = p.match(/^\/api\/courier\/orders\/(CMD-[A-F0-9]{6})\/(pickup|deliver)$/))) {
          const o = await env.DB.prepare('SELECT * FROM orders WHERE ref=?1 AND courier_id=?2').bind(m[1], user.id).first();
          if (!o) return bad('Commande introuvable', 404);
          const want = m[2] === 'pickup' ? ['ready', 'delivering'] : ['delivering', 'delivered'];
          if (o.status !== want[0]) return bad('Changement de statut impossible');
          if (o.pay_direct) { // les frais se paient au livreur : il ne part pas sans paiement déclaré, et ne livre qu'une fois les frais reçus
            if (m[2] === 'pickup' && !['submitted', 'paid'].includes(o.fee_state)) return bad('Le client n\'a pas encore payé les frais de livraison : relancez-le avant de partir.', 409);
            if (m[2] === 'deliver' && o.fee_state !== 'paid') return bad('Confirmez d\'abord avoir bien reçu les frais de livraison (ou signalez qu\'ils ne sont pas arrivés).', 409);
          }
          const upd = await env.DB.prepare('UPDATE orders SET status=?2, updated_at=?3 WHERE id=?1 AND status=?4').bind(o.id, want[1], now(), want[0]).run();
          if (!upd.meta.changes) return bad('Changement de statut impossible');
          await notify(env, o.customer_id, 'Votre commande ' + o.ref, ORDER_STATUS[want[1]], `/commandes.html?ref=${o.ref}`);
          if (want[1] === 'delivered') await awardLoyalty(env, o);
          return json({ ok: true });
        }
      }

      // ===== Administration =====
      if (p.startsWith('/api/admin/')) {
        if (user.role !== 'admin') return bad('Accès réservé à l\'administrateur', 403);
        const subAdm = await subAdminRoutes(env, request, user, p, method, { readJson, cleanText, logAction });
        if (subAdm) return subAdm;

        if (method === 'GET' && p === '/api/admin/overview') {
          const c = async q => (await env.DB.prepare(q).first()).n;
          return json({
            users: await c(`SELECT COUNT(*) AS n FROM users WHERE role!='admin'`), shopsActive: await c(`SELECT COUNT(*) AS n FROM shops WHERE status='active'`),
            shopsPending: await c(`SELECT COUNT(*) AS n FROM shops WHERE status='pending'`), orders: await c(`SELECT COUNT(*) AS n FROM orders`),
            paymentsToCheck: await c(`SELECT COUNT(*) AS n FROM checkouts WHERE status='submitted'`),
            revenue: await c(`SELECT COALESCE(SUM(total),0) AS n FROM orders WHERE status IN ('paid','preparing','ready','delivering','delivered')`)
          });
        }
        // ----- Croissance : les chiffres de la stratégie, semaine par semaine -----
        if (method === 'GET' && p === '/api/admin/growth') {
          const one = async (q, ...a) => (await env.DB.prepare(q).bind(...a).first()) || {};
          const all = async (q, ...a) => (await env.DB.prepare(q).bind(...a).all()).results;
          // 8 périodes de 7 jours glissants (0 = les 7 derniers jours). Une commande livrée compte à sa date de livraison (dernière mise à jour).
          const weeks = await all(`SELECT CAST((julianday('now') - julianday(updated_at)) / 7 AS INTEGER) AS w, COUNT(*) AS n, COALESCE(SUM(total),0) AS gmv
            FROM orders WHERE status='delivered' AND julianday('now') - julianday(updated_at) < 56 GROUP BY w`);
          const newCust = await all(`SELECT CAST((julianday('now') - julianday(created_at)) / 7 AS INTEGER) AS w, COUNT(*) AS n
            FROM users WHERE role='customer' AND julianday('now') - julianday(created_at) < 56 GROUP BY w`);
          const series = Array.from({ length: 8 }, (_, w) => ({ w, delivered: 0, gmv: 0, customers: 0 }));
          for (const r of weeks) if (series[r.w]) { series[r.w].delivered = r.n; series[r.w].gmv = r.gmv; }
          for (const r of newCust) if (series[r.w]) series[r.w].customers = r.n;
          const shops = await one(`SELECT COUNT(*) AS active,
              SUM(CASE WHEN (SELECT COUNT(*) FROM products p WHERE p.shop_id=s.id AND p.active=1) >= 10 THEN 1 ELSE 0 END) AS stocked,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM orders o WHERE o.shop_id=s.id AND o.status='delivered' AND julianday('now') - julianday(o.updated_at) < 30) THEN 1 ELSE 0 END) AS selling
            FROM shops s WHERE s.status='active'`);
          // Fidélité des clients : parmi ceux qui ont eu une 1re livraison entre 60 et 30 jours avant aujourd'hui (fenêtre de 30 jours terminée),
          // combien ont été livrés une 2e fois dans les 30 jours qui ont suivi. Les clients plus récents sont « en attente », pas comptés.
          const rep = await one(`WITH f AS (SELECT customer_id, MIN(updated_at) AS first FROM orders WHERE status='delivered' GROUP BY customer_id)
            SELECT COUNT(*) AS cohort,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM orders o WHERE o.customer_id=f.customer_id AND o.status='delivered' AND o.updated_at > f.first
                AND julianday(o.updated_at) - julianday(f.first) <= 30) THEN 1 ELSE 0 END) AS repeat
            FROM f WHERE julianday('now') - julianday(f.first) BETWEEN 30 AND 60`);
          const pending = await one(`SELECT COUNT(*) AS n FROM (SELECT customer_id, MIN(updated_at) AS first FROM orders WHERE status='delivered' GROUP BY customer_id) WHERE julianday('now') - julianday(first) < 30`);
          const speed = await one(`SELECT AVG((julianday(updated_at) - julianday(created_at)) * 24) AS h, COUNT(*) AS n FROM orders WHERE status='delivered' AND julianday('now') - julianday(updated_at) < 30`);
          const trouble = await one(`SELECT SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
              SUM(CASE WHEN pay_dispute IS NOT NULL OR fee_dispute IS NOT NULL THEN 1 ELSE 0 END) AS disputes, COUNT(*) AS n
            FROM orders WHERE julianday('now') - julianday(created_at) < 30`);
          return json({ series, shops: { active: shops.active || 0, stocked: shops.stocked || 0, selling: shops.selling || 0 },
            repeat: { cohort: rep.cohort || 0, repeat: rep.repeat || 0, pending: pending.n || 0 },
            speed: { hours: speed.h == null ? null : Math.round(speed.h * 10) / 10, n: speed.n || 0 },
            trouble: { cancelled: trouble.cancelled || 0, disputes: trouble.disputes || 0, orders: trouble.n || 0 }, goal: 50 });
        }
        // ----- Sauvegardes de la base (R2) -----
        if (method === 'GET' && p === '/api/admin/backups') return json(await backupStatus(env));
        if (method === 'POST' && p === '/api/admin/backups/run') {
          if (!env.BACKUPS) return bad('Le stockage des sauvegardes n\'est pas encore actif sur ce site', 503);
          const r = await backupStep(env, { force: true });
          await logAction(env, user, 'Sauvegarde lancée à la main', 'backup', r.id || '', r.id || '', '');
          return json(r);
        }
        if (method === 'POST' && (m = p.match(/^\/api\/admin\/backups\/([0-9Th-]{10,16})\/download$/))) {
          if (!env.BACKUPS) return bad('Le stockage des sauvegardes n\'est pas encore actif sur ce site', 503);
          const b = await readJson(request) || {};
          const err = await confirmAdmin(env, user, b.password); if (err) return bad(err, 403);
          const stream = await backupStream(env, m[1]);
          if (!stream) return bad('Sauvegarde introuvable', 404);
          await logAction(env, user, 'Sauvegarde téléchargée', 'backup', m[1], m[1], '');
          return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'content-disposition': `attachment; filename="sauvegarde-${m[1]}.jsonl"`, 'cache-control': 'no-store' } });
        }
        // ----- Ce que l'administrateur doit valider : changements de compte de paiement et litiges -----
        if (method === 'GET' && p === '/api/admin/review') {
          const { results: acc } = await env.DB.prepare(`SELECT c.id,c.owner_type,c.owner_id,c.old_data,c.new_data,c.status,c.note,c.created_at,c.decided_at,
              CASE c.owner_type WHEN 'shop' THEN (SELECT name FROM shops WHERE id=c.owner_id) ELSE (SELECT name FROM users WHERE id=c.owner_id) END AS owner_name
            FROM account_changes c ORDER BY (c.status='pending') DESC, c.created_at DESC LIMIT 60`).all();
          const parse = j => { try { return j ? JSON.parse(j) : null; } catch { return null; } };
          const { results: disputes } = await env.DB.prepare(
            `SELECT o.ref,o.status,o.subtotal,o.discount,o.delivery_fee,o.pay_ref,o.pay_dispute,o.fee_ref,o.fee_dispute,o.fee_state,s.name AS shop,cu.name AS customer,cu.phone AS customer_phone,co.name AS courier
             FROM orders o JOIN shops s ON s.id=o.shop_id JOIN users cu ON cu.id=o.customer_id LEFT JOIN users co ON co.id=o.courier_id
             WHERE (o.pay_dispute IS NOT NULL AND o.status='awaiting_payment') OR (o.fee_dispute IS NOT NULL AND o.fee_state IS NOT 'paid') ORDER BY o.updated_at DESC LIMIT 60`).all();
          return json({ accounts: acc.map(a => ({ ...a, old_data: parse(a.old_data), new_data: parse(a.new_data) })), disputes });
        }
        if (method === 'POST' && (m = p.match(/^\/api\/admin\/account-changes\/([a-f0-9]{16})\/decide$/))) {
          const b = await readJson(request) || {};
          const c = await env.DB.prepare(`SELECT * FROM account_changes WHERE id=?1 AND status='pending'`).bind(m[1]).first();
          if (!c) return bad('Demande introuvable ou déjà traitée', 404);
          const next = JSON.parse(c.new_data), note = cleanText(b.note, 300);
          const ownerUser = c.owner_type === 'shop' ? (await env.DB.prepare('SELECT owner_id AS u, name FROM shops WHERE id=?1').bind(c.owner_id).first()) : (await env.DB.prepare('SELECT id AS u, name FROM users WHERE id=?1').bind(c.owner_id).first());
          if (b.status === 'approved') {
            const err = await confirmAdmin(env, user, b.password); if (err) return bad(err, 403);
            if (c.owner_type === 'shop') await env.DB.prepare('UPDATE shops SET payout_method=?2,payout_number=?3,payout_name=?4,payout_code=?5,payout_bank=?6 WHERE id=?1').bind(c.owner_id, next.method, next.number, next.name, next.code, next.bank).run();
            else await env.DB.prepare('UPDATE couriers SET pay_method=?2,pay_number=?3,pay_name=?4,pay_code=?5,pay_bank=?6 WHERE user_id=?1').bind(c.owner_id, next.method, next.number, next.name, next.code, next.bank).run();
          } else if (b.status === 'rejected') { if (note.length < 3) return bad('Indiquez pourquoi la modification est refusée'); }
          else return bad('Décision invalide');
          await env.DB.prepare(`UPDATE account_changes SET status=?2, note=?3, decided_at=?4, decided_by=?5 WHERE id=?1`).bind(c.id, b.status, note || null, now(), user.id).run();
          await logAction(env, user, b.status === 'approved' ? 'Compte de paiement modifié' : 'Modification de compte refusée', c.owner_type, c.owner_id, ownerUser && ownerUser.name, next.number ? `${METHOD_LABEL[next.method]} ${next.number}` : 'suppression du compte');
          await notify(env, ownerUser.u, b.status === 'approved' ? 'Modification de compte acceptée' : 'Modification de compte refusée', b.status === 'approved' ? 'Votre nouveau compte de paiement est maintenant actif.' : `Votre demande n'a pas été acceptée : ${note}. Votre ancien compte reste actif.`, c.owner_type === 'shop' ? '/vendeur.html#boutique' : '/livreur.html');
          return json({ ok: true });
        }
        if (method === 'POST' && (m = p.match(/^\/api\/admin\/disputes\/(CMD-[A-F0-9]{6})\/decide$/))) {
          const b = await readJson(request) || {};
          const o = await env.DB.prepare('SELECT o.*, s.name AS shop_name, s.owner_id AS shop_owner FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.ref=?1').bind(m[1]).first();
          if (!o) return bad('Commande introuvable', 404);
          const cancelOrder = async () => {
            const u = await env.DB.prepare(`UPDATE orders SET status='cancelled', pay_dispute=NULL, updated_at=?2 WHERE id=?1 AND status='awaiting_payment'`).bind(o.id, now()).run();
            if (!u.meta.changes) return false;
            await restock(env, o.id);
            await releaseVoucher(env, o.id);
            return true;
          };
          if (b.kind === 'pay' && o.pay_dispute && o.status === 'awaiting_payment') {
            if (b.action === 'valid') {
              const u = await env.DB.prepare(`UPDATE orders SET status='paid', pay_dispute=NULL, updated_at=?2 WHERE id=?1 AND status='awaiting_payment'`).bind(o.id, now()).run();
              if (!u.meta.changes) return bad('Cette commande vient de changer d\'état. Rechargez la page.', 409);
              await env.DB.prepare(`UPDATE checkouts SET status='confirmed', confirmed_at=?2 WHERE id=?1 AND status!='confirmed' AND NOT EXISTS (SELECT 1 FROM orders WHERE checkout_id=?1 AND status='awaiting_payment')`).bind(o.checkout_id, now()).run();
              await notify(env, o.customer_id, 'Paiement validé', `L'équipe du marché a validé votre paiement (commande ${o.ref}). Elle est en préparation.`, `/recu.html?ref=${o.ref}`);
              await notify(env, o.shop_owner, 'Litige tranché : paiement valide', `L'équipe du marché a validé le paiement de la commande ${o.ref}. Vous pouvez la préparer.`, '/vendeur.html');
            } else if (b.action === 'cancel') {
              if (!await cancelOrder()) return bad('Cette commande vient de changer d\'état. Rechargez la page.', 409);
              await notify(env, o.customer_id, 'Commande annulée', `Après vérification, le paiement de la commande ${o.ref} n'a pas été retrouvé. Elle est annulée.`, `/commandes.html?ref=${o.ref}`);
              await notify(env, o.shop_owner, 'Litige tranché : commande annulée', `La commande ${o.ref} est annulée par l'équipe du marché.`, '/vendeur.html');
            } else return bad('Décision invalide');
            await logAction(env, user, b.action === 'valid' ? 'Litige de paiement : paiement validé' : 'Litige de paiement : commande annulée', 'order', o.id, o.ref, o.pay_dispute);
            return json({ ok: true });
          }
          if (b.kind === 'fee' && o.fee_dispute && o.courier_id) {
            if (b.action === 'received') {
              await env.DB.prepare(`UPDATE orders SET fee_state='paid', fee_dispute=NULL WHERE id=?1`).bind(o.id).run();
              await notify(env, o.courier_id, 'Frais de livraison validés', `L'équipe du marché a validé les frais de la commande ${o.ref}. Vous pouvez livrer.`, '/livreur.html');
            } else if (b.action === 'free' && o.status === 'ready') {
              const oldCourier = o.courier_id;
              await env.DB.prepare(`UPDATE orders SET courier_id=NULL, fee_state=NULL, fee_ref=NULL, fee_account=NULL, fee_dispute=NULL, updated_at=?2 WHERE id=?1`).bind(o.id, now()).run();
              await notify(env, oldCourier, 'Course retirée', `La course ${o.ref} vous a été retirée par l'équipe du marché.`, '/livreur.html');
              await notify(env, o.customer_id, 'Un autre livreur va être trouvé', `Votre commande ${o.ref} est remise en attente d'un livreur.`, `/commandes.html?ref=${o.ref}`);
              const shop = await env.DB.prepare('SELECT * FROM shops WHERE id=?1').bind(o.shop_id).first();
              await pushCouriers(env, shop, o, await loadSettings(env));
            } else return bad('Décision impossible dans cet état');
            await logAction(env, user, b.action === 'received' ? 'Litige de livraison : frais validés' : 'Litige de livraison : livreur remplacé', 'order', o.id, o.ref, o.fee_dispute);
            return json({ ok: true });
          }
          return bad('Aucun litige ouvert sur cette commande', 404);
        }
        if (method === 'GET' && p === '/api/admin/documents') {
          const { results } = await env.DB.prepare(
            `SELECT d.id,d.kind,d.status,d.note,d.size,d.mime,d.created_at,d.reviewed_at,u.id AS user_id,u.name,u.role,u.phone,u.email,(SELECT s.name FROM shops s WHERE s.owner_id=u.id LIMIT 1) AS shop
             FROM documents d JOIN users u ON u.id=d.user_id ORDER BY (d.status='pending') DESC, d.created_at DESC`).all();
          return json(results.map(d => ({ ...d, label: (DOC_KINDS[d.kind] || {}).label || d.kind })));
        }
        if (method === 'POST' && (m = p.match(/^\/api\/admin\/documents\/([a-f0-9]{16})\/review$/))) {
          const b = await readJson(request);
          if (!b || !['verified', 'rejected', 'pending'].includes(b.status)) return bad('Statut invalide');
          const note = cleanText(b.note, 300);
          if (b.status === 'rejected' && note.length < 3) return bad('Indiquez pourquoi la pièce est refusée (elle sera transmise à la personne)');
          const d = await env.DB.prepare('SELECT d.user_id,d.kind,u.name FROM documents d JOIN users u ON u.id=d.user_id WHERE d.id=?1').bind(m[1]).first();
          if (!d) return bad('Document introuvable', 404);
          await env.DB.prepare('UPDATE documents SET status=?2,note=?3,reviewed_at=?4,reviewed_by=?5 WHERE id=?1').bind(m[1], b.status, note || null, now(), user.id).run();
          await logAction(env, user, b.status === 'verified' ? 'Pièce validée' : b.status === 'rejected' ? 'Pièce refusée' : 'Pièce remise en attente', 'document', m[1], d.name, `${DOC_KINDS[d.kind].label}${note ? ' : ' + note : ''}`);
          if (b.status !== 'pending') await notify(env, d.user_id, b.status === 'verified' ? 'Pièce validée' : 'Pièce refusée',
            b.status === 'verified' ? `Votre pièce « ${DOC_KINDS[d.kind].label} » a été vérifiée. Merci !` : `Votre pièce « ${DOC_KINDS[d.kind].label} » n'a pas pu être validée : ${note}. Vous pouvez en envoyer une nouvelle.`, DOC_KINDS[d.kind].roles[0] === 'courier' ? '/livreur.html' : '/vendeur.html');
          return json({ ok: true });
        }
        if (method === 'GET' && p === '/api/admin/shops') {
          const { results } = await env.DB.prepare(`SELECT s.id,s.name,s.category,s.address,s.status,s.created_at,u.name AS owner,u.phone,s.payout_method,s.payout_number,s.payout_name,s.payout_code,(SELECT status FROM documents d WHERE d.user_id=s.owner_id AND d.kind='autorisation') AS doc_status FROM shops s JOIN users u ON u.id=s.owner_id ORDER BY s.created_at DESC`).all();
          return json(results);
        }
        if (method === 'POST' && (m = p.match(/^\/api\/admin\/shops\/([a-f0-9]{16})\/status$/))) {
          const b = await readJson(request);
          if (!b || !['active', 'suspended', 'pending'].includes(b.status)) return bad('Statut invalide');
          const s = await env.DB.prepare('SELECT owner_id,name,status FROM shops WHERE id=?1').bind(m[1]).first();
          if (!s) return bad('Boutique introuvable', 404);
          const reason = cleanText(b.reason, 300);
          if (b.status === 'suspended') {
            if (reason.length < 5) return bad('Indiquez le motif de la suspension (5 caractères minimum)');
            const err = await confirmAdmin(env, user, b.password);
            if (err) return bad(err, 403);
          }
          await env.DB.prepare('UPDATE shops SET status=?2 WHERE id=?1').bind(m[1], b.status).run();
          await logAction(env, user, b.status === 'suspended' ? 'Boutique suspendue' : b.status === 'active' ? (s.status === 'pending' ? 'Boutique validée' : 'Boutique réactivée') : 'Boutique remise en attente', 'shop', m[1], s.name, reason);
          if (b.status === 'active') await notify(env, s.owner_id, 'Boutique validée', `${s.name} est maintenant visible par les clients.`, '/vendeur.html');
          if (b.status === 'suspended') await notify(env, s.owner_id, 'Boutique suspendue', `${s.name} n'est plus visible par les clients. Motif : ${reason}`, '/vendeur.html');
          return json({ ok: true });
        }
        if (method === 'GET' && p === '/api/admin/accounting') {
          const per = period(url);
          const { results } = await env.DB.prepare(`SELECT s.id,s.name,s.status,
              COALESCE((SELECT COUNT(*) FROM orders o WHERE o.shop_id=s.id AND o.status IN ${SOLD} AND o.created_at BETWEEN ?1 AND ?2),0) AS orders,
              COALESCE((SELECT SUM(subtotal) FROM orders o WHERE o.shop_id=s.id AND o.status IN ${SOLD} AND o.created_at BETWEEN ?1 AND ?2),0) AS gross,
              COALESCE((SELECT SUM(discount) FROM orders o WHERE o.shop_id=s.id AND o.status IN ${SOLD} AND o.created_at BETWEEN ?1 AND ?2),0) AS discounts,
              COALESCE((SELECT SUM(commission) FROM orders o WHERE o.shop_id=s.id AND o.status IN ${SOLD} AND o.created_at BETWEEN ?1 AND ?2),0) AS commission,
              COALESCE((SELECT SUM(delivery_fee) FROM orders o WHERE o.shop_id=s.id AND o.status IN ${SOLD} AND o.created_at BETWEEN ?1 AND ?2),0) AS delivery,
              COALESCE((SELECT SUM(subtotal-discount-commission) FROM orders o WHERE o.shop_id=s.id AND o.status='delivered' AND o.pay_direct=0),0) AS earned,
              COALESCE((SELECT SUM(commission) FROM orders o WHERE o.shop_id=s.id AND o.pay_direct=1 AND o.status IN ${SOLD}),0) AS commission_owed,
              COALESCE((SELECT SUM(amount) FROM payouts p WHERE p.shop_id=s.id),0) AS paid,
              s.payout_method,s.payout_number,s.payout_name,s.payout_code
            FROM shops s ORDER BY gross DESC, s.name`).bind(per.fromIso, per.toIso).all();
          const rows = results.map(r => ({ ...r, net: r.gross - r.discounts - r.commission, due: r.earned - r.paid }));
          const tot = k => rows.reduce((t, r) => t + r[k], 0);
          const refunds = await env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS v FROM orders o JOIN checkouts c ON c.id=o.checkout_id WHERE o.status='cancelled' AND c.status='confirmed' AND o.created_at BETWEEN ?1 AND ?2`).bind(per.fromIso, per.toIso).first();
          return json({ period: { from: per.from, to: per.to }, rows, totals: { orders: tot('orders'), gross: tot('gross'), discounts: tot('discounts'), commission: tot('commission'), delivery: tot('delivery'), net: tot('net'), due: tot('due') },
            refunds, commission_pct: (await loadSettings(env)).commission_pct || 0 });
        }
        if (method === 'POST' && p === '/api/admin/payouts') {
          const b = await readJson(request) || {};
          const s = /^[a-f0-9]{16}$/.test(String(b.shopId || '')) && await env.DB.prepare('SELECT id,name,owner_id FROM shops WHERE id=?1').bind(b.shopId).first();
          if (!s) return bad('Boutique introuvable', 404);
          const amount = Math.round(num(b.amount));
          if (!(amount >= 1 && amount <= 100000000)) return bad('Montant invalide');
          const method2 = ['airtel_money', 'moov_money', 'virement', 'especes'].includes(b.method) ? b.method : 'airtel_money';
          await env.DB.prepare('INSERT INTO payouts (id,shop_id,amount,method,reference,note,created_by,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)')
            .bind(uid(), s.id, amount, method2, cleanText(b.reference, 60), cleanText(b.note, 200), user.id, now()).run();
          await logAction(env, user, 'Versement à une boutique', 'shop', s.id, s.name, `${amount} FCFA`);
          await notify(env, s.owner_id, 'Versement reçu', `${amount} FCFA vous ont été versés par ${{ airtel_money: 'Airtel Money', moov_money: 'Moov Money', virement: 'virement', especes: 'espèces' }[method2]}${b.reference ? ' (réf. ' + cleanText(b.reference, 60) + ')' : ''}.`, '/vendeur.html#compta', 'payment');
          return json({ ok: true }, 201);
        }
        if (method === 'GET' && p === '/api/admin/actions') {
          const { results } = await env.DB.prepare('SELECT admin_name,action,target_type,target_name,reason,created_at FROM admin_actions ORDER BY created_at DESC LIMIT 50').all();
          return json(results);
        }
        if (method === 'GET' && p === '/api/admin/invites') {
          const { results } = await env.DB.prepare('SELECT * FROM invites ORDER BY created_at DESC LIMIT 200').all();
          const { results: used } = await env.DB.prepare(
            `SELECT iu.invite_id,u.name,u.role,iu.created_at FROM invite_uses iu JOIN users u ON u.id=iu.user_id ORDER BY iu.created_at DESC LIMIT 1000`).all();
          return json(results.map(i => ({ id: i.id, code: i.code, role: i.role, kind: i.kind || null, label: i.label, maxUses: i.max_uses, uses: i.uses, expiresAt: i.expires_at,
            autoApprove: !!i.auto_approve, createdAt: i.created_at, state: inviteState(i), people: used.filter(x => x.invite_id === i.id).map(x => x.name) })));
        }
        if (method === 'POST' && p === '/api/admin/invites') {
          const b = await readJson(request);
          if (!b || !ROLES_PUBLIC.includes(b.role)) return bad('Choisissez le type de compte');
          const maxUses = b.maxUses === null || b.maxUses === '' || b.maxUses === undefined ? null : Math.round(num(b.maxUses));
          if (maxUses !== null && !(maxUses >= 1 && maxUses <= 10000)) return bad('Nombre d\'utilisations invalide');
          const days = Math.round(num(b.days));
          const expiresAt = Number.isFinite(days) && days > 0 && days <= 365 ? Date.now() + days * 86400000 : null;
          const id = uid(), code = rand(6);
          const kind = b.role === 'seller' && b.kind === 'services' ? 'services' : null;
          await env.DB.prepare('INSERT INTO invites (id,code,role,label,max_uses,uses,expires_at,auto_approve,revoked,created_by,created_at,kind) VALUES (?1,?2,?3,?4,?5,0,?6,?7,0,?8,?9,?10)')
            .bind(id, code, b.role, cleanText(b.label, 80), maxUses, expiresAt, b.role === 'seller' && b.autoApprove ? 1 : 0, user.id, now(), kind).run();
          await logAction(env, user, 'Lien d\'invitation créé', 'invite', id, cleanText(b.label, 80) || b.role, '');
          return json({ id, code, path: '/compte.html?invite=' + code }, 201);
        }
        if (method === 'POST' && (m = p.match(/^\/api\/admin\/invites\/([a-f0-9]{16})\/revoke$/))) {
          const inv = await env.DB.prepare('SELECT label,role FROM invites WHERE id=?1').bind(m[1]).first();
          if (!inv) return bad('Invitation introuvable', 404);
          await env.DB.prepare('UPDATE invites SET revoked=1 WHERE id=?1').bind(m[1]).run();
          await logAction(env, user, 'Lien d\'invitation révoqué', 'invite', m[1], inv.label || inv.role, '');
          return json({ ok: true });
        }
        if (method === 'GET' && p === '/api/admin/users') {
          // Les comptes sont rangés par rôle : clients, livreurs, boutiques, équipe (administrateurs)
          const role = ['customer', 'courier', 'seller', 'admin'].includes(url.searchParams.get('role')) ? url.searchParams.get('role') : 'customer';
          const { results: cnt } = await env.DB.prepare(`SELECT role, COUNT(*) AS n FROM users GROUP BY role`).all();
          const counts = { customer: 0, courier: 0, seller: 0, admin: 0 }; for (const c of cnt) counts[c.role] = c.n;
          const { results } = await env.DB.prepare(
            `SELECT u.id,u.email,u.name,u.phone,u.role,u.status,u.created_at,u.avatar_id,
               (SELECT COUNT(*) FROM orders o WHERE o.customer_id=u.id AND o.status IN ${SOLD}) AS orders_n,
               (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.customer_id=u.id AND o.status IN ${SOLD}) AS spent,
               (SELECT MAX(o.created_at) FROM orders o WHERE o.customer_id=u.id) AS last_order,
               (SELECT COUNT(*) FROM orders o WHERE o.courier_id=u.id AND o.status='delivered') AS deliveries,
               (SELECT c.available FROM couriers c WHERE c.user_id=u.id) AS available,
               (SELECT c.updated_at FROM couriers c WHERE c.user_id=u.id) AS last_seen,
               (SELECT COUNT(*) FROM documents d WHERE d.user_id=u.id) AS docs_n,
               (SELECT COUNT(*) FROM documents d WHERE d.user_id=u.id AND d.status='verified') AS docs_ok,
               (SELECT s.name FROM shops s WHERE s.owner_id=u.id LIMIT 1) AS shop_name,
               (SELECT s.status FROM shops s WHERE s.owner_id=u.id LIMIT 1) AS shop_status,
               (SELECT COUNT(*) FROM products p JOIN shops s ON s.id=p.shop_id WHERE s.owner_id=u.id AND p.active=1) AS products_n
             FROM users u WHERE u.role=?1 ORDER BY u.created_at DESC LIMIT 500`).bind(role).all();
          return json({ role, counts, users: results });
        }
        if (method === 'POST' && (m = p.match(/^\/api\/admin\/users\/([a-f0-9]{16})\/status$/))) {
          const b = await readJson(request);
          const t = await env.DB.prepare('SELECT role,name FROM users WHERE id=?1').bind(m[1]).first();
          if (!t || t.role === 'admin' || !b || !['active', 'suspended'].includes(b.status)) return bad('Action impossible');
          const reason = cleanText(b.reason, 300);
          if (b.status === 'suspended') {
            if (reason.length < 5) return bad('Indiquez le motif de la suspension (5 caractères minimum)');
            const err = await confirmAdmin(env, user, b.password);
            if (err) return bad(err, 403);
          }
          await env.DB.prepare('UPDATE users SET status=?2 WHERE id=?1').bind(m[1], b.status).run();
          await logAction(env, user, b.status === 'suspended' ? 'Compte suspendu' : 'Compte réactivé', 'user', m[1], t.name, reason);
          if (b.status === 'suspended') await env.DB.prepare('DELETE FROM sessions WHERE user_id=?1').bind(m[1]).run();
          return json({ ok: true });
        }
        if (method === 'POST' && (m = p.match(/^\/api\/admin\/users\/([a-f0-9]{16})\/reset$/))) {
          const t = await env.DB.prepare('SELECT role FROM users WHERE id=?1').bind(m[1]).first();
          if (!t) return bad('Utilisateur introuvable', 404);
          if (t.role === 'admin') return bad('Réinitialisation impossible pour un compte administrateur', 403);
          const token = rand(32);
          await env.DB.batch([
            env.DB.prepare('DELETE FROM reset_tokens WHERE user_id=?1 OR expires_at<?2').bind(m[1], Date.now()),
            env.DB.prepare('INSERT INTO reset_tokens (token_hash,user_id,expires_at) VALUES (?1,?2,?3)').bind(await sha256(token), m[1], Date.now() + 3600000)
          ]);
          return json({ path: '/compte.html?reset=' + token });
        }
        if (method === 'GET' && p === '/api/admin/payments') {
          const { results } = await env.DB.prepare(
            `SELECT c.id,c.ref,c.amount,c.method,c.provider,c.txn_ref,c.status,c.created_at,u.name AS customer FROM checkouts c JOIN users u ON u.id=c.user_id
             ORDER BY CASE c.status WHEN 'submitted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, c.created_at DESC LIMIT 100`).all();
          return json(results);
        }
        if (method === 'POST' && (m = p.match(/^\/api\/admin\/payments\/([a-f0-9]{16})\/(confirm|reject)$/))) {
          const co = await env.DB.prepare('SELECT * FROM checkouts WHERE id=?1').bind(m[1]).first();
          if (!co) return bad('Paiement introuvable', 404);
          if (m[2] === 'confirm') await confirmCheckout(env, co); else await rejectCheckout(env, co);
          return json({ ok: true });
        }
        if (method === 'GET' && p === '/api/admin/orders') {
          const { results } = await env.DB.prepare(
            `SELECT o.ref,o.status,o.total,o.created_at,s.name AS shop,u.name AS customer FROM orders o JOIN shops s ON s.id=o.shop_id JOIN users u ON u.id=o.customer_id
             ORDER BY o.created_at DESC LIMIT 100`).all();
          return json(results.map(o => ({ ...o, statusLabel: ORDER_STATUS[o.status] })));
        }
        if (method === 'GET' && p === '/api/admin/settings') return json(await loadSettings(env));
        if (method === 'PUT' && p === '/api/admin/settings') {
          const b = await readJson(request);
          if (!b) return bad('Requête invalide');
          const cur = await loadSettings(env);
          const nn = (v, d, lo, hi) => Number.isFinite(num(v)) && num(v) >= lo && num(v) <= hi ? Math.round(num(v)) : d;
          await saveSettings(env, {
            site_name: cleanText(b.site_name, 60) || cur.site_name, tagline: cleanText(b.tagline, 140) || cur.tagline,
            airtel_number: cleanText(b.airtel_number, 30), merchant_name: cleanText(b.merchant_name, 60) || cur.merchant_name,
            payment_instructions: cleanText(b.payment_instructions, 400) || cur.payment_instructions,
            payment_mode: b.payment_mode === 'marketplace' ? 'marketplace' : 'direct',
            delivery_base: nn(b.delivery_base, cur.delivery_base, 0, 100000), delivery_per_km: nn(b.delivery_per_km, cur.delivery_per_km, 0, 10000),
            courier_radius_km: nn(b.courier_radius_km, cur.courier_radius_km, 1, 200),
            invite_required: ['none', 'pro', 'all'].includes(b.invite_required) ? b.invite_required : cur.invite_required,
            promo_max_pct: nn(b.promo_max_pct, cur.promo_max_pct ?? 70, 5, 90), promo_max_days: nn(b.promo_max_days, cur.promo_max_days ?? 30, 1, 90),
            loyalty_max_pct: nn(b.loyalty_max_pct, cur.loyalty_max_pct ?? 30, 5, 80),
            commission_pct: nn(b.commission_pct, cur.commission_pct ?? 0, 0, 50),
            sub_enabled: b.sub_enabled === undefined ? !!cur.sub_enabled : !!b.sub_enabled,
            sub_trial_days: nn(b.sub_trial_days, cur.sub_trial_days, 0, 365), sub_grace_days: nn(b.sub_grace_days, cur.sub_grace_days, 0, 60),
            sub_price_essentiel: nn(b.sub_price_essentiel, cur.sub_price_essentiel, 0, 1000000), sub_price_pro: nn(b.sub_price_pro, cur.sub_price_pro, 0, 1000000),
            sub_price_courier: nn(b.sub_price_courier, cur.sub_price_courier, 0, 1000000), sub_product_limit: nn(b.sub_product_limit, cur.sub_product_limit, 1, 10000),
            moov_number: b.moov_number === undefined ? cur.moov_number || '' : cleanText(b.moov_number, 30)
          });
          if (!!cur.sub_enabled !== (b.sub_enabled === undefined ? !!cur.sub_enabled : !!b.sub_enabled)) {
            await logAction(env, user, b.sub_enabled ? 'Abonnements activés' : 'Abonnements désactivés', 'settings', '', '', '');
            await subSweep(env, true); // essais démarrés tout de suite, ou boutiques rétablies si on désactive
          }
          return json({ ok: true });
        }
        // Diagnostic SingPay : ne renvoie jamais les clés, seulement des statuts et des longueurs
        if (method === 'GET' && p === '/api/admin/singpay-check') {
          const out = {
            configured: singpayOn(env),
            lengths: { client_id: sp(env, 'SINGPAY_CLIENT_ID').length, client_secret: sp(env, 'SINGPAY_CLIENT_SECRET').length, wallet: sp(env, 'SINGPAY_WALLET').length, disbursement: sp(env, 'SINGPAY_DISBURSEMENT').length }
          };
          if (out.configured) {
            try {
              const w = await singpayCall(env, 'GET', '/portefeuille/api/' + encodeURIComponent(sp(env, 'SINGPAY_WALLET')));
              out.wallet_lookup = { ok: true, nom: w && w.nom, status: w && w.status, callbackURL: w && w.callbackURL };
            } catch (e) { out.wallet_lookup = { ok: false, error: e.message.slice(0, 200) }; }
          }
          return json(out);
        }
      }

      return bad('Introuvable', 404);
    } catch (e) {
      console.error(e);
      return bad('Erreur du serveur', 500);
    }
}
