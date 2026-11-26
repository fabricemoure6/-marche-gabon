// Univers « Services » : location de voitures, événementiel, nettoyage, réparations, BTP, architecture…
// Un prestataire est un gestionnaire dont la boutique est rangée dans un rayon de services.
// Étape 1 : prestations (prix fixe, à l'heure, à la journée ou sur devis), demandes des clients, devis du prestataire,
// acceptation par le client, prestation réalisée. Les acomptes en ligne viendront ensuite.
import { json, bad, uid, now, rand, recentCount, recordEvent, photoList, SERVICE_CATEGORIES, isServiceCat, loadSettings } from './lib.js';
import { notify } from './pay.js';

export const PRICE_TYPES = { fixe: 'Prix fixe', heure: 'par heure', jour: 'par jour', devis: 'Sur devis' };
export const REQ_STATUS = {
  new: 'Demande envoyée', quoted: 'Devis reçu', accepted: 'Réservé', refused: 'Refusée par le prestataire',
  declined: 'Devis refusé', cancelled: 'Annulée', done: 'Prestation réalisée'
};
const fcfa = n => new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0)).replace(/[   ]/g, ' ') + ' FCFA';

export function publicService(r) {
  return { id: r.id, name: r.name, description: r.description, price_type: r.price_type, price: r.price_type === 'devis' ? null : r.price,
    photo_id: r.photo_id, photos: photoList(r), created_at: r.created_at };
}
function reqRow(r, forCustomer) {
  const open = ['accepted', 'done'].includes(r.status);
  return { ref: r.ref, status: r.status, status_label: REQ_STATUS[r.status] || r.status, service: r.service_name, service_id: r.service_id,
    wanted_date: r.wanted_date, place: r.place, details: r.details, quote_amount: r.quote_amount, quote_note: r.quote_note,
    created_at: r.created_at, updated_at: r.updated_at,
    ...(forCustomer
      ? { shop: { name: r.shop_name, slug: r.slug, category: r.category, photo_id: r.shop_photo, ...(open ? { phone: r.shop_phone, whatsapp: r.shop_whatsapp } : {}) } }
      : { customer: { name: r.customer_name, phone: r.phone || r.customer_phone } }) };
}
const REQ_SELECT = `SELECT r.*, sv.name AS service_name, s.name AS shop_name, s.slug, s.category, s.photo_id AS shop_photo, s.phone AS shop_phone, s.whatsapp AS shop_whatsapp,
  s.owner_id, u.name AS customer_name, u.phone AS customer_phone
  FROM service_requests r JOIN services sv ON sv.id=r.service_id JOIN shops s ON s.id=r.shop_id JOIN users u ON u.id=r.customer_id`;
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d + 'T12:00:00Z'));

async function cleanServiceBody(env, user, b, cleanText) {
  const name = cleanText(b && b.name, 100);
  if (name.length < 2) return { error: 'Indiquez le nom de la prestation' };
  const price_type = PRICE_TYPES[b.price_type] ? b.price_type : null;
  if (!price_type) return { error: 'Choisissez le type de prix' };
  const price = price_type === 'devis' ? null : Math.round(Number(b.price));
  if (price_type !== 'devis' && !(price >= 100 && price <= 100000000)) return { error: 'Indiquez un prix (100 FCFA minimum)' };
  // Photos : seulement celles envoyées par ce compte
  const ids = (Array.isArray(b.photos) ? b.photos : b.photo_id ? [b.photo_id] : []).map(String).filter(x => /^[a-f0-9]{16}$/.test(x)).slice(0, 6);
  const mine = [];
  for (const id of ids) if (await env.DB.prepare('SELECT 1 FROM photos WHERE id=?1 AND owner_id=?2').bind(id, user.id).first()) mine.push(id);
  return { name, description: cleanText(b.description, 1000), price_type, price, photo_id: mine[0] || null, photos: mine.length ? JSON.stringify(mine) : null };
}

// ---------- Routes publiques : les prestations d'un prestataire (ajoutées à /api/shops/:slug) ----------
export async function servicesOfShop(env, shopId) {
  const { results } = await env.DB.prepare('SELECT * FROM services WHERE shop_id=?1 AND active=1 ORDER BY created_at DESC').bind(shopId).all();
  return results.map(publicService);
}

