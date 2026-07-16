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

// ---- rate limit (best-effort, per-izolat) ----
const rl = new Map();
function tooMany(key, max, windowMs) {
  const now = Date.now();
  const e = rl.get(key) || { n: 0, reset: now + windowMs };
  if (now > e.reset) { e.n = 0; e.reset = now + windowMs; }
  e.n++; rl.set(key, e);
  return e.n > max;
}

// ---- acces D1 (date aplicatie) ----
async function getConfig(env) {
  const row = await env.DB.prepare('SELECT racks, g FROM config WHERE id = 1').first();
  return { racks: row ? JSON.parse(row.racks) : [], g: row ? JSON.parse(row.g) : {} };
}
async function getInventory(env) {
  const { results } = await env.DB.prepare('SELECT code, items FROM inventory').all();
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

    if (p.startsWith('/api/')) await ensureRole(env);

    // ---------- rute publice de auth ----------
    if (p === '/api/auth-status' && method === 'GET') {
      const session = await getSession(req, env);
      const setup = (await userCount(env)) === 0;
      const role = session ? await getRole(env, session.sub) : null;
      return json({ setup, authenticated: !!session, id: session ? session.sub : null, role });
    }

    if (p === '/api/register' && method === 'POST') {
      if (tooMany(`reg:${ip}`, 10, 5 * 60000)) return json({ error: 'Prea multe încercări. Revino în câteva minute.' }, 429);
      const { id, password, role } = await readBody(req);
      const uid = String(id || '').trim();
      if (!uid || !password) return json({ error: 'Id și parolă obligatorii.' }, 400);
      if (String(password).length < 4) return json({ error: 'Parola trebuie să aibă minim 4 caractere.' }, 400);

      const count = await userCount(env);
      const session = await getSession(req, env);
      // primul cont e liber (bootstrap admin); ulterior doar ADMINII pot adauga colegi
      if (count > 0 && !session) return json({ error: 'Trebuie să fii autentificat ca să adaugi conturi.' }, 401);
      if (count > 0 && (await getRole(env, session.sub)) !== 'admin') return json({ error: 'Doar administratorii pot adăuga utilizatori.' }, 403);

      const exists = await env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(uid).first();
      if (exists) return json({ error: 'Există deja un cont cu acest id.' }, 409);

      // primul cont = admin; urmatoarele = rolul ales (implicit operator)
      const newRole = count === 0 ? 'admin' : (ROLES.includes(role) ? role : 'operator');
      const hash = await hashPassword(String(password));
      await env.DB.prepare('INSERT INTO users (id, pass_hash, created_at, role) VALUES (?1, ?2, ?3, ?4)')
        .bind(uid, hash, Date.now(), newRole).run();

      // la bootstrap (primul cont) auto-login
      if (count === 0) {
        const token = await signJWT({ sub: uid, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400 }, await getAuthSecret(env));
        return json({ ok: true, id: uid }, 200, { 'Set-Cookie': sessionCookie(token) });
      }
      return json({ ok: true, id: uid });
    }

    if (p === '/api/login' && method === 'POST') {
      if (tooMany(`login:${ip}`, 15, 5 * 60000)) return json({ error: 'Prea multe încercări. Revino în câteva minute.' }, 429);
      const { id, password } = await readBody(req);
      const uid = String(id || '').trim();
      const user = uid ? await env.DB.prepare('SELECT id, pass_hash FROM users WHERE id = ?1').bind(uid).first() : null;
      if (!user || !(await verifyPassword(String(password || ''), user.pass_hash))) {
        return json({ error: 'Id sau parolă greșite.' }, 401);
      }
      const token = await signJWT({ sub: user.id, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400 }, await getAuthSecret(env));
      return json({ ok: true, id: user.id }, 200, { 'Set-Cookie': sessionCookie(token) });
    }

    if (p === '/api/logout' && method === 'POST') {
      return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
    }

    // ---------- de aici incolo: totul cere sesiune ----------
    const session = await getSession(req, env);
    const myRole = session ? await getRole(env, session.sub) : null;

    // gestionare utilizatori
    if (p === '/api/users') {
      if (!session) return json({ error: 'Neautentificat.' }, 401);
      if (method === 'GET') {
        const { results } = await env.DB.prepare('SELECT id, created_at, role FROM users ORDER BY created_at').all();
        return json({ users: results || [], me: session.sub, myRole });
      }
    }
    const mUser = p.match(/^\/api\/users\/(.+)$/);
    if (mUser && method === 'DELETE') {
      if (!session) return json({ error: 'Neautentificat.' }, 401);
      if (myRole !== 'admin') return json({ error: 'Doar administratorii pot șterge utilizatori.' }, 403);
      const target = decodeURIComponent(mUser[1]);
      if ((await userCount(env)) <= 1) return json({ error: 'Nu poți șterge ultimul cont.' }, 400);
      await env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(target).run();
      const headers = target === session.sub ? { 'Set-Cookie': clearCookie() } : undefined;
      return json({ ok: true }, 200, headers);
    }

    // ---------- API date aplicatie (protejat) ----------
    if (p.startsWith('/api/')) {
      if (!session) return json({ error: 'Neautentificat.' }, 401);
      // rolul 'viewer' = doar citire: orice scriere e blocata
      if (method !== 'GET' && myRole === 'viewer') return json({ error: 'Cont de vizualizare — doar citire.' }, 403);
      try {
        if (p === '/api/data' && method === 'GET') {
          const cfg = await getConfig(env);
          const inv = await getInventory(env);
          return json({ racks: cfg.racks, g: cfg.g, inv });
        }
        if (p === '/api/inventory' && method === 'GET') return json(await getInventory(env));

        if (p === '/api/config' && method === 'PUT') {
          const body = await readBody(req);
          const racks = Array.isArray(body.racks) ? JSON.stringify(body.racks) : null;
          const g = body.g && typeof body.g === 'object' ? JSON.stringify(body.g) : null;
          await env.DB.prepare('UPDATE config SET racks = COALESCE(?1, racks), g = COALESCE(?2, g) WHERE id = 1').bind(racks, g).run();
          return json({ ok: true });
        }

        if (p === '/api/inventory' && method === 'PUT') {
          const body = await readBody(req);
          const obj = body && typeof body === 'object' ? body : {};
          const stmts = [env.DB.prepare('DELETE FROM inventory')];
          for (const code of Object.keys(obj)) {
            stmts.push(env.DB.prepare('INSERT OR REPLACE INTO inventory (code, items) VALUES (?1, ?2)').bind(code.toUpperCase(), JSON.stringify(obj[code])));
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
              await env.DB.prepare('INSERT OR REPLACE INTO inventory (code, items) VALUES (?1, ?2)').bind(code, JSON.stringify(arr)).run();
            } else {
              await env.DB.prepare('DELETE FROM inventory WHERE code = ?1').bind(code).run();
            }
            return json({ ok: true });
          }
          if (method === 'DELETE') {
            await env.DB.prepare('DELETE FROM inventory WHERE code = ?1').bind(code).run();
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
</style></head><body>
<form class="card" id="f">
  <h1>${setup ? 'Creează contul de administrator' : 'Autentificare'}</h1>
  <p class="sub">${setup ? 'Primul cont din aplicație. Cu el vei putea adăuga apoi colegi.' : 'Warehouse Organizer'}</p>
  <label>Id (utilizator)</label>
  <input id="uid" autocomplete="username" autofocus required>
  <label>Parolă</label>
  <input id="pwd" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required>
  <button id="btn" type="submit">${setup ? 'Creează cont' : 'Intră'}</button>
  <div class="err" id="err"></div>
</form>
<script>
  const SETUP=${setup ? 'true' : 'false'};
  const f=document.getElementById('f'), err=document.getElementById('err'), btn=document.getElementById('btn');
  f.addEventListener('submit', async (e)=>{
    e.preventDefault(); err.textContent=''; btn.disabled=true;
    const id=document.getElementById('uid').value.trim(), password=document.getElementById('pwd').value;
    try{
      const r=await fetch(SETUP?'/api/register':'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,password})});
      const d=await r.json().catch(()=>({}));
      if(r.ok){ location.reload(); return; }
      err.textContent=d.error||'Eroare.'; btn.disabled=false;
    }catch(ex){ err.textContent='Conexiune eșuată.'; btn.disabled=false; }
  });
</script>
</body></html>`;
}
