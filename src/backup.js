// Sauvegardes automatiques de la base D1 vers R2 (binding BACKUPS).
//
// Une copie complète par jour (id = AAAA-MM-JJ), découpée en petits fichiers JSON : `backups/<id>/<table>.<n>.json`,
// plus un `manifest.json` écrit à la toute fin (sa présence prouve que la copie est complète).
// Le travail est repris par morceaux à chaque passage du déclencheur (toutes les 15 minutes) : une copie interrompue
// repart là où elle s'était arrêtée, et même la formule gratuite de Workers (peu de temps de calcul) suffit.
// Si la variable secrète BACKUP_KEY existe, chaque fichier est chiffré (AES-GCM) avant d'être écrit.
// On garde les 30 dernières copies.
import { notify } from './pay.js';

const SKIP = new Set(['sessions', 'login_attempts', 'reset_tokens']); // éphémères et sensibles : inutiles à restaurer
const BIG = { photos: 3, documents: 2 };                               // lignes par fichier pour les tables qui contiennent des images
const PAGE = 400, KEEP = 30, STEP_PAGES = 25, STEP_MS = 20000;
const STATE = 'backups/_state.json', ALERT = 'backups/_alert.json';

const enc = new TextEncoder(), dec = new TextDecoder();
const day = (d = new Date()) => d.toISOString().slice(0, 10);

async function aesKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(String(env.BACKUP_KEY)));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(env, text) {
  const bytes = enc.encode(text);
  if (!env.BACKUP_KEY) return bytes;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), bytes));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return out;
}
async function unseal(env, buf, encrypted) {
  const bytes = new Uint8Array(buf);
  if (!encrypted) return dec.decode(bytes);
  if (!env.BACKUP_KEY) throw new Error('Cette sauvegarde est chiffrée : la clé BACKUP_KEY est absente');
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await aesKey(env), bytes.slice(12)));
}

async function readJson(env, key) { const o = await env.BACKUPS.get(key); return o ? o.json() : null; }
const writeJson = (env, key, v) => env.BACKUPS.put(key, JSON.stringify(v));

