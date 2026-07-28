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
  try { await env.DB.prepare("CREATE TABLE IF NOT EXISTS signup_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, company TEXT NOT NULL, admin_id TEXT NOT NULL, pass_hash TEXT NOT NULL, email TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT, note TEXT)").run(); } catch (e) {}
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

// ---- clienti (portal) + produse alocate + comenzi ----
let clientsReady = false;
async function ensureClients(env) {
  if (clientsReady) return;
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN products TEXT').run(); } catch (e) { /* exista deja */ }
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN login_token TEXT').run(); } catch (e) { /* exista deja */ }
  try { await env.DB.prepare("CREATE TABLE IF NOT EXISTS client_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, client TEXT NOT NULL, items TEXT NOT NULL, note TEXT, status TEXT NOT NULL DEFAULT 'nou', created_at INTEGER NOT NULL)").run(); } catch (e) {}
  clientsReady = true;
}
function parseProducts(v) {
  if (!v) return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : []; } catch (e) { return []; }
}
// produsele distincte din inventarul firmei (cu total pe stoc), pentru alocare / catalog
function catalogFromInventory(inv) {
  const map = new Map();
  for (const code of Object.keys(inv)) for (const it of inv[code]) {
    const n = String(it.produs || '').trim(); if (!n) continue;
    const k = n.toLowerCase(); const q = +it.cant || 0;
    if (!map.has(k)) map.set(k, { produs: n, cod: it.cod || '', total: 0 });
    map.get(k).total += q;
  }
  return [...map.values()].sort((a, b) => a.produs.localeCompare(b.produs));
}
// stocul detaliat pentru o multime de produse (nume normalizate) — total + loturi FIFO pe locatii
function stockForProducts(inv, assigned) {
  const assignedSet = new Set(assigned.map(s => s.toLowerCase()));
  const map = new Map();
  for (const code of Object.keys(inv)) for (const it of inv[code]) {
    const name = String(it.produs || '');
    if (!assignedSet.has(name.toLowerCase())) continue;
    const k = name.toLowerCase();
    if (!map.has(k)) map.set(k, { produs: name, cod: it.cod || '', total: 0, batches: [] });
    const e = map.get(k); const q = +it.cant || 0;
    e.total += q;
    e.batches.push({ code, cod: it.cod || '', data: it.data || '', cant: q });
  }
  for (const e of map.values()) e.batches.sort((a, b) => String(a.data).localeCompare(String(b.data)));
  // include si produsele alocate care nu au stoc (0)
  for (const name of assigned) { if (!map.has(name.toLowerCase())) map.set(name.toLowerCase(), { produs: name, cod: '', total: 0, batches: [] }); }
  return [...map.values()].sort((a, b) => a.produs.localeCompare(b.produs));
}

