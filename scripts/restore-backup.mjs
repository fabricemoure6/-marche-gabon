#!/usr/bin/env node
// Transforme une sauvegarde téléchargée (fichier .jsonl, depuis Administration, Réglages, Sauvegardes) en commandes SQL
// à rejouer sur la base D1. Usage :
//   node scripts/restore-backup.mjs sauvegarde-2026-11-18.jsonl > restauration.sql
//   npx wrangler d1 execute marche-gabon-db --remote --file restauration.sql
// Les lignes existantes sont remplacées (INSERT OR REPLACE) ; les autres lignes de la base ne sont pas touchées.
// Pour repartir d'une base vide, créez une nouvelle base D1 (le site recrée ses tables au premier appel), puis rejouez le fichier.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('Usage : node scripts/restore-backup.mjs <sauvegarde.jsonl> > restauration.sql'); process.exit(1); }

const q = v => v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";
const ORDER = ['users', 'site_config', 'photos', 'shops', 'products', 'couriers', 'checkouts', 'orders']; // parents d'abord, le reste ensuite
const parts = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const rank = t => { const i = ORDER.indexOf(t); return i < 0 ? ORDER.length : i; };
parts.sort((a, b) => rank(a.table) - rank(b.table));
const out = [];
let rows = 0;
for (const { table, rows: list } of parts) {
  for (const r of list) {
    const cols = Object.keys(r);
    out.push(`INSERT OR REPLACE INTO "${table}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map(c => q(r[c])).join(',')});`);
    rows++;
  }
}
console.log(out.join('\n'));
console.error(`${rows} lignes dans ${new Set(parts.map(p => p.table)).size} tables.`);
