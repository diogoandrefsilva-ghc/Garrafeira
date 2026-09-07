-- Migração 10 — layout opcional dos locais
--
-- Cada local pode passar a guardar o desenho das suas prateleiras:
-- `{prateleiras:[{nome,capacidade,formato},...]}`. É opcional; vazio
-- continua a ser o comportamento antigo, só com `garrafas.prateleira` e
-- `garrafas.lugar`. O `formato` fica por prateleira (fila/ziguezague/
-- sobrepostos).

ALTER TABLE garrafeira.locais
  ADD COLUMN IF NOT EXISTS layout jsonb;

UPDATE garrafeira.locais
   SET layout = '{"prateleiras":[]}'::jsonb
 WHERE layout IS NULL;

ALTER TABLE garrafeira.locais
  ALTER COLUMN layout SET DEFAULT '{"prateleiras":[]}'::jsonb;

ALTER TABLE garrafeira.locais
  ALTER COLUMN layout SET NOT NULL;
