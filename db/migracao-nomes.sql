-- ════════════════════════════════════════════════════════════════════
-- Migração 20 — os NOMES com maiúsculas de gente, nunca em CAPS LOCK
-- ════════════════════════════════════════════════════════════════════
-- A importação por fotografias lê o rótulo como está impresso, e a
-- 26/09/2026 havia na base a "HERDADE DO SOBROSO RESERVA TINTO", a
-- "PÊRA-MANCA VINHO TINTO" (produtor "CARTUXA"), a "TABOADELLA 1255 GRANDE
-- VILLAE BRANCO"… A regra do dono das apps: Herdades, Montes, Quintas…
-- sempre com maiúscula; o "do", o "da", o "de" sempre em minúsculas.
--
-- A REGRA NÃO VIVE AQUI. É a `winecatalog.nome_proprio` (`db/nomes.sql` do
-- repo WineCatalog), a mesma que arruma os nomes do catálogo — duas cópias
-- da mesma regra divergem no dia em que alguém mexe numa só, e o mesmo
-- vinho ficava escrito de uma maneira na garrafeira e de outra no catálogo.
-- Por isso este ficheiro corre DEPOIS do `nomes.sql` de lá. As regras
-- (e porque é que "CARM", "JCA" e "DOC" ficam como estão) estão lá.
--
-- Um trigger em `vinhos`, e não em cada porta de escrita (formulário,
-- importação por fotos, wishlist, IA, atualização massiva) — a que se
-- esquecesse era um buraco calado; é o mesmo desenho do `vinhos_sem_colheita`.
-- SECURITY DEFINER porque a `nome_proprio` não se dá a quem tem login; e se
-- o catálogo não responder, grava-se o nome como veio: é arrumação, nunca
-- pode impedir ninguém de guardar um vinho.
--
-- Idempotente. Numa base existente: `nomes.sql` (WineCatalog) → este.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.vinhos_nomes()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
BEGIN
  BEGIN
    NEW.nome     := winecatalog.nome_proprio(NEW.nome);
    NEW.produtor := winecatalog.nome_proprio(NEW.produtor);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$$;

-- Um trigger dispara sem olhar ao EXECUTE (só o CREATE TRIGGER o pede), e
-- sem isto o linter do Supabase lista-a como SECURITY DEFINER aberta.
REVOKE ALL ON FUNCTION garrafeira.vinhos_nomes() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS vinhos_nomes ON garrafeira.vinhos;
CREATE TRIGGER vinhos_nomes
  BEFORE INSERT OR UPDATE OF nome, produtor ON garrafeira.vinhos
  FOR EACH ROW EXECUTE FUNCTION garrafeira.vinhos_nomes();

-- ---------------------------------------------------------------------
-- E o que já lá estava (26/09/2026: 9 vinhos em três garrafeiras — as três
-- Herdade do Sobroso, a Pêra-Manca, a Taboadella, a Casa Ermelinda
-- Freitas, o "valedevila", e o "D'" da Clefs d'Or e do Leo d'Honor).
--
-- Com o `vinhos_catalogo` DESLIGADO durante o UPDATE: ligado, cada vinho
-- voltava a ser levado ao catálogo como se o dono o tivesse gravado agora,
-- e a `juntar` reescrevia com a força da garrafeira campos que ninguém
-- mexeu. O catálogo arruma os seus nomes sozinho (`nomes.sql`). Nem
-- `atualizado_em`: não foi o dono a mexer (a mesma razão da
-- `escrever_do_catalogo` do batch). Cada vinho corrigido fica no
-- `sync_log`, com o antes e o depois.
-- ---------------------------------------------------------------------
ALTER TABLE garrafeira.vinhos DISABLE TRIGGER vinhos_catalogo;

WITH mudou AS (
  UPDATE garrafeira.vinhos v
     SET nome     = winecatalog.nome_proprio(v.nome),
         produtor = winecatalog.nome_proprio(v.produtor)
    FROM (SELECT id, nome, produtor FROM garrafeira.vinhos) antes
   WHERE antes.id = v.id
     AND (v.nome     IS DISTINCT FROM winecatalog.nome_proprio(v.nome)
       OR v.produtor IS DISTINCT FROM winecatalog.nome_proprio(v.produtor))
  RETURNING v.id, v.garrafeira_id, antes.nome AS nome_antes, antes.produtor AS produtor_antes,
            v.nome, v.produtor
)
INSERT INTO garrafeira.sync_log (origem, acao, estado, quem, detalhe)
SELECT 'migracao', 'nome_capitalizado', 'ok', 'migração 20 (nomes)',
       jsonb_build_object('vinho_id', id, 'garrafeira_id', garrafeira_id,
                          'antes',  jsonb_build_object('nome', nome_antes, 'produtor', produtor_antes),
                          'depois', jsonb_build_object('nome', nome, 'produtor', produtor))
  FROM mudou;

ALTER TABLE garrafeira.vinhos ENABLE TRIGGER vinhos_catalogo;
