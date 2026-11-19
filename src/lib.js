// Utilitaires partagés : réponses JSON, mots de passe, sessions, schéma D1, réglages, distances.

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
  });
export const bad = (msg, status = 400, extra = {}) => json({ error: msg, ...extra }, status);

const enc = new TextEncoder();
const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export const rand = n => toHex(crypto.getRandomValues(new Uint8Array(n)));
export const uid = () => rand(8); // 16 caractères hexadécimaux
export const now = () => new Date().toISOString();

export async function sha256(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function hashPassword(password, salt) {
  salt = salt || rand(16);
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 }, key, 256);
  return { hash: toHex(bits), salt };
}

// ---------- Sessions (cookie HttpOnly, jeton stocké haché) ----------
const SESSION_DAYS = 30;

function getCookie(request, name) {
  const c = request.headers.get('cookie') || '';
  const m = c.split(/;\s*/).find(x => x.startsWith(name + '='));
  if (!m) return null;
  try { return decodeURIComponent(m.slice(name.length + 1)); } catch { return null; } // cookie mal formé : traité comme absent
}

export async function createSession(env, userId, secure) {
  const token = rand(32);
  const exp = Date.now() + SESSION_DAYS * 86400000;
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1,?2,?3)')
    .bind(await sha256(token), userId, exp).run();
  return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
}

