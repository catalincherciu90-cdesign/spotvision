# Publicare pe Cloudflare (din GitHub) — partajat cu colegii, în cloud

Acest ghid pune aplicația **online pe Cloudflare**, direct din GitHub. Colegii o
deschid dintr-un simplu link (fără să pornească niciun calculator-server, fără
rețea locală). Datele sunt **partajate**, ca la varianta cu `server.js` — doar că
în locul fișierului `data.json` folosim o bază de date reală **Cloudflare D1** (SQL).

> Diferența față de `server.js`: acolo trebuia un PC pornit în firmă. Aici totul
> stă pe Cloudflare, gratuit pentru volume mici, accesibil de oriunde.

## Ce s-a schimbat în proiect

- `schema.sql` — structura bazei de date (tabelele `config` și `inventory`).
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

### 2. Creează baza de date D1
În dashboard: **Storage & Databases → D1 SQL Database → Create**.
- Nume: `spotvision`.
- După creare, deschide tab-ul **Console** al bazei și **lipește tot conținutul
  fișierului `schema.sql`**, apoi rulează. Asta creează tabelele. (Poți verifica:
  ar trebui să vezi tabelele `config` și `inventory`.)

### 3. Conectează GitHub și creează proiectul Pages
1. **Workers & Pages → Create → Pages → Connect to Git**.
2. Autorizează GitHub și alege repo-ul `spotvision`, branch-ul pe care e codul.
3. La **Build settings** lasă totul gol:
   - Framework preset: **None**
   - Build command: *(gol)*
   - Build output directory: `.` *(un punct)*
4. **Save and Deploy**. Prima publicare durează ~1 minut.

### 4. Leagă baza de date la aplicație (pasul cheie!)
În proiectul Pages: **Settings → Functions (sau Bindings) → D1 database bindings → Add binding**.
- **Variable name:** `DB`  ← exact așa, cu majuscule.
- **D1 database:** cea creată la pasul 2 (`spotvision`).
- Salvează, apoi **Deployments → Retry deployment** (ca binding-ul să intre în vigoare).

> Dacă uiți acest pas, aplicația se deschide dar arată eroarea
> „Lipsește baza de date DB". Atunci întoarce-te aici și leag-o.

### 5. Gata
Primești un link de forma `https://spotvision.pages.dev`. Trimite-l colegilor.
Sus în aplicație apare eticheta verde **„Conectat la server (partajat cu colegii)"**.
Orice modificare se vede la toți în câteva secunde.

---

## Actualizări viitoare
Orice `git push` pe branch-ul conectat **republică automat** aplicația. Nu mai ai
nimic de făcut. (Schema bazei de date se aplică o singură dată, la pasul 2.)

## Backup
- Din aplicație: tab-ul **Inventar → Exportă inventarul în Excel** și, pe Schemă,
  **Salvează valorile în Excel**.
- Din bază: `wrangler d1 export spotvision --remote --output backup.sql`.

## Costuri
Planul **gratuit** Cloudflare D1 acoperă un depozit obișnuit fără probleme
(milioane de citiri și mii de scrieri pe zi). Dacă firma are trafic foarte mare,
Cloudflare afișează clar dacă e nevoie de un plan plătit.

---

## Alternativă rapidă (fără dashboard), din terminal
Dacă vrei să faci totul din linia de comandă:

```bash
npm install -g wrangler
wrangler login

# 1. creeaza baza de date (copiaza "database_id"-ul afisat)
wrangler d1 create spotvision

# 2. pune database_id in wrangler.toml (blocul [[d1_databases]], decomentat)

# 3. aplica structura tabelelor
wrangler d1 execute spotvision --remote --file schema.sql

# 4. publica aplicatia
wrangler pages deploy .
```
