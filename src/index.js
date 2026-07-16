// ================================================================
//  Spotvision — Cloudflare Worker (API + autentificare)
//  Rafturi depozit pe Cloudflare Workers + D1.
//  - /api/*        -> API (protejat prin sesiune)
//  - /api/login,   /api/register, /api/logout, /api/auth-status, /api/users
//  - orice alt path -> aplicatia (doar autentificat), altfel pagina de login.
//  Baza de date: D1 (binding `DB`), schema in schema.sql.
// ================================================================

// HTML-ul aplicatiei, importat ca text (vezi [[rules]] Text din wrangler.toml).
import APP_HTML from '../public/index.html';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Credentials': 'true',
};

const COOKIE = 'sv_session';
const SESSION_DAYS = 30;

function json(data, status = 200, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS,
      ...(extraHeaders || {}),
    },
  });
}

async function readBody(req) {
  try { const t = await req.text(); return t ? JSON.parse(t) : {}; }
  catch (e) { return {}; }
}

// ---- base64url ----
function b64u(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---- parole: PBKDF2-SHA256 ----
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return `pbkdf2:${toHex(salt)}:${toHex(bits)}`;
}
async function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 3) return false;
  const salt = Uint8Array.from(parts[1].match(/.{2}/g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return toHex(bits) === parts[2];
}

// ---- secret de semnare (auto-generat, stocat in D1 meta) ----
async function getAuthSecret(env) {
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k = 'auth_secret'").first();
  if (row && row.v) return row.v;
  const secret = toHex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?1, ?2)').bind('auth_secret', secret).run();
  const again = await env.DB.prepare("SELECT v FROM meta WHERE k = 'auth_secret'").first();
  return again ? again.v : secret;
}

// ---- JWT HMAC-SHA256 ----
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signJWT(payload, secret) {
  const header = b64u(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64u(new TextEncoder().encode(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(data));
  return `${data}.${b64u(sig)}`;
}
async function verifyJWT(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64uToBytes(parts[2]), new TextEncoder().encode(data));
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64uToBytes(parts[1]))); } catch (e) { return null; }
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

// ---- cookie ----
function getCookie(req, name) {
  const c = req.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function sessionCookie(token) {
  const maxAge = SESSION_DAYS * 24 * 3600;
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function getSession(req, env) {
  const token = getCookie(req, COOKIE);
  if (!token) return null;
  return verifyJWT(token, await getAuthSecret(env));
}
async function userCount(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  return row ? row.n : 0;
}

// ---- roluri: admin | operator | viewer ----
const ROLES = ['admin', 'operator', 'viewer'];
let roleColReady = false;
async function ensureRole(env) {
  if (roleColReady) return;
  try {
    await env.DB.prepare("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'operator'").run();
    // coloana tocmai adaugata -> userii de dinainte de roluri aveau acces total => admini
    await env.DB.prepare("UPDATE users SET role = 'admin'").run();
  } catch (e) { /* coloana exista deja */ }
  roleColReady = true;
}
async function getRole(env, id) {
  const r = await env.DB.prepare('SELECT role FROM users WHERE id = ?1').bind(id).first();
  return r ? (r.role || 'operator') : null;
}
async function masterCount(env) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'master'").first();
  return r ? r.n : 0;
}

// ---- permisiuni pe taburi per utilizator (NULL = toate) ----
const TAB_KEYS = ['schema', 'inv', 'pick', 'dim', 'tech', 'labels', 'users', 'log'];
let tabsColReady = false;
async function ensureTabs(env) {
  if (tabsColReady) return;
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN tabs TEXT').run(); } catch (e) { /* exista deja */ }
  tabsColReady = true;
}
function parseTabs(v) {
  if (!v) return null;
  try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter(t => TAB_KEYS.includes(t)) : null; } catch (e) { return null; }
}
async function getTabs(env, id) {
  const r = await env.DB.prepare('SELECT tabs FROM users WHERE id = ?1').bind(id).first();
  return r ? parseTabs(r.tabs) : null;
}

