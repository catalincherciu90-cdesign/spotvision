-- Date de pornire generate din data.json (cu make-seed.mjs).
-- Aplica DUPA schema.sql:
--   wrangler d1 execute spotvision --remote --file seed.sql

INSERT INTO config (id, racks, g) VALUES
  (1, '[{"name":"A01","levels":4,"pallets":3,"dims":{}}]', '{"lpref":"N","ppref":"R"}')
ON CONFLICT(id) DO UPDATE SET racks = excluded.racks, g = excluded.g;

-- (inventarul din data.json este gol — nu inserez randuri in inventory)
