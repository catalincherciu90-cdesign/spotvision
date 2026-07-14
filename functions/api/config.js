// PUT /api/config   body: { racks?, g? }
// Echivalentul lui `PUT /api/config` din server.js.
import { getConfig, putConfig, readBody, json, noDb } from '../_db.js';

export async function onRequestPut({ request, env }) {
  if (!env.DB) return noDb();
  const body = await readBody(request);
  const c = await getConfig(env);
  if (Array.isArray(body.racks)) c.racks = body.racks;
  if (body.g && typeof body.g === 'object') c.g = body.g;
  await putConfig(env, c);
  return json({ ok: true });
}
