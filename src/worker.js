// Marché Gabon : galerie marchande (Cloudflare Workers + D1).
import {
  json, bad, rand, uid, now, sha256, safeEqual, hashPassword, createSession, clearCookie, currentUser, destroySession,
  CATEGORIES, ORDER_STATUS, ensureSchema, loadSettings, saveSettings, toBase64, fromBase64, sniffImage,
  validCoord, distanceKm, slugify, EFFECTIVE_PRICE, promoActive, publicProduct, voucherDiscount, loyaltyProgram
} from './lib.js';
import { notify, confirmCheckout, rejectCheckout, cancelOrders, releaseVoucher, createVoucher, awardLoyalty, startOnlinePayment, singpayVerify, singpayOn, singpayCall, sp } from './pay.js';
import { botReply, searchProducts } from './bot.js';

const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const validEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e) && e.length <= 254;
const readJson = async request => { try { return await request.json(); } catch { return null; } };
const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
const ROLES_PUBLIC = ['customer', 'seller', 'courier'];

// Limite des essais de connexion : 5 échecs par e-mail et 20 par adresse IP sur 15 minutes
const LOGIN_WINDOW = 15 * 60000, MAX_FAIL_EMAIL = 5, MAX_FAIL_IP = 20;
const failCount = async (env, key, since) =>
  ((await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE key=?1 AND at>?2').bind(key, since).first()) || { n: 0 }).n;

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
    if (!CATEGORIES.some(c => c[0] === category)) return bad('Choisissez la catégorie de la boutique');
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
    await env.DB.prepare(`INSERT INTO shops (id,owner_id,name,slug,category,address,phone,status,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`)
      .bind(uid(), id, shopName, slug, category, address, phone, approved ? 'active' : 'pending', now()).run();
    const { results: admins } = await env.DB.prepare(`SELECT id FROM users WHERE role='admin'`).all();
    for (const a of admins) await notify(env, a.id, approved ? 'Nouvelle boutique (invitation)' : 'Nouvelle boutique à valider', `${shopName} (${name})`, '/admin.html');
  }
  if (invite) await env.DB.prepare('INSERT INTO invite_uses (invite_id,user_id,created_at) VALUES (?1,?2,?3)').bind(invite.id, id, now()).run();
  if (role === 'courier') await env.DB.prepare('INSERT INTO couriers (user_id,available) VALUES (?1,0)').bind(id).run();
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
  await env.DB.prepare('DELETE FROM login_attempts WHERE key=?1').bind(kEmail).run();
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

// ---------- Aides communes ----------
async function itemsOf(env, orderId) {
  const { results } = await env.DB.prepare('SELECT name,price,qty FROM order_items WHERE order_id=?1').bind(orderId).all();
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
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname, method = request.method;
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(request);
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
          site_name: s.site_name, tagline: s.tagline, categories: CATEGORIES, delivery_base: s.delivery_base,
          delivery_per_km: s.delivery_per_km, online_payment: singpayOn(env), invite_required: s.invite_required,
          promo_max_pct: s.promo_max_pct, promo_max_days: s.promo_max_days, loyalty_max_pct: s.loyalty_max_pct ?? 30
        });
      }
      if (method === 'GET' && p === '/api/shops') {
        const cat = url.searchParams.get('cat') || '', q = cleanText(url.searchParams.get('q'), 60).toLowerCase();
        const { results } = await env.DB.prepare(
          `SELECT s.id,s.name,s.slug,s.category,s.description,s.address,s.photo_id,
                  (SELECT COUNT(*) FROM products p WHERE p.shop_id=s.id AND p.active=1) AS products,
                  (SELECT COUNT(*) FROM products p WHERE p.shop_id=s.id AND p.active=1 AND p.stock>0 AND ${EFFECTIVE_PRICE} < p.price) AS promos,
                  (SELECT MAX(ROUND(100 - 100.0 * p.promo_price / p.price)) FROM products p WHERE p.shop_id=s.id AND p.active=1 AND p.stock>0 AND ${EFFECTIVE_PRICE} < p.price) AS best_pct,
                  (SELECT p.photo_id FROM products p WHERE p.shop_id=s.id AND p.active=1 AND p.photo_id IS NOT NULL ORDER BY p.created_at DESC LIMIT 1) AS cover_id,
                  s.loyalty_enabled
           FROM shops s WHERE s.status='active' ORDER BY promos > 0 DESC, s.name`).all();
        return json(results.filter(s => (!cat || s.category === cat) && (!q || (s.name + ' ' + (s.description || '')).toLowerCase().includes(q))));
      }
      if (method === 'GET' && p === '/api/promotions') {
        const { results } = await env.DB.prepare(
          `SELECT p.id,p.name,p.description,p.price,p.promo_price,p.promo_until,p.stock,p.photo_id,s.name AS shop_name,s.slug,s.category
           FROM products p JOIN shops s ON s.id=p.shop_id
           WHERE p.active=1 AND p.stock>0 AND s.status='active' AND ${EFFECTIVE_PRICE} < p.price
           ORDER BY (1.0 * p.promo_price / p.price) ASC, p.promo_until ASC LIMIT 24`).all();
        return json(results.map(publicProduct));
      }
      if (method === 'GET' && p === '/api/products') {
        const cat = url.searchParams.get('cat') || '', q = cleanText(url.searchParams.get('q'), 60);
        const limit = Math.min(48, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 24));
        return json(await searchProducts(env, { cat, q, limit }));
      }
      if (method === 'GET' && (m = p.match(/^\/api\/shops\/([a-z0-9-]{1,60})$/))) {
        const s = await env.DB.prepare(`SELECT id,name,slug,category,description,address,photo_id,phone,loyalty_enabled,loyalty_every,loyalty_kind,loyalty_value,loyalty_min,loyalty_days
          FROM shops WHERE slug=?1 AND status='active'`).bind(m[1]).first();
        if (!s) return bad('Boutique introuvable', 404);
        const loyalty = loyaltyProgram(s);
        for (const k of ['loyalty_enabled', 'loyalty_every', 'loyalty_kind', 'loyalty_value', 'loyalty_min', 'loyalty_days']) delete s[k];
        let mine = null;
        const viewer = await currentUser(request, env);
        if (viewer && viewer.role === 'customer') {
          const card = await env.DB.prepare('SELECT stamps,orders FROM loyalty_cards WHERE user_id=?1 AND shop_id=?2').bind(viewer.id, s.id).first();
          const v = await env.DB.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE user_id=?1 AND shop_id=?2 AND used_at IS NULL AND expires_at>?3').bind(viewer.id, s.id, Date.now()).first();
          mine = { stamps: card ? card.stamps : 0, orders: card ? card.orders : 0, vouchers: v.n };
        }
        const { results } = await env.DB.prepare(
          `SELECT id,name,description,price,promo_price,promo_until,stock,photo_id,created_at FROM products WHERE shop_id=?1 AND active=1 ORDER BY created_at DESC`).bind(s.id).all();
        const list = results.map(publicProduct).sort((a, b) => (b.promo_pct ? 1 : 0) - (a.promo_pct ? 1 : 0) || (b.stock > 0) - (a.stock > 0));
        return json({ shop: { ...s, loyalty }, products: list, mine });
      }
      if (method === 'GET' && (m = p.match(/^\/api\/invites\/([a-f0-9]{12})$/))) {
        const inv = await env.DB.prepare('SELECT role,label,max_uses,uses,expires_at,auto_approve,revoked FROM invites WHERE code=?1').bind(m[1]).first();
        const state = inviteState(inv);
        return json(state === 'valide' ? { state, role: inv.role, autoApprove: !!inv.auto_approve, expiresAt: inv.expires_at } : { state });
      }
      if (method === 'GET' && (m = p.match(/^\/api\/photos\/([a-f0-9]{16})$/))) {
        const ph = await env.DB.prepare('SELECT mime,data FROM photos WHERE id=?1').bind(m[1]).first();
        if (!ph) return bad('Photo introuvable', 404);
        return new Response(fromBase64(ph.data), { headers: { 'content-type': ph.mime, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' } });
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

      if (method === 'GET' && p === '/api/notifications') {
        const { results } = await env.DB.prepare('SELECT id,title,body,url,read,created_at FROM notifications WHERE user_id=?1 ORDER BY created_at DESC LIMIT 30').bind(user.id).all();
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
        const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM photos WHERE owner_id=?1').bind(user.id).first()).n;
        if (n >= 400) return bad('Limite de photos atteinte');
        const id = uid();
        await env.DB.prepare('INSERT INTO photos (id,owner_id,mime,data,size,created_at) VALUES (?1,?2,?3,?4,?5,?6)').bind(id, user.id, mime, toBase64(buf), buf.byteLength, now()).run();
        return json({ id }, 201);
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
          `SELECT c.product_id,c.qty,p.name,${EFFECTIVE_PRICE} AS price,p.price AS base_price,p.stock,p.photo_id,p.active,s.id AS shop_id,s.name AS shop_name,s.slug,s.status AS shop_status
           FROM cart_items c JOIN products p ON p.id=c.product_id JOIN shops s ON s.id=p.shop_id WHERE c.user_id=?1`).bind(user.id).all();
        const { results: vouchers } = await env.DB.prepare(
          `SELECT id,code,shop_id,kind,value,min_order,expires_at FROM vouchers WHERE user_id=?1 AND used_at IS NULL AND expires_at>?2 ORDER BY expires_at`).bind(user.id, Date.now()).all();
        return json({ items: results, vouchers: vouchers.filter(v => results.some(i => i.shop_id === v.shop_id)) });
      }
      if (method === 'PUT' && p === '/api/cart') {
        const b = await readJson(request);
        const qty = Math.floor(num(b && b.qty));
        const prod = b && await env.DB.prepare(`SELECT p.id,p.stock FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.id=?1 AND p.active=1 AND s.status='active'`).bind(String(b.productId || '')).first();
        if (!prod) return bad('Produit introuvable', 404);
        if (!Number.isFinite(qty) || qty < 0 || qty > 99) return bad('Quantité invalide');
        if (qty === 0) await env.DB.prepare('DELETE FROM cart_items WHERE user_id=?1 AND product_id=?2').bind(user.id, prod.id).run();
        else {
          if (qty > prod.stock) return bad(`Stock insuffisant (${prod.stock} disponible${prod.stock > 1 ? 's' : ''})`);
          await env.DB.prepare('INSERT INTO cart_items (user_id,product_id,qty) VALUES (?1,?2,?3) ON CONFLICT(user_id,product_id) DO UPDATE SET qty=excluded.qty').bind(user.id, prod.id, qty).run();
        }
        return json({ ok: true });
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
          `SELECT c.product_id,c.qty,p.name,${EFFECTIVE_PRICE} AS price,p.stock,p.active,s.id AS shop_id,s.name AS shop_name,s.status AS shop_status,s.lat AS slat,s.lng AS slng
           FROM cart_items c JOIN products p ON p.id=c.product_id JOIN shops s ON s.id=p.shop_id WHERE c.user_id=?1`).bind(user.id).all();
        if (!lines.length) return bad('Votre panier est vide');
        for (const l of lines) {
          if (!l.active || l.shop_status !== 'active') return bad(`« ${l.name} » n'est plus disponible. Retirez-le du panier.`);
          if (l.qty > l.stock) return bad(`« ${l.name} » : seulement ${l.stock} en stock.`);
        }
        const settings = await loadSettings(env);
        const byShop = new Map();
        for (const l of lines) { if (!byShop.has(l.shop_id)) byShop.set(l.shop_id, []); byShop.get(l.shop_id).push(l); }
        const checkoutId = uid(), ref = 'MG-' + rand(4).toUpperCase();
        const stmts = [], orderRefs = [];
        let amount = 0;
        // Bons d'achat choisis : un par boutique, réservés avant la création des commandes
        const wanted = [...new Set((Array.isArray(b.vouchers) ? b.vouchers : []).map(String).filter(x => /^[a-f0-9]{16}$/.test(x)))].slice(0, 20);
        const useVoucher = new Map(), orderIds = new Map([...byShop.keys()].map(k => [k, uid()]));
        for (const vid of wanted) {
          const v = await env.DB.prepare('SELECT * FROM vouchers WHERE id=?1 AND user_id=?2 AND used_at IS NULL AND expires_at>?3').bind(vid, user.id, Date.now()).first();
          if (!v || !byShop.has(v.shop_id) || useVoucher.has(v.shop_id)) continue;
          const sub = byShop.get(v.shop_id).reduce((t, l) => t + l.price * l.qty, 0);
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
          const subtotal = ls.reduce((t, l) => t + l.price * l.qty, 0);
          const voucher = useVoucher.get(shopId) || null, discount = voucher ? voucherDiscount(voucher, subtotal) : 0;
          let km = null, fee = settings.delivery_base;
          if (hasPos && validCoord(ls[0].slat, ls[0].slng)) {
            km = Math.round(distanceKm(lat, lng, ls[0].slat, ls[0].slng) * 10) / 10;
            fee = Math.round((settings.delivery_base + settings.delivery_per_km * Math.ceil(km)) / 50) * 50;
          }
          const orderId = orderIds.get(shopId), oref = 'CMD-' + rand(3).toUpperCase();
          orderRefs.push(oref); amount += subtotal - discount + fee;
          stmts.push(env.DB.prepare(
            `INSERT INTO orders (id,ref,checkout_id,customer_id,shop_id,status,subtotal,delivery_fee,total,address,lat,lng,phone,note,distance_km,created_at,updated_at,discount,voucher_id)
             VALUES (?1,?2,?3,?4,?5,'awaiting_payment',?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?15,?16,?17)`)
            .bind(orderId, oref, checkoutId, user.id, shopId, subtotal, fee, subtotal - discount + fee, address, hasPos ? lat : null, hasPos ? lng : null, phone, note, km, now(), discount, voucher ? voucher.id : null));
          for (const l of ls) {
            stmts.push(env.DB.prepare('INSERT INTO order_items (id,order_id,product_id,name,price,qty) VALUES (?1,?2,?3,?4,?5,?6)').bind(uid(), orderId, l.product_id, l.name, l.price, l.qty));
            stmts.push(env.DB.prepare('UPDATE products SET stock = stock - ?2 WHERE id=?1 AND stock >= ?2').bind(l.product_id, l.qty));
          }
        }
        const method2 = ['airtel_money', 'moov_money', 'card'].includes(b.method) ? b.method : 'airtel_money';
        stmts.unshift(env.DB.prepare(`INSERT INTO checkouts (id,ref,user_id,amount,method,provider,status,created_at) VALUES (?1,?2,?3,?4,?5,'manual','pending',?6)`)
          .bind(checkoutId, ref, user.id, amount, method2, now()));
        stmts.push(env.DB.prepare('DELETE FROM cart_items WHERE user_id=?1').bind(user.id));
        try { await env.DB.batch(stmts); }
        catch (e) { for (const o of reserved) await releaseVoucher(env, o); throw e; }
        const co = { id: checkoutId, ref, amount };
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
        return json({ order: orderPublic(r.o, r.role), items: await itemsOf(env, r.o.id) });
      }
      if (method === 'POST' && (m = p.match(/^\/api\/orders\/(CMD-[A-F0-9]{6})\/cancel$/))) {
        const r = await loadOrderFor(env, user, m[1]);
        if (!r || r.role !== 'customer') return bad('Commande introuvable', 404);
        if (r.o.status !== 'awaiting_payment') return bad('Seule une commande non payée peut être annulée ici. Écrivez à la boutique.');
        await env.DB.prepare(`UPDATE products SET stock = stock + COALESCE((SELECT qty FROM order_items WHERE order_id=?1 AND product_id=products.id),0)
          WHERE id IN (SELECT product_id FROM order_items WHERE order_id=?1)`).bind(r.o.id).run();
        await env.DB.prepare(`UPDATE orders SET status='cancelled', updated_at=?2 WHERE id=?1`).bind(r.o.id, now()).run();
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

        if (method === 'GET' && p === '/api/seller/shop') return json({ shop, categories: CATEGORIES });
        if (method === 'PUT' && p === '/api/seller/shop') {
          const b = await readJson(request);
          if (!b) return bad('Requête invalide');
          const name = cleanText(b.name, 80);
          if (name.length < 2) return bad('Indiquez le nom de la boutique');
          const cat = CATEGORIES.some(c => c[0] === b.category) ? b.category : shop.category;
          const lat = num(b.lat), lng = num(b.lng), pos = validCoord(lat, lng);
          let photo = shop.photo_id;
          if (b.photo_id !== undefined) {
            photo = null;
            if (b.photo_id && await env.DB.prepare('SELECT 1 FROM photos WHERE id=?1 AND owner_id=?2').bind(String(b.photo_id), user.id).first()) photo = String(b.photo_id);
          }
          await env.DB.prepare('UPDATE shops SET name=?2,category=?3,description=?4,address=?5,phone=?6,whatsapp=?7,lat=?8,lng=?9,photo_id=?10 WHERE id=?1')
            .bind(shop.id, name, cat, cleanText(b.description, 600), cleanText(b.address, 200), cleanText(b.phone, 30), cleanText(b.whatsapp, 30),
              pos ? lat : shop.lat, pos ? lng : shop.lng, photo).run();
          return json({ ok: true });
        }
        if (method === 'GET' && p === '/api/seller/products') {
          const { results } = await env.DB.prepare('SELECT * FROM products WHERE shop_id=?1 ORDER BY created_at DESC').bind(shop.id).all();
          return json(results.map(r => ({ ...r, promo_active: promoActive(r), promo_pct: promoActive(r) ? Math.round(100 - (100 * r.promo_price) / r.price) : null })));
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
          const name = cleanText(b && b.name, 100), price = Math.round(num(b && b.price)), stock = Math.floor(num(b && b.stock));
          if (name.length < 2) return bad('Indiquez le nom du produit');
          if (!Number.isFinite(price) || price < 50 || price > 50000000) return bad('Prix invalide');
          if (!Number.isFinite(stock) || stock < 0 || stock > 100000) return bad('Stock invalide');
          const photo = b.photo_id && await env.DB.prepare('SELECT 1 FROM photos WHERE id=?1 AND owner_id=?2').bind(String(b.photo_id), user.id).first() ? String(b.photo_id) : null;
          const id = uid();
          await env.DB.prepare('INSERT INTO products (id,shop_id,name,description,price,stock,photo_id,active,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,1,?8)')
            .bind(id, shop.id, name, cleanText(b.description, 500), price, stock, photo, now()).run();
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
          const stock = Number.isFinite(num(b && b.stock)) ? Math.floor(num(b.stock)) : prod.stock;
          if (price < 50 || price > 50000000 || stock < 0 || stock > 100000) return bad('Prix ou stock invalide');
          if (promoActive(prod) && price !== prod.price) return bad('Arrêtez la promotion avant de changer le prix normal (le prix barré doit rester honnête)');
          let photo = prod.photo_id;
          if (b && b.photo_id !== undefined) photo = b.photo_id && await env.DB.prepare('SELECT 1 FROM photos WHERE id=?1 AND owner_id=?2').bind(String(b.photo_id), user.id).first() ? String(b.photo_id) : null;
          await env.DB.prepare('UPDATE products SET name=?2,description=?3,price=?4,stock=?5,photo_id=?6,active=?7 WHERE id=?1')
            .bind(prod.id, name, b && b.description !== undefined ? cleanText(b.description, 500) : prod.description, price, stock, photo, b && b.active === 0 ? 0 : 1).run();
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
        if (method === 'GET' && p === '/api/seller/orders') {
          const { results } = await env.DB.prepare(
            `SELECT o.id,o.ref,o.status,o.total,o.subtotal,o.discount,o.delivery_fee,o.address,o.note,o.created_at,u.name AS customer_name
             FROM orders o JOIN users u ON u.id=o.customer_id WHERE o.shop_id=?1 AND o.status!='awaiting_payment' ORDER BY o.created_at DESC LIMIT 60`).bind(shop.id).all();
          for (const o of results) { o.items = await itemsOf(env, o.id); o.statusLabel = ORDER_STATUS[o.status]; delete o.id; }
          return json(results);
        }
        if (method === 'POST' && (m = p.match(/^\/api\/seller\/orders\/(CMD-[A-F0-9]{6})\/status$/))) {
          const b = await readJson(request);
          const o = await env.DB.prepare('SELECT * FROM orders WHERE ref=?1 AND shop_id=?2').bind(m[1], shop.id).first();
          if (!o) return bad('Commande introuvable', 404);
          const next = b && b.status, allowed = { paid: ['preparing', 'cancelled'], preparing: ['ready', 'cancelled'] }[o.status] || [];
          if (!allowed.includes(next)) return bad('Changement de statut impossible');
          await env.DB.prepare('UPDATE orders SET status=?2, updated_at=?3 WHERE id=?1').bind(o.id, next, now()).run();
          if (next === 'cancelled') {
            await env.DB.prepare(`UPDATE products SET stock = stock + COALESCE((SELECT qty FROM order_items WHERE order_id=?1 AND product_id=products.id),0)
              WHERE id IN (SELECT product_id FROM order_items WHERE order_id=?1)`).bind(o.id).run();
            await releaseVoucher(env, o.id);
          }
          await notify(env, o.customer_id, 'Votre commande ' + o.ref, ORDER_STATUS[next], `/commandes.html?ref=${o.ref}`);
          if (next === 'ready') await pushCouriers(env, shop, o, await loadSettings(env));
          return json({ ok: true });
        }
      }

      // ===== Livreur =====
      if (p.startsWith('/api/courier/')) {
        if (user.role !== 'courier') return bad('Réservé aux livreurs', 403);
        await env.DB.prepare('INSERT OR IGNORE INTO couriers (user_id,available) VALUES (?1,0)').bind(user.id).run();
        const me = await env.DB.prepare('SELECT * FROM couriers WHERE user_id=?1').bind(user.id).first();

        if (method === 'GET' && p === '/api/courier/me') return json(me);
        if (method === 'POST' && p === '/api/courier/availability') {
          const b = await readJson(request);
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
        if (method === 'GET' && p === '/api/courier/jobs') {
          const settings = await loadSettings(env);
          const { results } = await env.DB.prepare(
            `SELECT o.ref,o.total,o.delivery_fee,o.address,o.distance_km,s.name AS shop_name,s.address AS shop_address,s.lat AS slat,s.lng AS slng
             FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.status='ready' AND o.courier_id IS NULL ORDER BY o.updated_at`).all();
          const jobs = results.map(j => {
            const d = validCoord(me.lat, me.lng) && validCoord(j.slat, j.slng) ? Math.round(distanceKm(me.lat, me.lng, j.slat, j.slng) * 10) / 10 : null;
            return { ref: j.ref, shop: j.shop_name, shopAddress: j.shop_address, address: j.address, fee: j.delivery_fee, tripKm: j.distance_km, toShopKm: d };
          }).filter(j => j.toShopKm === null || j.toShopKm <= settings.courier_radius_km)
            .sort((a, b) => (a.toShopKm ?? 1e9) - (b.toShopKm ?? 1e9));
          return json({ jobs, available: !!me.available, hasPosition: validCoord(me.lat, me.lng) });
        }
        if (method === 'POST' && (m = p.match(/^\/api\/courier\/jobs\/(CMD-[A-F0-9]{6})\/accept$/))) {
          if (!me.available) return bad('Activez d\'abord votre disponibilité');
          const r = await env.DB.prepare(`UPDATE orders SET courier_id=?2, updated_at=?3 WHERE ref=?1 AND status='ready' AND courier_id IS NULL`).bind(m[1], user.id, now()).run();
          if (!r.meta.changes) return bad('Cette course vient d\'être prise par un autre livreur', 409);
          const o = await env.DB.prepare('SELECT o.customer_id,o.ref,s.owner_id FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.ref=?1').bind(m[1]).first();
          await notify(env, o.customer_id, 'Un livreur arrive à la boutique', `${user.name} va récupérer votre commande ${o.ref}.`, `/commandes.html?ref=${o.ref}`);
          await notify(env, o.owner_id, 'Livreur en route', `${user.name} vient chercher la commande ${o.ref}.`, '/vendeur.html');
          return json({ ok: true });
        }
        if (method === 'GET' && p === '/api/courier/orders') {
          const { results } = await env.DB.prepare(
            `SELECT o.ref,o.status,o.address,o.delivery_fee,o.lat,o.lng,s.name AS shop_name,s.address AS shop_address,s.lat AS slat,s.lng AS slng,s.phone AS shop_phone
             FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.courier_id=?1 ORDER BY o.updated_at DESC LIMIT 30`).bind(user.id).all();
          return json(results.map(o => ({ ...o, statusLabel: ORDER_STATUS[o.status] })));
        }
        if (method === 'POST' && (m = p.match(/^\/api\/courier\/orders\/(CMD-[A-F0-9]{6})\/(pickup|deliver)$/))) {
          const o = await env.DB.prepare('SELECT * FROM orders WHERE ref=?1 AND courier_id=?2').bind(m[1], user.id).first();
          if (!o) return bad('Commande introuvable', 404);
          const want = m[2] === 'pickup' ? ['ready', 'delivering'] : ['delivering', 'delivered'];
          if (o.status !== want[0]) return bad('Changement de statut impossible');
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

        if (method === 'GET' && p === '/api/admin/overview') {
          const c = async q => (await env.DB.prepare(q).first()).n;
          return json({
            users: await c(`SELECT COUNT(*) AS n FROM users WHERE role!='admin'`), shopsActive: await c(`SELECT COUNT(*) AS n FROM shops WHERE status='active'`),
            shopsPending: await c(`SELECT COUNT(*) AS n FROM shops WHERE status='pending'`), orders: await c(`SELECT COUNT(*) AS n FROM orders`),
            paymentsToCheck: await c(`SELECT COUNT(*) AS n FROM checkouts WHERE status='submitted'`),
            revenue: await c(`SELECT COALESCE(SUM(total),0) AS n FROM orders WHERE status IN ('paid','preparing','ready','delivering','delivered')`)
          });
        }
        if (method === 'GET' && p === '/api/admin/shops') {
          const { results } = await env.DB.prepare(`SELECT s.id,s.name,s.category,s.address,s.status,s.created_at,u.name AS owner,u.phone FROM shops s JOIN users u ON u.id=s.owner_id ORDER BY s.created_at DESC`).all();
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
        if (method === 'GET' && p === '/api/admin/actions') {
          const { results } = await env.DB.prepare('SELECT admin_name,action,target_type,target_name,reason,created_at FROM admin_actions ORDER BY created_at DESC LIMIT 50').all();
          return json(results);
        }
        if (method === 'GET' && p === '/api/admin/invites') {
          const { results } = await env.DB.prepare('SELECT * FROM invites ORDER BY created_at DESC LIMIT 200').all();
          const { results: used } = await env.DB.prepare(
            `SELECT iu.invite_id,u.name,u.role,iu.created_at FROM invite_uses iu JOIN users u ON u.id=iu.user_id ORDER BY iu.created_at DESC LIMIT 1000`).all();
          return json(results.map(i => ({ id: i.id, code: i.code, role: i.role, label: i.label, maxUses: i.max_uses, uses: i.uses, expiresAt: i.expires_at,
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
          await env.DB.prepare('INSERT INTO invites (id,code,role,label,max_uses,uses,expires_at,auto_approve,revoked,created_by,created_at) VALUES (?1,?2,?3,?4,?5,0,?6,?7,0,?8,?9)')
            .bind(id, code, b.role, cleanText(b.label, 80), maxUses, expiresAt, b.role === 'seller' && b.autoApprove ? 1 : 0, user.id, now()).run();
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
          const { results } = await env.DB.prepare(`SELECT id,email,name,phone,role,status,created_at,avatar_id FROM users ORDER BY created_at DESC LIMIT 300`).all();
          return json(results);
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
            delivery_base: nn(b.delivery_base, cur.delivery_base, 0, 100000), delivery_per_km: nn(b.delivery_per_km, cur.delivery_per_km, 0, 10000),
            courier_radius_km: nn(b.courier_radius_km, cur.courier_radius_km, 1, 200),
            invite_required: ['none', 'pro', 'all'].includes(b.invite_required) ? b.invite_required : cur.invite_required,
            promo_max_pct: nn(b.promo_max_pct, cur.promo_max_pct ?? 70, 5, 90), promo_max_days: nn(b.promo_max_days, cur.promo_max_days ?? 30, 1, 90),
            loyalty_max_pct: nn(b.loyalty_max_pct, cur.loyalty_max_pct ?? 30, 5, 80)
          });
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
};
