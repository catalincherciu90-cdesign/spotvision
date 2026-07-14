// GET /api/data  ->  { racks, g, inv }
// Echivalentul lui `GET /api/data` din server.js, dar pe Cloudflare D1.
import { getConfig, getInv, json, noDb } from '../_db.js';

export async function onRequestGet({ env }) {
  if (!env.DB) return noDb();
  const c = await getConfig(env);
  const inv = await getInv(env);
  return json({ racks: c.racks, g: c.g, inv });
}