export const clearCookie = secure => `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;

export async function currentUser(request, env) {
  const sid = getCookie(request, 'sid');
  if (!sid) return null;
  const u = await env.DB.prepare(
    `SELECT u.id,u.email,u.name,u.phone,u.role,u.status,u.avatar_id FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=?1 AND s.expires_at>?2`).bind(await sha256(sid), Date.now()).first();
  return u && u.status === 'active' ? u : null;
}

export async function destroySession(request, env) {
  const sid = getCookie(request, 'sid');
  if (sid) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?1').bind(await sha256(sid)).run();
}

// ---------- En-têtes de sécurité (toutes les réponses) ----------
// Le site utilise des scripts en ligne : 'unsafe-inline' reste nécessaire, mais seules les sources listées sont autorisées.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://unpkg.com",
  "connect-src 'self' https://nominatim.openstreetmap.org https://router.project-osrm.org",
  "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"
].join('; ');
export function withSecurityHeaders(res) {
  const r = new Response(res.body, res);
  const h = r.headers;
  h.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  h.set('x-content-type-options', 'nosniff');
  h.set('x-frame-options', 'DENY');
  h.set('referrer-policy', 'strict-origin-when-cross-origin');
  h.set('permissions-policy', 'geolocation=(self), camera=(), microphone=(), payment=()');
  if (!h.has('content-security-policy')) h.set('content-security-policy', CSP);
  return r;
}

// ---------- Limites d'usage (inscriptions, photos) ----------
// Compte les événements récents d'une clé dans login_attempts (même table que les essais de connexion)
export async function recentCount(env, key, windowMs) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE key=?1 AND at>?2').bind(key, Date.now() - windowMs).first();
  return r ? r.n : 0;
}
export async function recordEvent(env, key) {
  await env.DB.prepare('INSERT INTO login_attempts (key,at) VALUES (?1,?2)').bind(key, Date.now()).run();
}

// ---------- Données de référence ----------
export const CATEGORIES = [
  ['habits', 'Habits et mode'], ['parfumerie', 'Parfumerie et beauté'], ['alimentation', 'Alimentation'],
  ['quincaillerie', 'Quincaillerie'], ['electronique', 'Électronique'], ['maison', 'Maison et déco'], ['autres', 'Autres']
];

export const ORDER_STATUS = {
  awaiting_payment: 'En attente de paiement', paid: 'Payée, en attente de la boutique', preparing: 'En préparation',
  ready: 'Prête, un livreur est recherché', delivering: 'En cours de livraison', delivered: 'Livrée', cancelled: 'Annulée'
};

// Valeurs de départ : l'administrateur les règle dans son espace (onglet Réglages)
export const DEFAULT_SETTINGS = {
  site_name: 'Marché Gabon',
  tagline: 'Toutes vos boutiques au même endroit, livrées chez vous',
  payment_mode: 'direct',   // 'direct' : le client paie la boutique (et le livreur) ; 'marketplace' : le client paie le marché
  airtel_number: '',
  merchant_name: 'Marché Gabon',
  payment_instructions: 'Envoyez le montant par Airtel Money au numéro indiqué avec la référence en motif, puis saisissez la référence de la transaction reçue par SMS.',
  delivery_base: 1000,      // FCFA : frais de départ par boutique
  delivery_per_km: 200,     // FCFA : par kilomètre entre la boutique et le client
  courier_radius_km: 15,    // les livreurs à moins de cette distance de la boutique sont prévenus
  promo_max_pct: 70,        // remise maximale autorisée (%)
  promo_max_days: 30,       // durée maximale d'une promotion (jours)
  loyalty_max_pct: 30,
  commission_pct: 0,        // commission du marché sur les ventes des boutiques (%)      // valeur maximale d'un bon d'achat en pourcentage
  invite_required: 'none'   // 'none' : inscription libre · 'pro' : invitation obligatoire pour boutiques et livreurs · 'all' : pour tous
};

// ---------- Schéma ----------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, phone TEXT,
     pass_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer', status TEXT NOT NULL DEFAULT 'active', created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS login_attempts (key TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts (key, at)`,
  `CREATE TABLE IF NOT EXISTS reset_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, mime TEXT NOT NULL, data TEXT NOT NULL, size INTEGER, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS shops (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
     category TEXT NOT NULL, description TEXT, address TEXT, lat REAL, lng REAL, phone TEXT, whatsapp TEXT, photo_id TEXT,
     status TEXT NOT NULL DEFAULT 'pending', created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_shops_owner ON shops(owner_id)`,
  `CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
     price INTEGER NOT NULL, stock INTEGER NOT NULL DEFAULT 0, photo_id TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_products_shop ON products(shop_id)`,
  `CREATE TABLE IF NOT EXISTS cart_items (user_id TEXT NOT NULL, product_id TEXT NOT NULL, qty INTEGER NOT NULL, PRIMARY KEY (user_id, product_id))`,
  `CREATE TABLE IF NOT EXISTS checkouts (id TEXT PRIMARY KEY, ref TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL, amount INTEGER NOT NULL,
     method TEXT, provider TEXT DEFAULT 'manual', txn_ref TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT, confirmed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, ref TEXT UNIQUE NOT NULL, checkout_id TEXT NOT NULL, customer_id TEXT NOT NULL,
     shop_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'awaiting_payment', subtotal INTEGER NOT NULL, delivery_fee INTEGER NOT NULL,
     total INTEGER NOT NULL, address TEXT, lat REAL, lng REAL, phone TEXT, note TEXT, courier_id TEXT, distance_km REAL,
     created_at TEXT, updated_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_shop ON orders(shop_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_courier ON orders(courier_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_checkout ON orders(checkout_id)`,
  `CREATE TABLE IF NOT EXISTS order_items (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, product_id TEXT, name TEXT NOT NULL, price INTEGER NOT NULL, qty INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id)`,
  `CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT, url TEXT, read INTEGER NOT NULL DEFAULT 0, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, sender_id TEXT NOT NULL, sender_name TEXT, sender_role TEXT, body TEXT NOT NULL, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_order ON chat_messages(order_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS couriers (user_id TEXT PRIMARY KEY, available INTEGER NOT NULL DEFAULT 0, lat REAL, lng REAL, vehicle TEXT, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, role TEXT NOT NULL, label TEXT, max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0,
     expires_at INTEGER, auto_approve INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS invite_uses (invite_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_invite_uses ON invite_uses(invite_id)`,
  `CREATE TABLE IF NOT EXISTS admin_actions (id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, admin_name TEXT, action TEXT NOT NULL, target_type TEXT,
     target_id TEXT, target_name TEXT, reason TEXT, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_admin_actions ON admin_actions(created_at)`,
  // Historique des comptes de paiement : une première saisie est enregistrée, toute modification attend l'accord de l'administrateur
  `CREATE TABLE IF NOT EXISTS account_changes (id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, user_id TEXT NOT NULL, old_data TEXT, new_data TEXT,
     status TEXT NOT NULL DEFAULT 'pending', note TEXT, created_at TEXT, decided_at TEXT, decided_by TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_account_changes ON account_changes(status, created_at)`,
  // Pièces justificatives (facultatives) : visibles seulement par leur propriétaire et par l'administrateur
  `CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, data TEXT NOT NULL, size INTEGER,
     status TEXT NOT NULL DEFAULT 'pending', note TEXT, created_at TEXT, reviewed_at TEXT, reviewed_by TEXT, UNIQUE (user_id, kind))`,
  `CREATE TABLE IF NOT EXISTS loyalty_cards (user_id TEXT NOT NULL, shop_id TEXT NOT NULL, stamps INTEGER NOT NULL DEFAULT 0, orders INTEGER NOT NULL DEFAULT 0,
     spent INTEGER NOT NULL DEFAULT 0, updated_at TEXT, PRIMARY KEY (user_id, shop_id))`,
  `CREATE TABLE IF NOT EXISTS vouchers (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL, shop_id TEXT NOT NULL, kind TEXT NOT NULL,
     value INTEGER NOT NULL, min_order INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, origin TEXT, note TEXT, used_at TEXT, order_id TEXT, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_vouchers_user ON vouchers(user_id, shop_id)`,
  `CREATE INDEX IF NOT EXISTS idx_vouchers_order ON vouchers(order_id)`,
  `CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, day TEXT NOT NULL, category TEXT NOT NULL, label TEXT, amount INTEGER NOT NULL, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_expenses_shop ON expenses(shop_id, day)`,
  `CREATE TABLE IF NOT EXISTS payouts (id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, amount INTEGER NOT NULL, method TEXT, reference TEXT, note TEXT, created_by TEXT, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_payouts_shop ON payouts(shop_id)`,
  `CREATE TABLE IF NOT EXISTS stock_alerts (user_id TEXT NOT NULL, product_id TEXT NOT NULL, created_at TEXT, PRIMARY KEY (user_id, product_id))`,
  `CREATE INDEX IF NOT EXISTS idx_stock_alerts_product ON stock_alerts(product_id)`,
  // Le stock ne peut jamais devenir négatif : deux paiements simultanés du dernier article échouent proprement
  `CREATE TRIGGER IF NOT EXISTS products_stock_nonneg BEFORE UPDATE OF stock ON products WHEN NEW.stock < 0 BEGIN SELECT RAISE(ABORT, 'stock_insuffisant'); END`
];

