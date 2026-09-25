-- ---------------------------------------------------------------------
-- Migração 15 — a WISHLIST (vinhos que se querem ter)
--
-- Um vinho da wishlist é uma linha normal de `garrafeira.vinhos` — a mesma
-- ficha, a mesma procura da IA, as mesmas castas — sem garrafas e com
-- `desejado = true`. Não é uma tabela à parte de propósito: passar um
-- desejo para a garrafeira é só desligar a marca e acrescentar garrafas,
-- sem copiar a ficha de um sítio para o outro (duas cópias da mesma ficha
-- divergem no dia em que se edita uma). E vem com a RLS de sempre: é da
-- garrafeira do vinho, `pode_ver`/`pode_mexer` como tudo o resto.
--
-- Correr DEPOIS desta: `db/catalogo-partilhado.sql` (a `catalogar_vinho`
-- passa a saltar os vinhos da wishlist — quem os escreveu não tem a garrafa
-- na mão, e o catálogo dava-lhes a força de quem tem). É idempotente.
-- ---------------------------------------------------------------------
ALTER TABLE garrafeira.vinhos
  ADD COLUMN IF NOT EXISTS desejado boolean NOT NULL DEFAULT false;

-- A wishlist é uma pergunta de cada garrafeira ("o que é que eu quero?"),
-- e são poucas linhas no meio de muitas: um índice parcial chega.
CREATE INDEX IF NOT EXISTS vinhos_desejados_idx
  ON garrafeira.vinhos (garrafeira_id) WHERE desejado;
