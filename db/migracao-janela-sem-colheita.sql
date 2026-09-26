-- ---------------------------------------------------------------------
-- Migração 16 — sem colheita não há JANELA DE CONSUMO
--
-- `beber_de`/`beber_ate` são ANOS ("beber entre 2026 e 2034"), e esses anos
-- são os de UMA colheita. Num vinho sem ano — o normal na wishlist, e em
-- quem escreve o vinho à pressa — a janela é a de uma colheita qualquer que
-- a IA imaginou, e no ano em que sair a seguinte continua a dizer o mesmo.
-- Não é informação: é um número com ar de facto.
--
-- A app já não a pede nem a propõe sem ano (`IA_JANELA`/`iaCamposPara`) e
-- esconde o campo no formulário; isto é a trave na BD, na tabela e não em
-- cada porta de escrita (formulário, IA, importação, atualização massiva,
-- `aplicar_do_catalogo`) — a que se esquecesse era um buraco calado. É a
-- mesma regra do catálogo (`winecatalog.da_colheita` e o trigger
-- `vinhos_sem_colheita` de lá, em `db/catalogo.sql` do repo WineCatalog).
--
-- Idempotente. Em 2026-09-25 não havia nenhum vinho sem ano com janela.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.vinhos_sem_colheita()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path TO 'garrafeira', 'public'
AS $$
BEGIN
  IF NEW.ano IS NULL THEN
    NEW.beber_de  := NULL;
    NEW.beber_ate := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vinhos_sem_colheita ON garrafeira.vinhos;
CREATE TRIGGER vinhos_sem_colheita
  BEFORE INSERT OR UPDATE ON garrafeira.vinhos
  FOR EACH ROW EXECUTE FUNCTION garrafeira.vinhos_sem_colheita();

UPDATE garrafeira.vinhos SET beber_de = NULL, beber_ate = NULL
 WHERE ano IS NULL AND (beber_de IS NOT NULL OR beber_ate IS NOT NULL);
