// GET /api/inventory        -> întreg inventarul { COD: [...] }
// PUT /api/inventory  body  -> înlocuiește tot inventarul
// Echivalentul rutelor `GET/PUT /api/inventory` din server.js.
import { getInv, putInv, readBody, json, noKv } from '../_db.js';

export async function onRequestGet({ env }) {
  if (!env.RAFT_DB) return noKv();
  return json(await getInv(env));
}

export async function onRequestPut({ request, env }) {
  if (!env.RAFT_DB) return noKv();
  const body = await readBody(request);
  const inv = (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};
  await putInv(env, inv);
  return json({ ok: true, locations: Object.keys(inv).length });
}
