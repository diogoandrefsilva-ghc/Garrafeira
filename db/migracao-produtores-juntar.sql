-- ════════════════════════════════════════════════════════════════════════
-- Migração 45 — Produtores: "não são o mesmo" com a mesma chave, e juntar
-- à mão (05/10/2026)
-- ════════════════════════════════════════════════════════════════════════
-- O dono das apps, sobre "Adega Monte Branco" × "Herdade do Monte Branco":
-- "são diferentes" — e não havia botão. A chave do produtor
-- (`winecatalog.chave_produtor`) tira "Adega", "Herdade", "Monte", "do" e
-- dá "branco" às duas; a `produtores_diferentes` recusava pares com a mesma
-- chave e a app escondia o botão. E: "como posso juntar dois produtores
-- que possas não estar a ver como potencialmente iguais".
--
-- 1. `produtores_distintos_grafias`: os pares de GRAFIAS (não de chaves)
--    marcados como diferentes. A chave continua a mesma (mexer-lhe mudava a
--    chave dos vinhos todos); só deixam de ser sugeridos. Atenção: enquanto
--    tiverem a mesma chave, tornar uma delas oficial leva a outra atrás —
--    a app avisa.
-- 2. `produtor_juntar(de, para)`: junta um produtor (oficial ou grafia solta)
--    a outro, à escolha. Passa as grafias do primeiro para o segundo pela
--    `produtor_definir` (que corrige o catálogo e as garrafeiras), passa-lhe
--    as casas de que era casa-mãe, e apaga o primeiro se ficou sem grafias.
-- Corre depois da 43. Idempotente.

CREATE TABLE IF NOT EXISTS winecatalog.produtores_distintos_grafias (
  a text NOT NULL,
  b text NOT NULL,
  quem text,
  quando timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
ALTER TABLE winecatalog.produtores_distintos_grafias ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON winecatalog.produtores_distintos_grafias FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION winecatalog.produtores_diferentes(p_a text, p_b text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'winecatalog', 'public' AS $function$
DECLARE
  ka text := winecatalog.chave_produtor(p_a);
  kb text := winecatalog.chave_produtor(p_b);
  ga text := lower(btrim(COALESCE(p_a, '')));
  gb text := lower(btrim(COALESCE(p_b, '')));
BEGIN
  IF NOT winecatalog.produtores_autorizado() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  IF ka = '' OR kb = '' OR ga = gb THEN
    RAISE EXCEPTION 'Faltam as duas grafias.';
  END IF;
  IF ka = kb THEN
    -- A mesma chave: guarda-se o par de grafias (a chave não muda).
    INSERT INTO winecatalog.produtores_distintos_grafias (a, b, quem)
    VALUES (LEAST(ga, gb), GREATEST(ga, gb), NULLIF(auth.email(), '')) ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('ok', true, 'mesmaChave', true);
  END IF;
  INSERT INTO winecatalog.produtores_distintos (chave_a, chave_b)
  VALUES (LEAST(ka, kb), GREATEST(ka, kb)) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

CREATE OR REPLACE FUNCTION winecatalog.produtores_sugestoes()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'winecatalog', 'public' AS $function$
BEGIN
  IF NOT winecatalog.produtores_autorizado() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  RETURN (
    WITH g AS MATERIALIZED (
      SELECT x.produtor, x.chave, x.n_catalogo, x.n_garrafeiras,
             string_to_array(x.chave, '-') AS tk,
             pv.produtor_id, p.nome AS oficial
        FROM winecatalog.produtores_grafias() x
        LEFT JOIN winecatalog.produtor_variantes pv ON pv.chave = x.chave
        LEFT JOIN winecatalog.produtores p ON p.id = pv.produtor_id
       WHERE x.chave <> ''
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'a', jsonb_build_object('produtor', a.produtor, 'chave', a.chave, 'catalogo', a.n_catalogo,
                                     'garrafeiras', a.n_garrafeiras, 'oficial', a.oficial),
             'b', jsonb_build_object('produtor', b.produtor, 'chave', b.chave, 'catalogo', b.n_catalogo,
                                     'garrafeiras', b.n_garrafeiras, 'oficial', b.oficial),
             'mesmaChave', a.chave = b.chave)
           ORDER BY lower(a.produtor), lower(b.produtor)), '[]'::jsonb)
      FROM g a JOIN g b ON a.produtor < b.produtor
     WHERE (a.tk <@ b.tk OR b.tk <@ a.tk)
       AND NOT (a.produtor_id IS NOT NULL AND a.produtor_id = b.produtor_id)
       AND (a.chave = b.chave OR NOT EXISTS (
             SELECT 1 FROM winecatalog.produtores_distintos d
              WHERE d.chave_a = LEAST(a.chave, b.chave) AND d.chave_b = GREATEST(a.chave, b.chave)))
       AND NOT EXISTS (
             SELECT 1 FROM winecatalog.produtores_distintos_grafias d
              WHERE d.a = LEAST(lower(a.produtor), lower(b.produtor))
                AND d.b = GREATEST(lower(a.produtor), lower(b.produtor)))
  );
