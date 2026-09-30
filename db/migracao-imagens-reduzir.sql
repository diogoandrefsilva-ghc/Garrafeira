-- =====================================================================
-- Migração 35 — as imagens copiadas ficam PEQUENAS
-- (30/09/2026, o dono: "uma imagem de 3 MBs para um vinho não faz sentido")
--
-- A migração 34 guardava a imagem da loja tal e qual: 55 das 302 passavam
-- dos 250 KB e três dos 1 MB (PNG de 3,3 MB para uma garrafa). Agora a
-- `garrafeira-imagens` passa cada uma pelas transformações de imagem do
-- próprio Supabase (`/storage/v1/render/image`, que este projeto tem
-- ligadas): no máximo 800×800, WebP a 80 — a PNG de 3,3 MB fica em 17 KB.
-- Guarda-se o RESULTADO (não se transforma a cada visita), e a original
-- apaga-se do bucket. O WebP mantém a transparência das garrafas recortadas.
--
-- As que já estavam copiadas passam pela mesma redução na volta seguinte
-- da função (`reduzida = false`): o ficheiro novo, o link trocado no
-- catálogo e nas garrafeiras (`imagem_trocar`, do link velho do Supabase
-- para o novo), e o velho apagado.
--
-- Se a transformação falhar, fica a original: uma imagem grande é melhor
-- do que nenhuma. Diz-se em `erro`.
--
-- Custo: o Supabase cobra as transformações por imagem de ORIGEM diferente
-- por mês. Cada imagem transforma-se uma vez na vida, por isso é o número
-- de imagens novas desse mês.
-- =====================================================================

ALTER TABLE garrafeira.imagens_copia ADD COLUMN IF NOT EXISTS reduzida boolean NOT NULL DEFAULT false;

-- O que há por fazer: por copiar E por reduzir (o cron só acorda a função
-- se houver alguma das duas).
CREATE OR REPLACE FUNCTION garrafeira.imagens_descobrir()
  RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  r record;
  n integer;
BEGIN
  INSERT INTO garrafeira.imagens_copia (url_origem)
  SELECT DISTINCT u FROM (
    SELECT btrim(ficha ->> 'imagem_url') u FROM winecatalog.vinhos
    UNION
    SELECT btrim(imagem_url) FROM garrafeira.vinhos
  ) x
  WHERE u ~ '^https?://' AND NOT garrafeira.imagem_no_supabase(u)
  ON CONFLICT (url_origem) DO NOTHING;

  FOR r IN
    SELECT c.url_origem, c.url FROM garrafeira.imagens_copia c
     WHERE c.estado = 'copiada'
       AND (EXISTS (SELECT 1 FROM winecatalog.vinhos v WHERE v.ficha ->> 'imagem_url' = c.url_origem)
            OR EXISTS (SELECT 1 FROM garrafeira.vinhos g WHERE g.imagem_url = c.url_origem))
  LOOP
    PERFORM garrafeira.imagem_trocar(r.url_origem, r.url);
  END LOOP;

  SELECT count(*) INTO n FROM garrafeira.imagens_copia
   WHERE (estado = 'pendente' AND tentativas < 3)
      OR (estado = 'copiada' AND NOT reduzida);
  RETURN n;
END;
$$;

-- As já copiadas que falta reduzir, com o mesmo "em curso" do lote de cópia.
CREATE OR REPLACE FUNCTION garrafeira.imagens_por_reduzir(p_limite integer DEFAULT 10)
  RETURNS TABLE (url_origem text, caminho text, url text, bytes integer) LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
BEGIN
  RETURN QUERY
  UPDATE garrafeira.imagens_copia c
     SET em_curso_ate = now() + interval '2 minutes'
   WHERE c.url_origem IN (
     SELECT x.url_origem FROM garrafeira.imagens_copia x
      WHERE x.estado = 'copiada' AND NOT x.reduzida
        AND (x.em_curso_ate IS NULL OR x.em_curso_ate < now())
      ORDER BY x.bytes DESC NULLS LAST
      LIMIT GREATEST(1, LEAST(COALESCE(p_limite, 10), 50))
        FOR UPDATE SKIP LOCKED)
  RETURNING c.url_origem, c.caminho, c.url, c.bytes;
END;
$$;

-- O resultado de uma redução: o ficheiro novo (e o link trocado em todo o
-- lado), ou — sem `p_url` — ficou a original, e diz-se porquê.
CREATE OR REPLACE FUNCTION garrafeira.imagem_reduzida(
  p_origem text, p_caminho text DEFAULT NULL, p_url text DEFAULT NULL,
  p_bytes integer DEFAULT NULL, p_tipo text DEFAULT NULL, p_erro text DEFAULT NULL)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
DECLARE
  v_antes text;
  t jsonb := '{}'::jsonb;
BEGIN
  SELECT url INTO v_antes FROM garrafeira.imagens_copia WHERE url_origem = p_origem;
  IF p_url IS NOT NULL AND p_url IS DISTINCT FROM v_antes THEN
    UPDATE garrafeira.imagens_copia
       SET caminho = p_caminho, url = p_url, bytes = p_bytes, tipo = p_tipo,
           reduzida = true, erro = NULL, em_curso_ate = NULL
     WHERE url_origem = p_origem;
    t := garrafeira.imagem_trocar(v_antes, p_url);
  ELSE
    UPDATE garrafeira.imagens_copia
       SET reduzida = true, em_curso_ate = NULL,
           bytes = COALESCE(p_bytes, bytes), erro = left(p_erro, 300)
     WHERE url_origem = p_origem;
  END IF;
  RETURN t;