// Colonnes ajoutées après la première version : créées sur les bases existantes
const MIGRATIONS = {
  users: [['avatar_id', 'TEXT']],
  notifications: [['kind', 'TEXT']],
  products: [['unit', "TEXT NOT NULL DEFAULT 'piece'"], ['qty_step', 'REAL NOT NULL DEFAULT 1'], ['promo_price', 'INTEGER'], ['promo_until', 'INTEGER'], ['promo_start', 'INTEGER'], ['stock_updated_at', 'INTEGER'], ['photos', 'TEXT']],
  shops: [['loyalty_enabled', 'INTEGER NOT NULL DEFAULT 0'], ['loyalty_every', 'INTEGER'], ['loyalty_kind', 'TEXT'], ['loyalty_value', 'INTEGER'],
    ['loyalty_min', 'INTEGER'], ['loyalty_days', 'INTEGER'], ['cover_photo', 'TEXT'],
    ['payout_method', 'TEXT'], ['payout_number', 'TEXT'], ['payout_name', 'TEXT'], ['payout_code', 'TEXT'], ['payout_bank', 'TEXT']],
  couriers: [['pay_method', 'TEXT'], ['pay_number', 'TEXT'], ['pay_name', 'TEXT'], ['pay_code', 'TEXT'], ['pay_bank', 'TEXT']],
  order_items: [['unit', "TEXT NOT NULL DEFAULT 'piece'"]],
  orders: [['pay_account', 'TEXT'], ['fee_account', 'TEXT'], ['pay_dispute', 'TEXT'], ['fee_dispute', 'TEXT'], ['pay_direct', 'INTEGER NOT NULL DEFAULT 0'], ['pay_ref', 'TEXT'], ['pay_submitted_at', 'TEXT'], ['fee_state', 'TEXT'], ['fee_ref', 'TEXT'], ['discount', 'INTEGER NOT NULL DEFAULT 0'], ['voucher_id', 'TEXT'], ['commission', 'INTEGER NOT NULL DEFAULT 0']]
};
async function migrate(db) {
  for (const [table, cols] of Object.entries(MIGRATIONS)) {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
    const have = new Set(results.map(r => r.name));
    for (const [c, type] of cols) if (!have.has(c)) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${c} ${type}`).run();
  }
}

let ready = null;
export function ensureSchema(db) {
  if (!ready) {
    ready = db.batch(SCHEMA.map(s => db.prepare(s))).then(() => migrate(db)).catch(e => { ready = null; throw e; });
  }
  return ready;
}

// ---------- Comptes de paiement (boutiques et livreurs) ----------
// Mobile Money (Airtel, Moov) ou compte bancaire. Renvoie { error } ou { method, number, name, code, bank } (number vide = compte effacé).
export function cleanAccount(b, clean) {
  const method = ['airtel_money', 'moov_money', 'bank'].includes(b && b.method) ? b.method : 'airtel_money';
  const raw = String((b && b.number) || '').replace(/[\s.\-]/g, '');
  if (!raw) return { method: null, number: null, name: null, code: null, bank: null };
  if (method === 'bank') {
    if (!/^[A-Za-z0-9]{8,34}$/.test(raw)) return { error: 'Numéro de compte bancaire invalide (8 à 34 caractères, ex. IBAN ou RIB)' };
    const bank = clean(b.bank, 60);
    if (bank.length < 2) return { error: 'Indiquez le nom de la banque' };
    return { method, number: raw.toUpperCase(), name: clean(b.name, 80) || null, code: null, bank };
  }
  if (!/^\+?\d{8,15}$/.test(raw)) return { error: 'Numéro Mobile Money invalide : 8 à 15 chiffres (ex. 077 12 34 56)' };
  return { method, number: raw, name: clean(b.name, 80) || null, code: clean(b.code, 30) || null, bank: null };
}
export const METHOD_LABEL = { airtel_money: 'Airtel Money', moov_money: 'Moov Money', bank: 'Compte bancaire' };

// ---------- Unités de vente ----------
// Chaque produit se vend à la pièce, au kilo, au litre, au tas, au sachet ou à la botte ; le vendeur choisit.
// Kilo et litre acceptent des quantités décimales (pas de 0,25, 0,5 ou 1 réglé par la boutique).
export const UNITS = {
  piece: { label: 'à la pièce', short: '', decimal: false }, kg: { label: 'au kilo', short: 'kg', decimal: true },
  litre: { label: 'au litre', short: 'L', decimal: true }, tas: { label: 'au tas', short: 'tas', decimal: false },
  sachet: { label: 'au sachet', short: 'sachet', decimal: false }, botte: { label: 'à la botte', short: 'botte', decimal: false }
};
export const r3 = n => Math.round(n * 1000) / 1000;
export const unitOf = u => (UNITS[u] ? u : 'piece');
export const stepOf = (unit, step) => (UNITS[unit].decimal && [0.25, 0.5, 1].includes(Number(step)) ? Number(step) : 1);
export const fmtQty = (q, unit) => { const s = (UNITS[unit] || UNITS.piece).short, n = String(r3(q)).replace('.', ','); return s ? `${n} ${s}` : n; };
export const lineTotal = (price, qty) => Math.round(price * qty);

// ---------- Promotions ----------
// Prix réellement facturé (SQL) : le prix promo tant que la promotion court, sinon le prix normal.
export const EFFECTIVE_PRICE = `(CASE WHEN p.promo_price IS NOT NULL AND p.promo_until > CAST(strftime('%s','now') AS INTEGER) * 1000 THEN p.promo_price ELSE p.price END)`;
export const promoActive = p => p.promo_price != null && p.promo_until > Date.now() && p.promo_price < p.price;
// Produit tel que montré au public : price = prix à payer, old_price = prix barré pendant la promotion.
// Liste des photos d'un produit (la première est la principale)
export function photoList(p) {
  let l = []; try { l = p.photos ? JSON.parse(p.photos) : []; } catch { l = []; }
  if (!Array.isArray(l) || !l.length) l = p.photo_id ? [p.photo_id] : [];
  return l.filter(x => /^[a-f0-9]{16}$/.test(x)).slice(0, 6);
}
export function publicProduct(p) {
  const { promo_price, promo_until, promo_start, ...rest } = p;
  if ('photos' in rest || rest.photo_id) rest.photos = photoList(p);
  if (!promoActive(p)) return rest;
  return { ...rest, price: promo_price, old_price: p.price, promo_pct: Math.round(100 - (100 * promo_price) / p.price), promo_until };
}

// ---------- Réglages ----------
export async function loadSettings(env) {
  const row = await env.DB.prepare(`SELECT value FROM site_config WHERE key='settings'`).first();
  let saved = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch { /* réglages illisibles : valeurs par défaut */ }
  return { ...DEFAULT_SETTINGS, ...saved };
}

export async function saveSettings(env, settings) {
  await env.DB.prepare(`INSERT INTO site_config (key,value) VALUES ('settings',?1)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(JSON.stringify(settings)).run();
}

// ---------- Photos : base64 <-> octets ----------
export function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
// Pièces justificatives : un livreur peut fournir carte d'identité, permis ou passeport ; une boutique, son document administratif d'ouverture.
export const DOC_KINDS = {
  cni: { label: 'Carte d\'identité', roles: ['courier'] }, permis: { label: 'Permis de conduire', roles: ['courier'] },
  passeport: { label: 'Passeport', roles: ['courier'] }, autorisation: { label: 'Autorisation d\'ouverture du commerce', roles: ['seller'] }
};
export function sniffDocument(buf) {
  const b = new Uint8Array(buf.slice(0, 5));
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'application/pdf';
  return sniffImage(buf);
}
export function sniffImage(buf) {
  const b = new Uint8Array(buf.slice(0, 12));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  return null;
}

// ---------- Géolocalisation ----------
export const validCoord = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

// Distance à vol d'oiseau en kilomètres (formule de haversine)
export function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = d => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export const slugify = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'boutique';

// ---------- Stock ----------
export const LOW_STOCK = 5; // « Plus que N » à partir de ce seuil
export const stockLevel = n => (n <= 0 ? 'out' : n <= LOW_STOCK ? 'low' : 'ok');

// ---------- Comptabilité ----------
export const SOLD = `('paid','preparing','ready','delivering','delivered')`; // commandes comptées comme ventes
export const EXPENSE_CATS = ['Achat de marchandises', 'Transport', 'Loyer', 'Salaires', 'Électricité et eau', 'Téléphone et internet', 'Publicité', 'Impôts et taxes', 'Autre'];
// Période [from, to] au format AAAA-MM-JJ (par défaut : le mois en cours)
export function period(url) {
  const ok = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const t = new Date(), first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)).toISOString().slice(0, 10);
  let from = url.searchParams.get('from'), to = url.searchParams.get('to');
  from = ok(from) ? from : first; to = ok(to) ? to : t.toISOString().slice(0, 10);
  if (from > to) [from, to] = [to, from];
  return { from, to, fromIso: from + 'T00:00:00.000Z', toIso: to + 'T23:59:59.999Z' };
}

// ---------- Fidélité ----------
// Montant de la remise d'un bon sur un sous-total (arrondi à 5 FCFA, jamais plus que le sous-total)
export function voucherDiscount(v, subtotal) {
  if (subtotal < (v.min_order || 0)) return 0;
  const d = v.kind === 'percent' ? Math.round((subtotal * v.value) / 100 / 5) * 5 : v.value;
  return Math.max(0, Math.min(d, subtotal));
}
export const loyaltyProgram = s => (s && s.loyalty_enabled ? {
  every: s.loyalty_every, kind: s.loyalty_kind, value: s.loyalty_value, min: s.loyalty_min || 0, days: s.loyalty_days
} : null);