END;
$function$;

CREATE OR REPLACE FUNCTION winecatalog.produtor_juntar(p_de text, p_para text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'winecatalog', 'garrafeira', 'public' AS $function$
DECLARE
  v_de_id bigint; v_para_id bigint; v_para text; v_graf text[]; r jsonb;
BEGIN
  IF NOT winecatalog.produtores_autorizado() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  IF btrim(COALESCE(p_de,'')) = '' OR btrim(COALESCE(p_para,'')) = '' THEN
    RAISE EXCEPTION 'Faltam os dois produtores.';
  END IF;
  SELECT id INTO v_de_id FROM winecatalog.produtores WHERE lower(nome) = lower(btrim(p_de));
  SELECT id, nome INTO v_para_id, v_para FROM winecatalog.produtores WHERE lower(nome) = lower(btrim(p_para));
  v_para := COALESCE(v_para, btrim(p_para));
  IF v_de_id IS NOT NULL AND v_de_id = v_para_id THEN
    RAISE EXCEPTION 'É o mesmo produtor.';
  END IF;
  -- As grafias que passam: as do produtor oficial todo, ou a grafia solta.
  IF v_de_id IS NOT NULL THEN
    SELECT array_agg(DISTINCT e) INTO v_graf
      FROM winecatalog.produtor_variantes v,
           unnest(array_prepend(v.escrito, COALESCE(v.escritos, ARRAY[]::text[]))) e
     WHERE v.produtor_id = v_de_id AND e IS NOT NULL;
    v_graf := array_append(COALESCE(v_graf, ARRAY[]::text[]), (SELECT nome FROM winecatalog.produtores WHERE id = v_de_id));
  ELSE
    v_graf := ARRAY[btrim(p_de)];
  END IF;
  r := winecatalog.produtor_definir(v_para, v_graf);
  v_para_id := (r ->> 'id')::bigint;
  IF v_de_id IS NOT NULL THEN
    -- As casas de que era casa-mãe passam para o produtor que fica.
    UPDATE winecatalog.produtores SET casa_mae_id = v_para_id
     WHERE casa_mae_id = v_de_id AND id <> v_para_id;
    -- O nome completo e a casa-mãe passam se o que fica não os tiver.
    UPDATE winecatalog.produtores p SET
      nome_completo = COALESCE(p.nome_completo, d.nome_completo),
      casa_mae_id = CASE WHEN p.casa_mae_id IS NULL AND d.casa_mae_id <> p.id
                          AND NOT EXISTS (SELECT 1 FROM winecatalog.produtores f WHERE f.casa_mae_id = p.id)
                         THEN d.casa_mae_id ELSE p.casa_mae_id END
      FROM winecatalog.produtores d
     WHERE p.id = v_para_id AND d.id = v_de_id;
    IF NOT EXISTS (SELECT 1 FROM winecatalog.produtor_variantes WHERE produtor_id = v_de_id) THEN
      DELETE FROM winecatalog.produtores WHERE id = v_de_id;
    END IF;
  END IF;
  RETURN r;
END;
$function$;
REVOKE ALL ON FUNCTION winecatalog.produtor_juntar(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION winecatalog.produtor_juntar(text, text) TO authenticated;
