// PUT    /api/inventory/:code   body: [ {produs,cant,data}, ... ]
// DELETE /api/inventory/:code
// Echivalentul rutelor pe cod din server.js (setează / șterge o locație).
import { putLoc, deleteLoc, readBody, json, noDb } from '../../_db.js';

const norm = (params) => decodeURIComponent(String(params.code || '')).toUpperCase();

export async function onRequestPut({ request, env, params }) {
  if (!env.DB) return noDb();
  const code = norm(params);
  const arr = await readBody(request);
  await putLoc(env, code, Array.isArray(arr) ? arr : []);
  return json({ ok: true });
}

export async function onRequestDelete({ env, params }) {
  if (!env.DB) return noDb();
  await deleteLoc(env, norm(params));
  return json({ ok: true });
}
