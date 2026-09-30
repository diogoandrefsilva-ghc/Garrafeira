-- =====================================================================
-- Migração 31 — o Catálogo dentro da Garrafeira (30/09/2026, o dono das
-- apps: "quero incluir na garrafeira o catálogo de vinhos").
--
-- Um separador idêntico ao Detalhe, a ler o CATÁLOGO em vez da minha
-- garrafeira. Quem vê: TODA a gente que entra na Garrafeira (decisão do
-- dono, 30/09/2026). Até aqui só o admin do catálogo lia uma linha dele
-- (`winecatalog.pode_ler()`).
--
-- O que atravessa é só a FICHA de cada vinho — o que é sobre o vinho, que
-- é o que o catálogo guarda (invariante 1 da WineCatalog). Não sai nada de
-- quem o tem: nem o `origens` (de onde veio cada campo), nem o `vezes`,
-- nem as `fontes`, nem quem o escreveu. A lista inteira diz, no conjunto,
-- que vinhos passaram pelas apps, mas nunca quem tem qual — é essa a
-- decisão que o dono tomou.
--
-- Os fundidos (a perdedora de um `winecatalog.alias`) não entram: respondem
-- pela linha que ficou, e o `ids` de cada linha leva os deles — é por aí
-- que a app sabe que um vinho da minha garrafeira ligado a uma linha
-- fundida (`catalogo_id`) é este.
--
-- Os preços das lojas saem no MESMO formato da `garrafeira.precos_lojas`
-- (lista de {loja, preco, url, nome, colheita, em}), sem os retirados à
-- mão — para o `precoPrincipal` da app os ler da mesma maneira.
--
-- O catálogo tem ~300 linhas: a app carrega-as todas de uma vez e filtra
-- do lado de cá, com os MESMOS filtros do Detalhe. Se um dia passar das
-- milhares, é aqui que se pagina.
-- Idempotente.
-- =====================================================================

CREATE OR REPLACE FUNCTION garrafeira.catalogo_vinhos()
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = garrafeira, winecatalog, public
AS $$
DECLARE
  v_res jsonb;
BEGIN
  IF NOT garrafeira.is_allowed() THEN
    RAISE EXCEPTION 'Sem acesso.';
  END IF;

  WITH mortos AS MATERIALIZED (
    SELECT id_de FROM winecatalog.alias
  ), fund AS (
    SELECT id_para, array_agg(id_de) AS ids FROM winecatalog.alias GROUP BY id_para
  )
  SELECT COALESCE(jsonb_agg(
           (c.ficha - 'precos' - 'produtor' - 'ano')
           || jsonb_build_object(
                'id',       c.id,
                'ids',      to_jsonb(ARRAY[c.id] || COALESCE(f.ids, ARRAY[]::bigint[])),
                'nome',     c.nome,
                'produtor', c.produtor,
                'ano',      c.ano,
                'tipo',     COALESCE(NULLIF(c.ficha ->> 'tipo', ''),
                              CASE c.cor WHEN 'tinto' THEN 'Tinto' WHEN 'branco' THEN 'Branco'
                                         WHEN 'rose' THEN 'Rosé' WHEN 'espumante' THEN 'Espumante'
                                         WHEN 'frisante' THEN 'Frisante' WHEN 'licoroso' THEN 'Licoroso' END),
                'criado_em',     c.criado_em,
                'atualizado_em', c.atualizado_em,
                'precos', COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                           'loja',     e.key,
                           'preco',    (e.value ->> 'preco')::numeric,
                           'url',      e.value ->> 'url',
                           'nome',     e.value ->> 'nome',
                           'colheita', CASE WHEN (e.value ->> 'colheita') ~ '^\d{4}$'
                                            THEN (e.value ->> 'colheita')::integer END,
                           'em',       e.value ->> 'em')
                         ORDER BY e.key)
                    FROM jsonb_each(CASE WHEN jsonb_typeof(c.ficha -> 'precos') = 'object'
                                         THEN c.ficha -> 'precos' ELSE '{}'::jsonb END) e
                   WHERE jsonb_typeof(e.value) = 'object'
                     AND NOT COALESCE((e.value ->> 'retirado')::boolean, false)
                     AND (e.value ->> 'preco') ~ '^\d+(\.\d+)?$'
                     AND (e.value ->> 'preco')::numeric > 0), '[]'::jsonb)
              )
           ORDER BY c.nome), '[]'::jsonb)
    INTO v_res
    FROM winecatalog.vinhos c
    LEFT JOIN fund f ON f.id_para = c.id
   WHERE c.id NOT IN (SELECT id_de FROM mortos);
  RETURN v_res;
END;
$$;

REVOKE ALL ON FUNCTION garrafeira.catalogo_vinhos() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.catalogo_vinhos() TO authenticated;
