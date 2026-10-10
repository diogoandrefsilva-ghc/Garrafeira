-- =====================================================================
-- Migração 51 — apagar um vinho do Catálogo que não está em garrafeira
-- nenhuma (10/10/2026)
--
-- O dono das apps: "há alguns vinhos que puxei de algumas cartas de
-- vinhos, mas que na verdade não têm informação nenhuma de jeito … podes
-- criar um botão eliminar vinhos, que só disponibilizas caso não esteja em
-- nenhuma garrafeira?"
--
-- "Em nenhuma garrafeira" é: nenhum vinho de NENHUMA garrafeira ligado a
-- esta linha (`garrafeira.vinhos.catalogo_id`) — com garrafas, na wishlist
-- ou já bebido —, nem às linhas fundidas nela (o `alias`). A app só sabe
-- dos vinhos da garrafeira aberta, por isso quem o diz é a BD, e só o
-- número (nunca de quem).
--
-- Três peças:
--  · `winecatalog.linha_ligados(id)` — quantos vinhos das garrafeiras
--    estão ligados à linha (ou às fundidas nela). Ajudante, sem `GRANT`.
--  · `winecatalog.apagar(id)` — só o admin do catálogo. Recusa se houver
--    um vinho ligado, ou se a linha foi fundida noutra (apaga-se a que
--    ficou). Apaga a linha, as fundidas nela (estacionadas no `alias`: sem
--    a que ficou, voltavam ao Catálogo como linhas vivas), o `alias` que as
--    ligava (senão a `achar` levava as grafias antigas a uma linha morta),
--    as notas da casa e os links retirados dela. A linha INTEIRA (e as
--    fundidas, e o `alias`) fica no `winecatalog.sync_log` (acao
--    `apagar_linha`, a mesma da que se apagou à mão a 02/10/2026): não há
--    "Desfazer", mas há de onde a repor. O histórico (`alteracoes`), os
--    comentários e os reportes ficam — são o registo do que se passou.
--  · `garrafeira.catalogo_fontes` (nova versão da da migração 47) — passa
--    a dar também `ligados` ao admin do catálogo: é por aí que a página do
--    vinho sabe se mostra o "Apagar do Catálogo", sem um pedido a mais.
--
-- Corre depois da 47. Idempotente.
-- =====================================================================

CREATE OR REPLACE FUNCTION winecatalog.linha_ligados(p_id bigint)
  RETURNS integer LANGUAGE sql STABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT count(*)::integer FROM garrafeira.vinhos g
   WHERE g.catalogo_id = p_id
      OR g.catalogo_id IN (SELECT a.id_de FROM winecatalog.alias a WHERE a.id_para = p_id);
$$;
REVOKE ALL ON FUNCTION winecatalog.linha_ligados(bigint) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION winecatalog.apagar(p_id bigint)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v_linha   winecatalog.vinhos%ROWTYPE;
  v_fund    bigint[];
  v_n       integer;
  v_notas   integer;
BEGIN
  IF NOT winecatalog.sou_admin() THEN
    RAISE EXCEPTION 'Só o admin do catálogo apaga vinhos do Catálogo.';
  END IF;
  IF EXISTS (SELECT 1 FROM winecatalog.alias WHERE id_de = p_id) THEN
    RAISE EXCEPTION 'Essa linha foi fundida noutra — apaga a que ficou.';
  END IF;
  SELECT * INTO v_linha FROM winecatalog.vinhos WHERE id = p_id FOR UPDATE;
  IF v_linha.id IS NULL THEN
    RAISE EXCEPTION 'Este vinho já não está no Catálogo — recarrega a página.';
  END IF;

  v_n := winecatalog.linha_ligados(p_id);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Não se apaga: está em % das garrafeiras (com garrafas, na wishlist ou já bebido).',
      CASE WHEN v_n = 1 THEN '1 vinho' ELSE v_n || ' vinhos' END;
  END IF;

  SELECT COALESCE(array_agg(id_de), ARRAY[]::bigint[]) INTO v_fund
    FROM winecatalog.alias WHERE id_para = p_id;

  SELECT count(*)::integer INTO v_notas
    FROM garrafeira.notas_catalogo WHERE catalogo_id = p_id OR catalogo_id = ANY (v_fund);

  -- O registo vem PRIMEIRO, com tudo o que se vai apagar: é ele que deixa
  -- repor a linha à mão. As notas da casa só pelo número (quem deu qual
  -- nunca sai da `notas_catalogo`).
  INSERT INTO winecatalog.sync_log (origem, acao, estado, quem, detalhe)
  VALUES ('garrafeira', 'apagar_linha', 'ok', lower(COALESCE(auth.email(), '')),
    jsonb_build_object(
      'linha',    to_jsonb(v_linha),
      'fundidas', COALESCE((SELECT jsonb_agg(to_jsonb(f)) FROM winecatalog.vinhos f WHERE f.id = ANY (v_fund)), '[]'::jsonb),
      'alias',    COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM winecatalog.alias a WHERE a.id_para = p_id), '[]'::jsonb),
      'notas',    v_notas));

  DELETE FROM garrafeira.notas_catalogo
   WHERE catalogo_id = p_id OR catalogo_id = ANY (v_fund);
  DELETE FROM winecatalog.fontes_retiradas
   WHERE vinho_id = p_id OR vinho_id = ANY (v_fund);
  DELETE FROM winecatalog.alias WHERE id_para = p_id;
  DELETE FROM winecatalog.vinhos WHERE id = p_id OR id = ANY (v_fund);

  RETURN jsonb_build_object('ok', true, 'id', p_id,
    'fundidas', COALESCE(array_length(v_fund, 1), 0), 'notas', v_notas);
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.apagar(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.apagar(bigint) TO authenticated;

-- A da migração 47, mais o `ligados` (só ao admin do catálogo).
CREATE OR REPLACE FUNCTION garrafeira.catalogo_fontes(p_id bigint)
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
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
      ELSE '[]'::jsonb END,
    'precos_retirados', CASE WHEN v_cur THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'loja',     e.key,
               'preco',    CASE WHEN (e.value ->> 'preco') ~ '^\d+(\.\d+)?$' THEN (e.value ->> 'preco')::numeric END,
               'url',      e.value ->> 'url',
               'nome',     e.value ->> 'nome',
               'colheita', CASE WHEN (e.value ->> 'colheita') ~ '^\d{4}$' THEN (e.value ->> 'colheita')::integer END,
               'em',       e.value ->> 'em',
               'quando',   e.value ->> 'retirado_em',
               'quem',     e.value ->> 'retirado_por')
             ORDER BY e.key)
        FROM winecatalog.vinhos c,
             jsonb_each(CASE WHEN jsonb_typeof(c.ficha -> 'precos') = 'object' THEN c.ficha -> 'precos' ELSE '{}'::jsonb END) e
       WHERE c.id = v_id
         AND jsonb_typeof(e.value) = 'object'
         AND COALESCE((e.value ->> 'retirado')::boolean, false)), '[]'::jsonb)
      ELSE '[]'::jsonb END,
    -- Quantos vinhos das garrafeiras estão ligados (o número, nunca de
    -- quem): com zero, a página do vinho mostra o "Apagar do Catálogo".
    'ligados', CASE WHEN winecatalog.sou_admin() THEN winecatalog.linha_ligados(v_id) END);
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.catalogo_fontes(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.catalogo_fontes(bigint) TO authenticated;
