// ================================================================
//  Server local pentru aplicatia de rafturi (baza de date locala)
//  Ruleaza cu:  node server.js
//  Nu are dependinte externe - doar Node.js.
//  Colegii din retea deschid:  http://IP-UL-ACESTUI-PC:3000
// ================================================================

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT     = process.env.PORT || 3000;
const DIR      = __dirname;
const HTML     = path.join(DIR, 'schema-raft.html');
const DB_FILE  = path.join(DIR, 'data.json');

// ---- baza de date (fisier JSON, scriere atomica) ----
let db = { racks: [], g: {}, inv: {} };
function loadDB(){
  try{ db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch(e){ db = { racks: [], g: {}, inv: {} }; }
  if(!db.racks) db.racks = [];
  if(!db.g)     db.g = {};
  if(!db.inv)   db.inv = {};
}
function saveDB(){
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
loadDB();

// ---- utilitare ----
function send(res, code, data, type){
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  if(Buffer.isBuffer(data)) res.end(data);
  else if(typeof data === 'string') res.end(data);
  else res.end(JSON.stringify(data));
}
function readBody(req){
  return new Promise((resolve)=>{
    let b=''; req.on('data', c=>{ b+=c; if(b.length>5e7) req.destroy(); });
    req.on('end', ()=>{ try{ resolve(b?JSON.parse(b):{}); }catch(e){ resolve({}); } });
  });
}

// ---- server ----
const server = http.createServer(async (req, res)=>{
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname);

  if(req.method === 'OPTIONS') return send(res, 204, '');

  if(p === '/api/data' && req.method === 'GET') return send(res, 200, db);
  if(p === '/api/inventory' && req.method === 'GET') return send(res, 200, db.inv);

  if(p === '/api/config' && req.method === 'PUT'){
    const body = await readBody(req);
    if(Array.isArray(body.racks)) db.racks = body.racks;
    if(body.g && typeof body.g === 'object') db.g = body.g;
    saveDB();
    return send(res, 200, { ok:true });
  }

  if(p === '/api/inventory' && req.method === 'PUT'){
    const body = await readBody(req);
    db.inv = (body && typeof body === 'object') ? body : {};
    saveDB();
    return send(res, 200, { ok:true, locations:Object.keys(db.inv).length });
  }

  const mInv = p.match(/^\/api\/inventory\/(.+)$/);
  if(mInv){
    const code = mInv[1].toUpperCase();
    if(req.method === 'PUT'){
      const arr = await readBody(req);
      if(Array.isArray(arr) && arr.length) db.inv[code] = arr; else delete db.inv[code];
      saveDB();
      return send(res, 200, { ok:true });
    }
    if(req.method === 'DELETE'){
      delete db.inv[code]; saveDB();
      return send(res, 200, { ok:true });
    }
  }

  if(p === '/' || p === '/index.html' || p === '/schema-raft.html'){
    try{ return send(res, 200, fs.readFileSync(HTML), 'text/html; charset=utf-8'); }
    catch(e){ return send(res, 500, 'Nu gasesc schema-raft.html langa server.js', 'text/plain; charset=utf-8'); }
  }

  send(res, 404, 'Not found', 'text/plain; charset=utf-8');
});

server.listen(PORT, ()=>{
  const ips = [];
  const nets = os.networkInterfaces();
  for(const name in nets) for(const ni of nets[name]) if(ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
  console.log('');
  console.log('  Server pornit. Baza de date: data.json');
  console.log('  Pe acest calculator:  http://localhost:' + PORT);
  ips.forEach(ip => console.log('  In retea (colegi):    http://' + ip + ':' + PORT));
  console.log('  Oprire: Ctrl+C');
  console.log('');
});
