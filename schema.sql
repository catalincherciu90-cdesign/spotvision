-- Schema D1 pentru spotvision (rafturi depozit)
-- Aplica cu:  npx wrangler d1 execute <DB_NAME> --remote --file=./schema.sql

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
