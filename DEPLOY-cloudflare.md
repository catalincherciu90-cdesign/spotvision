# Deploy pe Cloudflare (Worker + D1)

Aplicația a fost portată de pe serverul local Node (`server.js` + `data.json`) pe
**Cloudflare Workers + D1**. `data.json` devine baza de date D1, iar `schema-raft.html`
e servit ca static asset.

## Structură

```
src/index.js       -> Worker: autentificare + rutele /api/* (D1)
public/index.html  -> HTML-ul aplicației (servit la / doar utilizatorilor logați)
schema.sql         -> schema D1 (config, inventory, users, meta)
wrangler.toml      -> config Worker + binding D1
```

## Autentificare (login cu id + parolă)

Aplicația e protejată: cine nu e logat vede pagina de **login**, nu aplicația.

- **Primul cont** (administrator) se creează liber, direct din pagina de login,
  la prima accesare (formularul „Creează contul de administrator").
- **Colegii** se adaugă apoi din aplicație: butonul **Utilizatori** (dreapta sus) →
  id + parolă. Fiecare intră cu contul lui.
- **Ieșire** (dreapta sus) face logout.
- Parolele sunt stocate hash-uite (PBKDF2-SHA256, salt per user). Sesiunea e un
  cookie semnat (HttpOnly), valabil 30 de zile. Secretul de semnare se generează
  automat și se ține în tabelul `meta`.

> Dacă ai deja o bază D1 din deploy-ul anterior, rulează din nou `schema.sql`
> (comanda de mai jos) ca să adaugi tabelele noi `users` și `meta` — e idempotent,
> nu atinge datele existente (`config`/`inventory`).

Rutele API sunt identice cu cele din serverul local:
`GET /api/data`, `GET /api/inventory`, `PUT /api/config`, `PUT /api/inventory`,
`PUT/DELETE /api/inventory/:code`.

## Pași de deploy (o singură dată)

1. **Găsește D1-ul deja creat:**
   ```bash
   npx wrangler d1 list
   ```
   Copiază `name` și `uuid` (id-ul) în `wrangler.toml` la `database_name` / `database_id`.

2. **Creează tabelele în D1:**
   ```bash
   npx wrangler d1 execute <D1_NAME> --remote --file=./schema.sql
   ```

3. **Publică Worker-ul:**
   ```bash
   npx wrangler deploy
   ```

Gata — aplicația e la `https://spotvision.<subdomeniu>.workers.dev` (sau pe ruta/domeniul tău).

## Deploy prin GitHub Actions

La fiecare push pe `main` (cu modificări în `src/`, `public/`, `wrangler.toml`,
`schema.sql` sau workflow), GitHub Actions rulează automat:
1. Aplică migrarea D1 (`schema.sql` — idempotent, fără pierdere de date)
2. Face deploy la Cloudflare Workers

### Ce trebuie să faci manual (o singură dată)

**Pasul 1 — Adaugă secretul API în GitHub:**
- Mergi la repo → **Settings → Secrets and variables → Actions → New repository secret**
- Nume: `CLOUDFLARE_API_TOKEN`
- Valoare: un token Cloudflare cu permisiunile `Workers Scripts:Edit` și `D1:Edit`
  (generezi din [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens))

**Pasul 2 — Completează datele D1 reale:**

Află `name` și `id`-ul bazei tale D1:
```bash
npx wrangler d1 list
```

Înlocuiește placeholder-ele în **două locuri**:

a) În `wrangler.toml`:
```toml
[[d1_databases]]
binding = "DB"
database_name = "NUMELE_REAL_D1"   # înlocuiește REPLACE_WITH_D1_NAME
database_id   = "uuid-real-d1"     # înlocuiește REPLACE_WITH_D1_ID
```

b) În `.github/workflows/deploy.yml`, la pasul „Aplica migrare D1":
```yaml
command: d1 execute NUMELE_REAL_D1 --remote --file=./schema.sql
         # înlocuiește REPLACE_WITH_D1_NAME cu același nume de mai sus
```

După aceste două modificări, orice push pe `main` face deploy complet automat.

## Dezvoltare locală

```bash
npx wrangler dev        # rulează Worker + D1 local
```