// ================================================================
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = decodeURIComponent(url.pathname);
    const method = req.method;
    const ip = req.headers.get('CF-Connecting-IP') || 'local';

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (p.startsWith('/api/')) { await ensureRole(env); await ensureTabs(env); await ensureTenancy(env); await ensureClients(env); }

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

    // ---------- inregistrare firma noua (public) ----------
    // Daca exista deja un master: se creeaza o CERERE, aprobata ulterior de master.
    // Inainte de a exista un master (bootstrap): se creeaza direct firma + admin + login.
    if (p === '/api/signup' && method === 'POST') {
      if (tooMany(`signup:${ip}`, 8, 10 * 60000)) return json({ error: 'Prea multe încercări. Revino în câteva minute.' }, 429);
      const { company, id, password, email } = await readBody(req);
      const uid = String(id || '').trim();
      const cname = String(company || '').trim();
      const mail = String(email || '').trim().slice(0, 120);
      if (!cname) return json({ error: 'Completează numele firmei.' }, 400);
      if (!/^[a-zA-Z0-9._-]{2,40}$/.test(uid)) return json({ error: 'Id-ul contului: 2-40 caractere (litere, cifre, . _ -).' }, 400);
      if (String(password || '').length < 6) return json({ error: 'Parola: minim 6 caractere.' }, 400);
      if (await env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(uid).first()) return json({ error: 'Acest id de cont e deja folosit. Alege altul.' }, 409);
      const hash = await hashPassword(String(password));

      if ((await masterCount(env)) > 0) {
        // deja e o cerere in asteptare pentru acest id?
        const pend = await env.DB.prepare("SELECT id FROM signup_requests WHERE admin_id = ?1 AND status = 'pending'").bind(uid).first();
        if (pend) return json({ error: 'Există deja o cerere în așteptare pentru acest id.' }, 409);
        await env.DB.prepare('INSERT INTO signup_requests (company, admin_id, pass_hash, email, status, created_at) VALUES (?1, ?2, ?3, ?4, \'pending\', ?5)').bind(cname.slice(0, 60), uid, hash, mail, Date.now()).run();
        return json({ pending: true });
      }

      // bootstrap: prima firma / inainte de master -> creare directa + login
      const tid = 't_' + toHex(crypto.getRandomValues(new Uint8Array(8)));
      await env.DB.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?1, ?2, ?3)').bind(tid, cname.slice(0, 60), Date.now()).run();
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

    // ---------- logare automata prin QR (scanabil cu Zebra) ----------
    // QR-ul contine un link /qr?t=<token>; deschis pe dispozitiv -> seteaza sesiunea si intra.
    if (p === '/qr' && method === 'GET') {
      if (tooMany(`qr:${ip}`, 40, 60000)) return new Response('Prea multe încercări. Revino în câteva minute.', { status: 429 });
      await ensureClients(env);
      const t = url.searchParams.get('t') || '';
      let user = null;
      if (/^[a-f0-9]{24,64}$/.test(t)) {
        user = await env.DB.prepare('SELECT id, tenant FROM users WHERE login_token = ?1').bind(t).first();
      }
      if (!user) {
        // token invalid/expirat -> pagina de autentificare normala
        return new Response(null, { status: 302, headers: { Location: '/login' } });
      }
      const tid2 = user.tenant || 'default';
      const token = await signJWT({ sub: user.id, t: tid2, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400 }, await getAuthSecret(env));
      await logAct(env, tid2, user.id, 'S-a autentificat prin QR');
      await touchPresence(env, tid2, user.id);
      return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': sessionCookie(token) } });
    }

    // ---------- de aici incolo: totul cere sesiune ----------
    const session = await getSession(req, env);
    const myRole = session ? await getRole(env, session.sub) : null;
    const tid = session ? (session.t || await getUserTenant(env, session.sub)) : null;
    const adminish = (myRole === 'admin' || myRole === 'master'); // master = admin + platforma
    const isClient = myRole === 'client';

    // conturile de client au acces DOAR la portalul lor (/api/client/*) — nimic din aplicatia de depozit
    if (isClient && p.startsWith('/api/') && !p.startsWith('/api/client/')) {
      return json({ error: 'Cont de client — acces doar la portal.' }, 403);
    }

    // ---------- PORTAL CLIENT (stoc + comenzi) ----------
    if (p.startsWith('/api/client/')) {
      if (!session) return json({ error: 'Neautentificat.' }, 401);
      if (!isClient) return json({ error: 'Doar conturi de client.' }, 403);
      const meRow = await env.DB.prepare('SELECT products FROM users WHERE id = ?1').bind(session.sub).first();
      const assigned = parseProducts(meRow && meRow.products);
      const assignedSet = new Set(assigned.map(s => s.toLowerCase()));

      if (p === '/api/client/stock' && method === 'GET') {
        const inv = await getInventory(env, tid);
        const products = stockForProducts(inv, assigned);
        return json({ products, tenantName: await tenantName(env, tid), client: session.sub });
      }
      return json({ error: 'Not found' }, 404);
    }

    // ---------- CLIENTI: gestionare de admin + catalog produse ----------
    if (p === '/api/products' || p.startsWith('/api/clients')) {
      if (!session) return json({ error: 'Neautentificat.' }, 401);

      // catalog de produse (din inventar) — pt. alocare la client si pt. UI
      if (p === '/api/products' && method === 'GET') {
        return json({ products: catalogFromInventory(await getInventory(env, tid)) });
      }
      if (p === '/api/clients' && method === 'GET') {
        if (!adminish) return json({ error: 'Doar administratorii.' }, 403);
        const rows = (await env.DB.prepare("SELECT id, created_at, products FROM users WHERE tenant = ?1 AND role = 'client' ORDER BY created_at").bind(tid).all()).results || [];
        return json({ clients: rows.map(r => ({ id: r.id, created_at: r.created_at, products: parseProducts(r.products) })) });
      }
      if (p === '/api/clients' && method === 'POST') {
        if (!adminish) return json({ error: 'Doar administratorii pot adăuga clienți.' }, 403);
        const body = await readBody(req) || {};
        const uid = String(body.id || '').trim();
        if (!/^[a-zA-Z0-9._-]{2,40}$/.test(uid)) return json({ error: 'Id client: 2-40 caractere (litere, cifre, . _ -).' }, 400);
        if (String(body.password || '').length < 4) return json({ error: 'Parola: minim 4 caractere.' }, 400);
        if (await env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(uid).first()) return json({ error: 'Acest id e deja folosit. Alege altul.' }, 409);
        const products = Array.isArray(body.products) ? body.products.map(s => String(s).slice(0, 120)).filter(Boolean) : [];
        const hash = await hashPassword(String(body.password));
        await env.DB.prepare('INSERT INTO users (id, pass_hash, created_at, role, tenant, products) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(uid, hash, Date.now(), 'client', tid, JSON.stringify(products)).run();
        await logAct(env, tid, session.sub, 'A creat clientul „' + uid + '” (' + products.length + ' produse alocate)', 'platforma');
        return json({ ok: true, id: uid });
      }
      const mCliP = p.match(/^\/api\/clients\/(.+)\/products$/);
      if (mCliP && method === 'POST') {
        if (!adminish) return json({ error: 'Doar administratorii.' }, 403);
        const target = decodeURIComponent(mCliP[1]);
        const u = await env.DB.prepare('SELECT tenant, role FROM users WHERE id = ?1').bind(target).first();
        if (!u || u.tenant !== tid || u.role !== 'client') return json({ error: 'Client inexistent.' }, 404);
        const body = await readBody(req) || {};
        const products = Array.isArray(body.products) ? body.products.map(s => String(s).slice(0, 120)).filter(Boolean) : [];
        await env.DB.prepare('UPDATE users SET products = ?1 WHERE id = ?2 AND tenant = ?3').bind(JSON.stringify(products), target, tid).run();
        await logAct(env, tid, session.sub, 'A actualizat produsele clientului „' + target + '”', 'platforma');
        return json({ ok: true, products });
      }
      const mCli = p.match(/^\/api\/clients\/(.+)$/);
      if (mCli && method === 'DELETE') {
        if (!adminish) return json({ error: 'Doar administratorii.' }, 403);
        const target = decodeURIComponent(mCli[1]);
        const u = await env.DB.prepare('SELECT tenant, role FROM users WHERE id = ?1').bind(target).first();
        if (!u || u.tenant !== tid || u.role !== 'client') return json({ error: 'Client inexistent.' }, 404);
        await env.DB.prepare('DELETE FROM users WHERE id = ?1 AND tenant = ?2').bind(target, tid).run();
        await logAct(env, tid, session.sub, 'A șters clientul „' + target + '”', 'platforma');
        return json({ ok: true });
      }
      return json({ error: 'Not found' }, 404);
    }

    // gestionare utilizatori (doar din propria firma)
    if (p === '/api/users') {
      if (!session) return json({ error: 'Neautentificat.' }, 401);
      if (method === 'GET') {
        const { results } = await env.DB.prepare("SELECT id, created_at, role, tabs FROM users WHERE tenant = ?1 AND role != 'client' ORDER BY created_at").bind(tid).all();
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
    // token de logare prin QR pentru un utilizator (get/genereaza sau rotate)
    const mQr = p.match(/^\/api\/users\/(.+)\/qr$/);
    if (mQr && (method === 'GET' || method === 'POST')) {
      if (!session) return json({ error: 'Neautentificat.' }, 401);
      if (!adminish) return json({ error: 'Doar administratorii pot genera QR de logare.' }, 403);
      const target = decodeURIComponent(mQr[1]);
      if (await getUserTenant(env, target) !== tid) return json({ error: 'Utilizator din altă firmă.' }, 403);
      await ensureClients(env);
      const row = await env.DB.prepare('SELECT login_token FROM users WHERE id = ?1 AND tenant = ?2').bind(target, tid).first();
      let tok = row && row.login_token;
      const rotate = method === 'POST';
      if (!tok || rotate) {
        tok = toHex(crypto.getRandomValues(new Uint8Array(24)));
        await env.DB.prepare('UPDATE users SET login_token = ?1 WHERE id = ?2 AND tenant = ?3').bind(tok, target, tid).run();
        if (rotate) await logAct(env, tid, session.sub, 'A regenerat QR-ul de logare pentru „' + target + '”', 'platforma');
      }
      return json({ ok: true, id: target, token: tok });
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
      // cereri de inregistrare firma
      if (p === '/api/master/requests' && method === 'GET') {
        const rows = (await env.DB.prepare("SELECT id, company, admin_id, email, status, created_at FROM signup_requests WHERE status = 'pending' ORDER BY created_at").all()).results || [];
        return json({ requests: rows });
      }
      const mReq = p.match(/^\/api\/master\/requests\/(\d+)$/);
      if (mReq && method === 'POST') {
        const rid = parseInt(mReq[1], 10);
        const body = await readBody(req) || {};
        const action = body.action;
        const r = await env.DB.prepare('SELECT * FROM signup_requests WHERE id = ?1').bind(rid).first();
        if (!r) return json({ error: 'Cerere inexistentă.' }, 404);
        if (r.status !== 'pending') return json({ error: 'Cererea a fost deja procesată.' }, 409);
        if (action === 'approve') {
          if (await env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(r.admin_id).first()) {
            await env.DB.prepare("UPDATE signup_requests SET status='rejected', decided_at=?1, decided_by=?2, note='id ocupat' WHERE id=?3").bind(Date.now(), session.sub, rid).run();
            return json({ error: 'Id-ul de admin e deja folosit acum. Cererea a fost respinsă.' }, 409);
          }
          const ntid = 't_' + toHex(crypto.getRandomValues(new Uint8Array(8)));
          await env.DB.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?1, ?2, ?3)').bind(ntid, String(r.company).slice(0, 60), Date.now()).run();
          await env.DB.prepare('INSERT INTO users (id, pass_hash, created_at, role, tenant) VALUES (?1, ?2, ?3, ?4, ?5)').bind(r.admin_id, r.pass_hash, Date.now(), 'admin', ntid).run();
          await env.DB.prepare("INSERT OR IGNORE INTO config_mt (tenant, racks, g) VALUES (?1, '[]', '{}')").bind(ntid).run();
          await env.DB.prepare("UPDATE signup_requests SET status='approved', decided_at=?1, decided_by=?2 WHERE id=?3").bind(Date.now(), session.sub, rid).run();
          await logAct(env, ntid, session.sub, 'Master a aprobat firma „' + r.company + '”', 'platforma');
          return json({ ok: true });
        }
        if (action === 'reject') {
          await env.DB.prepare("UPDATE signup_requests SET status='rejected', decided_at=?1, decided_by=?2, note=?3 WHERE id=?4").bind(Date.now(), session.sub, String(body.note || '').slice(0, 200), rid).run();
          return json({ ok: true });
        }
        return json({ error: 'Acțiune invalidă.' }, 400);
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
    const htmlResp = (body) => new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' } });

    if (session) {
      // clientii primesc DOAR portalul lor, indiferent de path
      if (isClient) {
        const cs = await getCompany(env, tid);
        return htmlResp(clientPage({ tenantName: cs.name || 'Depozit', clientId: session.sub }));
      }
      // echipa depozitului -> aplicatia (ca pana acum, pe orice path, inclusiv deep-link ?loc=)
      return htmlResp(APP_HTML);
    }

    // vizitator neautentificat
    if (p === '/login') {
      const setup = (await userCount(env)) === 0;
      return new Response(loginPage(setup), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    // orice alt path public -> landing page (pagina de prezentare)
    return htmlResp(landingPage());
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
    <label>Email de contact (opțional)</label>
    <input id="email" type="email" autocomplete="email" placeholder="ca să te putem anunța">
  </div>
  <label>Id (utilizator)</label>
  <input id="uid" autocomplete="username" required>
  <label>Parolă</label>
  <input id="pwd" type="password" autocomplete="current-password" required>
  <button id="btn" type="submit"></button>
  <div class="err" id="err"></div>
  <div class="ok" id="ok" style="margin-top:14px;color:#86efac;font-size:14px"></div>
  <div class="toggle" id="toggle"></div>
</form>
<script>
  const FORCE_SIGNUP=${setup ? 'true' : 'false'};
  let mode = FORCE_SIGNUP ? 'signup' : 'login';
  const f=document.getElementById('f'), err=document.getElementById('err'), btn=document.getElementById('btn');
  const companyWrap=document.getElementById('companyWrap'), ttl=document.getElementById('ttl'), sub=document.getElementById('sub'), toggle=document.getElementById('toggle');
  const okEl=document.getElementById('ok');
  function render(){
    err.textContent=''; okEl.textContent='';
    if(mode==='signup'){
      ttl.textContent='Solicită înregistrarea firmei';
      sub.textContent='Trimiți o cerere; după ce administratorul platformei o aprobă, poți intra cu contul ales.';
      companyWrap.classList.remove('hidden');
      document.getElementById('pwd').setAttribute('autocomplete','new-password');
      btn.textContent='Trimite cererea';
      toggle.innerHTML = FORCE_SIGNUP ? '' : 'Ai deja cont? <a id="tg">Autentifică-te</a>';
    } else {
      ttl.textContent='Autentificare';
      sub.textContent='Warehouse Organizer';
      companyWrap.classList.add('hidden');
      document.getElementById('pwd').setAttribute('autocomplete','current-password');
      btn.textContent='Intră';
      toggle.innerHTML = 'Firmă nouă? <a id="tg">Solicită înregistrarea firmei</a>';
    }
    const tg=document.getElementById('tg'); if(tg) tg.addEventListener('click', ()=>{ mode = mode==='signup'?'login':'signup'; render(); });
  }
  render();
  f.addEventListener('submit', async (e)=>{
    e.preventDefault(); err.textContent=''; okEl.textContent=''; btn.disabled=true;
    const id=document.getElementById('uid').value.trim(), password=document.getElementById('pwd').value;
    const company=document.getElementById('company').value.trim(), email=document.getElementById('email').value.trim();
    try{
      const url = mode==='signup' ? '/api/signup' : '/api/login';
      const payload = mode==='signup' ? {company,id,password,email} : {id,password};
      const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const d=await r.json().catch(()=>({}));
      if(d && d.pending){ okEl.textContent='✓ Cererea a fost trimisă. Vei putea intra cu id-ul și parola alese după ce este aprobată.'; f.reset(); btn.disabled=false; return; }
      if(r.ok){ location.href='/'; return; }
      err.textContent=d.error||'Eroare.'; btn.disabled=false;
    }catch(ex){ err.textContent='Conexiune eșuată.'; btn.disabled=false; }
  });
</script>
</body></html>`;
}

// ---------- LANDING PAGE (pagina de prezentare, publica) ----------
function landingPage() {
  return `<!DOCTYPE html>
<html lang="ro"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Warehouse Organizer — organizează-ți depozitul inteligent</title>
<meta name="description" content="Warehouse Organizer: schema locațiilor, inventar FIFO, etichete QR, scanare Zebra, picking și portal pentru clienți. Totul într-o singură aplicație.">
<style>
  *{box-sizing:border-box} html{scroll-behavior:smooth}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1e2b34;background:#f4f6f4;line-height:1.55}
  a{color:inherit}
  .btn{display:inline-block;padding:12px 22px;border-radius:11px;font-weight:700;font-size:15px;text-decoration:none;cursor:pointer;border:0;transition:transform .06s,box-shadow .2s}
  .btn:active{transform:translateY(1px)}
  .btn-primary{background:#4a8f24;color:#fff;box-shadow:0 3px 12px rgba(74,143,36,.35)}
  .btn-primary:hover{background:#3a721c}
  .btn-ghost{background:#fff;color:#1e2b34;border:1.5px solid #d5ddd6}
  .btn-ghost:hover{border-color:#4a8f24;color:#3a721c}
  header.nav{position:sticky;top:0;z-index:10;background:rgba(30,43,52,.97);backdrop-filter:blur(6px);color:#fff}
  .nav-in{max-width:1080px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:14px 20px;gap:12px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:19px;letter-spacing:.2px}
  .brand .logo{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,#6cb33f,#3a721c);display:flex;align-items:center;justify-content:center;font-size:19px}
  .brand small{color:#9fb4a3;font-weight:600;font-size:12px;display:block;margin-top:-2px}
  .hero{max-width:1080px;margin:0 auto;padding:64px 20px 40px;text-align:center}
  .hero h1{font-size:clamp(30px,5vw,50px);line-height:1.1;margin:0 0 16px;letter-spacing:-.5px}
  .hero h1 .g{color:#4a8f24}
  .hero p.lead{font-size:clamp(16px,2.4vw,20px);color:#4b5a62;max-width:640px;margin:0 auto 30px}
  .cta{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
  .pill{display:inline-block;background:#eaf0e8;color:#3a721c;font-weight:700;font-size:13px;padding:6px 14px;border-radius:20px;margin-bottom:22px}
  section{max-width:1080px;margin:0 auto;padding:34px 20px}
  h2.sec{font-size:clamp(23px,3.5vw,32px);text-align:center;margin:0 0 8px;letter-spacing:-.3px}
  p.sub{text-align:center;color:#5c6b73;max-width:600px;margin:0 auto 32px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
  .feat{background:#fff;border:1px solid #e2e7e5;border-radius:15px;padding:22px}
  .feat .ic{font-size:26px;margin-bottom:10px}
  .feat h3{margin:0 0 6px;font-size:17px}
  .feat p{margin:0;color:#5c6b73;font-size:14.5px}
  .split{background:#1e2b34;color:#fff;border-radius:20px;padding:40px 28px;display:grid;grid-template-columns:1.1fr 1fr;gap:30px;align-items:center}
  .split h2{font-size:clamp(22px,3vw,30px);margin:0 0 12px}
  .split p{color:#c3d0c8;margin:0 0 18px;font-size:15.5px}
  .split ul{margin:0 0 22px;padding-left:20px;color:#dbe6df}
  .split li{margin:7px 0}
  .mock{background:#0f1a22;border:1px solid #2c3d47;border-radius:14px;padding:16px}
  .mock .mrow{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-radius:9px;background:#16242d;margin-bottom:8px;font-size:14px}
  .mock .mrow:last-child{margin-bottom:0}
  .mock .q{background:#4a8f24;color:#fff;font-weight:700;border-radius:7px;padding:2px 10px;font-size:13px}
  footer{text-align:center;color:#8a979d;font-size:13px;padding:40px 20px 50px}
  @media(max-width:720px){ .split{grid-template-columns:1fr;padding:28px 20px} .hero{padding:44px 20px 26px} }
</style></head><body>
<header class="nav"><div class="nav-in">
  <div class="brand"><span class="logo">📦</span><span>Warehouse Organizer<small>organizează-ți depozitul</small></span></div>
  <a class="btn btn-primary" href="/login">Autentificare</a>
</div></header>

<div class="hero">
  <span class="pill">📦 Depozit · Inventar · Picking · Portal clienți</span>
  <h1>Depozitul tău, <span class="g">organizat inteligent</span></h1>
  <p class="lead">Schema locațiilor, inventar în timp real cu FIFO, etichete QR, scanare cu aparate Zebra și un portal pentru clienți — totul într-o singură aplicație, partajată cu echipa.</p>
  <div class="cta">
    <a class="btn btn-primary" href="/login">Autentificare echipă</a>
    <a class="btn btn-ghost" href="/login">🔑 Portal clienți</a>
  </div>
</div>

<section id="functii">
  <h2 class="sec">Tot ce-ți trebuie pentru depozit</h2>
  <p class="sub">De la organizarea rafturilor până la comenzile clienților, într-un singur loc.</p>
  <div class="grid">
    <div class="feat"><div class="ic">🗺️</div><h3>Schema locațiilor</h3><p>Vezi rafturile și locațiile pe o hartă interactivă, cu stocul din fiecare poziție.</p></div>
    <div class="feat"><div class="ic">📥</div><h3>Inventar FIFO</h3><p>Intrări și ieșiri pe loturi, cu ordine „cel mai vechi primul”, ca să nu-ți expire marfa.</p></div>
    <div class="feat"><div class="ic">🏷️</div><h3>Etichete QR</h3><p>Printezi etichete A5 cu cod QR pentru fiecare locație și le scanezi direct din telefon.</p></div>
    <div class="feat"><div class="ic">📟</div><h3>Scanare Zebra</h3><p>Aparatele Zebra scanează automat locația și îți arată pe loc stocul și produsele.</p></div>
    <div class="feat"><div class="ic">🛒</div><h3>Picking / culegere</h3><p>Listă de cules ordonată pe traseu, cu cantitățile de luat din fiecare locație.</p></div>
    <div class="feat"><div class="ic">🏢</div><h3>Mai multe firme</h3><p>Fiecare firmă are datele ei, complet izolate. Roluri și permisiuni per utilizator.</p></div>
  </div>
</section>

<section id="clienti">
  <div class="split">
    <div>
      <h2>Un portal dedicat clienților tăi</h2>
      <p>Clienții se autentifică și văd în timp real stocul produselor lor — cu detalii pe loturi și locații. Transparent, mereu la zi.</p>
      <ul>
        <li>Vede doar produsele care îi sunt alocate</li>
        <li>Stoc disponibil, detalii pe loturi (FIFO) și locații</li>
        <li>Informație în timp real, fără telefoane sau emailuri</li>
      </ul>
      <a class="btn btn-primary" href="/login">Intră în portalul de client</a>
    </div>
    <div class="mock">
      <div class="mrow"><span>Cutii carton 60×40</span><span class="q">1 240 buc</span></div>
      <div class="mrow"><span>Folie stretch 500mm</span><span class="q">86 role</span></div>
      <div class="mrow"><span>Bandă adezivă 48mm</span><span class="q">320 buc</span></div>
      <div class="mrow"><span>Paleți EUR</span><span class="q">54 buc</span></div>
    </div>
  </div>
</section>

<footer>
  Warehouse Organizer — organizează-ți depozitul inteligent. &nbsp;·&nbsp; <a href="/login" style="color:#4a8f24;font-weight:600;text-decoration:none">Autentificare</a>
</footer>
</body></html>`;
}

// ---------- PORTAL CLIENT (stoc + comenzi) ----------
function clientPage(opts) {
  const he = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const firm = he(opts.tenantName || 'Depozit');
  const cid = he(opts.clientId || '');
  return `<!DOCTYPE html>
<html lang="ro"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Portal client — ${firm}</title>
<style>
  *{box-sizing:border-box} body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1e2b34;background:#f4f6f4}
  header{background:#1e2b34;color:#fff;padding:12px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
  .brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:17px}
  .brand .logo{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#6cb33f,#3a721c);display:flex;align-items:center;justify-content:center}
  .brand small{display:block;color:#9fb4a3;font-weight:600;font-size:12px;margin-top:-2px}
  .who{display:flex;align-items:center;gap:12px;font-size:13px;color:#c3d0c8}
  .who a{color:#fff;text-decoration:none;background:#33474f;padding:6px 12px;border-radius:8px;font-weight:600}
  .who a:hover{background:#415862}
  .wrap{max-width:820px;margin:18px auto;padding:0 16px}
  .card{background:#fff;border:1px solid #e2e7e5;border-radius:14px;padding:16px}
  h2{font-size:16px;margin:0 0 4px}
  .lead{color:#5c6b73;font-size:13.5px;margin:0 0 14px}
  input{width:100%;padding:10px 11px;border:1px solid #d5ddd6;border-radius:9px;font-size:15px;font-family:inherit}
  input:focus{outline:none;border-color:#4a8f24}
  .search{margin-bottom:12px}
  .prod{border:1px solid #e2e7e5;border-radius:11px;margin-bottom:10px;overflow:hidden}
  .prow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px}
  .pname{font-weight:700;font-size:15px}
  .pcod{font-size:12px;color:#8a979d}
  .pqty{font-weight:800;font-size:19px;color:#3a721c;white-space:nowrap}
  .pqty small{font-size:12px;color:#8a979d;font-weight:600}
  .det{background:#f8faf8;border-top:1px solid #eef2ee;padding:0 14px;max-height:0;overflow:hidden;transition:max-height .2s,padding .2s}
  .det.open{max-height:360px;overflow:auto;padding:10px 14px}
  .drow{display:flex;justify-content:space-between;font-size:13px;color:#5c6b73;padding:5px 0;border-bottom:1px dashed #e2e7e5}
  .drow:last-child{border-bottom:0}
  .toggle{background:none;border:0;color:#4a8f24;font-size:12px;font-weight:700;cursor:pointer;padding:0}
  .empty{color:#8a979d;font-size:14px;text-align:center;padding:20px 0}
</style></head><body>
<header>
  <div class="brand"><span class="logo">📦</span><span>${firm}<small>Portal client · Warehouse Organizer</small></span></div>
  <div class="who"><span>👤 ${cid}</span><a href="#" id="logout">Ieși</a></div>
</header>

<div class="wrap">
  <div class="card">
    <h2>📦 Stocul produselor tale</h2>
    <p class="lead">Vezi în timp real disponibilul produselor alocate ție. Apasă pe „detalii" pentru loturi și locații.</p>
    <input class="search" id="search" placeholder="🔎 Caută produs…">
    <div id="stockList"><p class="empty">Se încarcă…</p></div>
  </div>
</div>

<script>
  var $=function(id){return document.getElementById(id);};
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  var STOCK=[];
  // 401 -> inapoi la pagina publica
  var _f=window.fetch.bind(window);
  window.fetch=function(){return _f.apply(null,arguments).then(function(r){ if(r.status===401) location.href='/'; return r;});};

  function loadStock(){
    fetch('/api/client/stock').then(function(r){return r.json();}).then(function(d){
      STOCK=(d&&d.products)||[]; renderStock();
    }).catch(function(){ $('stockList').innerHTML='<p class="empty">Eroare la încărcare.</p>'; });
  }
  function renderStock(){
    var q=($('search').value||'').trim().toLowerCase();
    var list=STOCK.filter(function(p){ return !q || p.produs.toLowerCase().indexOf(q)>=0 || (p.cod||'').toLowerCase().indexOf(q)>=0; });
    if(!list.length){ $('stockList').innerHTML='<p class="empty">'+(STOCK.length?'Niciun produs găsit.':'Nu ai încă produse alocate. Contactează depozitul.')+'</p>'; return; }
    var html='';
    list.forEach(function(p){
      var i=STOCK.indexOf(p);
      var batches=(p.batches||[]).map(function(b){
        return '<div class="drow"><span>📍 '+esc(b.code)+(b.data?' · lot '+esc(b.data):'')+'</span><span>'+b.cant+' buc</span></div>';
      }).join('')||'<div class="drow"><span>Fără stoc pe locații</span><span>0</span></div>';
      html+='<div class="prod">'
        +'<div class="prow">'
          +'<div><div class="pname">'+esc(p.produs)+'</div>'+(p.cod?'<div class="pcod">cod: '+esc(p.cod)+'</div>':'')
            +' <button class="toggle" data-tg="'+i+'">detalii pe loturi ▾</button></div>'
          +'<div class="pqty">'+p.total+' <small>buc</small></div>'
        +'</div>'
        +'<div class="det" id="det'+i+'">'+batches+'</div>'
      +'</div>';
    });
    $('stockList').innerHTML=html;
    [].forEach.call($('stockList').querySelectorAll('[data-tg]'),function(b){ b.addEventListener('click',function(){ var d=$('det'+b.getAttribute('data-tg')); d.classList.toggle('open'); b.textContent=d.classList.contains('open')?'ascunde loturile ▴':'detalii pe loturi ▾'; }); });
  }
  $('search').addEventListener('input',renderStock);
  $('logout').addEventListener('click',function(e){ e.preventDefault(); fetch('/api/logout',{method:'POST'}).then(function(){location.href='/';}).catch(function(){location.href='/';}); });

  loadStock();
</script>
</body></html>`;
}
