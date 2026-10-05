-- =====================================================================
-- Migração 41 — o preço da LOJA que se leu no "Procurar informação"
-- (05/10/2026)
--
-- O dono das apps: "quando estamos a fazer pesquisas de informação e temos
-- por base um site (Garrafeira Nacional, Vinha.pt, Granvine), estamos a
-- guardar o preço de referência mas não o preço obtido em cada um desses
-- sites, conforme fazemos no batch". A `vinho-info` já ABRE a página da
-- loja; o preço que ela declara (JSON-LD `offers`, `product:price:amount`)
-- passa a ir para `winecatalog.vinhos.ficha -> 'precos' -> <loja>` — o
-- mesmo sítio e a mesma forma do script das lojas
-- ({preco, url, nome, colheita, em}), mais `de: "pesquisa"`. A
-- `precos_lojas` (migração 17) lê-o daí sem mudar nada.
--
-- A `juntar` não serve: trata `precos` como UM campo e trocava o objeto
-- inteiro — a Granvine lida agora apagava a Garrafeira Nacional e a Vinha
-- que o script lá tinha. Aqui junta-se loja a loja.
--
-- Três peças:
--  · `catalogo_precos_por(id, precos)` — o trabalho; só a service role e
--    as duas de baixo. Uma loja que o admin RETIROU (Editar › Fontes de
--    preço) com a MESMA página fica retirada.
--  · `catalogo_precos_pagina(nome, produtor, ano, cor, precos)` — a da
--    `vinho-info`, quando o nome está confirmado (a mesma regra da
--    `juntar`, ver "O catálogo partilhado" no CLAUDE.md): acha a linha como
--    a `juntar` a acha. Só a service role.
--  · `precos_da_procura(analise, vinho)` — a da APP, para o vinho NOVO
--    (o "adiado": a linha do catálogo só nasce quando ele é gravado). Os
--    preços saem da `analises.resultado` que a função escreveu — nunca do
--    browser —, de uma procura minha e de há menos de um dia; o vinho tem
--    de ser meu (`pode_mexer`) e já ligado (`catalogo_id`). Um id NEGATIVO
--    é uma linha do Catálogo (o vinho novo do Catálogo), e aí só a um
--    curador ou ao admin do catálogo.
--
-- Corre depois da 28 (`vinhos.catalogo_id`). Idempotente.
-- =====================================================================

CREATE OR REPLACE FUNCTION garrafeira.catalogo_precos_por(p_id bigint, p_precos jsonb)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v_id    bigint;
  v_ficha jsonb;
  v_orig  jsonb;
  k       text;
  e       jsonb;
  ant     jsonb;
  n       integer := 0;