// ---------- Client : demander, suivre, accepter ou refuser un devis ----------
export async function serviceCustomerRoutes(env, request, user, p, method, { readJson, cleanText }) {
  let m;
  if (method === 'POST' && (m = p.match(/^\/api\/services\/([a-f0-9]{16})\/request$/))) {
    if (user.role !== 'customer') return bad('Connectez-vous avec un compte client pour faire une demande', 403);
    const sv = await env.DB.prepare(`SELECT sv.*, s.name AS shop_name, s.owner_id, s.status AS shop_status FROM services sv JOIN shops s ON s.id=sv.shop_id WHERE sv.id=?1 AND sv.active=1`).bind(m[1]).first();
    if (!sv || sv.shop_status !== 'active') return bad('Cette prestation n\'est plus disponible', 404);
    if (await recentCount(env, 'svcreq:' + user.id, 3600e3) >= 10) return bad('Trop de demandes en peu de temps : réessayez dans une heure', 429);
    const b = await readJson(request) || {};
    const date = String(b.wanted_date || ''), place = cleanText(b.place, 200), details = cleanText(b.details, 1000), phone = cleanText(b.phone, 30);
    if (!validDate(date)) return bad('Choisissez la date souhaitée');
    if (date < new Date(Date.now() - 864e5).toISOString().slice(0, 10)) return bad('La date est déjà passée');
    if (place.length < 3) return bad('Indiquez le lieu de la prestation (quartier, ville)');
    if (details.length < 5) return bad('Décrivez votre besoin en quelques mots');
    if (phone.replace(/\D/g, '').length < 8) return bad('Indiquez un numéro où le prestataire peut vous joindre');
    if (await env.DB.prepare(`SELECT 1 FROM service_requests WHERE customer_id=?1 AND service_id=?2 AND status IN ('new','quoted')`).bind(user.id, sv.id).first())
      return bad('Vous avez déjà une demande en cours pour cette prestation : retrouvez-la dans « Mes achats ».', 409);
    const ref = 'DEV-' + rand(3).toUpperCase();
    await env.DB.prepare(`INSERT INTO service_requests (id,ref,service_id,shop_id,customer_id,wanted_date,place,details,phone,status,created_at,updated_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'new',?10,?10)`).bind(uid(), ref, sv.id, sv.shop_id, user.id, date, place, details, phone, now()).run();
    await recordEvent(env, 'svcreq:' + user.id);
    await notify(env, sv.owner_id, 'Nouvelle demande de devis', `${user.name} : ${sv.name}, le ${date.split('-').reverse().join('/')} à ${place}. Réf. ${ref}`, '/vendeur.html#demandes', 'order');
    return json({ ok: true, ref }, 201);
  }
  if (method === 'GET' && p === '/api/my/requests') {
    const { results } = await env.DB.prepare(REQ_SELECT + ' WHERE r.customer_id=?1 ORDER BY r.updated_at DESC LIMIT 50').bind(user.id).all();
    return json(results.map(r => reqRow(r, true)));
  }
  if (method === 'POST' && (m = p.match(/^\/api\/my\/requests\/(DEV-[A-F0-9]{6})\/(accept|decline|cancel)$/))) {
    const r = await env.DB.prepare(REQ_SELECT + ' WHERE r.ref=?1 AND r.customer_id=?2').bind(m[1], user.id).first();
    if (!r) return bad('Demande introuvable', 404);
    const to = { accept: ['quoted', 'accepted'], decline: ['quoted', 'declined'], cancel: [null, 'cancelled'] }[m[2]];
    const allowed = m[2] === 'cancel' ? ['new', 'quoted', 'accepted'].includes(r.status) : r.status === to[0];
    if (!allowed) return bad(m[2] === 'cancel' ? 'Cette demande ne peut plus être annulée' : 'Il n\'y a pas de devis en attente pour cette demande', 409);
    const u = await env.DB.prepare(`UPDATE service_requests SET status=?2, updated_at=?3 WHERE id=?1 AND status=?4`).bind(r.id, to[1], now(), r.status).run();
    if (!u.meta.changes) return bad('La demande vient de changer : rechargez la page', 409);
    const msg = { accept: ['Devis accepté', `${r.customer_name} a accepté votre devis de ${fcfa(r.quote_amount)} pour « ${r.service_name} » (${r.ref}). Contactez le client pour organiser la prestation.`],
      decline: ['Devis refusé', `${r.customer_name} n'a pas retenu votre devis pour « ${r.service_name} » (${r.ref}).`],
      cancel: ['Demande annulée', `${r.customer_name} a annulé sa demande pour « ${r.service_name} » (${r.ref}).`] }[m[2]];
    await notify(env, r.owner_id, msg[0], msg[1], '/vendeur.html#demandes', 'order');
    return json({ ok: true });
  }
  return null;
}

