-- =====================================================================
-- Migração 47 — retirar um PREÇO na página do vinho do Catálogo
-- (08/10/2026)
--
-- O dono das apps: "no detalhe de um vinho, no Catálogo, quero poder
-- apagar preços de referência (de lojas ou do Vivino), conforme posso
-- fazer com os sites — tipo ter logo ali uma cruz para apagar".
--
-- Retirar NÃO é apagar a entrada: é a marca que o painel do PC já usa
-- (Editar › Fontes de preço) — `retirado: true` e `retirado_em` na loja,
-- dentro de `ficha -> 'precos'`. Apagada, a corrida seguinte do script das
-- lojas (ou do Vivino) punha lá o mesmo número, que é o que a página diz;
-- marcada, o script salta essa loja (`retirada()` no
-- `batch/vivino-verificar.mjs` da WineCatalog), a `catalogo_precos_por`
-- (migração 41) não a reescreve com a mesma página, e a `precos_lojas`
-- (17) e a `catalogo_vinhos` (31) deixam-na de fora.
--
-- O PREÇO DE REFERÊNCIA (`preco_medio`) vai atrás quando vinha dessa loja
-- — a regra do `fonteDoPrecoRef` do painel do PC, tal e qual: pela origem
-- (`loja-…`, `vivino-…`) ou, sem ela, pelo número igual; e passa à loja
-- seguinte que sobra (Garrafeira Nacional → Granvine → Vinha → Vivino), ou
-- fica vazio se não sobrar nenhuma. Sem isto o número retirado continuava
-- na ficha como "Preço de referência".
--
-- Três peças:
--  · `winecatalog.preco_retirar(id, loja, url)` — só curadores e o admin
--    do catálogo. O `url` é o que se viu: se o script trocou a página
--    entretanto, recusa (retirava-se um preço que ninguém viu).
--  · `winecatalog.preco_devolver(id, loja)` — tira a marca; se a ficha
--    ficou sem preço de referência, volta a ter o desta loja (ou o da
--    primeira que sobra).
--  · `garrafeira.catalogo_fontes` (nova versão da da migração 42) — passa
--    a dar também os preços retirados (`precos_retirados`), só a quem
--    corrige o catálogo, para os poder devolver.
-- As duas primeiras gravam pela `winecatalog.editar`: a mesma porta das
-- outras correções, com a linha no `sync_log` — o histórico do vinho
-- mostra-o e o "Repor" desfaz.
--
-- Corre depois da 42. Idempotente.
-- =====================================================================

-- A loja de onde veio o preço de referência (`fonteDoPrecoRef` do painel).
CREATE OR REPLACE FUNCTION winecatalog.preco_ref_fonte(p_ficha jsonb, p_origens jsonb)
  RETURNS text LANGUAGE plpgsql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v_precos jsonb := CASE WHEN jsonb_typeof(p_ficha -> 'precos') = 'object' THEN p_ficha -> 'precos' ELSE '{}'::jsonb END;
  v_m      numeric := CASE WHEN (p_ficha ->> 'preco_medio') ~ '^\d+(\.\d+)?$' THEN (p_ficha ->> 'preco_medio')::numeric END;
  v_og     text := COALESCE(p_origens -> 'preco_medio' ->> 'o', '');
  v_pela   text;
BEGIN
  IF v_m IS NULL OR v_m <= 0 THEN RETURN NULL; END IF;
  v_pela := CASE WHEN v_og LIKE 'loja-%' THEN replace(substr(v_og, 6), '-', '_')
                 WHEN v_og LIKE 'vivino-%' THEN 'vivino' END;
  IF v_pela IS NOT NULL THEN
    RETURN CASE WHEN jsonb_typeof(v_precos -> v_pela) = 'object' THEN v_pela END;
  END IF;
  -- Escrito à mão (ou por uma pesquisa) não é de loja nenhuma.
  IF v_og IN ('catalogo-admin', 'catalogo-pesquisa') THEN RETURN NULL; END IF;
  RETURN (SELECT u.l FROM unnest(ARRAY['garrafeira_nacional','granvine','vinha','vivino']) WITH ORDINALITY AS u(l, i)
           WHERE jsonb_typeof(v_precos -> u.l) = 'object'
             AND abs(CASE WHEN (v_precos -> u.l ->> 'preco') ~ '^\d+(\.\d+)?$'
                          THEN (v_precos -> u.l ->> 'preco')::numeric END - v_m) < 0.005
           ORDER BY u.i LIMIT 1);
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.preco_ref_fonte(jsonb, jsonb) FROM PUBLIC, anon, authenticated;

-- O preço da primeira loja que conta (não retirada, com preço), pela ordem
-- de sempre; NULL se não sobrar nenhuma.
CREATE OR REPLACE FUNCTION winecatalog.preco_ref_seguinte(p_precos jsonb)
  RETURNS numeric LANGUAGE sql IMMUTABLE
  SET search_path TO 'winecatalog', 'public'
AS $$
  SELECT round((p_precos -> u.l ->> 'preco')::numeric, 2)
    FROM unnest(ARRAY['garrafeira_nacional','granvine','vinha','vivino']) WITH ORDINALITY AS u(l, i)
   WHERE jsonb_typeof(p_precos -> u.l) = 'object'
     AND NOT COALESCE((p_precos -> u.l ->> 'retirado')::boolean, false)
     AND COALESCE(CASE WHEN (p_precos -> u.l ->> 'preco') ~ '^\d+(\.\d+)?$'
                       THEN (p_precos -> u.l ->> 'preco')::numeric END, 0) > 0
   ORDER BY u.i LIMIT 1;
