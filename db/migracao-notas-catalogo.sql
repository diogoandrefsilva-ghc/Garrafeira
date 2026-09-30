-- =====================================================================
-- Migração 33 — as notas dos utilizadores aos vinhos do CATÁLOGO
-- (30/09/2026, o dono das apps: "gostava que os utilizadores da garrafeira
-- pudessem dar notas/avaliações aos vinhos do catálogo (notas de 0 a 5,
-- com possibilidade de colocar valores decimais - uma casa apenas)").
--
-- Uma nota é de uma PESSOA sobre um vinho — não é sobre o vinho, e por
-- isso não entra na ficha do catálogo (invariante 1 da WineCatalog: "isto é
-- sobre o vinho ou sobre quem o tem?"). Vive aqui, uma linha por pessoa e
-- por linha do catálogo, e só se lê por duas funções:
--  · `catalogo_notas()` — a MÉDIA e o número de notas de cada vinho, mais a
--    MINHA. Nunca quem deu qual (invariante 2: ninguém vê o que o outro tem
--    ou bebeu, só o conjunto);
--  · `catalogo_nota_definir(id, nota)` — a minha nota (0 a 5, uma casa
--    decimal); `NULL` tira-a.
-- A tabela tem RLS e zero policies, e nenhum GRANT a quem tem login: é
-- o mesmo desenho do catálogo — só as funções lhe chegam.
--
-- Um vinho fundido (`winecatalog.alias`) responde pela linha que ficou: a
-- nota dada à que saiu conta para a que ficou, e a mesma pessoa não conta
-- duas vezes (fica a mais recente).
--
-- Não é a nota de um CONSUMO (`garrafas.consumo_avaliacao`, 1 a 5): essa é
-- de uma garrafa bebida e vive na garrafeira de quem a bebeu. Esta é do
-- vinho, dada no Catálogo, e vai de 0 a 5.
-- Idempotente.
-- =====================================================================

CREATE TABLE IF NOT EXISTS garrafeira.notas_catalogo (
  catalogo_id   bigint       NOT NULL,
  email         text         NOT NULL,
  nota          numeric(2,1) NOT NULL CHECK (nota >= 0 AND nota <= 5),
  criado_em     timestamptz  NOT NULL DEFAULT now(),
  atualizado_em timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (catalogo_id, email)
);
CREATE INDEX IF NOT EXISTS notas_catalogo_email ON garrafeira.notas_catalogo (email);

ALTER TABLE garrafeira.notas_catalogo ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON garrafeira.notas_catalogo FROM PUBLIC, anon, authenticated;
GRANT ALL ON garrafeira.notas_catalogo TO service_role;

-- As notas de cada vinho: {"<id do catálogo>": {media, n, minha}}.
CREATE OR REPLACE FUNCTION garrafeira.catalogo_notas()
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = garrafeira, winecatalog, public
AS $$
DECLARE
  v_eu  text := lower(COALESCE(auth.email(), ''));
  v_res jsonb;
BEGIN
  IF NOT garrafeira.is_allowed() THEN
    RAISE EXCEPTION 'Sem acesso.';
  END IF;

  WITH resolvidas AS (
    SELECT DISTINCT ON (COALESCE(a.id_para, x.catalogo_id), x.email)
           COALESCE(a.id_para, x.catalogo_id) AS id, x.email, x.nota
      FROM garrafeira.notas_catalogo x
      LEFT JOIN winecatalog.alias a ON a.id_de = x.catalogo_id
     ORDER BY COALESCE(a.id_para, x.catalogo_id), x.email, x.atualizado_em DESC
  )
  SELECT COALESCE(jsonb_object_agg(id::text, jsonb_build_object(
           'media', media, 'n', n, 'minha', minha)), '{}'::jsonb)
    INTO v_res
    FROM (SELECT id, round(avg(nota), 1) AS media, count(*) AS n,
                 max(nota) FILTER (WHERE email = v_eu) AS minha
            FROM resolvidas GROUP BY id) t;
  RETURN v_res;
END;
$$;

-- A minha nota a um vinho do catálogo. Devolve as notas desse vinho, já
-- com a minha: {id, media, n, minha}.
CREATE OR REPLACE FUNCTION garrafeira.catalogo_nota_definir(p_catalogo_id bigint, p_nota numeric)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = garrafeira, winecatalog, public
AS $$
DECLARE
  v_eu    text := lower(COALESCE(auth.email(), ''));
  v_id    bigint;
  v_ids   bigint[];
  v_nota  numeric;
  v_res   jsonb;
BEGIN
  IF v_eu = '' OR NOT garrafeira.is_allowed() THEN
    RAISE EXCEPTION 'Sem acesso.';
  END IF;
  v_id := COALESCE((SELECT id_para FROM winecatalog.alias WHERE id_de = p_catalogo_id), p_catalogo_id);
  IF NOT EXISTS (SELECT 1 FROM winecatalog.vinhos WHERE id = v_id) THEN
    RAISE EXCEPTION 'Esse vinho não está no catálogo.';
  END IF;
  -- a linha que ficou e as que foram fundidas nela
  v_ids := ARRAY[v_id] || COALESCE((SELECT array_agg(id_de) FROM winecatalog.alias WHERE id_para = v_id), ARRAY[]::bigint[]);

  IF p_nota IS NULL THEN
    DELETE FROM garrafeira.notas_catalogo WHERE email = v_eu AND catalogo_id = ANY (v_ids);
  ELSE
    v_nota := round(p_nota, 1);
    IF v_nota < 0 OR v_nota > 5 THEN
      RAISE EXCEPTION 'A nota vai de 0 a 5, com uma casa decimal.';
    END IF;
    -- uma nota só por pessoa e por vinho: a que tinha dado a uma linha
    -- fundida nesta sai
    DELETE FROM garrafeira.notas_catalogo
     WHERE email = v_eu AND catalogo_id = ANY (v_ids) AND catalogo_id <> v_id;
    INSERT INTO garrafeira.notas_catalogo (catalogo_id, email, nota)
    VALUES (v_id, v_eu, v_nota)
    ON CONFLICT (catalogo_id, email)
      DO UPDATE SET nota = EXCLUDED.nota, atualizado_em = now();
  END IF;

  SELECT jsonb_build_object('id', v_id, 'media', round(avg(nota), 1), 'n', count(*),
                            'minha', max(nota) FILTER (WHERE email = v_eu))
    INTO v_res
    FROM (SELECT DISTINCT ON (email) email, nota
            FROM garrafeira.notas_catalogo
           WHERE catalogo_id = ANY (v_ids)
           ORDER BY email, atualizado_em DESC) t;
  RETURN v_res;
END;
$$;

REVOKE ALL ON FUNCTION garrafeira.catalogo_notas() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION garrafeira.catalogo_nota_definir(bigint, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.catalogo_notas() TO authenticated;
GRANT EXECUTE ON FUNCTION garrafeira.catalogo_nota_definir(bigint, numeric) TO authenticated;
