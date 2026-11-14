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
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
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
  airtel_number: '',
  merchant_name: 'Marché Gabon',
  payment_instructions: 'Envoyez le montant par Airtel Money au numéro indiqué avec la référence en motif, puis saisissez la référence de la transaction reçue par SMS.',
  delivery_base: 1000,      // FCFA : frais de départ par boutique
  delivery_per_km: 200,     // FCFA : par kilomètre entre la boutique et le client
  courier_radius_km: 15,    // les livreurs à moins de cette distance de la boutique sont prévenus
  promo_max_pct: 70,        // remise maximale autorisée (%)
  promo_max_days: 30,       // durée maximale d'une promotion (jours)
  loyalty_max_pct: 30,      // valeur maximale d'un bon d'achat en pourcentage
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
  `CREATE TABLE IF NOT EXISTS loyalty_cards (user_id TEXT NOT NULL, shop_id TEXT NOT NULL, stamps INTEGER NOT NULL DEFAULT 0, orders INTEGER NOT NULL DEFAULT 0,
     spent INTEGER NOT NULL DEFAULT 0, updated_at TEXT, PRIMARY KEY (user_id, shop_id))`,
  `CREATE TABLE IF NOT EXISTS vouchers (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL, shop_id TEXT NOT NULL, kind TEXT NOT NULL,
     value INTEGER NOT NULL, min_order INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, origin TEXT, note TEXT, used_at TEXT, order_id TEXT, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_vouchers_user ON vouchers(user_id, shop_id)`,
  `CREATE INDEX IF NOT EXISTS idx_vouchers_order ON vouchers(order_id)`
];

// Colonnes ajoutées après la première version : créées sur les bases existantes
const MIGRATIONS = {
  users: [['avatar_id', 'TEXT']],
  products: [['promo_price', 'INTEGER'], ['promo_until', 'INTEGER'], ['promo_start', 'INTEGER']],
  shops: [['loyalty_enabled', 'INTEGER NOT NULL DEFAULT 0'], ['loyalty_every', 'INTEGER'], ['loyalty_kind', 'TEXT'], ['loyalty_value', 'INTEGER'],
    ['loyalty_min', 'INTEGER'], ['loyalty_days', 'INTEGER']],
  orders: [['discount', 'INTEGER NOT NULL DEFAULT 0'], ['voucher_id', 'TEXT']]
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

// ---------- Promotions ----------
// Prix réellement facturé (SQL) : le prix promo tant que la promotion court, sinon le prix normal.
export const EFFECTIVE_PRICE = `(CASE WHEN p.promo_price IS NOT NULL AND p.promo_until > CAST(strftime('%s','now') AS INTEGER) * 1000 THEN p.promo_price ELSE p.price END)`;
export const promoActive = p => p.promo_price != null && p.promo_until > Date.now() && p.promo_price < p.price;
// Produit tel que montré au public : price = prix à payer, old_price = prix barré pendant la promotion.
export function publicProduct(p) {
  const { promo_price, promo_until, promo_start, ...rest } = p;
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
