-- ════════════════════════════════════════════════════════════════════
-- Migração 22 — a nota do Vivino de TODAS as colheitas, ao lado da da colheita
-- ════════════════════════════════════════════════════════════════════
-- Até aqui havia UMA nota (`vivino_nota`/`vivino_avaliacoes`), e com ela
-- duas perguntas diferentes misturadas: a da colheita (a página do Vivino
-- com `?year=`) e a do vinho todo (a página sem ano, e o que o Google e as
-- pesquisas de memória devolvem). Um 4,5 com 40 avaliações de 2019 e um
-- 4,2 com 5000 do vinho todo não dizem a mesma coisa (26/09/2026, o dono).
--
-- Agora são duas:
--   · `vivino_nota`/`vivino_avaliacoes` — a da COLHEITA (como sempre);
--   · `vivino_nota_global`/`vivino_avaliacoes_global` — a de TODAS.
-- Quem as enche é o script do Vivino (WineCatalog, `batch/`), no catálogo;
-- chegam aqui como os outros campos do catálogo (`ficha_catalogo`/
-- `escrever_do_catalogo`, o "≠ catálogo" e o cartão das fichas do painel).
-- Os valores que já existiam NÃO se mexem (decisão do dono): muita da
-- `vivino_nota` de hoje é, na verdade, a global — o script trata disso
-- quando passar por cada vinho.
--
-- A que se MOSTRA num cartão decide-a a app (`notaVivino` em app.js): a da
-- colheita a partir de 100 avaliações, senão a que tiver mais avaliações.
--
-- Idempotente. Numa base existente corre, a seguir a esta, o
-- `catalogo-partilhado.sql` e o `migracao-fichas-catalogo.sql` (que passam
-- a levar as colunas novas). Precisa do `db/catalogo.sql` do WineCatalog
-- com os campos globais na `volatil`/`da_colheita`.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE garrafeira.vinhos
  ADD COLUMN IF NOT EXISTS vivino_nota_global       numeric(3,2),
  ADD COLUMN IF NOT EXISTS vivino_avaliacoes_global integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'vinhos_vivino_global_chk'
                    AND conrelid = 'garrafeira.vinhos'::regclass) THEN
    ALTER TABLE garrafeira.vinhos ADD CONSTRAINT vinhos_vivino_global_chk
      CHECK (vivino_nota_global IS NULL OR (vivino_nota_global >= 0 AND vivino_nota_global <= 5));
  END IF;
END;
$$;
