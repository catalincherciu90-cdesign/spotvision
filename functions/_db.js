// ================================================================
//  Helper comun pentru Cloudflare Pages Functions.
//  Ține locul lui data.json din server.js, dar pe Cloudflare KV.
//
//  Model de date (identic cu server.js):
//    KV["config"]     -> { racks: [...], g: {...} }
//    KV["inventory"]  -> { "COD-LOCATIE": [ {produs,cant,data}, ... ], ... }
//
//  Binding KV așteptat:  RAFT_DB  (se creează în Cloudflare — vezi DEPLOY-cloudflare.md)
// ================================================================

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

// Răspuns clar dacă cineva a uitat să lege namespace-ul KV la variabila RAFT_DB.
export const noKv = () =>
  json(
    { error: 'Lipsește binding-ul KV „RAFT_DB". Leagă un namespace KV în Cloudflare (vezi DEPLOY-cloudflare.md).' },
    500
  );

export async function readBody(request) {
  try { return await request.json(); }
  catch (e) { return {}; }
}

export async function getConfig(env) {
  let c = {};
  try { const raw = await env.RAFT_DB.get('config'); c = raw ? JSON.parse(raw) : {}; }
  catch (e) { c = {}; }
  return {
    racks: Array.isArray(c.racks) ? c.racks : [],
    g: (c.g && typeof c.g === 'object') ? c.g : {},
  };
}

export async function putConfig(env, c) {
  await env.RAFT_DB.put('config', JSON.stringify(c));
}

export async function getInv(env) {
  let i = {};
  try { const raw = await env.RAFT_DB.get('inventory'); i = raw ? JSON.parse(raw) : {}; }
  catch (e) { i = {}; }
  return (i && typeof i === 'object') ? i : {};
}

export async function putInv(env, inv) {
  await env.RAFT_DB.put('inventory', JSON.stringify(inv));
}
