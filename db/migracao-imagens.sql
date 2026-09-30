-- =====================================================================
-- Migração 34 — as imagens das lojas passam a viver no Supabase
-- (30/09/2026, o dono das apps: "tendo link fico sempre refém dos sites
-- mudarem o link")
--
-- O `imagem_url` de um vinho (no catálogo e nas garrafeiras) era o link
-- DIRETO de uma loja. Um link morto não se vê — o `onerror` da app troca-o
-- pela garrafa desenhada, calado —, e cada imagem era um pedido a um site
-- de terceiros sempre que alguém abria a lista.
--
-- Agora a Edge Function `garrafeira-imagens` descarrega cada link para o
-- bucket PÚBLICO `garrafeira-imagens` e troca o link, no catálogo e em
-- todas as garrafeiras que tinham o MESMO, pelo do Supabase. A app não
-- muda nada na ordem: continua a ler `imagem_url` (a minha fotografia,
-- `imagem_path`, continua a ganhar e continua no bucket privado).
--
-- O link de origem não se perde: fica em `garrafeira.imagens_copia`, que é
-- também o registo do que falhou e porquê. Uma cópia por LINK (e não por
-- vinho): o mesmo link em dez garrafeiras é um ficheiro só.
--
-- O que chega depois (a IA, uma edição à mão) apanha-o o cron de hora a
-- hora (`garrafeira-imagens`). Um link que já foi copiado não se volta a
-- descarregar: troca-se logo pelo do Supabase.
--
-- Público porque são fotografias de lojas, iguais para toda a gente — ao
-- contrário das minhas (`garrafeira-rotulos`), que apanham a casa à volta.
-- Só a service_role escreve no bucket (não há policy nenhuma para os
-- outros).
-- =====================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('garrafeira-imagens', 'garrafeira-imagens', true, 6291456,
        ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif'])
ON CONFLICT (id) DO UPDATE SET file_size_limit = EXCLUDED.file_size_limit;

-- O prefixo de um endereço que JÁ está no Supabase (este bucket, o
-- `winecatalog-rotulos` da WineCatalog): esses não se copiam.
CREATE OR REPLACE FUNCTION garrafeira.imagem_no_supabase(p_url text)
  RETURNS boolean LANGUAGE sql IMMUTABLE
AS $$
  SELECT COALESCE(p_url, '') LIKE 'https://gjweqwfbnkgnibhajldc.supabase.co/%';
$$;

CREATE TABLE IF NOT EXISTS garrafeira.imagens_copia (
  url_origem   text PRIMARY KEY,
  estado       text NOT NULL DEFAULT 'pendente'
               CHECK (estado IN ('pendente', 'copiada', 'falhou')),
  caminho      text,             -- no bucket `garrafeira-imagens`
  url          text,             -- o endereço público da cópia
  bytes        integer,
  tipo         text,
  tentativas   integer NOT NULL DEFAULT 0,
  erro         text,
  em_curso_ate timestamptz,      -- quem a está a copiar agora (evita dois de uma vez)
  criado_em    timestamptz NOT NULL DEFAULT now(),
  tentado_em   timestamptz,
  copiada_em   timestamptz
);
ALTER TABLE garrafeira.imagens_copia ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON garrafeira.imagens_copia FROM PUBLIC, anon, authenticated;
GRANT ALL ON garrafeira.imagens_copia TO service_role;

-- ---------------------------------------------------------------------
-- TROCAR um link pelo da cópia, em todo o lado onde está. Não volta ao
-- catálogo nem passa pela regra dos nomes (a marca `garrafeira.do_catalogo`,
-- a mesma da `receber_identidade`), e não carimba `atualizado_em`: não foi
-- o dono a mexer.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.imagem_trocar(p_origem text, p_url text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  n_cat integer := 0;
  n_gar integer := 0;
BEGIN
  IF COALESCE(p_origem, '') = '' OR COALESCE(p_url, '') = '' THEN
    RETURN jsonb_build_object('catalogo', 0, 'garrafeiras', 0);
  END IF;
  PERFORM set_config('winecatalog.quem', 'cópia das imagens (migração 34)', true);
  UPDATE winecatalog.vinhos
     SET ficha = jsonb_set(ficha, '{imagem_url}', to_jsonb(p_url))
   WHERE ficha ->> 'imagem_url' = p_origem;
  GET DIAGNOSTICS n_cat = ROW_COUNT;
  PERFORM set_config('garrafeira.do_catalogo', 'sim', true);
  UPDATE garrafeira.vinhos SET imagem_url = p_url WHERE imagem_url = p_origem;
  GET DIAGNOSTICS n_gar = ROW_COUNT;
  PERFORM set_config('garrafeira.do_catalogo', '', true);
  RETURN jsonb_build_object('catalogo', n_cat, 'garrafeiras', n_gar);
END;
$$;

-- ---------------------------------------------------------------------
-- DESCOBRIR o que há por copiar (os links de fora do Supabase, no catálogo
-- e nas garrafeiras), e trocar logo os que já foram copiados antes.
-- Devolve quantos estão à espera.
-- ---------------------------------------------------------------------
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

  -- Um link já copiado que voltou a aparecer (a IA voltou a propô-lo, ou
  -- alguém o colou): troca-se sem descarregar outra vez.
  FOR r IN
    SELECT c.url_origem, c.url FROM garrafeira.imagens_copia c
     WHERE c.estado = 'copiada'
       AND (EXISTS (SELECT 1 FROM winecatalog.vinhos v WHERE v.ficha ->> 'imagem_url' = c.url_origem)
            OR EXISTS (SELECT 1 FROM garrafeira.vinhos g WHERE g.imagem_url = c.url_origem))
  LOOP
    PERFORM garrafeira.imagem_trocar(r.url_origem, r.url);
  END LOOP;

  SELECT count(*) INTO n FROM garrafeira.imagens_copia
   WHERE estado = 'pendente' AND tentativas < 3;
  RETURN n;
END;
$$;

-- O LOTE seguinte para a Edge Function, marcado como "em curso" durante
-- dois minutos (o cron e o botão do admin podem calhar ao mesmo tempo).
CREATE OR REPLACE FUNCTION garrafeira.imagens_por_copiar(p_limite integer DEFAULT 10)
  RETURNS SETOF text LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
BEGIN
  RETURN QUERY
  UPDATE garrafeira.imagens_copia c
     SET em_curso_ate = now() + interval '2 minutes'
   WHERE c.url_origem IN (
     SELECT url_origem FROM garrafeira.imagens_copia
      WHERE estado = 'pendente' AND tentativas < 3
        AND (em_curso_ate IS NULL OR em_curso_ate < now())
        AND (tentado_em IS NULL OR tentado_em < now() - interval '10 minutes')
      ORDER BY tentativas, criado_em
      LIMIT GREATEST(1, LEAST(COALESCE(p_limite, 10), 50))
        FOR UPDATE SKIP LOCKED)
  RETURNING c.url_origem;
END;
$$;

-- O resultado de UMA cópia: copiada (e o link trocado em todo o lado), ou
-- falhada (3 tentativas, e desiste — o link fica como estava).
CREATE OR REPLACE FUNCTION garrafeira.imagem_resultado(
  p_origem text, p_ok boolean, p_caminho text DEFAULT NULL, p_url text DEFAULT NULL,
  p_bytes integer DEFAULT NULL, p_tipo text DEFAULT NULL, p_erro text DEFAULT NULL)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
DECLARE
  t jsonb := '{}'::jsonb;
BEGIN
  IF p_ok THEN
    UPDATE garrafeira.imagens_copia
       SET estado = 'copiada', caminho = p_caminho, url = p_url, bytes = p_bytes, tipo = p_tipo,
           erro = NULL, em_curso_ate = NULL, tentado_em = now(), copiada_em = now(),
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
          jsonb_build_object('origem', p_origem, 'url', p_url, 'bytes', p_bytes, 'erro', p_erro) || t);
  RETURN t;
END;
$$;

-- ---------------------------------------------------------------------
-- ACORDAR a função (pelo pg_net, com a chave do cofre — como o push) e o
-- cron de hora a hora, que só a acorda se houver alguma coisa à espera.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.imagens_cron()
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
BEGIN
  IF garrafeira.imagens_descobrir() > 0 THEN
    PERFORM net.http_post(
      url     := 'https://gjweqwfbnkgnibhajldc.supabase.co/functions/v1/garrafeira-imagens',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets
                                        WHERE name = 'service_role_key')),
      body    := jsonb_build_object('acao', 'copiar'),
      timeout_milliseconds := 5000);
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