// ---------- Prestataire : prestations et demandes (appelé dans le bloc /api/seller/, boutique déjà chargée) ----------
export async function serviceSellerRoutes(env, request, user, shop, p, method, { readJson, cleanText }) {
  if (!p.startsWith('/api/seller/services') && !p.startsWith('/api/seller/requests')) return null;
  if (!isServiceCat(shop.category)) return bad('Votre boutique vend des produits : les prestations sont réservées aux rayons de services', 403);
  let m;
  if (method === 'GET' && p === '/api/seller/services') {
    const { results } = await env.DB.prepare(`SELECT sv.*, (SELECT COUNT(*) FROM service_requests r WHERE r.service_id=sv.id AND r.status IN ('new','quoted')) AS open_requests
      FROM services sv WHERE sv.shop_id=?1 AND sv.active=1 ORDER BY sv.created_at DESC`).bind(shop.id).all();
    return json(results.map(r => ({ ...publicService(r), open_requests: r.open_requests })));
  }
  if (method === 'POST' && p === '/api/seller/services') {
    const st = await loadSettings(env);
    if (st.sub_enabled && !shop.pro) {
      const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM services WHERE shop_id=?1 AND active=1').bind(shop.id).first()).n;
      if (n >= st.sub_product_limit) return bad(`Vous avez atteint ${st.sub_product_limit} prestations en ligne, la limite de la formule Essentiel. Passez à la formule Pro (onglet Abonnement) pour en ajouter sans limite.`, 403);
    }
    const v = await cleanServiceBody(env, user, await readJson(request) || {}, cleanText);
    if (v.error) return bad(v.error);
    const id = uid();
    await env.DB.prepare(`INSERT INTO services (id,shop_id,name,description,price_type,price,photo_id,photos,active,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,?9)`)
      .bind(id, shop.id, v.name, v.description, v.price_type, v.price, v.photo_id, v.photos, now()).run();
    return json({ id }, 201);
  }
  if ((method === 'PUT' || method === 'DELETE') && (m = p.match(/^\/api\/seller\/services\/([a-f0-9]{16})$/))) {
    const sv = await env.DB.prepare('SELECT * FROM services WHERE id=?1 AND shop_id=?2 AND active=1').bind(m[1], shop.id).first();
    if (!sv) return bad('Prestation introuvable', 404);
    if (method === 'DELETE') { await env.DB.prepare('UPDATE services SET active=0 WHERE id=?1').bind(sv.id).run(); return json({ ok: true }); }
    const b = await readJson(request) || {};
    const v = await cleanServiceBody(env, user, { ...b, photos: b.photos !== undefined ? b.photos : photoList(sv) }, cleanText);
    if (v.error) return bad(v.error);
    await env.DB.prepare('UPDATE services SET name=?2,description=?3,price_type=?4,price=?5,photo_id=?6,photos=?7 WHERE id=?1')
      .bind(sv.id, v.name, v.description, v.price_type, v.price, v.photo_id, v.photos).run();
    return json({ ok: true });
  }
  if (method === 'GET' && p === '/api/seller/requests') {
    const { results } = await env.DB.prepare(REQ_SELECT + ` WHERE r.shop_id=?1 ORDER BY CASE r.status WHEN 'new' THEN 0 WHEN 'accepted' THEN 1 WHEN 'quoted' THEN 2 ELSE 3 END, r.updated_at DESC LIMIT 100`).bind(shop.id).all();
    return json(results.map(r => reqRow(r, false)));
  }
  if (method === 'POST' && (m = p.match(/^\/api\/seller\/requests\/(DEV-[A-F0-9]{6})\/(quote|refuse|done)$/))) {
    const r = await env.DB.prepare(REQ_SELECT + ' WHERE r.ref=?1 AND r.shop_id=?2').bind(m[1], shop.id).first();
    if (!r) return bad('Demande introuvable', 404);
    const b = await readJson(request) || {};
    const url = '/commandes.html#demandes';
    if (m[2] === 'quote') {
      if (!['new', 'quoted'].includes(r.status)) return bad('Cette demande n\'attend plus de devis', 409);
      const amount = Math.round(Number(b.amount)), note = cleanText(b.note, 600);
      if (!(amount >= 100 && amount <= 100000000)) return bad('Indiquez le montant du devis (100 FCFA minimum)');
      if (note.length < 3) return bad('Précisez ce que comprend le devis (matériel, durée, déplacement…)');
      await env.DB.prepare(`UPDATE service_requests SET status='quoted', quote_amount=?2, quote_note=?3, updated_at=?4 WHERE id=?1`).bind(r.id, amount, note, now()).run();
      await notify(env, r.customer_id, 'Devis reçu', `${r.shop_name} vous propose ${fcfa(amount)} pour « ${r.service_name} » (${r.ref}). Acceptez ou refusez depuis « Mes achats ».`, url, 'order');
      return json({ ok: true });
    }
    if (m[2] === 'refuse') {
      if (!['new', 'quoted'].includes(r.status)) return bad('Cette demande ne peut plus être refusée', 409);
      const note = cleanText(b.note, 300) || 'Le prestataire n\'est pas disponible';
      await env.DB.prepare(`UPDATE service_requests SET status='refused', quote_note=?2, updated_at=?3 WHERE id=?1`).bind(r.id, note, now()).run();
      await notify(env, r.customer_id, 'Demande non retenue', `${r.shop_name} ne peut pas répondre à votre demande « ${r.service_name} » (${r.ref}) : ${note}`, url, 'order');
      return json({ ok: true });
    }
    if (r.status !== 'accepted') return bad('Seule une prestation réservée peut être marquée comme réalisée', 409);
    await env.DB.prepare(`UPDATE service_requests SET status='done', updated_at=?2 WHERE id=?1`).bind(r.id, now()).run();
    await notify(env, r.customer_id, 'Prestation réalisée', `${r.shop_name} indique que « ${r.service_name} » (${r.ref}) a été réalisée. Merci de votre confiance !`, url, 'order');
    return json({ ok: true });
  }
  return bad('Introuvable', 404);
}
export { SERVICE_CATEGORIES };
