-- ================================================================
--  Baza de date SpotVision (Cloudflare D1 / SQLite)
--  Se aplica o singura data pe baza de date creata in Cloudflare:
--    wrangler d1 execute spotvision --remote --file schema.sql
--  (sau din dashboard: D1 -> baza ta -> Console, lipesti tot fisierul)
-- ================================================================

-- Configul aplicatiei: rafturile si setarile.
-- Le tinem ca JSON intr-un singur rand, ca sa pastram exact structura
-- {name, levels, pallets, dims} folosita de aplicatie (schema-raft.html).
CREATE TABLE IF NOT EXISTS config (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  racks TEXT NOT NULL DEFAULT '[]',   -- JSON: [{name,levels,pallets,dims}, ...]
  g     TEXT NOT NULL DEFAULT '{}'    -- JSON: setari cod/afisare {lpref,ppref,ldig,...}
);
INSERT OR IGNORE INTO config (id, racks, g) VALUES (1, '[]', '{}');

-- Inventar: cate un rand pentru fiecare produs de pe o locatie.
--   code  = codul locatiei, ex. A01-N01-R01 (mereu MAJUSCULE)
--   data  = data intrarii YYYY-MM-DD (folosita pentru FIFO)
--   pos   = ordinea produsului in cadrul locatiei
CREATE TABLE IF NOT EXISTS inventory (
  code   TEXT    NOT NULL,
  produs TEXT    NOT NULL,
  cant   REAL    NOT NULL DEFAULT 0,
  data   TEXT    NOT NULL DEFAULT '',
  pos    INTEGER NOT NULL DEFAULT 0
);

-- Index pentru citire/filtrare rapida pe cod locatie.
CREATE INDEX IF NOT EXISTS idx_inventory_code ON inventory(code);