async function tablesToSave(db) {
  const { results } = await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name`).all();
  return results.map(r => r.name).filter(n => !SKIP.has(n));
}

// Nombre de copies complètes déjà faites aujourd'hui ?
async function doneToday(env) {
  const m = await readJson(env, `backups/${day()}/manifest.json`);
  return !!m;
}

// Fait avancer la copie du jour (ou une copie manuelle si force = true). Renvoie l'état.
export async function backupStep(env, { force = false } = {}) {
  if (!env.BACKUPS) return { enabled: false };
  let st = await readJson(env, STATE);
  if (force && (!st || st.done)) st = null;                  // nouvelle copie manuelle
  else if (!force && (!st || st.done)) {
    if (await doneToday(env)) return { enabled: true, done: true, id: day() };
    st = null;
  }
  if (!st) {
    const id = force ? new Date().toISOString().slice(0, 16).replace(/[:]/g, 'h') : day();
    st = { id, started: new Date().toISOString(), tables: await tablesToSave(env.DB), ti: 0, last: 0, parts: {}, rows: {}, bytes: 0, done: false, encrypted: !!env.BACKUP_KEY };
  }
  const t0 = Date.now();
  let pages = 0;
  while (!st.done && pages < STEP_PAGES && Date.now() - t0 < STEP_MS) {
    const table = st.tables[st.ti];
    if (!table) break;
    const limit = BIG[table] || PAGE;
    const { results } = await env.DB.prepare(`SELECT rowid AS _rid, * FROM "${table}" WHERE rowid > ?1 ORDER BY rowid LIMIT ?2`).bind(st.last, limit).all();
    if (!results.length) { st.ti++; st.last = 0; continue; }
    const rows = results.map(({ _rid, ...r }) => r);
    const n = (st.parts[table] = (st.parts[table] || 0) + 1);
    const body = await seal(env, JSON.stringify({ table, rows }));
    await env.BACKUPS.put(`backups/${st.id}/${table}.${n}.json`, body);
    st.last = results[results.length - 1]._rid; st.rows[table] = (st.rows[table] || 0) + rows.length; st.bytes += body.byteLength; pages++;
    await writeJson(env, STATE, st);
  }
  if (st.ti >= st.tables.length) {                           // tout est copié : on écrit le manifeste, puis on fait le ménage
    await env.BACKUPS.put(`backups/${st.id}/manifest.json`, JSON.stringify({ id: st.id, created: new Date().toISOString(), started: st.started, tables: st.tables.map(t => ({ name: t, rows: st.rows[t] || 0, parts: st.parts[t] || 0 })), bytes: st.bytes, encrypted: st.encrypted }));
    st.done = true;
    await prune(env);
  }
  await writeJson(env, STATE, st);
  return { enabled: true, done: st.done, id: st.id, table: st.tables[st.ti] || null, tablesDone: st.ti, tablesTotal: st.tables.length };
}

async function backupIds(env) {
  const ids = []; let cursor;
  do {
    const l = await env.BACKUPS.list({ prefix: 'backups/', delimiter: '/', cursor });
    for (const p of l.delimitedPrefixes) ids.push(p.slice('backups/'.length, -1));
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
  return ids.filter(Boolean).sort();
}

async function prune(env) {
  const ids = await backupIds(env), old = ids.slice(0, Math.max(0, ids.length - KEEP));
  for (const id of old) {
    let cursor;
    do {
      const l = await env.BACKUPS.list({ prefix: `backups/${id}/`, cursor });
      if (l.objects.length) await env.BACKUPS.delete(l.objects.map(o => o.key));
      cursor = l.truncated ? l.cursor : undefined;
    } while (cursor);
  }
}

// Liste des copies complètes (les plus récentes d'abord) et état de la copie en cours
export async function backupStatus(env) {
  if (!env.BACKUPS) return { enabled: false };
  const out = [];
  for (const id of (await backupIds(env)).reverse().slice(0, KEEP)) {
    const m = await readJson(env, `backups/${id}/manifest.json`);
    if (m) out.push({ id, created: m.created, bytes: m.bytes, rows: m.tables.reduce((t, x) => t + x.rows, 0), tables: m.tables.length, encrypted: m.encrypted });
  }
  const st = await readJson(env, STATE);
  return { enabled: true, encrypted: !!env.BACKUP_KEY, backups: out, running: st && !st.done ? { id: st.id, tablesDone: st.ti, tablesTotal: st.tables.length } : null };
}

// Flux de téléchargement : une ligne JSON par fichier ({table, rows}), déchiffrée. Sert à garder une copie hors de Cloudflare.
export async function backupStream(env, id) {
  const m = /^[0-9Th-]{10,16}$/.test(id) && await readJson(env, `backups/${id}/manifest.json`);
  if (!m) return null;
  const files = m.tables.flatMap(t => Array.from({ length: t.parts }, (_, i) => `backups/${id}/${t.name}.${i + 1}.json`));
  let i = 0;
  return new ReadableStream({
    async pull(ctl) {
      if (i >= files.length) return ctl.close();
      const o = await env.BACKUPS.get(files[i++]);
      if (!o) return ctl.error(new Error('fichier manquant : ' + files[i - 1]));
      ctl.enqueue(enc.encode(await unseal(env, await o.arrayBuffer(), m.encrypted) + '\n'));
    }
  });
}

// Alerte : aucune copie complète depuis plus de 48 h (prévenue au plus une fois par jour)
export async function backupWatch(env) {
  if (!env.BACKUPS) return;
  const ids = await backupIds(env);
  let last = null;
  for (const id of ids.reverse()) { const m = await readJson(env, `backups/${id}/manifest.json`); if (m) { last = m; break; } }
  const age = last ? Date.now() - new Date(last.created).getTime() : Infinity;
  if (age < 48 * 3600 * 1000) return;
  const a = await readJson(env, ALERT);
  if (a && a.day === day()) return;
  await writeJson(env, ALERT, { day: day() });
  const { results } = await env.DB.prepare(`SELECT id FROM users WHERE role='admin'`).all();
  for (const u of results) await notify(env, u.id, 'Sauvegarde en retard', last ? `La dernière sauvegarde complète date du ${last.created.slice(0, 10)}. Vérifiez Administration, Réglages, Sauvegardes.` : 'Aucune sauvegarde complète n\'a encore été faite. Vérifiez Administration, Réglages, Sauvegardes.', '/admin.html');
}
