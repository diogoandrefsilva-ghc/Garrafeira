-- ════════════════════════════════════════════════════════════════════
-- Migração 21 — a REGIÃO normalizada, sem impedir um vinho sem região
-- ════════════════════════════════════════════════════════════════════
-- A 13/09/2026 entrou no Supabase (migração `garrafeira_normalizar_regiao`)
-- um trigger em `vinhos` que passava "DOURO" a "Douro" e a Península de
-- Setúbal a "Setúbal" — mas nunca chegou a este repo, e trazia dois
-- defeitos:
--   1. a regra era uma CÓPIA da `winecatalog.normalizar_regiao`
--      (`db/catalogo.sql` do repo WineCatalog), com o nome
--      `garrafeira.normalizar_regiao` — duas cópias divergem no dia em que
--      alguém mexe numa só;
--   2. a função devolve NULL para uma região vazia, e `vinhos.regiao` é
--      NOT NULL DEFAULT '': gravar um vinho SEM região — um desejo da
--      wishlist, uma garrafa importada por foto sem região lida, o
--      formulário com o campo em branco — rebentava com "null value in
--      column regiao violates not-null constraint". A 26/09/2026 não havia
--      um único vinho sem região em 187, e é por isso: não se conseguia
--      gravar nenhum.
--
-- Agora o trigger chama a função do catálogo (a regra vive só lá, como a
-- dos nomes — migração 20) e uma região vazia fica vazia (''). A cópia sai:
-- só este trigger a chamava. SECURITY DEFINER e com o erro engolido pela
-- mesma razão do `vinhos_nomes`: é arrumação, nunca pode impedir ninguém de
-- guardar um vinho.
--
-- Idempotente. Precisa do `db/catalogo.sql` do WineCatalog.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.vinhos_normalizar_regiao()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
BEGIN
  BEGIN
    NEW.regiao := COALESCE(winecatalog.normalizar_regiao(NEW.regiao), '');
  EXCEPTION WHEN OTHERS THEN
    NEW.regiao := COALESCE(NEW.regiao, '');
  END;
  RETURN NEW;
END;
$$;

-- Um trigger dispara sem olhar ao EXECUTE (só o CREATE TRIGGER o pede), e
-- sem isto o linter do Supabase lista-a como SECURITY DEFINER aberta.
REVOKE ALL ON FUNCTION garrafeira.vinhos_normalizar_regiao() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS vinhos_normalizar_regiao ON garrafeira.vinhos;
CREATE TRIGGER vinhos_normalizar_regiao
  BEFORE INSERT OR UPDATE ON garrafeira.vinhos
  FOR EACH ROW EXECUTE FUNCTION garrafeira.vinhos_normalizar_regiao();

DROP FUNCTION IF EXISTS garrafeira.normalizar_regiao(text);
