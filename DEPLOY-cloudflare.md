# Publicare pe Cloudflare (din GitHub) — partajat cu colegii, în cloud

Acest ghid pune aplicația **online pe Cloudflare**, direct din GitHub. Colegii o
deschid dintr-un simplu link (fără să pornească niciun calculator-server, fără
rețea locală). Datele sunt **partajate**, ca la varianta cu `server.js` — doar că
în locul fișierului `data.json` folosim baza de date Cloudflare (**KV**).

> Diferența față de `server.js`: acolo trebuia un PC pornit în firmă. Aici totul
> stă pe Cloudflare, gratuit pentru volume mici, accesibil de oriunde.

## Ce s-a schimbat în proiect

- `functions/` — mică logică de server rescrisă pentru Cloudflare (înlocuiește `server.js`):
  - `GET  /api/data` — configul + tot inventarul
  - `PUT  /api/config` — salvează rafturile și setările
  - `GET/PUT /api/inventory` — citește / înlocuiește tot inventarul
  - `PUT/DELETE /api/inventory/:cod` — o singură locație
- `_redirects` — face ca linkul principal `/` să deschidă `schema-raft.html`.
- `wrangler.toml` — configul proiectului Cloudflare.

`schema-raft.html` **nu s-a modificat** — detectează singur că e servit online și
se sincronizează prin `/api/...`. Aceleași fișiere merg în continuare și local
(dublu-click) și cu `server.js`.

---

## Pași (o singură dată, ~10 minute)

### 1. Cont Cloudflare
Intră pe https://dash.cloudflare.com și fă-ți un cont gratuit (dacă nu ai).

### 2. Creează baza de date KV
În dashboard: **Storage & Databases → KV → Create a namespace**.
- Nume: `spotvision` (orice nume).
- După creare rămâi în pagină; îl vei lega la aplicație la pasul 4.

### 3. Conectează GitHub și creează proiectul Pages
1. **Workers & Pages → Create → Pages → Connect to Git**.
2. Autorizează GitHub și alege repo-ul `spotvision`, branch-ul pe care e codul.
3. La **Build settings** lasă totul gol:
   - Framework preset: **None**
   - Build command: *(gol)*
   - Build output directory: `.` *(un punct)*
4. **Save and Deploy**. Prima publicare durează ~1 minut.

### 4. Leagă baza de date KV la aplicație (pasul cheie!)
În proiectul Pages: **Settings → Functions (sau Bindings) → KV namespace bindings → Add binding**.
- **Variable name:** `RAFT_DB`  ← exact așa, cu majuscule.
- **KV namespace:** cel creat la pasul 2.
- Salvează, apoi **Deployments → Retry deployment** (ca binding-ul să intre în vigoare).

> Dacă uiți acest pas, aplicația se deschide dar arată eroarea
> „Lipsește binding-ul KV RAFT_DB". Atunci întoarce-te aici și leagă-l.

### 5. Gata
Primești un link de forma `https://spotvision.pages.dev`. Trimite-l colegilor.
Sus în aplicație apare eticheta verde **„Conectat la server (partajat cu colegii)"**.
Orice modificare se vede la toți în câteva secunde.

---

## Actualizări viitoare
Orice `git push` pe branch-ul conectat **republică automat** aplicația. Nu mai ai
nimic de făcut.

## Backup
Din aplicație: tab-ul **Inventar → Exportă inventarul în Excel** și, pe Schemă,
**Salvează valorile în Excel**. Le poți reîncărca oricând. (Cloudflare păstrează
oricum datele în KV.)

## Costuri
Planul **gratuit** Cloudflare acoperă un depozit obișnuit fără probleme (mii de
citiri/scrieri pe zi). Dacă firma are trafic foarte mare, Cloudflare afișează
clar dacă e nevoie de un plan plătit.

---

## Alternativă rapidă (fără GitHub), din terminal
Dacă vrei să publici de pe calculatorul tău fără interfața web:

```bash
npm install -g wrangler
wrangler login
wrangler kv namespace create RAFT_DB      # copiază "id"-ul afișat
# pune id-ul în wrangler.toml (blocul [[kv_namespaces]], decomentat)
wrangler pages deploy .
```