// ---- jurnal de activitate ----
let activityReady = false;
async function ensureActivity(env) {
  if (activityReady) return;
  try {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user TEXT NOT NULL, action TEXT NOT NULL, cat TEXT NOT NULL DEFAULT 'platforma', tenant TEXT)").run();
  } catch (e) { /* exista deja */ }
  try { await env.DB.prepare("ALTER TABLE activity ADD COLUMN cat TEXT NOT NULL DEFAULT 'platforma'").run(); } catch (e) {}
  try { await env.DB.prepare('ALTER TABLE activity ADD COLUMN tenant TEXT').run(); } catch (e) {}
  activityReady = true;
}
async function logAct(env, tenant, user, action, cat) {
  try {
    await ensureActivity(env);
    const c = cat === 'depozit' ? 'depozit' : 'platforma';
    await env.DB.prepare('INSERT INTO activity (ts, user, action, cat, tenant) VALUES (?1, ?2, ?3, ?4, ?5)').bind(Date.now(), String(user || '—'), String(action || '').slice(0, 300), c, tenant || 'default').run();
  } catch (e) { /* nu bloca actiunea din cauza jurnalului */ }
}

// ---- prezenta (cine e conectat), pe firma ----
async function touchPresence(env, tenant, user) {
  try {
    await ensureTenancy(env);
    await env.DB.prepare('INSERT INTO presence_mt (tenant, user, last_seen) VALUES (?1, ?2, ?3) ON CONFLICT(tenant, user) DO UPDATE SET last_seen = ?3').bind(tenant || 'default', String(user), Date.now()).run();
  } catch (e) { /* best-effort */ }
}

// ---- rate limit (best-effort, per-izolat) ----
const rl = new Map();
function tooMany(key, max, windowMs) {
  const now = Date.now();
  const e = rl.get(key) || { n: 0, reset: now + windowMs };
  if (now > e.reset) { e.n = 0; e.reset = now + windowMs; }
  e.n++; rl.set(key, e);
  return e.n > max;
}

// ---- multi-tenant (gestiuni multiple, date izolate pe firma) ----
let tenancyReady = false;
async function ensureTenancy(env) {
  if (tenancyReady) return;
  try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)').run(); } catch (e) {}
  try { await env.DB.prepare('ALTER TABLE tenants ADD COLUMN details TEXT').run(); } catch (e) {}
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN tenant TEXT').run(); } catch (e) {}
  try { await env.DB.prepare("CREATE TABLE IF NOT EXISTS config_mt (tenant TEXT PRIMARY KEY, racks TEXT NOT NULL DEFAULT '[]', g TEXT NOT NULL DEFAULT '{}')").run(); } catch (e) {}
  try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS inventory_mt (tenant TEXT NOT NULL, code TEXT NOT NULL, items TEXT NOT NULL, PRIMARY KEY (tenant, code))').run(); } catch (e) {}
  try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS presence_mt (tenant TEXT NOT NULL, user TEXT NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY (tenant, user))').run(); } catch (e) {}
  // migrare o singura data: datele vechi (single-tenant) -> firma 'default'
  try {
    const orphan = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE tenant IS NULL').first();
    if (orphan && orphan.n > 0) {
      await env.DB.prepare("INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES ('default', 'Firma mea', ?1)").bind(Date.now()).run();
      await env.DB.prepare("UPDATE users SET tenant = 'default' WHERE tenant IS NULL").run();
      try { const c = await env.DB.prepare('SELECT racks, g FROM config WHERE id = 1').first(); if (c) await env.DB.prepare('INSERT OR IGNORE INTO config_mt (tenant, racks, g) VALUES (?1, ?2, ?3)').bind('default', c.racks, c.g).run(); } catch (e) {}
      try { await env.DB.prepare("INSERT OR IGNORE INTO inventory_mt (tenant, code, items) SELECT 'default', code, items FROM inventory").run(); } catch (e) {}
    }
  } catch (e) {}
  tenancyReady = true;
}
async function getUserTenant(env, id) {
  const r = await env.DB.prepare('SELECT tenant FROM users WHERE id = ?1').bind(id).first();
  return r ? (r.tenant || 'default') : null;
}
async function tenantName(env, tid) {
  const r = await env.DB.prepare('SELECT name FROM tenants WHERE id = ?1').bind(tid).first();
  return r ? r.name : '';
}
const COMPANY_FIELDS = ['cui', 'regcom', 'adresa', 'oras', 'telefon', 'email'];
async function getCompany(env, tid) {
  const r = await env.DB.prepare('SELECT name, details FROM tenants WHERE id = ?1').bind(tid).first();
  let details = {};
  if (r && r.details) { try { const o = JSON.parse(r.details); if (o && typeof o === 'object') details = o; } catch (e) {} }
  return { name: r ? r.name : '', details };
}
async function tenantUserCount(env, tid) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE tenant = ?1').bind(tid).first();
  return r ? r.n : 0;
}