SELECT cron.unschedule('garrafeira-imagens')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'garrafeira-imagens');
SELECT cron.schedule('garrafeira-imagens', '17 * * * *', 'SELECT garrafeira.imagens_cron()');

-- ---------------------------------------------------------------------
-- O RESUMO para o Diagnóstico (só o admin): quantas copiadas, à espera,
-- falhadas, e as falhadas com o erro.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.imagens_resumo()
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
BEGIN
  IF NOT garrafeira.is_admin() THEN RAISE EXCEPTION 'só o admin'; END IF;
  RETURN jsonb_build_object(
    'copiadas',  (SELECT count(*) FROM garrafeira.imagens_copia WHERE estado = 'copiada'),
    'pendentes', (SELECT count(*) FROM garrafeira.imagens_copia WHERE estado = 'pendente'),
    'falhadas',  (SELECT count(*) FROM garrafeira.imagens_copia WHERE estado = 'falhou'),
    'mb',        (SELECT round(COALESCE(sum(bytes), 0) / 1048576.0, 1) FROM garrafeira.imagens_copia WHERE estado = 'copiada'),
    'erros',     COALESCE((SELECT jsonb_agg(jsonb_build_object('url', url_origem, 'erro', erro) ORDER BY tentado_em DESC)
                             FROM (SELECT * FROM garrafeira.imagens_copia WHERE estado = 'falhou'
                                    ORDER BY tentado_em DESC LIMIT 30) f), '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION garrafeira.imagem_no_supabase(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION garrafeira.imagem_trocar(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION garrafeira.imagens_descobrir() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION garrafeira.imagens_por_copiar(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION garrafeira.imagem_resultado(text, boolean, text, text, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION garrafeira.imagens_cron() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION garrafeira.imagens_resumo() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.imagem_trocar(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION garrafeira.imagens_descobrir() TO service_role;
GRANT EXECUTE ON FUNCTION garrafeira.imagens_por_copiar(integer) TO service_role;
GRANT EXECUTE ON FUNCTION garrafeira.imagem_resultado(text, boolean, text, text, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION garrafeira.imagens_cron() TO service_role;
GRANT EXECUTE ON FUNCTION garrafeira.imagens_resumo() TO authenticated, service_role;
