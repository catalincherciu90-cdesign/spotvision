// Generează seed.sql (date de pornire) din data.json.
// Rulare:   node make-seed.mjs > seed.sql
// Aplici apoi seed.sql pe baza D1, DUPĂ schema.sql:
//   wrangler d1 execute spotvision --remote --file seed.sql
import { readFileSync } from 'fs';

const db = JSON.parse(readFileSync(new URL('./data.json', import.meta.url), 'utf8'));
const racks = Array.isArray(db.racks) ? db.racks : [];
const g = (db.g && typeof db.g === 'object') ? db.g : {};
const inv = (db.inv && typeof db.inv === 'object') ? db.inv : {};

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";   // string SQL sigur

const out = [];
out.push('-- Date de pornire generate din data.json (cu make-seed.mjs).');
out.push('-- Aplica DUPA schema.sql:');
out.push('--   wrangler d1 execute spotvision --remote --file seed.sql');
out.push('');
out.push('INSERT INTO config (id, racks, g) VALUES');
out.push(`  (1, ${q(JSON.stringify(racks))}, ${q(JSON.stringify(g))})`);
out.push('ON CONFLICT(id) DO UPDATE SET racks = excluded.racks, g = excluded.g;');
out.push('');

const codes = Object.keys(inv);
if (codes.length) {
  out.push('DELETE FROM inventory;');
  for (const rawCode of codes) {
    const code = String(rawCode).toUpperCase();
    (Array.isArray(inv[rawCode]) ? inv[rawCode] : []).forEach((x, i) => {
      out.push(
        `INSERT INTO inventory (code, produs, cant, data, pos) VALUES ` +
        `(${q(code)}, ${q(x.produs || '')}, ${Number(x.cant) || 0}, ${q(x.data || '')}, ${i});`
      );
    });
  }
} else {
  out.push('-- (inventarul din data.json este gol — nu inserez randuri in inventory)');
}
out.push('');
process.stdout.write(out.join('\n'));
