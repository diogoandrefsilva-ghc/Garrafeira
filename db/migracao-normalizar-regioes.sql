-- ---------------------------------------------------------------------
-- Migração 14 — normalizar as REGIÕES já gravadas
--
-- A função `garrafeira.normalizar_regiao()` e o trigger
-- `vinhos_normalizar_regiao` (em `functions.sql`, idempotentes, correm
-- sempre que a base se monta de novo) já garantem que uma região nova
-- nunca mais entra como "DOURO" ou "Península de Setúbal" — mas não tocam
-- no que já estava gravado. Este ficheiro é o ÚNICO SÍTIO que faz essa
-- correção, e corre uma vez só.
--
-- Antes desta migração (2026-09-13): 65 "Douro" + 2 "DOURO", e 7 "Setúbal"
-- + 9 "Península de Setúbal" — a mesma região, contada como duas em
-- qualquer filtro ou resumo por região.
--
-- Correr DEPOIS de `functions.sql` (precisa de `garrafeira.normalizar_regiao`
-- já existir). É seguro repetir: a segunda vez não encontra nada para
-- mudar. Dispara o trigger `vinhos_catalogo` como qualquer UPDATE
-- normal — o catálogo partilhado (`winecatalog`) recebe a correção pela
-- mesma porta de sempre, sem precisar de nada à parte.
-- ---------------------------------------------------------------------
UPDATE garrafeira.vinhos
   SET regiao = garrafeira.normalizar_regiao(regiao)
 WHERE regiao IS DISTINCT FROM garrafeira.normalizar_regiao(regiao);
