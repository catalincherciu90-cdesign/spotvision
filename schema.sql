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
  role       TEXT NOT NULL DEFAULT 'operator',  -- 'admin' | 'operator' | 'viewer'
  tabs       TEXT,                               -- JSON cu taburile permise; NULL = toate
  tenant     TEXT                                -- firma (gestiune) careia ii apartine
);

-- Gestiuni multiple (firme). Fiecare firma are datele ei, izolate.
CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Config si inventar pe firma (izolat pe tenant).
CREATE TABLE IF NOT EXISTS config_mt (
  tenant TEXT PRIMARY KEY,
  racks  TEXT NOT NULL DEFAULT '[]',
  g      TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS inventory_mt (
  tenant TEXT NOT NULL,
  code   TEXT NOT NULL,
  items  TEXT NOT NULL,
  PRIMARY KEY (tenant, code)
);
CREATE TABLE IF NOT EXISTS presence_mt (
  tenant    TEXT NOT NULL,
  user      TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (tenant, user)
);

-- Config intern (ex: secretul de semnare a sesiunilor, auto-generat).
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- Jurnal de activitate (cine, când, ce acțiune, categorie, firma).
CREATE TABLE IF NOT EXISTS activity (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  user   TEXT NOT NULL,
  action TEXT NOT NULL,
  cat    TEXT NOT NULL DEFAULT 'platforma',
  tenant TEXT
);

-- Prezenta (cine e conectat): ultima activitate a fiecarui utilizator.
CREATE TABLE IF NOT EXISTS presence (
  user      TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL
);
