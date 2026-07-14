// ================================================================
//  Acces la baza de date (Cloudflare D1 / SQLite) pentru Worker.
//
//  Model:
//    tabela config    -> un rand (id=1) cu racks (JSON) si g (JSON)
//    tabela inventory  -> cate un rand per produs: code, produs, cant, data, pos
//
//  Binding D1 asteptat:  DB   (definit in wrangler.toml)
//  Schema:               schema.sql
// ================================================================

// ---------- config (rafturi + setari) ----------
export async function getConfig(env) {
  const row = await env.DB.prepare('SELECT racks, g FROM config WHERE id = 1').first();
  let racks = [], g = {};
  try { racks = JSON.parse(row?.racks || '[]'); } catch (e) { racks = []; }
  try { g = JSON.parse(row?.g || '{}'); } catch (e) { g = {}; }
  return {
    racks: Array.isArray(racks) ? racks : [],
    g: (g && typeof g === 'object') ? g : {},
  };
}

export async function putConfig(env, c) {
  await env.DB
    .prepare('INSERT INTO config (id, racks, g) VALUES (1, ?1, ?2) ' +
             'ON CONFLICT(id) DO UPDATE SET racks = ?1, g = ?2')
    .bind(JSON.stringify(c.racks || []), JSON.stringify(c.g || {}))
    .run();
}

// ---------- inventar ----------
function rowsToInv(rows) {
  const inv = {};
  for (const r of (rows || [])) {
    (inv[r.code] = inv[r.code] || []).push({
      produs: r.produs,
      cant: r.cant,
      data: r.data || '',
    });
  }
  return inv;
}

// Intreg inventarul, sub forma { COD: [{produs,cant,data}, ...] }
export async function getInv(env) {
  const { results } = await env.DB
    .prepare('SELECT code, produs, cant, data FROM inventory ORDER BY code, pos, rowid')
    .all();
  return rowsToInv(results);
}

// Inlocuieste produsele unei singure locatii (atomic, in tranzactie).
export async function putLoc(env, code, arr) {
  const stmts = [env.DB.prepare('DELETE FROM inventory WHERE code = ?1').bind(code)];
  (Array.isArray(arr) ? arr : []).forEach((x, i) => {
    stmts.push(
      env.DB
        .prepare('INSERT INTO inventory (code, produs, cant, data, pos) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(code, String(x.produs || ''), Number(x.cant) || 0, String(x.data || ''), i)
    );
  });
  await env.DB.batch(stmts);
}

export async function deleteLoc(env, code) {
  await env.DB.prepare('DELETE FROM inventory WHERE code = ?1').bind(code).run();
}

// Inlocuieste TOT inventarul (obiect { COD: [...] }).
export async function putAllInv(env, inv) {
  const stmts = [env.DB.prepare('DELETE FROM inventory')];
  for (const rawCode of Object.keys(inv || {})) {
    const code = String(rawCode).toUpperCase();
    (Array.isArray(inv[rawCode]) ? inv[rawCode] : []).forEach((x, i) => {
      stmts.push(
        env.DB
          .prepare('INSERT INTO inventory (code, produs, cant, data, pos) VALUES (?1, ?2, ?3, ?4, ?5)')
          .bind(code, String(x.produs || ''), Number(x.cant) || 0, String(x.data || ''), i)
      );
    });
  }
  await env.DB.batch(stmts);
}
