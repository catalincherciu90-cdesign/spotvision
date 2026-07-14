// GET /api/data  ->  { racks, g, inv }
// Echivalentul lui `GET /api/data` din server.js, dar pe Cloudflare KV.
import { getConfig, getInv, json, noKv } from '../_db.js';

export async function onRequestGet({ env }) {
  if (!env.RAFT_DB) return noKv();
  const c = await getConfig(env);
  const inv = await getInv(env);
  return json({ racks: c.racks, g: c.g, inv });
}
