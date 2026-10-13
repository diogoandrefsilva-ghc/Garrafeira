-- =====================================================================
-- Migração 53 — de onde veio cada valor, nas colheitas que não batem
-- (13/10/2026, o dono das apps: "colocasses o método de obtenção de cada
-- atributo — se foi introduzido manualmente, se veio da IA sem fonte, se
-- veio de pesquisa em site e qual o site, ou se veio dum documento").
--
-- O `origens` de uma linha do catálogo diz só a PORTA por onde o valor
-- entrou (`garrafeira`, `catalogo-admin`, `vinho-info-premium`…), não de
-- onde ele veio antes disso: um valor que a procura com IA encontrou na
-- Garrafeira Nacional e que a pessoa aceitou e gravou chega ao catálogo
-- como `garrafeira`. O pormenor (a página, o documento, "sem dizer de
-- onde") vive no resultado de cada procura (`garrafeira.analises`,
-- `resultado.origemCampos`) e de cada importação de ficheiros
-- (`garrafeira.importacoes`).
--
-- Esta função junta as três coisas para as colheitas de um vinho: o
-- `origens` de cada linha, as procuras com IA deste vinho (pelo vinho de
-- garrafeira ligado à linha, pelo nome, ou pelo lote da atualização
-- massiva) e as importações onde ele foi lido. QUAL procura deu o valor
-- decide-o a app, comparando o valor (a mesma comparação do ecrã) — uma
-- procura cujo valor não é o que lá está não explica nada.
--
-- Só ao admin do catálogo (é o Backoffice). Nunca sai quem procurou nem
-- de que garrafeira — só o que se encontrou e onde.
-- Idempotente.
-- =====================================================================

CREATE OR REPLACE FUNCTION garrafeira.colheitas_origens(p_ids bigint[])
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = garrafeira, winecatalog, public
AS $$
DECLARE
  -- Os campos que o ecrã compara (e os que andam com eles).
  c_campos CONSTANT text[] := ARRAY['regiao','classificacao','teor','castas','harmonizacao',
    'vivino_nota_global','vivino_avaliacoes_global','vivino_nota','vivino_avaliacoes','preco_medio','precos'];
  v_ids   bigint[];
  v_gids  bigint[];
  v_bases text[];
  v_nomes text[];
  v_res   jsonb;
BEGIN
  IF NOT winecatalog.sou_admin() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN '{}'::jsonb; END IF;
  v_ids := p_ids[1:60];

  SELECT array_agg(DISTINCT v.chave_base) FILTER (WHERE v.chave_base IS NOT NULL),
         array_agg(DISTINCT lower(trim(v.nome)))
    INTO v_bases, v_nomes
    FROM winecatalog.vinhos v WHERE v.id = ANY(v_ids);
  SELECT array_agg(g.id) INTO v_gids FROM garrafeira.vinhos g WHERE g.catalogo_id = ANY(v_ids);

  SELECT jsonb_build_object(
    'linhas', coalesce((
      SELECT jsonb_object_agg(v.id::text, coalesce((
        SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(v.origens) e WHERE e.key = ANY(c_campos)
      ), '{}'::jsonb))
      FROM winecatalog.vinhos v WHERE v.id = ANY(v_ids)), '{}'::jsonb),
    -- As procuras de um vinho só (o "Procurar informação").
    'analises', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', a.id, 'em', a.criado_em, 'ano', a.pedido->'ano',
        'garrafeira', a.vinho_id IS NOT NULL AND a.vinho_id = ANY(coalesce(v_gids,'{}')),
        'soSites', coalesce((a.pedido->>'soSites')::boolean, false),
        'docs', (SELECT jsonb_agg(coalesce(d->>'titulo', d->>'nome')) FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(a.pedido->'documentos')='array' THEN a.pedido->'documentos' ELSE '[]' END) d),
        'r', (SELECT jsonb_object_agg(k, a.resultado->k) FROM jsonb_object_keys(a.resultado) k
               WHERE k = ANY(c_campos) OR k IN ('origemCampos','catalogoCampos','semFonte','pesquisaWeb','sites'))
      ) ORDER BY a.id DESC)
      FROM garrafeira.analises a
      WHERE a.estado = 'concluido' AND NOT a.pedido ? 'vinhos'
        AND ((a.vinho_id IS NOT NULL AND a.vinho_id = ANY(coalesce(v_gids,'{}')))
          OR lower(trim(a.pedido->>'nome')) = ANY(coalesce(v_nomes,'{}'))
          OR winecatalog.chave_base(a.pedido->>'nome', a.pedido->>'produtor') = ANY(coalesce(v_bases,'{}')))
    ), '[]'::jsonb),
    -- A atualização massiva: um resultado por vinho, com o id dele (o da
    -- garrafeira, ou o da linha do catálogo em valor absoluto).
    'lotes', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', a.id, 'em', a.criado_em, 'vinho', (x->>'id')::bigint,
        'r', (SELECT jsonb_object_agg(k, x->k) FROM jsonb_object_keys(x) k
               WHERE k = ANY(c_campos) OR k IN ('origemCampos','catalogoCampos','pesquisaWeb'))) ORDER BY a.id DESC)
      FROM garrafeira.analises a, jsonb_array_elements(a.resultado->'resultados') x
      WHERE a.estado = 'concluido' AND jsonb_typeof(a.resultado->'resultados') = 'array'
        AND (x->>'id') ~ '^\d+$'
        AND ((x->>'id')::bigint = ANY(v_ids) OR (x->>'id')::bigint = ANY(coalesce(v_gids,'{}')))
    ), '[]'::jsonb),
    -- As importações de imagens ou documentos onde este vinho foi lido.
    'importacoes', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', i.id, 'em', i.criado_em, 'ano', x->'ano',
        'tipo', CASE WHEN (x->>'ficheiro') ~ '^\d+$' THEN i.pedido->'tipos'->>((x->>'ficheiro')::int - 1) END,
        'r', (SELECT jsonb_object_agg(k, x->k) FROM jsonb_object_keys(x) k WHERE k = ANY(c_campos))) ORDER BY i.id DESC)
      FROM garrafeira.importacoes i, jsonb_array_elements(i.resultado->'vinhos') x
      WHERE i.estado = 'concluido' AND jsonb_typeof(i.resultado->'vinhos') = 'array'
        AND (lower(trim(x->>'nome')) = ANY(coalesce(v_nomes,'{}'))
          OR winecatalog.chave_base(x->>'nome', x->>'produtor') = ANY(coalesce(v_bases,'{}')))
    ), '[]'::jsonb)
  ) INTO v_res;
  RETURN v_res;
END $$;

REVOKE ALL ON FUNCTION garrafeira.colheitas_origens(bigint[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION garrafeira.colheitas_origens(bigint[]) TO authenticated;
