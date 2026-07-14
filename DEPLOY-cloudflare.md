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

## Deploy automat (opțional)

`.github/workflows/deploy.yml` face deploy automat la fiecare push pe `main`.
Necesită secretul **`CLOUDFLARE_API_TOKEN`** în setările repo-ului GitHub
(Settings → Secrets and variables → Actions).

## Dezvoltare locală

```bash
npx wrangler dev        # rulează Worker + D1 local
```
