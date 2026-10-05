-- =====================================================================
-- Migração 42 — os LINKS das pesquisas na página do vinho (05/10/2026, o
-- dono das apps: "os links dos vinhos que se capturaram nas pesquisas
-- (com opções de poder remover um ou outro que esteja errado) … é uma
-- cena pública, para todos (só não podem remover, só curadores)").
--
-- As `fontes` de uma linha do catálogo ([{titulo,url}], as páginas de onde
-- as pesquisas tiraram a ficha). A migração 31 deixou-as de fora da
-- `catalogo_vinhos` — lêem-se aqui, UM vinho de cada vez, quando a página
-- dele abre: são links públicos de lojas e produtores, não dizem quem tem
-- o vinho. A quem corrige o catálogo (curadores e o admin) vão também os
-- RETIRADOS (`winecatalog.fontes_retiradas`), para os poder devolver.
-- Retirar e devolver são da WineCatalog (`db/fontes.sql` de lá: a
-- `fonte_retirar`/`fonte_devolver`, e o trigger que impede um link
-- retirado de voltar pela pesquisa seguinte) — corre DEPOIS dela.
-- Idempotente.
-- =====================================================================

CREATE OR REPLACE FUNCTION garrafeira.catalogo_fontes(p_id bigint)
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = garrafeira, winecatalog, public
AS $$
DECLARE
  v_id  bigint;
  v_cur boolean := winecatalog.sou_admin() OR winecatalog.sou_curador();
BEGIN
  IF NOT garrafeira.is_allowed() THEN
    RAISE EXCEPTION 'Sem acesso.';
  END IF;
  -- Uma linha fundida responde pela que ficou.
  v_id := COALESCE((SELECT id_para FROM winecatalog.alias WHERE id_de = p_id), p_id);
  RETURN jsonb_build_object(
    'vinho', v_id,
    'fontes', COALESCE((SELECT fontes FROM winecatalog.vinhos WHERE id = v_id), '[]'::jsonb),
    'retiradas', CASE WHEN v_cur THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object('url', r.url, 'titulo', r.titulo, 'quem', r.quem, 'quando', r.quando)
               ORDER BY r.quando DESC)
        FROM winecatalog.fontes_retiradas r WHERE r.vinho_id = v_id AND r.devolvido_em IS NULL), '[]'::jsonb)
      ELSE '[]'::jsonb END);
END;
$$;

REVOKE ALL ON FUNCTION garrafeira.catalogo_fontes(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.catalogo_fontes(bigint) TO authenticated;