BEGIN
  IF p_id IS NULL OR p_precos IS NULL OR jsonb_typeof(p_precos) <> 'object' THEN RETURN 0; END IF;
  -- Uma linha fundida responde pela que ficou.
  SELECT COALESCE((SELECT a.id_para FROM winecatalog.alias a WHERE a.id_de = p_id LIMIT 1), p_id) INTO v_id;
  SELECT COALESCE(c.ficha, '{}'::jsonb), COALESCE(c.origens, '{}'::jsonb)
    INTO v_ficha, v_orig
    FROM winecatalog.vinhos c WHERE c.id = v_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF jsonb_typeof(v_ficha -> 'precos') IS DISTINCT FROM 'object' THEN
    v_ficha := v_ficha || '{"precos":{}}'::jsonb;
  END IF;

  FOR k, e IN SELECT key, value FROM jsonb_each(p_precos) LOOP
    -- Só as lojas que a app conhece (o Vivino não se abre do servidor).
    CONTINUE WHEN k NOT IN ('garrafeira_nacional', 'granvine', 'vinha');
    CONTINUE WHEN jsonb_typeof(e) <> 'object'
               OR COALESCE(e ->> 'preco', '') !~ '^\d+(\.\d+)?$'
               OR (e ->> 'preco')::numeric <= 0 OR (e ->> 'preco')::numeric > 100000
               OR COALESCE(e ->> 'url', '') !~* '^https?://';
    ant := v_ficha -> 'precos' -> k;
    CONTINUE WHEN jsonb_typeof(ant) = 'object'
              AND COALESCE((ant ->> 'retirado')::boolean, false)
              AND ant ->> 'url' = e ->> 'url';
    v_ficha := jsonb_set(v_ficha, ARRAY['precos', k], jsonb_strip_nulls(jsonb_build_object(
      'preco',    round((e ->> 'preco')::numeric, 2),
      'url',      left(e ->> 'url', 400),
      'nome',     NULLIF(left(COALESCE(e ->> 'nome', ''), 200), ''),
      'colheita', CASE WHEN (e ->> 'colheita') ~ '^\d{4}$' THEN (e ->> 'colheita')::integer END,
      'em',       to_char(now() AT TIME ZONE 'Europe/Lisbon', 'YYYY-MM-DD'),
      'de',       'pesquisa')));
    n := n + 1;
  END LOOP;
  IF n = 0 THEN RETURN 0; END IF;

  -- A origem é o que o histórico do catálogo (`alteracoes`) mostra; a força
  -- gravada fica a que estava (o script das lojas continua a refrescar).
  v_orig := v_orig || jsonb_build_object('precos', jsonb_build_object(
    'o', 'vinho-info-pagina', 'f', COALESCE((v_orig -> 'precos' ->> 'f')::integer, 2), 'em', now()));
  UPDATE winecatalog.vinhos SET ficha = v_ficha, origens = v_orig, atualizado_em = now() WHERE id = v_id;
  RETURN n;
EXCEPTION WHEN OTHERS THEN
  -- É uma poupança: nunca deita abaixo a procura nem a gravação.
  RETURN 0;
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.catalogo_precos_por(bigint, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION garrafeira.catalogo_precos_por(bigint, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION garrafeira.catalogo_precos_pagina(
  p_nome text, p_produtor text, p_ano integer, p_cor text, p_precos jsonb)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v_idt jsonb;
  v_id  bigint;
BEGIN
  v_idt := winecatalog.identidade(p_nome, COALESCE(p_produtor, ''), p_ano, p_cor, true);
  IF COALESCE(v_idt ->> 'chave_base', '') = '' THEN RETURN 0; END IF;
  v_id := winecatalog.achar(v_idt ->> 'nome', v_idt ->> 'produtor', (v_idt ->> 'ano')::integer, true, NULL, v_idt ->> 'cor');
  RETURN garrafeira.catalogo_precos_por(v_id, p_precos);
EXCEPTION WHEN OTHERS THEN
  RETURN 0;
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.catalogo_precos_pagina(text, text, integer, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION garrafeira.catalogo_precos_pagina(text, text, integer, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION garrafeira.precos_da_procura(p_analise bigint, p_vinho bigint)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v_precos jsonb;
  v_cid    bigint;
  v_gid    bigint;
BEGIN
  SELECT a.resultado -> 'precosLoja' INTO v_precos
    FROM garrafeira.analises a
   WHERE a.id = p_analise
     AND lower(a.quem) = lower(auth.email())
     AND a.estado = 'concluido'
     AND a.criado_em > now() - interval '1 day';
  IF v_precos IS NULL OR jsonb_typeof(v_precos) <> 'object' THEN RETURN 0; END IF;

  IF p_vinho < 0 THEN
    IF NOT (winecatalog.sou_curador() OR winecatalog.sou_admin()) THEN RETURN 0; END IF;
    v_cid := -p_vinho;
  ELSE
    SELECT v.catalogo_id, v.garrafeira_id INTO v_cid, v_gid FROM garrafeira.vinhos v WHERE v.id = p_vinho;
    IF v_gid IS NULL OR NOT garrafeira.pode_mexer(v_gid) THEN RETURN 0; END IF;
  END IF;
  RETURN garrafeira.catalogo_precos_por(v_cid, v_precos);
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.precos_da_procura(bigint, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.precos_da_procura(bigint, bigint) TO authenticated;
