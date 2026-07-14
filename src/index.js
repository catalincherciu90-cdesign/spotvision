// ================================================================
//  Spotvision — Cloudflare Worker (API pentru rafturi depozit)
//  Portat din server.js (Node) -> Cloudflare Workers + D1.
//  Baza de date: D1 (binding `DB`), schema in schema.sql.
//  HTML-ul (schema-raft.html) e servit din static assets (public/).
// ================================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });
}

async function readBody(req) {
  try {
    const t = await req.text();
    return t ? JSON.parse(t) : {};
  } catch (e) {
    return {};
  }
}

// ---- acces D1 ----
async function getConfig(env) {
  const row = await env.DB.prepare('SELECT racks, g FROM config WHERE id = 1').first();
  return {
    racks: row ? JSON.parse(row.racks) : [],
    g: row ? JSON.parse(row.g) : {},
  };
}

async function getInventory(env) {
  const { results } = await env.DB.prepare('SELECT code, items FROM inventory').all();
  const inv = {};
  for (const r of results || []) inv[r.code] = JSON.parse(r.items);
  return inv;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = decodeURIComponent(url.pathname);
    const method = req.method;

    // doar rutele /api/* sunt gestionate de Worker; restul cade pe static assets.
    if (!p.startsWith('/api/')) {
      // fallback: daca exista binding ASSETS, serveste; altfel 404.
      if (env.ASSETS) return env.ASSETS.fetch(req);
      return new Response('Not found', { status: 404 });
    }

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      // GET /api/data  -> { racks, g, inv }
      if (p === '/api/data' && method === 'GET') {
        const cfg = await getConfig(env);
        const inv = await getInventory(env);
        return json({ racks: cfg.racks, g: cfg.g, inv });
      }

      // GET /api/inventory -> { CODE: [...] }
      if (p === '/api/inventory' && method === 'GET') {
        return json(await getInventory(env));
      }

      // PUT /api/config -> actualizeaza racks si/sau g
      if (p === '/api/config' && method === 'PUT') {
        const body = await readBody(req);
        const racks = Array.isArray(body.racks) ? JSON.stringify(body.racks) : null;
        const g = body.g && typeof body.g === 'object' ? JSON.stringify(body.g) : null;
        await env.DB.prepare(
          'UPDATE config SET racks = COALESCE(?1, racks), g = COALESCE(?2, g) WHERE id = 1'
        ).bind(racks, g).run();
        return json({ ok: true });
      }

      // PUT /api/inventory -> inlocuieste tot inventarul
      if (p === '/api/inventory' && method === 'PUT') {
        const body = await readBody(req);
        const obj = body && typeof body === 'object' ? body : {};
        const stmts = [env.DB.prepare('DELETE FROM inventory')];
        for (const code of Object.keys(obj)) {
          stmts.push(
            env.DB.prepare('INSERT OR REPLACE INTO inventory (code, items) VALUES (?1, ?2)')
              .bind(code.toUpperCase(), JSON.stringify(obj[code]))
          );
        }
        await env.DB.batch(stmts);
        return json({ ok: true, locations: Object.keys(obj).length });
      }

      // /api/inventory/:code
      const mInv = p.match(/^\/api\/inventory\/(.+)$/);
      if (mInv) {
        const code = mInv[1].toUpperCase();
        if (method === 'PUT') {
          const arr = await readBody(req);
          if (Array.isArray(arr) && arr.length) {
            await env.DB.prepare('INSERT OR REPLACE INTO inventory (code, items) VALUES (?1, ?2)')
              .bind(code, JSON.stringify(arr)).run();
          } else {
            await env.DB.prepare('DELETE FROM inventory WHERE code = ?1').bind(code).run();
          }
          return json({ ok: true });
        }
        if (method === 'DELETE') {
          await env.DB.prepare('DELETE FROM inventory WHERE code = ?1').bind(code).run();
          return json({ ok: true });
        }
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};
