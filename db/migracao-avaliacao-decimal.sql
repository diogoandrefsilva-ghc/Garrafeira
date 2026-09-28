-- ════════════════════════════════════════════════════════════════════
-- Migração 25 — a nota de um consumo com uma casa decimal (4,2)
-- ════════════════════════════════════════════════════════════════════
-- A avaliação de uma garrafa bebida era um inteiro de 1 a 5 (as estrelas),
-- e entre um "Muito bom" e um "Do outro mundo" não havia meio-termo: um
-- vinho que foi um pouco melhor do que outro ficava com a mesma nota
-- (28/09/2026, o dono). Passa a `numeric(2,1)`: continua de 1 a 5, agora
-- com uma casa decimal — a mesma precisão da nota do Vivino ao lado.
--
-- Os valores que já existiam passam tal e qual (4 → 4.0).
--
-- A `consumir_garrafa` recebia `p_avaliacao integer`, e trocar o tipo de um
-- parâmetro com CREATE OR REPLACE não substitui a função — cria OUTRA ao
-- lado, e o PostgREST deixa de saber qual chamar ("Could not choose the
-- best candidate function"). Por isso a de inteiro apaga-se aqui antes.
-- O `functions.sql` faz o mesmo DROP, para poder ser corrido sozinho.
--
-- Quem mais lê esta coluna: a `winecatalog.marcas_amigos` (as marcas dos
-- amigos na WineSelection) — faz `avg()` e `round(…, 1)`, que já eram
-- numéricos; não muda nada do lado de lá.
--
-- Idempotente. Numa base existente corre, a seguir a esta, o
-- `functions.sql` (a `consumir_garrafa` com `p_avaliacao numeric`).
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE garrafeira.garrafas DROP CONSTRAINT IF EXISTS garrafas_aval_chk;

ALTER TABLE garrafeira.garrafas
  ALTER COLUMN consumo_avaliacao TYPE numeric(2,1);

ALTER TABLE garrafeira.garrafas ADD CONSTRAINT garrafas_aval_chk
  CHECK (consumo_avaliacao IS NULL OR consumo_avaliacao BETWEEN 1 AND 5);

DROP FUNCTION IF EXISTS garrafeira.consumir_garrafa(bigint, date, text, text, integer);
