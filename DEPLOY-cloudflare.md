# Publicare pe Cloudflare (din GitHub) — partajat cu colegii, în cloud

Acest ghid pune aplicația **online pe Cloudflare**, direct din GitHub, ca un
**Cloudflare Worker cu Static Assets**. Colegii o deschid dintr-un simplu link
(fără să pornească niciun calculator-server, fără rețea locală). Datele sunt
**partajate**, ca la varianta cu `server.js` — doar că în locul fișierului
`data.json` folosim o bază de date reală **Cloudflare D1** (SQL).

> Diferența față de `server.js`: acolo trebuia un PC pornit în firmă. Aici totul
> stă pe Cloudflare, gratuit pentru volume mici, accesibil de oriunde.

## Ce s-a schimbat în proiect

- `src/index.js` — Worker-ul: servește aplicația (`schema-raft.html`) + API-ul.
- `src/db.js` — accesul la baza de date D1.
- `schema.sql` — structura bazei (tabelele `config` și `inventory`).
- `seed.sql` — date de pornire (opțional), generate din `data.json`.
- `wrangler.toml` — configul Worker-ului (Static Assets + binding D1 `DB`).
- `.assetsignore` — ce fișiere NU se publică (cod server, docs).

`schema-raft.html` **nu s-a modificat** — detectează singur că e servit online și
se sincronizează prin `/api/...`. Aceleași fișiere merg în continuare și local
(dublu-click) și cu `server.js`.

---

## Pași (o singură dată, ~10 minute)

### 1. Baza de date D1 (dacă nu e deja creată)
Dashboard: **Storage & Databases → D1 SQL Database → Create** → nume `spotvision`.
> Este deja creată — `database_id`-ul ei e pus în `wrangler.toml`.

### 2. Creează tabelele (și, opțional, datele de pornire)
Deschide baza `spotvision` → tab-ul **Console** și rulează, pe rând:
- tot conținutul din `schema.sql` (creează tabelele `config` și `inventory`);
- *(opțional)* tot conținutul din `seed.sql` (pune raftul A01 + setările, ca baza
  să nu fie goală la prima deschidere).

### 3. Worker-ul conectat la GitHub
Ai creat deja Worker-ul `spotvision`, conectat la repo. La fiecare `git push`,
Cloudflare **rebuild-uiește și publică automat**. Build-ul folosește `wrangler.toml`
și leagă singur baza de date D1 (binding `DB`) — nu trebuie s-o legi manual.

> Dacă un build a eșuat înainte de această versiune, e normal: configul era pentru
> „Pages". Acum e pentru Worker și ar trebui să treacă.

### 4. Activează linkul (URL)
În Worker: **Settings → Domains & Routes** (sau secțiunea „Domains") →
activează **`workers.dev`**. Vei primi un link de forma:
```
https://spotvision.<contul-tau>.workers.dev
```
Deschizi linkul → aplicația e live. Sus apare eticheta verde
**„Conectat la server (partajat cu colegii)"**. Trimite linkul colegilor.

---

## Verificare rapidă
- `https://.../` — se deschide aplicația.
- `https://.../api/data` — trebuie să întoarcă un JSON `{"racks":...}`.
  Dacă vezi „Lipsește baza de date DB", înseamnă că baza nu e legată — verifică
  în **Settings → Bindings** că există binding-ul `DB` către D1 `spotvision`
  (ar trebui adăugat automat din `wrangler.toml` la ultimul deploy).

## Actualizări viitoare
Orice `git push` **republică automat** Worker-ul. Schema bazei se aplică o singură
dată (pasul 2).

## Backup
- Din aplicație: **Inventar → Exportă în Excel** și, pe Schemă, **Salvează în Excel**.
- Din bază: `wrangler d1 export spotvision --remote --output backup.sql`.

## Costuri
Planul **gratuit** Cloudflare (Workers + D1) acoperă un depozit obișnuit fără
probleme. Dacă firma are trafic foarte mare, Cloudflare afișează clar dacă e
nevoie de un plan plătit.

---

## Alternativă: totul din terminal
```bash
npm install -g wrangler
wrangler login
wrangler d1 execute spotvision --remote --file schema.sql   # tabelele
wrangler d1 execute spotvision --remote --file seed.sql     # (optional) date de pornire
wrangler deploy                                             # publica Worker-ul
```
