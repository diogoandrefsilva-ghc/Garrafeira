-- ════════════════════════════════════════════════════════════════════
-- Migração 38 — as CASTAS: uma grafia por casta (01/10/2026)
-- ════════════════════════════════════════════════════════════════════
-- O filtro das castas tinha "Aragonez", "Aragonês" e "Aragonêz" lado a
-- lado, "Castelao"/"Castelão", "Sousão"/"Souzão", "Shiraz/Syrah"/"Syrah",
-- "Tinta Cão"/"Tinto Cão" — e uma "Touriga Nacional e Merlot", duas
-- castas escritas sem vírgula que a app gravou como uma só.
--
-- A regra é a do catálogo, `winecatalog.normalizar_castas` (`db/castas.sql`
-- da WineCatalog, que corre ANTES desta): separa por " e ", "&", "/", "+",
-- ";" e vírgulas, compara sem acentos nem maiúsculas, troca a grafia pela
-- de referência e tira o que não é casta ("Vinhas Velhas"). Uma regra só
-- para os dois lados — duas cópias divergiam, e a mesma casta voltava a
-- ter duas facetas.
--
-- Aqui:
--   1. `castas_normalizadas()` — a regra do catálogo, com uma rede: se o
--      schema `winecatalog` faltar, fica só o trim de sempre (guardar as
--      castas de um vinho nunca pode depender do catálogo);
--   2. `casta_id()` normaliza o nome e procura a casta pela CHAVE (sem
--      acentos), não só pelas minúsculas: "Castelao" acha a "Castelão";
--   3. `definir_castas()` separa a lista antes de procurar cada uma —
--      "Touriga Nacional e Merlot" passa a ser duas;
--   4. as castas que já lá estavam juntam-se na de referência: as ligações
--      (`vinho_castas`) passam para ela e a variante sai.
--
-- Não junta sinónimos REGIONAIS (Tinta Roriz/Aragonez/Tempranillo): o nome
-- diz de onde é o vinho. Idempotente. Depois desta, `functions.sql` traz as
-- mesmas `casta_id`/`definir_castas`.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION garrafeira.castas_normalizadas(p_nomes text[])
  RETURNS text[] LANGUAGE plpgsql STABLE SECURITY INVOKER
  SET search_path TO 'garrafeira', 'public'
AS $$
BEGIN
  RETURN winecatalog.normalizar_castas(p_nomes);
EXCEPTION WHEN OTHERS THEN
  RETURN ARRAY(SELECT regexp_replace(trim(x), '\s+', ' ', 'g')
                 FROM unnest(COALESCE(p_nomes, ARRAY[]::text[])) x
                WHERE trim(COALESCE(x, '')) <> '');
END;
$$;

CREATE OR REPLACE FUNCTION garrafeira.casta_id(p_nome text)
  RETURNS bigint LANGUAGE plpgsql SECURITY INVOKER
  SET search_path TO 'garrafeira', 'public'
AS $$
DECLARE
  v_nome text := (garrafeira.castas_normalizadas(ARRAY[p_nome]))[1];
  v_id   bigint;
BEGIN
  IF COALESCE(v_nome, '') = '' THEN RETURN NULL; END IF;
  SELECT id INTO v_id FROM garrafeira.castas WHERE nome = v_nome;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  BEGIN
    SELECT id INTO v_id FROM garrafeira.castas
     WHERE winecatalog.casta_chave(nome) = winecatalog.casta_chave(v_nome)
     ORDER BY id LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    SELECT id INTO v_id FROM garrafeira.castas WHERE lower(nome) = lower(v_nome)
     ORDER BY id LIMIT 1;
  END;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO garrafeira.castas (nome) VALUES (v_nome)
  ON CONFLICT (nome) DO UPDATE SET nome = EXCLUDED.nome
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION garrafeira.definir_castas(p_vinho_id bigint, p_nomes text[])
  RETURNS integer LANGUAGE plpgsql SECURITY INVOKER
  SET search_path TO 'garrafeira', 'public'
AS $$
DECLARE
  v_nome text;
  v_ids  bigint[] := '{}';
  v_id   bigint;
  v_antes bigint[];
BEGIN
  -- A lista já separada e normalizada ("Touriga Nacional e Merlot" são duas).
  FOREACH v_nome IN ARRAY garrafeira.castas_normalizadas(p_nomes) LOOP
    v_id := garrafeira.casta_id(v_nome);
    IF v_id IS NOT NULL AND NOT (v_id = ANY(v_ids)) THEN
      v_ids := array_append(v_ids, v_id);
    END IF;
  END LOOP;

  SELECT COALESCE(array_agg(casta_id ORDER BY casta_id), ARRAY[]::bigint[])
    INTO v_antes FROM garrafeira.vinho_castas WHERE vinho_id = p_vinho_id;

  DELETE FROM garrafeira.vinho_castas
   WHERE vinho_id = p_vinho_id AND NOT (casta_id = ANY(v_ids));

  INSERT INTO garrafeira.vinho_castas (vinho_id, casta_id)
  SELECT p_vinho_id, x FROM unnest(v_ids) AS x
  ON CONFLICT DO NOTHING;

  BEGIN
    IF cardinality(v_ids) > 0
       AND v_antes IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(v_ids) x) THEN
      PERFORM garrafeira.curador_levar(p_vinho_id, '{"castas": null}'::jsonb);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  BEGIN
    PERFORM garrafeira.catalogar_vinho(p_vinho_id);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN cardinality(v_ids);
END;
$$;

GRANT EXECUTE ON FUNCTION garrafeira.castas_normalizadas(text[]) TO authenticated;

-- ---------------------------------------------------------------------
-- 4. As que já lá estavam. Uma variante que dá UM nome que ainda não existe
-- muda de nome no sítio; senão as ligações passam para a(s) casta(s) de
-- referência (criadas se faltarem) e a variante sai. Não passa pela
-- `definir_castas`: é arrumar o nome, não uma escrita nova no vinho — o
-- catálogo foi arrumado pelo `castas.sql` do lado de lá.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  c   record;
  t   text[];
  n   text;
  tid bigint;
BEGIN
  FOR c IN SELECT id, nome FROM garrafeira.castas ORDER BY id LOOP
    t := garrafeira.castas_normalizadas(ARRAY[c.nome]);
    CONTINUE WHEN t = ARRAY[c.nome];
    IF cardinality(t) = 1
       AND NOT EXISTS (SELECT 1 FROM garrafeira.castas WHERE nome = t[1] AND id <> c.id) THEN
      UPDATE garrafeira.castas SET nome = t[1] WHERE id = c.id;
      CONTINUE;
    END IF;
    FOREACH n IN ARRAY t LOOP
      SELECT id INTO tid FROM garrafeira.castas WHERE nome = n;
      IF tid IS NULL THEN
        INSERT INTO garrafeira.castas (nome) VALUES (n) RETURNING id INTO tid;
      END IF;
      INSERT INTO garrafeira.vinho_castas (vinho_id, casta_id)
      SELECT vinho_id, tid FROM garrafeira.vinho_castas WHERE casta_id = c.id
      ON CONFLICT DO NOTHING;
    END LOOP;
    DELETE FROM garrafeira.castas WHERE id = c.id;   -- leva as ligações dela (CASCADE)
  END LOOP;
END;
$$;
