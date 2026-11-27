// Notifications « push » : elles arrivent sur le téléphone ou l'ordinateur même quand le site est fermé,
// comme celles d'une application (Web Push, standard RFC 8291 + VAPID RFC 8292, sans bibliothèque externe).
// - Les clés VAPID sont créées automatiquement à la première utilisation et gardées dans site_config.
// - notify() (pay.js) enregistre la notification ; flushPush() envoie ensuite, après la réponse, celles qui ne sont pas encore parties.
import { json, bad, now, uid, toBase64 } from './lib.js';

const enc = new TextEncoder();
const b64url = buf => toBase64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => { const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// ---------- Clés du serveur (VAPID) ----------
let vapidMemo = null;
export async function vapidKeys(env) {
  if (vapidMemo) return vapidMemo;
  let row = await env.DB.prepare(`SELECT value FROM site_config WHERE key='vapid'`).first();
  if (!row) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const value = JSON.stringify({ pub: b64url(await crypto.subtle.exportKey('raw', kp.publicKey)), jwk: await crypto.subtle.exportKey('jwk', kp.privateKey) });
    await env.DB.prepare(`INSERT OR IGNORE INTO site_config (key,value) VALUES ('vapid',?1)`).bind(value).run(); // deux créations simultanées : la première gagne
    row = await env.DB.prepare(`SELECT value FROM site_config WHERE key='vapid'`).first();
  }
  const v = JSON.parse(row.value);
  vapidMemo = { pub: v.pub, key: await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
  return vapidMemo;
}
async function vapidHeader(env, endpoint, contact) {
  const v = await vapidKeys(env);
  const head = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contact })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, v.key, enc.encode(head + '.' + body)); // signature brute r||s, le format attendu par JWT
  return `vapid t=${head}.${body}.${b64url(sig)}, k=${v.pub}`;
}

// ---------- Chiffrement du message (aes128gcm, RFC 8291) ----------
export async function encryptPayload(p256dh, auth, text) {
  const uaPub = fromB64url(p256dh), secret = fromB64url(auth);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const peer = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, eph.privateKey, 256));
  const prkKey = await hmac(secret, shared);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPub, asPub, [1]));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), [1]))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(enc.encode(text), [2]))); // 2 = dernier bloc
  const header = new Uint8Array(21); header.set(salt); new DataView(header.buffer).setUint32(16, 4096); header[20] = 65;
  return concat(header, asPub, cipher);
}

// Envoie un message à un abonnement. Renvoie le code HTTP du service de notification (404/410 = abonnement mort).
export async function sendPush(env, sub, data, contact) {
  const body = await encryptPayload(sub.p256dh, sub.auth, JSON.stringify(data));
  const r = await fetch(sub.endpoint, {
    method: 'POST', body,
    headers: { authorization: await vapidHeader(env, sub.endpoint, contact), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'high' }
  });
  return r.status;
}

// ---------- File d'envoi ----------
let pending = false;
export const markPush = () => { pending = true; };
// Envoie les notifications enregistrées dans les 10 dernières minutes et pas encore parties (une seule fois chacune, même avec des requêtes simultanées).
export async function flushPush(env, origin, force = false) {
  if (!pending && !force) return 0;
  pending = false;
  const since = new Date(Date.now() - 10 * 60000).toISOString();
  const { results: items } = await env.DB.prepare(
    `UPDATE notifications SET pushed=1 WHERE id IN (SELECT id FROM notifications WHERE created_at>?1 AND pushed=0 ORDER BY created_at LIMIT 60) RETURNING id,user_id,title,body,url,kind`).bind(since).all();
  if (!items.length) return 0;
  const users = [...new Set(items.map(n => n.user_id))];
  const { results: subs } = await env.DB.prepare(`SELECT id,user_id,endpoint,p256dh,auth FROM push_subs WHERE user_id IN (${users.map((_, i) => '?' + (i + 1)).join(',')})`).bind(...users).all();
  if (!subs.length) return 0;
  const contact = origin || 'https://marche-gabon.mourefabrice7.workers.dev';
  let sent = 0;
  await Promise.all(subs.map(async s => {
    for (const n of items.filter(i => i.user_id === s.user_id)) {
      try {
        const st = await sendPush(env, s, { id: n.id, title: n.title, body: n.body || '', url: n.url || '/', kind: n.kind || 'info' }, contact);
        if (st === 404 || st === 410) { await env.DB.prepare('DELETE FROM push_subs WHERE id=?1').bind(s.id).run(); return; } // téléphone désinscrit
        if (st < 300) sent++; else console.error('push', st);
      } catch (e) { console.error('push', e && e.message); }
    }
  }));
  return sent;
}

// ---------- Routes (compte connecté) ----------
export async function pushRoutes(env, request, user, p, method, { readJson }) {
  if (method === 'GET' && p === '/api/push/key') return json({ key: (await vapidKeys(env)).pub });
  if (method === 'POST' && p === '/api/push/subscribe') {
    const b = await readJson(request), k = (b && b.keys) || {};
    let ep; try { ep = new URL(b.endpoint); } catch { return bad('Abonnement invalide'); }
    if (ep.protocol !== 'https:' || String(b.endpoint).length > 800 || !/^[\w-]{80,100}$/.test(k.p256dh || '') || !/^[\w-]{16,30}$/.test(k.auth || '')) return bad('Abonnement invalide');
    // Un même téléphone ne reçoit que les notifications du compte connecté dessus
    await env.DB.prepare(`INSERT INTO push_subs (id,user_id,endpoint,p256dh,auth,created_at) VALUES (?1,?2,?3,?4,?5,?6)
      ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth`).bind(uid(), user.id, b.endpoint, k.p256dh, k.auth, now()).run();
    const { results } = await env.DB.prepare('SELECT id FROM push_subs WHERE user_id=?1 ORDER BY created_at DESC').bind(user.id).all();
    for (const r of results.slice(10)) await env.DB.prepare('DELETE FROM push_subs WHERE id=?1').bind(r.id).run(); // 10 appareils au plus par compte
    return json({ ok: true });
  }
  if (method === 'POST' && p === '/api/push/unsubscribe') {
    const b = await readJson(request);
    await env.DB.prepare('DELETE FROM push_subs WHERE user_id=?1 AND endpoint=?2').bind(user.id, String((b && b.endpoint) || '')).run();
    return json({ ok: true });
  }
  if (method === 'POST' && p === '/api/push/test') {
    const { results } = await env.DB.prepare('SELECT id,user_id,endpoint,p256dh,auth FROM push_subs WHERE user_id=?1').bind(user.id).all();
    if (!results.length) return bad('Les notifications ne sont pas activées sur cet appareil');
    const origin = new URL(request.url).origin;
    let ok = 0;
    for (const s of results) {
      try {
        const st = await sendPush(env, s, { id: 'test-' + uid(), title: 'Marché Gabon', body: 'Les notifications marchent ! Vous serez prévenu même application fermée.', url: '/compte.html#sons', kind: 'order' }, origin);
        if (st === 404 || st === 410) await env.DB.prepare('DELETE FROM push_subs WHERE id=?1').bind(s.id).run(); else if (st < 300) ok++;
      } catch (e) { console.error('push test', e && e.message); }
    }
    return ok ? json({ ok: true, devices: ok }) : bad('Envoi impossible : réactivez les notifications sur cet appareil', 502);
  }
  return null;
}