END;
$$;

-- A cópia nova já vem reduzida (a função reduz antes de responder): a
-- `imagem_resultado` passa a dizê-lo. Outra assinatura, por isso sai a velha.
DROP FUNCTION IF EXISTS garrafeira.imagem_resultado(text, boolean, text, text, integer, text, text);
CREATE OR REPLACE FUNCTION garrafeira.imagem_resultado(
  p_origem text, p_ok boolean, p_caminho text DEFAULT NULL, p_url text DEFAULT NULL,
  p_bytes integer DEFAULT NULL, p_tipo text DEFAULT NULL, p_erro text DEFAULT NULL,
  p_reduzida boolean DEFAULT false)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
DECLARE
  t jsonb := '{}'::jsonb;
BEGIN
  IF p_ok THEN
    UPDATE garrafeira.imagens_copia
       SET estado = 'copiada', caminho = p_caminho, url = p_url, bytes = p_bytes, tipo = p_tipo,
           reduzida = p_reduzida, erro = CASE WHEN p_reduzida THEN NULL ELSE left(p_erro, 300) END,
           em_curso_ate = NULL, tentado_em = now(), copiada_em = now(),
           tentativas = tentativas + 1
     WHERE url_origem = p_origem;
    t := garrafeira.imagem_trocar(p_origem, p_url);
  ELSE
    UPDATE garrafeira.imagens_copia
       SET tentativas = tentativas + 1, erro = left(p_erro, 300), em_curso_ate = NULL, tentado_em = now(),
           estado = CASE WHEN tentativas + 1 >= 3 THEN 'falhou' ELSE 'pendente' END
     WHERE url_origem = p_origem;
  END IF;
  INSERT INTO garrafeira.sync_log (origem, acao, estado, quem, detalhe)
  VALUES ('function', 'garrafeira-imagens', CASE WHEN p_ok THEN 'ok' ELSE 'erro' END, 'cópia das imagens',
          jsonb_build_object('origem', p_origem, 'url', p_url, 'bytes', p_bytes, 'erro', p_erro,
                             'reduzida', p_reduzida) || t);
  RETURN t;
END;
$$;

CREATE OR REPLACE FUNCTION garrafeira.imagens_resumo()
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
BEGIN
  IF NOT garrafeira.is_admin() THEN RAISE EXCEPTION 'só o admin'; END IF;
  RETURN jsonb_build_object(
    'copiadas',    (SELECT count(*) FROM garrafeira.imagens_copia WHERE estado = 'copiada'),
    'por_reduzir', (SELECT count(*) FROM garrafeira.imagens_copia WHERE estado = 'copiada' AND NOT reduzida),
    'pendentes',   (SELECT count(*) FROM garrafeira.imagens_copia WHERE estado = 'pendente'),
    'falhadas',    (SELECT count(*) FROM garrafeira.imagens_copia WHERE estado = 'falhou'),
    'mb',          (SELECT round(COALESCE(sum(bytes), 0) / 1048576.0, 1) FROM garrafeira.imagens_copia WHERE estado = 'copiada'),
    'erros',       COALESCE((SELECT jsonb_agg(jsonb_build_object('url', url_origem, 'erro', erro) ORDER BY tentado_em DESC)
                               FROM (SELECT * FROM garrafeira.imagens_copia WHERE estado = 'falhou'
                                      ORDER BY tentado_em DESC LIMIT 30) f), '[]'::jsonb));
END;
$$;

-- Os ficheiros que sobram no bucket: a original de uma imagem já reduzida
-- cujo apagar falhou (o Storage respondeu 429). Só os que têm uma irmã
-- reduzida em uso (o mesmo nome, outra extensão) — nunca um ficheiro de que
-- não se sabe nada.
CREATE OR REPLACE FUNCTION garrafeira.imagens_orfas(p_limite integer DEFAULT 50)
  RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'garrafeira', 'storage', 'public'
AS $$
  SELECT o.name FROM storage.objects o
   WHERE o.bucket_id = 'garrafeira-imagens'
     AND NOT EXISTS (SELECT 1 FROM garrafeira.imagens_copia c WHERE c.caminho = o.name)
     AND EXISTS (SELECT 1 FROM garrafeira.imagens_copia c
                  WHERE c.estado = 'copiada' AND c.reduzida
                    AND split_part(c.caminho, '.', 1) = split_part(o.name, '.', 1))
   LIMIT GREATEST(1, LEAST(COALESCE(p_limite, 50), 200));
$$;

REVOKE ALL ON FUNCTION garrafeira.imagens_orfas(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION garrafeira.imagens_orfas(integer) TO service_role;
REVOKE ALL ON FUNCTION garrafeira.imagens_por_reduzir(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION garrafeira.imagem_reduzida(text, text, text, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION garrafeira.imagem_resultado(text, boolean, text, text, integer, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION garrafeira.imagens_por_reduzir(integer) TO service_role;
GRANT EXECUTE ON FUNCTION garrafeira.imagem_reduzida(text, text, text, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION garrafeira.imagem_resultado(text, boolean, text, text, integer, text, text, boolean) TO service_role;
