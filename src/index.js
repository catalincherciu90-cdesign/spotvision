// ================================================================
//  Worker SpotVision — serveste aplicatia (schema-raft.html) + API-ul
//  pe baza de date Cloudflare D1. Inlocuieste server.js.
//
//  Rute:
//    GET    /                     -> schema-raft.html
//    GET    /api/data             -> { racks, g, inv }
//    PUT    /api/config           -> salveaza rafturile + setarile
//    GET    /api/inventory        -> tot inventarul
//    PUT    /api/inventory        -> inlocuieste tot inventarul
//    PUT    /api/inventory/:cod   -> o singura locatie
//    DELETE /api/inventory/:cod   -> sterge o locatie
//    orice altceva                -> fisier static (ASSETS)
// ================================================================
import { getConfig, putConfig, getInv, putLoc, deleteLoc, putAllInv } from './db.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const noDb = () =>
  json({ error: 'Lipsește baza de date „DB". Leagă un D1 database în Cloudflare (vezi DEPLOY-cloudflare.md).' }, 500);

async function readBody(request) {
  try { return await request.json(); }
  catch (e) { return {}; }
}

async function handleApi(request, env, p, method) {
  if (!env.DB) return noDb();

  if (p === '/api/data' && method === 'GET') {
    const c = await getConfig(env);
    const inv = await getInv(env);
    return json({ racks: c.racks, g: c.g, inv });
  }

  if (p === '/api/config' && method === 'PUT') {
    const body = await readBody(request);
    const c = await getConfig(env);
    if (Array.isArray(body.racks)) c.racks = body.racks;
    if (body.g && typeof body.g === 'object') c.g = body.g;
    await putConfig(env, c);
    return json({ ok: true });
  }

  if (p === '/api/inventory' && method === 'GET') return json(await getInv(env));

  if (p === '/api/inventory' && method === 'PUT') {
    const body = await readBody(request);
    const inv = (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};
    await putAllInv(env, inv);
    return json({ ok: true, locations: Object.keys(inv).length });
  }

  const mInv = p.match(/^\/api\/inventory\/(.+)$/);
  if (mInv) {
    const code = decodeURIComponent(mInv[1]).toUpperCase();
    if (method === 'PUT') {
      const arr = await readBody(request);
      await putLoc(env, code, Array.isArray(arr) ? arr : []);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await deleteLoc(env, code);
      return json({ ok: true });
    }
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = decodeURIComponent(url.pathname);
    const method = request.method;

    if (p.startsWith('/api/')) {
      try { return await handleApi(request, env, p, method); }
      catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
    }

    // Aplicatia la radacina (nu avem index.html, servim schema-raft.html).
    if (p === '/' || p === '/index.html') {
      return env.ASSETS.fetch(new URL('/schema-raft.html', url.origin));
    }

    // Orice alt fisier static.
    return env.ASSETS.fetch(request);
  },
};