// ---- acces D1 (date aplicatie), izolat pe firma (tenant) ----
async function getConfig(env, tenant) {
  const row = await env.DB.prepare('SELECT racks, g FROM config_mt WHERE tenant = ?1').bind(tenant).first();
  return { racks: row ? JSON.parse(row.racks) : [], g: row ? JSON.parse(row.g) : {} };
}
async function putConfig(env, tenant, racks, g) {
  await env.DB.prepare('INSERT INTO config_mt (tenant, racks, g) VALUES (?1, COALESCE(?2,\'[]\'), COALESCE(?3,\'{}\')) ON CONFLICT(tenant) DO UPDATE SET racks = COALESCE(?2, racks), g = COALESCE(?3, g)').bind(tenant, racks, g).run();
}
async function getInventory(env, tenant) {
  const { results } = await env.DB.prepare('SELECT code, items FROM inventory_mt WHERE tenant = ?1').bind(tenant).all();
  const inv = {};
  for (const r of results || []) inv[r.code] = JSON.parse(r.items);
  return inv;
}

// ================================================================
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = decodeURIComponent(url.pathname);
    const method = req.method;
    const ip = req.headers.get('CF-Connecting-IP') || 'local';

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (p.startsWith('/api/')) { await ensureRole(env); await ensureTabs(env); await ensureTenancy(env); }

    // ---------- rute publice de auth ----------
    if (p === '/api/auth-status' && method === 'GET') {
      const session = await getSession(req, env);
      const setup = (await userCount(env)) === 0;
      const role = session ? await getRole(env, session.sub) : null;
      const tabs = session ? await getTabs(env, session.sub) : null;
      const tid = session ? (session.t || await getUserTenant(env, session.sub)) : null;
      const tname = tid ? await tenantName(env, tid) : '';
      const masterExists = (await masterCount(env)) > 0;
      return json({ setup, authenticated: !!session, id: session ? session.sub : null, role, tabs, tenant: tid, tenantName: tname, masterExists, canClaimMaster: !!session && role === 'admin' && !masterExists });
    }

    // ---------- inregistrare firma noua (public): creeaza gestiune + admin ----------
    if (p === '/api/signup' && method === 'POST') {
      if (tooMany(`signup:${ip}`, 8, 10 * 60000)) return json({ error: 'Prea multe încercări. Revino în câteva minute.' }, 429);
      const { company, id, password } = await readBody(req);
      const uid = String(id || '').trim();
      const cname = String(company || '').trim();
      if (!cname) return json({ error: 'Completează numele firmei.' }, 400);
      if (!/^[a-zA-Z0-9._-]{2,40}$/.test(uid)) return json({ error: 'Id-ul contului: 2-40 caractere (litere, cifre, . _ -).' }, 400);
      if (String(password || '').length < 6) return json({ error: 'Parola: minim 6 caractere.' }, 400);
      const exists = await env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(uid).first();
      if (exists) return json({ error: 'Acest id de cont e deja folosit. Alege altul.' }, 409);
      const tid = 't_' + toHex(crypto.getRandomValues(new Uint8Array(8)));
      await env.DB.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?1, ?2, ?3)').bind(tid, cname.slice(0, 60), Date.now()).run();
      const hash = await hashPassword(String(password));
      await env.DB.prepare('INSERT INTO users (id, pass_hash, created_at, role, tenant) VALUES (?1, ?2, ?3, ?4, ?5)').bind(uid, hash, Date.now(), 'admin', tid).run();
      await env.DB.prepare("INSERT OR IGNORE INTO config_mt (tenant, racks, g) VALUES (?1, '[]', '{}')").bind(tid).run();
      await logAct(env, tid, uid, 'A creat firma „' + cname + '”', 'platforma');
      await touchPresence(env, tid, uid);
      const token = await signJWT({ sub: uid, t: tid, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400 }, await getAuthSecret(env));
      return json({ ok: true, id: uid, tenant: tid }, 200, { 'Set-Cookie': sessionCookie(token) });
    }

    if (p === '/api/register' && method === 'POST') {
      if (tooMany(`reg:${ip}`, 10, 5 * 60000)) return json({ error: 'Prea multe încercări. Revino în câteva minute.' }, 429);
      const { id, password, role } = await readBody(req);
      const uid = String(id || '').trim();
      if (!uid || !password) return json({ error: 'Id și parolă obligatorii.' }, 400);
      if (String(password).length < 4) return json({ error: 'Parola trebuie să aibă minim 4 caractere.' }, 400);

      // adaugarea de colegi se face DOAR de un admin, in firma lui
      const s = await getSession(req, env);
      if (!s) return json({ error: 'Trebuie să fii autentificat. Pentru o firmă nouă folosește „Creează firmă nouă”.' }, 401);
      { const rr = await getRole(env, s.sub); if (rr !== 'admin' && rr !== 'master') return json({ error: 'Doar administratorii pot adăuga utilizatori.' }, 403); }
      const stid = s.t || await getUserTenant(env, s.sub);

      const exists = await env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(uid).first();
      if (exists) return json({ error: 'Acest id de cont e deja folosit (pe întreaga platformă). Alege altul.' }, 409);

      const newRole = ROLES.includes(role) ? role : 'operator';
      const hash = await hashPassword(String(password));
      await env.DB.prepare('INSERT INTO users (id, pass_hash, created_at, role, tenant) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(uid, hash, Date.now(), newRole, stid).run();
      await logAct(env, stid, s.sub, 'A creat contul „' + uid + '” (' + newRole + ')');
      return json({ ok: true, id: uid });
    }

    if (p === '/api/login' && method === 'POST') {
      if (tooMany(`login:${ip}`, 15, 5 * 60000)) return json({ error: 'Prea multe încercări. Revino în câteva minute.' }, 429);
      const { id, password } = await readBody(req);
      const uid = String(id || '').trim();
      const user = uid ? await env.DB.prepare('SELECT id, pass_hash, tenant FROM users WHERE id = ?1').bind(uid).first() : null;
      if (!user || !(await verifyPassword(String(password || ''), user.pass_hash))) {
        return json({ error: 'Id sau parolă greșite.' }, 401);
      }
      const tid = user.tenant || 'default';
      const token = await signJWT({ sub: user.id, t: tid, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400 }, await getAuthSecret(env));
      await logAct(env, tid, user.id, 'S-a autentificat');
      await touchPresence(env, tid, user.id);
      return json({ ok: true, id: user.id }, 200, { 'Set-Cookie': sessionCookie(token) });
    }

    if (p === '/api/logout' && method === 'POST') {
      return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
    }

    // ---------- de aici incolo: totul cere sesiune ----------
    const session = await getSession(req, env);
    const myRole = session ? await getRole(env, session.sub) : null;
    const tid = session ? (session.t || await getUserTenant(env, session.sub)) : null;
    const adminish = (myRole === 'admin' || myRole === 'master'); // master = admin + platforma

    // gestionare utilizatori (doar din propria firma)
    if (p === '/api/users') {
      if (!session) return json({ error: 'Neautentificat.' }, 401);
      if (method === 'GET') {
        const { results } = await env.DB.prepare('SELECT id, created_at, role, tabs FROM users WHERE tenant = ?1 ORDER BY created_at').bind(tid).all();
        const users = (results || []).map(u => ({ id: u.id, created_at: u.created_at, role: u.role, tabs: parseTabs(u.tabs) }));
        return json({ users, me: session.sub, myRole, allTabs: TAB_KEYS, tenantName: await tenantName(env, tid) });
      }
    }
    // setare taburi permise pentru un utilizator (admin, din firma lui)
    const mTabs = p.match(/^\/api\/users\/(.+)\/tabs$/);
    if (mTabs && method === 'POST') {
      if (!session) return json({ error: 'Neautentificat.' }, 401);
      if (!adminish) return json({ error: 'Doar administratorii pot schimba permisiunile.' }, 403);
      const target = decodeURIComponent(mTabs[1]);
      if (await getUserTenant(env, target) !== tid) return json({ error: 'Utilizator din altă firmă.' }, 403);
      const body = await readBody(req);
      let tabs = Array.isArray(body && body.tabs) ? body.tabs.filter(t => TAB_KEYS.includes(t)) : null;
      const store = (!tabs || tabs.length >= TAB_KEYS.length) ? null : JSON.stringify(tabs);
      await env.DB.prepare('UPDATE users SET tabs = ?1 WHERE id = ?2 AND tenant = ?3').bind(store, target, tid).run();
      await logAct(env, tid, session.sub, 'A schimbat taburile pentru „' + target + '”');
      return json({ ok: true, tabs: parseTabs(store) });
    }
    const mUser = p.match(/^\/api\/users\/(.+)$/);
    if (mUser && method === 'DELETE') {
      if (!session) return json({ error: 'Neautentificat.' }, 401);
      if (!adminish) return json({ error: 'Doar administratorii pot șterge utilizatori.' }, 403);
      const target = decodeURIComponent(mUser[1]);
      if (await getUserTenant(env, target) !== tid) return json({ error: 'Utilizator din altă firmă.' }, 403);
      if ((await tenantUserCount(env, tid)) <= 1) return json({ error: 'Nu poți șterge ultimul cont din firmă.' }, 400);
      await env.DB.prepare('DELETE FROM users WHERE id = ?1 AND tenant = ?2').bind(target, tid).run();
      await logAct(env, tid, session.sub, 'A șters contul „' + target + '”');
      const headers = target === session.sub ? { 'Set-Cookie': clearCookie() } : undefined;
      return json({ ok: true }, 200, headers);
    }

    // ---------- datele firmei ----------
    if (p === '/api/company') {
      if (!session) return json({ error: 'Neautentificat.' }, 401);
      if (method === 'GET') { return json(await getCompany(env, tid)); }
      if (method === 'POST' || method === 'PUT') {
        if (!adminish) return json({ error: 'Doar administratorii pot edita datele firmei.' }, 403);
        const body = await readBody(req) || {};
        const name = String(body.name || '').trim().slice(0, 60);
        const d = {};
        for (const k of COMPANY_FIELDS) d[k] = String((body.details && body.details[k]) || '').trim().slice(0, 120);
        await env.DB.prepare('UPDATE tenants SET name = COALESCE(NULLIF(?1, \'\'), name), details = ?2 WHERE id = ?3').bind(name, JSON.stringify(d), tid).run();
        await logAct(env, tid, session.sub, 'A actualizat datele firmei', 'platforma');
        return json({ ok: true, ...(await getCompany(env, tid)) });
      }
    }

    // ---------- MASTER: administrator de platforma (toate firmele) ----------
    // preluare rol master (o singura data, de un admin, cat timp nu exista master)
    if (p === '/api/master/claim' && method === 'POST') {
      if (!session) return json({ error: 'Neautentificat.' }, 401);
      if ((await masterCount(env)) > 0) return json({ error: 'Există deja un cont master.' }, 409);
      if (myRole !== 'admin') return json({ error: 'Doar un administrator poate deveni master.' }, 403);
      await env.DB.prepare("UPDATE users SET role = 'master' WHERE id = ?1").bind(session.sub).run();
      await logAct(env, tid, session.sub, 'A devenit master al platformei', 'platforma');
      return json({ ok: true });
    }
    if (p.startsWith('/api/master/')) {
      if (!session) return json({ error: 'Neautentificat.' }, 401);
      if (myRole !== 'master') return json({ error: 'Doar contul master.' }, 403);

      if (p === '/api/master/tenants' && method === 'GET') {
        const tenants = (await env.DB.prepare('SELECT id, name, details, created_at FROM tenants ORDER BY created_at').all()).results || [];
        const uc = {}; for (const r of (await env.DB.prepare('SELECT tenant, COUNT(*) AS n FROM users GROUP BY tenant').all()).results || []) uc[r.tenant] = r.n;
        const oc = {}; const cutoff = Date.now() - 90 * 1000; for (const r of (await env.DB.prepare('SELECT tenant, COUNT(*) AS n FROM presence_mt WHERE last_seen > ?1 GROUP BY tenant').bind(cutoff).all()).results || []) oc[r.tenant] = r.n;
        const ic = {}; for (const r of (await env.DB.prepare('SELECT tenant, COUNT(*) AS n FROM inventory_mt GROUP BY tenant').all()).results || []) ic[r.tenant] = r.n;
        const list = tenants.map(t => { let d = {}; try { d = t.details ? JSON.parse(t.details) : {}; } catch (e) {} return { id: t.id, name: t.name, details: d, created_at: t.created_at, users: uc[t.id] || 0, online: oc[t.id] || 0, locations: ic[t.id] || 0 }; });
        return json({ tenants: list, myTenant: tid });
      }
      if (p === '/api/master/tenants' && method === 'POST') {
        const body = await readBody(req) || {};
        const cname = String(body.company || '').trim();
        const uid = String(body.id || '').trim();
        if (!cname) return json({ error: 'Completează numele firmei.' }, 400);
        if (!/^[a-zA-Z0-9._-]{2,40}$/.test(uid)) return json({ error: 'Id admin: 2-40 caractere (litere, cifre, . _ -).' }, 400);
        if (String(body.password || '').length < 6) return json({ error: 'Parola: minim 6 caractere.' }, 400);
        if (await env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(uid).first()) return json({ error: 'Id de cont deja folosit.' }, 409);
        const ntid = 't_' + toHex(crypto.getRandomValues(new Uint8Array(8)));
        await env.DB.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?1, ?2, ?3)').bind(ntid, cname.slice(0, 60), Date.now()).run();
        const hash = await hashPassword(String(body.password));
        await env.DB.prepare('INSERT INTO users (id, pass_hash, created_at, role, tenant) VALUES (?1, ?2, ?3, ?4, ?5)').bind(uid, hash, Date.now(), 'admin', ntid).run();
        await env.DB.prepare("INSERT OR IGNORE INTO config_mt (tenant, racks, g) VALUES (?1, '[]', '{}')").bind(ntid).run();
        await logAct(env, ntid, session.sub, 'Master a creat firma „' + cname + '”', 'platforma');
        return json({ ok: true, id: ntid });
      }
      const mT = p.match(/^\/api\/master\/tenants\/(.+)$/);
      if (mT) {
        const targetT = decodeURIComponent(mT[1]);
        if (method === 'POST') { // redenumire
          const body = await readBody(req) || {};
          const nm = String(body.name || '').trim().slice(0, 60);
          if (!nm) return json({ error: 'Nume gol.' }, 400);
          await env.DB.prepare('UPDATE tenants SET name = ?1 WHERE id = ?2').bind(nm, targetT).run();
          return json({ ok: true });
        }
        if (method === 'DELETE') {
          if (targetT === tid) return json({ error: 'Nu poți șterge firma din care faci parte.' }, 400);
          await env.DB.batch([
            env.DB.prepare('DELETE FROM users WHERE tenant = ?1').bind(targetT),
            env.DB.prepare('DELETE FROM config_mt WHERE tenant = ?1').bind(targetT),
            env.DB.prepare('DELETE FROM inventory_mt WHERE tenant = ?1').bind(targetT),
            env.DB.prepare('DELETE FROM presence_mt WHERE tenant = ?1').bind(targetT),
            env.DB.prepare('DELETE FROM activity WHERE tenant = ?1').bind(targetT),
            env.DB.prepare('DELETE FROM tenants WHERE id = ?1').bind(targetT),
          ]);
          return json({ ok: true });
        }
      }
      return json({ error: 'Not found' }, 404);
    }

    // ---------- prezenta (permisa si pentru viewer), izolata pe firma ----------
    if (p === '/api/presence') {
      if (!session) return json({ error: 'Neautentificat.' }, 401);
      await ensureTenancy(env);
      if (method === 'POST') { await touchPresence(env, tid, session.sub); }
      const winMs = 90 * 1000, cutoff = Date.now() - 30 * 60000;
      const { results } = await env.DB.prepare('SELECT user, last_seen FROM presence_mt WHERE tenant = ?1 AND last_seen > ?2 ORDER BY last_seen DESC').bind(tid, cutoff).all();
      const now = Date.now();
      const users = (results || []).map(r => ({ user: r.user, last_seen: r.last_seen, online: (now - r.last_seen) <= winMs }));
      return json({ now, users, me: session.sub });
    }

    // ---------- API date aplicatie (protejat) ----------
    if (p.startsWith('/api/')) {
      if (!session) return json({ error: 'Neautentificat.' }, 401);
      // rolul 'viewer' = doar citire: orice scriere e blocata
      if (method !== 'GET' && myRole === 'viewer') return json({ error: 'Cont de vizualizare — doar citire.' }, 403);
      try {
        if (p === '/api/data' && method === 'GET') {
          const cfg = await getConfig(env, tid);
          const inv = await getInventory(env, tid);
          return json({ racks: cfg.racks, g: cfg.g, inv });
        }
        if (p === '/api/inventory' && method === 'GET') return json(await getInventory(env, tid));

        if (p === '/api/activity' && method === 'GET') {
          await ensureActivity(env);
          const catQ = url.searchParams.get('cat');
          let res;
          if (catQ === 'depozit' || catQ === 'platforma') {
            res = await env.DB.prepare('SELECT ts, user, action, cat FROM activity WHERE tenant = ?1 AND cat = ?2 ORDER BY id DESC LIMIT 300').bind(tid, catQ).all();
          } else {
            res = await env.DB.prepare('SELECT ts, user, action, cat FROM activity WHERE tenant = ?1 ORDER BY id DESC LIMIT 300').bind(tid).all();
          }
          return json({ items: res.results || [] });
        }
        if (p === '/api/activity' && method === 'POST') {
          const body = await readBody(req);
          const action = String((body && body.action) || '').trim();
          const cat = (body && body.cat) === 'depozit' ? 'depozit' : 'platforma';
          if (action) await logAct(env, tid, session.sub, action, cat);
          return json({ ok: true });
        }

        if (p === '/api/config' && method === 'PUT') {
          const body = await readBody(req);
          const racks = Array.isArray(body.racks) ? JSON.stringify(body.racks) : null;
          const g = body.g && typeof body.g === 'object' ? JSON.stringify(body.g) : null;
          await putConfig(env, tid, racks, g);
          return json({ ok: true });
        }

        if (p === '/api/inventory' && method === 'PUT') {
          const body = await readBody(req);
          const obj = body && typeof body === 'object' ? body : {};
          const stmts = [env.DB.prepare('DELETE FROM inventory_mt WHERE tenant = ?1').bind(tid)];
          for (const code of Object.keys(obj)) {
            stmts.push(env.DB.prepare('INSERT OR REPLACE INTO inventory_mt (tenant, code, items) VALUES (?1, ?2, ?3)').bind(tid, code.toUpperCase(), JSON.stringify(obj[code])));
          }
          await env.DB.batch(stmts);
          return json({ ok: true, locations: Object.keys(obj).length });
        }

        const mInv = p.match(/^\/api\/inventory\/(.+)$/);
        if (mInv) {
          const code = mInv[1].toUpperCase();
          if (method === 'PUT') {
            const arr = await readBody(req);
            if (Array.isArray(arr) && arr.length) {
              await env.DB.prepare('INSERT OR REPLACE INTO inventory_mt (tenant, code, items) VALUES (?1, ?2, ?3)').bind(tid, code, JSON.stringify(arr)).run();
            } else {
              await env.DB.prepare('DELETE FROM inventory_mt WHERE tenant = ?1 AND code = ?2').bind(tid, code).run();
            }
            return json({ ok: true });
          }
          if (method === 'DELETE') {
            await env.DB.prepare('DELETE FROM inventory_mt WHERE tenant = ?1 AND code = ?2').bind(tid, code).run();
            return json({ ok: true });
          }
        }
        return json({ error: 'Not found' }, 404);
      } catch (e) {
        return json({ error: String((e && e.message) || e) }, 500);
      }
    }

    // ---------- pagini (front controller) ----------
    if (!session) {
      const setup = (await userCount(env)) === 0;
      return new Response(loginPage(setup), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    // autentificat -> serveste aplicatia direct din bundle-ul Worker-ului, fara cache
    return new Response(APP_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' } });
  },
};

// ---------- pagina de login (inline) ----------
function loginPage(setup) {
  return `<!DOCTYPE html>
<html lang="ro"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${setup ? 'Configurare cont' : 'Autentificare'} — Warehouse Organizer</title>
<style>
  *{box-sizing:border-box} body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
    background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}
  .card{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:28px;width:100%;max-width:360px;box-shadow:0 10px 40px rgba(0,0,0,.4)}
  h1{font-size:20px;margin:0 0 4px} p.sub{margin:0 0 20px;color:#94a3b8;font-size:14px}
  label{display:block;font-size:13px;margin:14px 0 6px;color:#cbd5e1}
  input{width:100%;padding:11px 12px;border-radius:9px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:15px}
  input:focus{outline:none;border-color:#6cb33f}
  button{width:100%;margin-top:20px;padding:12px;border:0;border-radius:9px;background:#6cb33f;color:#08131f;font-weight:700;font-size:15px;cursor:pointer}
  button:hover{background:#57a02c} button:disabled{opacity:.6;cursor:default}
  .err{margin-top:14px;color:#fca5a5;font-size:14px;min-height:18px}
  .toggle{margin-top:16px;text-align:center;font-size:13px;color:#94a3b8}
  .toggle a{color:#6cb33f;text-decoration:none;font-weight:600;cursor:pointer}
  .hidden{display:none}
</style></head><body>
<form class="card" id="f">
  <h1 id="ttl"></h1>
  <p class="sub" id="sub"></p>
  <div id="companyWrap" class="hidden">
    <label>Numele firmei</label>
    <input id="company" autocomplete="organization" placeholder="ex. Depozit SRL">
  </div>
  <label>Id (utilizator)</label>
  <input id="uid" autocomplete="username" required>
  <label>Parolă</label>
  <input id="pwd" type="password" autocomplete="current-password" required>
  <button id="btn" type="submit"></button>
  <div class="err" id="err"></div>
  <div class="toggle" id="toggle"></div>
</form>
<script>
  const FORCE_SIGNUP=${setup ? 'true' : 'false'};
  let mode = FORCE_SIGNUP ? 'signup' : 'login';
  const f=document.getElementById('f'), err=document.getElementById('err'), btn=document.getElementById('btn');
  const companyWrap=document.getElementById('companyWrap'), ttl=document.getElementById('ttl'), sub=document.getElementById('sub'), toggle=document.getElementById('toggle');
  function render(){
    err.textContent='';
    if(mode==='signup'){
      ttl.textContent='Creează o firmă nouă';
      sub.textContent='Firma ta primește o bază de date proprie, separată de celelalte.';
      companyWrap.classList.remove('hidden');
      document.getElementById('pwd').setAttribute('autocomplete','new-password');
      btn.textContent='Creează firma';
      toggle.innerHTML = FORCE_SIGNUP ? '' : 'Ai deja cont? <a id="tg">Autentifică-te</a>';
    } else {
      ttl.textContent='Autentificare';
      sub.textContent='Warehouse Organizer';
      companyWrap.classList.add('hidden');
      document.getElementById('pwd').setAttribute('autocomplete','current-password');
      btn.textContent='Intră';
      toggle.innerHTML = 'Firmă nouă? <a id="tg">Creează un cont de firmă</a>';
    }
    const tg=document.getElementById('tg'); if(tg) tg.addEventListener('click', ()=>{ mode = mode==='signup'?'login':'signup'; render(); });
  }
  render();
  f.addEventListener('submit', async (e)=>{
    e.preventDefault(); err.textContent=''; btn.disabled=true;
    const id=document.getElementById('uid').value.trim(), password=document.getElementById('pwd').value;
    const company=document.getElementById('company').value.trim();
    try{
      const url = mode==='signup' ? '/api/signup' : '/api/login';
      const payload = mode==='signup' ? {company,id,password} : {id,password};
      const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const d=await r.json().catch(()=>({}));
      if(r.ok){ location.reload(); return; }
      err.textContent=d.error||'Eroare.'; btn.disabled=false;
    }catch(ex){ err.textContent='Conexiune eșuată.'; btn.disabled=false; }
  });
</script>
</body></html>`;
}
