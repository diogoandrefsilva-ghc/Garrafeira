-- ---------------------------------------------------------------------
-- Migração 17 — os PREÇOS DAS LOJAS, lidos do catálogo
--
-- O catálogo partilhado (`winecatalog.vinhos.ficha -> 'precos'`) guarda o
-- preço loja a loja — Garrafeira Nacional, Granvine, Vinha, Vivino — com o
-- link, a data da recolha e (nas lojas) a colheita que a loja vende. Quem
-- o enche é um script do lado da WineCatalog, e vai-o refrescando.
--
-- NÃO SE COPIA PARA `garrafeira.vinhos`. Uma cópia ficava velha no dia a
-- seguir à recolha, e não há nada nestes números que seja da garrafeira:
-- é o que uma loja pede HOJE por um rótulo. Por isso a app pergunta-os ao
-- carregar, todos de uma vez, e decide lá qual é o preço que conta
-- (`precoPrincipal` no app.js — a ordem das lojas e a regra da colheita
-- vivem lá, não aqui).
--
-- A linha do catálogo acha-se como a `winecatalog.comparar` a acha (chave
-- sem ano: `chave_base`/`base_nome`), mas aqui juntam-se TODAS as linhas
-- que casam, não só a mais cheia: cada preço traz a sua própria colheita,
-- e o preço da colheita certa pode estar numa linha irmã.
--
-- Nunca deita a app abaixo: sem catálogo (ou com ele a meio de uma
-- migração) devolve `{}` e a app fica com o preço médio de sempre.
--
-- Idempotente. Só cria uma função.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.precos_lojas(p_garrafeira_id bigint)
  RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v_res jsonb;
BEGIN
  IF NOT garrafeira.pode_ver(p_garrafeira_id) THEN
    RAISE EXCEPTION 'Sem acesso a esta garrafeira.';
  END IF;

  BEGIN
    WITH gv AS MATERIALIZED (
      SELECT v.id,
             winecatalog.chave_base(v.nome, COALESCE(v.produtor,'')) AS b,
             winecatalog.base_nome(v.nome)                           AS bn
        FROM garrafeira.vinhos v
       WHERE v.garrafeira_id = p_garrafeira_id
         AND COALESCE(btrim(v.nome),'') <> ''
    ), cv AS (
      SELECT c.chave_base, c.base_nome, c.ficha -> 'precos' AS precos
        FROM winecatalog.vinhos c
       WHERE jsonb_typeof(c.ficha -> 'precos') = 'object'
    ), par AS (
      SELECT DISTINCT gv.id AS vinho_id, e.key AS loja,
             jsonb_build_object(
               'loja',     e.key,
               'preco',    (e.value ->> 'preco')::numeric,
               'url',      e.value ->> 'url',
               'nome',     e.value ->> 'nome',
               'colheita', CASE WHEN (e.value ->> 'colheita') ~ '^\d{4}$'
                                THEN (e.value ->> 'colheita')::integer END,
               'em',       e.value ->> 'em') AS p
        FROM gv
        JOIN cv ON cv.chave_base = gv.b
                OR (gv.bn IS NOT NULL AND cv.chave_base = gv.bn)
                OR (cv.base_nome IS NOT NULL AND cv.base_nome IN (gv.b, gv.bn))
       CROSS JOIN LATERAL jsonb_each(cv.precos) e
       WHERE jsonb_typeof(e.value) = 'object'
         -- Retirada à mão na WineCatalog (Editar › Fontes de preço): o preço
         -- estava errado. Fica no catálogo marcada, mas não conta aqui.
         AND NOT COALESCE((e.value ->> 'retirado')::boolean, false)
         AND (e.value ->> 'preco') ~ '^\d+(\.\d+)?$'
         AND (e.value ->> 'preco')::numeric > 0
    )
    SELECT COALESCE(jsonb_object_agg(vinho_id, lista), '{}'::jsonb) INTO v_res
      FROM (SELECT vinho_id, jsonb_agg(p ORDER BY loja, p ->> 'colheita' DESC) AS lista
              FROM par GROUP BY vinho_id) x;
  EXCEPTION WHEN OTHERS THEN
    RETURN '{}'::jsonb;
  END;
  RETURN v_res;
END;
$$;

REVOKE ALL ON FUNCTION garrafeira.precos_lojas(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.precos_lojas(bigint) TO authenticated;
