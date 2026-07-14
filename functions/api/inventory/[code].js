// PUT    /api/inventory/:code   body: [ {produs,cant,data}, ... ]
// DELETE /api/inventory/:code
// Echivalentul rutelor pe cod din server.js (setează / șterge o locație).
import { getInv, putInv, readBody, json, noKv } from '../../_db.js';

const norm = (params) => decodeURIComponent(String(params.code || '')).toUpperCase();

export async function onRequestPut({ request, env, params }) {
  if (!env.RAFT_DB) return noKv();
  const code = norm(params);
  const arr = await readBody(request);
  const inv = await getInv(env);
  if (Array.isArray(arr) && arr.length) inv[code] = arr;
  else delete inv[code];
  await putInv(env, inv);
  return json({ ok: true });
}

export async function onRequestDelete({ env, params }) {
  if (!env.RAFT_DB) return noKv();
  const code = norm(params);
  const inv = await getInv(env);
  delete inv[code];
  await putInv(env, inv);
  return json({ ok: true });
}
