-- =====================================================================
-- Migração 48 — acrescentar um PREÇO à mão, pelo link, na página do vinho
-- do Catálogo (09/10/2026)
--
-- O dono das apps: "também era interessante que eu pudesse inserir os
-- preços de referência apontando a links. Hoje só consigo com IA mas nem
-- sempre funciona (e estou a gastar à toa)". O "Procurar informação" lê o
-- preço da página da loja (migração 41), mas paga a IA para isso, e uma
-- loja que recuse o servidor não dá nada. Aqui é quem corrige o catálogo
-- que cola o link e escreve o preço que lá vê.
--
-- `winecatalog.preco_definir(id, url, preco, colheita)` — só curadores e o
-- admin do catálogo. A LOJA sai do link (`winecatalog.loja_do_link`:
-- Garrafeira Nacional, Granvine, Vinha, Vivino — as quatro que a app
-- conhece; outro site recusa-se). Fica em `ficha -> 'precos' -> <loja>` na
-- forma do script das lojas ({preco, url, colheita, em}), mais
-- `de: "manual"` e `por` (o email; não sai na `catalogo_vinhos` nem na
-- `precos_lojas`, que só dão loja, preço, url, nome, colheita e data).
-- Substitui o que a loja lá tinha — também um preço retirado: é quem
-- corrige o catálogo a dizer que este é o certo.
--
-- O preço de referência (`preco_medio`) vai atrás quando vinha desta loja
-- (`winecatalog.preco_ref_fonte`, da migração 47), e enche-se se estava
-- vazio (`preco_ref_seguinte`). Grava pela `winecatalog.editar`: fica no
-- histórico do vinho.
--
-- Corre depois da 47. Idempotente.
-- =====================================================================

CREATE OR REPLACE FUNCTION winecatalog.loja_do_link(p_url text)
  RETURNS text LANGUAGE sql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT CASE
           WHEN h = 'garrafeiranacional.com' OR h LIKE '%.garrafeiranacional.com' THEN 'garrafeira_nacional'
           WHEN h = 'granvine.com'           OR h LIKE '%.granvine.com'           THEN 'granvine'
           WHEN h = 'vinha.pt'               OR h LIKE '%.vinha.pt'               THEN 'vinha'
           WHEN h = 'vivino.com'             OR h LIKE '%.vivino.com'             THEN 'vivino'
         END
    FROM (SELECT lower(substring(btrim(COALESCE(p_url, '')) from '^https?://([^/:?#@]+)(?:[/:?#]|$)')) AS h) x;
$$;
REVOKE ALL ON FUNCTION winecatalog.loja_do_link(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.loja_do_link(text) TO authenticated;

CREATE OR REPLACE FUNCTION winecatalog.preco_definir(
  p_id bigint, p_url text, p_preco numeric, p_colheita integer DEFAULT NULL)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v_url    text := btrim(COALESCE(p_url, ''));
  v_loja   text;
  v_id     bigint;
  v_ficha  jsonb;
  v_orig   jsonb;
  v_precos jsonb;
  v_ant    jsonb;
  v_campos jsonb;
  v_nova   numeric;
BEGIN
  IF NOT (winecatalog.sou_admin() OR winecatalog.sou_curador()) THEN
    RAISE EXCEPTION 'Só os curadores do catálogo acrescentam preços.';
  END IF;
  IF v_url !~* '^https?://' THEN
    RAISE EXCEPTION 'O link tem de ser o endereço da página (http:// ou https://).';
  END IF;
  v_loja := winecatalog.loja_do_link(v_url);
  IF v_loja IS NULL THEN
    RAISE EXCEPTION 'Só se guardam preços da Garrafeira Nacional, da Granvine, da Vinha ou do Vivino.';
  END IF;
  IF p_preco IS NULL OR p_preco <= 0 OR p_preco > 100000 THEN
    RAISE EXCEPTION 'O preço tem de ser um número maior do que zero.';
  END IF;
  IF p_colheita IS NOT NULL AND (p_colheita < 1900 OR p_colheita > extract(year FROM now())::integer + 1) THEN
    RAISE EXCEPTION 'A colheita tem de ser um ano (ou ficar vazia).';
  END IF;

  -- Uma linha fundida responde pela que ficou.
  v_id := COALESCE((SELECT a.id_para FROM winecatalog.alias a WHERE a.id_de = p_id LIMIT 1), p_id);
  SELECT COALESCE(c.ficha, '{}'::jsonb), COALESCE(c.origens, '{}'::jsonb)
    INTO v_ficha, v_orig
    FROM winecatalog.vinhos c WHERE c.id = v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Linha não encontrada.'; END IF;

  v_precos := CASE WHEN jsonb_typeof(v_ficha -> 'precos') = 'object' THEN v_ficha -> 'precos' ELSE '{}'::jsonb END;
  v_ant := v_precos -> v_loja;
  v_precos := v_precos || jsonb_build_object(v_loja, jsonb_strip_nulls(jsonb_build_object(
    'preco',    round(p_preco, 2),
    'url',      left(v_url, 400),
    -- O nome do produto na loja só se sabe se a página é a mesma de antes.
    'nome',     CASE WHEN jsonb_typeof(v_ant) = 'object' AND v_ant ->> 'url' = v_url THEN v_ant ->> 'nome' END,
    'colheita', p_colheita,
    'em',       to_char(now() AT TIME ZONE 'Europe/Lisbon', 'YYYY-MM-DD'),
    'de',       'manual',
    'por',      NULLIF(lower(COALESCE(auth.email(), '')), ''))));
  v_campos := jsonb_build_object('precos', v_precos);

  -- O preço de referência que vinha desta loja acompanha-a; vazio, enche-se.
  IF winecatalog.preco_ref_fonte(v_ficha, v_orig) = v_loja THEN
    v_nova := round(p_preco, 2);
    v_campos := v_campos || jsonb_build_object('preco_medio', v_nova);
  ELSIF winecatalog.vazio(v_ficha -> 'preco_medio') THEN
    v_nova := winecatalog.preco_ref_seguinte(v_precos);
    IF v_nova IS NOT NULL THEN v_campos := v_campos || jsonb_build_object('preco_medio', v_nova); END IF;
  END IF;

  PERFORM winecatalog.editar(v_id, v_campos);
  RETURN jsonb_build_object('ok', true, 'vinho', v_id, 'loja', v_loja,
    'preco_medio_mudou', v_campos ? 'preco_medio', 'preco_medio', v_nova);
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.preco_definir(bigint, text, numeric, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.preco_definir(bigint, text, numeric, integer) TO authenticated;
