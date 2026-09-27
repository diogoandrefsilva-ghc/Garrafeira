-- =====================================================================
-- Migração 23 — os PRODUTORES OFICIAIS também nas garrafeiras
-- (27/09/2026, fase 1 dos nomes)
--
-- Correr DEPOIS de `db/produtores.sql` do repo WineCatalog (as tabelas
-- `winecatalog.produtores`/`produtor_variantes` e a `produtor_oficial`) e
-- da migração 20 (`migracao-nomes.sql`, o trigger que isto substitui).
--
-- O mesmo produtor escrito de várias maneiras ("Ramos Pinto" / "Adriano
-- Ramos Pinto") passa a ficar sempre com o nome OFICIAL, que o admin do
-- catálogo escolhe (WineCatalog › Produtores, ou o painel do PC). O
-- trigger dos nomes, que já punha as maiúsculas, passa a trocar também a
-- grafia pela oficial — em qualquer escrita (formulário, importação,
-- wishlist, IA, atualização massiva). A regra vive SÓ no catálogo: aqui
-- chama-se a mesma função, como a `nome_proprio`.
--
-- O que já estava escrito é corrigido do lado de lá, no momento em que o
-- admin confirma um produtor (`winecatalog.produtor_definir`, com uma linha
-- no `sync_log` por vinho, origem `winecatalog-batch`). Decisão do dono
-- das apps: vale para todas as garrafeiras.
-- =====================================================================

CREATE OR REPLACE FUNCTION garrafeira.vinhos_nomes()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
BEGIN
  BEGIN
    NEW.nome     := winecatalog.nome_proprio(NEW.nome);
    NEW.produtor := winecatalog.produtor_oficial(winecatalog.nome_proprio(NEW.produtor));
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION garrafeira.vinhos_nomes() FROM PUBLIC, anon, authenticated;
