# Deploy pe Cloudflare (Worker + D1)

Aplicația a fost portată de pe serverul local Node (`server.js` + `data.json`) pe
**Cloudflare Workers + D1**. `data.json` devine baza de date D1, iar `schema-raft.html`
e servit ca static asset.

## Structură

```
src/index.js       -> Worker: rutele /api/* (D1)
public/index.html  -> HTML-ul aplicației (copie a schema-raft.html), servit la /
schema.sql         -> schema bazei de date D1 (tabelele config + inventory)
wrangler.toml      -> config Worker + binding D1
```

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
