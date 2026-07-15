-- Schema D1 pentru spotvision (rafturi depozit)
-- Aplica / actualizeaza cu:
--   npx wrangler d1 execute <DB_NAME> --remote --file=./schema.sql
-- Toate tabelele sunt IF NOT EXISTS -> se poate rula si peste o baza existenta.

CREATE TABLE IF NOT EXISTS config (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  racks TEXT NOT NULL DEFAULT '[]',
  g     TEXT NOT NULL DEFAULT '{}'
);

INSERT OR IGNORE INTO config (id, racks, g) VALUES (1, '[]', '{}');

CREATE TABLE IF NOT EXISTS inventory (
  code  TEXT PRIMARY KEY,
  items TEXT NOT NULL
);

-- Utilizatori (login cu id + parola). Parola: PBKDF2-SHA256, salt per user.
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  pass_hash  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  role       TEXT NOT NULL DEFAULT 'operator'  -- 'admin' | 'operator' | 'viewer'
);

-- Config intern (ex: secretul de semnare a sesiunilor, auto-generat).
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
