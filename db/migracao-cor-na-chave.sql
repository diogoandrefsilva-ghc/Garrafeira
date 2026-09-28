-- =====================================================================
-- Migração 24 — a REGRA DO NOME a cada escrita, e a cor na chave
-- (27/09/2026, fase 4 dos nomes)
--
-- Correr DEPOIS de `cor-na-chave.sql` do repo WineCatalog (a
-- `winecatalog.identidade`, a `nome_normal` da fase 4, a `achar` com a cor)
-- e da migração 23 (`migracao-produtores.sql`, o trigger que isto
-- substitui).
--
-- O que muda aqui:
--   · o trigger dos nomes aplica a regra do catálogo INTEIRA quando o nome
--     é escrito (um vinho novo, ou o nome mudado): as maiúsculas, o produtor
--     oficial, o ano fora do nome (sem ano no vinho, passa a sê-lo), a cor no
--     fim do nome (sai, se for a do vinho) e o produtor à frente do nome (se
--     o resto se aguentar sozinho — "Cartuxa Colheita" fica). É a MESMA
--     função do catálogo: duas cópias da regra divergiam, e o mesmo vinho
--     ficava escrito de duas maneiras;
--   · mudar só o produtor (ou a cor, ou o ano) troca o produtor pelo oficial
--     e não mexe no nome: os nomes que já cá estavam arrumam-se pela
--     simulação do painel do admin (`winecatalog.nomes_rever`), vistos um a
--     um — decisão do dono das apps;
--   · a comparação dos links do Vivino passa a mandar a COR ao catálogo
--     (um tinto nunca vai buscar o link do branco).
-- A app lê de volta o que a BD gravou (`Prefer: return=representation`),
-- por isso quem escrever "Papa Figos Tinto 2021" vê "Papa Figos", 2021.
-- =====================================================================

-- SUBSTITUÍDA pela migração 28 (`migracao-catalogo-id.sql`), que deixa
-- passar tal e qual o nome e o produtor que vêm do catálogo.
CREATE OR REPLACE FUNCTION garrafeira.vinhos_nomes()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  id jsonb;
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' OR NEW.nome IS DISTINCT FROM OLD.nome THEN
      id := winecatalog.identidade(NEW.nome, NEW.produtor, NEW.ano, NEW.tipo, true);
      NEW.nome     := COALESCE(NULLIF(id ->> 'nome', ''), NEW.nome);
      NEW.produtor := COALESCE(id ->> 'produtor', NEW.produtor);
      NEW.ano      := (id ->> 'ano')::integer;
    ELSE
      NEW.produtor := winecatalog.produtor_oficial(winecatalog.nome_proprio(NEW.produtor));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;   -- arrumação: nunca impede ninguém de guardar um vinho
  END;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.vinhos_nomes() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS vinhos_nomes ON garrafeira.vinhos;
CREATE TRIGGER vinhos_nomes
  BEFORE INSERT OR UPDATE OF nome, produtor ON garrafeira.vinhos
  FOR EACH ROW EXECUTE FUNCTION garrafeira.vinhos_nomes();