$$;
REVOKE ALL ON FUNCTION winecatalog.preco_ref_seguinte(jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION winecatalog.preco_retirar(p_id bigint, p_loja text, p_url text DEFAULT NULL)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v_id     bigint;
  v_ficha  jsonb;
  v_orig   jsonb;
  v_precos jsonb;
  v_e      jsonb;
  v_campos jsonb;
  v_nova   numeric;
BEGIN
  IF NOT (winecatalog.sou_admin() OR winecatalog.sou_curador()) THEN
    RAISE EXCEPTION 'Só os curadores do catálogo retiram preços.';
  END IF;
  IF COALESCE(p_loja, '') = '' THEN RAISE EXCEPTION 'Falta a loja.'; END IF;
  -- Uma linha fundida responde pela que ficou.
  v_id := COALESCE((SELECT a.id_para FROM winecatalog.alias a WHERE a.id_de = p_id LIMIT 1), p_id);
  SELECT COALESCE(c.ficha, '{}'::jsonb), COALESCE(c.origens, '{}'::jsonb)
    INTO v_ficha, v_orig
    FROM winecatalog.vinhos c WHERE c.id = v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Linha não encontrada.'; END IF;

  v_precos := CASE WHEN jsonb_typeof(v_ficha -> 'precos') = 'object' THEN v_ficha -> 'precos' ELSE '{}'::jsonb END;
  v_e := v_precos -> p_loja;
  IF jsonb_typeof(v_e) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Este vinho já não tem preço dessa loja — recarrega a página.';
  END IF;
  IF COALESCE((v_e ->> 'retirado')::boolean, false) THEN
    RETURN jsonb_build_object('ok', true, 'vinho', v_id, 'ja', true);
  END IF;
  -- O script pode ter trocado a página entretanto: retira-se o que se viu.
  IF p_url IS NOT NULL AND COALESCE(v_e ->> 'url', '') <> p_url THEN
    RAISE EXCEPTION 'O preço dessa loja mudou entretanto — recarrega a página.';
  END IF;

  v_precos := jsonb_set(v_precos, ARRAY[p_loja], v_e || jsonb_strip_nulls(jsonb_build_object(
    'retirado',     true,
    'retirado_em',  to_char(now() AT TIME ZONE 'Europe/Lisbon', 'YYYY-MM-DD'),
    'retirado_por', NULLIF(lower(COALESCE(auth.email(), '')), ''))));
  v_campos := jsonb_build_object('precos', v_precos);

  -- O preço de referência que vinha desta loja passa à seguinte (ou sai).
  IF winecatalog.preco_ref_fonte(v_ficha, v_orig) = p_loja THEN
    v_nova := winecatalog.preco_ref_seguinte(v_precos);
    v_campos := v_campos || jsonb_build_object('preco_medio', COALESCE(to_jsonb(v_nova), 'null'::jsonb));
  END IF;

  PERFORM winecatalog.editar(v_id, v_campos);
  RETURN jsonb_build_object('ok', true, 'vinho', v_id,
    'preco_medio_mudou', v_campos ? 'preco_medio', 'preco_medio', v_nova);
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.preco_retirar(bigint, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.preco_retirar(bigint, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION winecatalog.preco_devolver(p_id bigint, p_loja text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
DECLARE
  v_id     bigint;
  v_ficha  jsonb;
  v_precos jsonb;
  v_e      jsonb;
  v_campos jsonb;
  v_nova   numeric;
BEGIN
  IF NOT (winecatalog.sou_admin() OR winecatalog.sou_curador()) THEN
    RAISE EXCEPTION 'Só os curadores do catálogo devolvem preços.';
  END IF;
  v_id := COALESCE((SELECT a.id_para FROM winecatalog.alias a WHERE a.id_de = p_id LIMIT 1), p_id);
  SELECT COALESCE(c.ficha, '{}'::jsonb) INTO v_ficha
    FROM winecatalog.vinhos c WHERE c.id = v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Linha não encontrada.'; END IF;

  v_precos := CASE WHEN jsonb_typeof(v_ficha -> 'precos') = 'object' THEN v_ficha -> 'precos' ELSE '{}'::jsonb END;
  v_e := v_precos -> COALESCE(p_loja, '');
  IF jsonb_typeof(v_e) IS DISTINCT FROM 'object' OR NOT COALESCE((v_e ->> 'retirado')::boolean, false) THEN
    RETURN jsonb_build_object('ok', true, 'vinho', v_id, 'ja', true);
  END IF;

  v_precos := jsonb_set(v_precos, ARRAY[p_loja], v_e - 'retirado' - 'retirado_em' - 'retirado_por');
  v_campos := jsonb_build_object('precos', v_precos);
  -- Sem preço de referência (saiu com este), volta a ter o da primeira loja.
  IF winecatalog.vazio(v_ficha -> 'preco_medio') THEN
    v_nova := winecatalog.preco_ref_seguinte(v_precos);
    IF v_nova IS NOT NULL THEN v_campos := v_campos || jsonb_build_object('preco_medio', v_nova); END IF;
  END IF;

  PERFORM winecatalog.editar(v_id, v_campos);
  RETURN jsonb_build_object('ok', true, 'vinho', v_id,
    'preco_medio_mudou', v_campos ? 'preco_medio', 'preco_medio', v_nova);
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.preco_devolver(bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION winecatalog.preco_devolver(bigint, text) TO authenticated;

-- A da migração 42, mais os preços retirados (só a quem corrige o catálogo).
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
      ELSE '[]'::jsonb END);
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.catalogo_fontes(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.catalogo_fontes(bigint) TO authenticated;
