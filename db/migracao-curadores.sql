-- =====================================================================
-- Migração 32 — os CURADORES do catálogo (30/09/2026, o dono das apps:
-- "se esses utilizadores fizerem alguma alteração num vinho da sua
-- garrafeira, essa correção deverá atualizar também o vinho no catálogo").
--
-- Quem é curador decide-o o admin do CATÁLOGO (a lista vive lá:
-- `winecatalog.curadores`, `db/curadores.sql` da WineCatalog, que corre
-- ANTES desta). Aqui fica o outro lado: o que um curador muda num vinho da
-- SUA garrafeira chega à linha do catálogo a que ele está ligado
-- (`catalogo_id`), pela MESMA `winecatalog.editar` do admin — com a origem
-- `catalogo-curador`, que vale o mesmo que a do admin (4 no rótulo, 3 na
-- nota e no preço). Uma gravação de quem não é curador continua a ir pela
-- `juntar`, com a força de sempre.
--
-- As regras, todas pela mesma razão (é uma CORREÇÃO do vinho, não outro
-- vinho):
--  · só o que MUDOU nesta gravação (o antes e o depois da linha), nunca a
--    ficha inteira — um preço velho de há um ano não é uma correção;
--  · só a linha LIGADA, e só se for a mesma colheita e a mesma cor. Mudar o
--    ano ou a cor é mudar de vinho: segue o caminho de sempre (procura-se
--    pelo nome, pode ser outra linha);
--  · o nome e o produtor vão com o interruptor da identidade da `editar`:
--    se a linha passar a ser a mesma que outra, a `editar` recusa, fica
--    registado, e segue-se o caminho de sempre (a garrafeira nunca deixa
--    de gravar). Mudado lá, o nome chega às outras garrafeiras ligadas a
--    essa linha (`receber_identidade`);
--  · um campo ESVAZIADO não apaga nada no catálogo: esvaziar na minha
--    garrafeira pode ser só "não quero isto aqui";
--  · as castas vão pela `definir_castas` (não vivem na linha do vinho);
--  · vai ANTES da `juntar`: com a força do curador já escrita, a leitura
--    mais fraca da garrafeira não lhe passa por cima.
-- Cada ida fica no `garrafeira.sync_log` (acao `curador_catalogo`), e a app
-- lê-a a seguir a gravar (`curador_resultado`) para dizer o que aconteceu.
-- O histórico do catálogo diz "curador: <email>" — é o admin que os
-- escolhe, e quer saber quem corrigiu.
-- Idempotente.
-- =====================================================================

-- ---------------------------------------------------------------------
-- A tradução colunas → ficha, a partir de uma LINHA (e não de um id): é o
-- que deixa comparar o antes e o depois dentro do trigger. A
-- `ficha_catalogo` passa a usá-la — uma cópia só.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.ficha_da_linha(v garrafeira.vinhos, p_castas text[])
  RETURNS jsonb LANGUAGE sql IMMUTABLE
  SET search_path TO 'garrafeira', 'public'
AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'tipo',              NULLIF(COALESCE(v.tipo, ''), ''),
    'estilo',            NULLIF(COALESCE(v.estilo, ''), ''),
    'mencao',            NULLIF(COALESCE(v.mencao, ''), ''),
    'classificacao',     NULLIF(COALESCE(v.classificacao, ''), ''),
    'regiao',            NULLIF(COALESCE(v.regiao, ''), ''),
    'sub_regiao',        NULLIF(COALESCE(v.sub_regiao, ''), ''),
    'pais',              NULLIF(COALESCE(v.pais, ''), ''),
    'teor',              v.teor,
    'estagio_meses',     v.estagio_meses,
    'estagio_texto',     NULLIF(COALESCE(v.estagio_texto, ''), ''),
    'castas',            CASE WHEN cardinality(p_castas) > 0 THEN to_jsonb(p_castas) ELSE NULL END,
    'vivino_nota',       v.vivino_nota,
    'vivino_avaliacoes', v.vivino_avaliacoes,
    'vivino_nota_global',       v.vivino_nota_global,
    'vivino_avaliacoes_global', v.vivino_avaliacoes_global,
    'vivino_url',        NULLIF(COALESCE(v.vivino_url, ''), ''),
    'imagem_url',        NULLIF(COALESCE(v.imagem_url, ''), ''),
    'preco_medio',       v.preco_medio,
    'beber_de',          v.beber_de,
    'beber_ate',         v.beber_ate,
    'notas_prova',       NULLIF(COALESCE(v.notas_prova, ''), ''),
    'harmonizacao',      NULLIF(COALESCE(v.harmonizacao, ''), ''),
    'ai_resumo',         NULLIF(COALESCE(v.ai_resumo, ''), '')
  ));
$$;
REVOKE ALL ON FUNCTION garrafeira.ficha_da_linha(garrafeira.vinhos, text[]) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION garrafeira.castas_do_vinho(p_vinho_id bigint)
  RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
  SELECT COALESCE(array_agg(c.nome ORDER BY c.nome), ARRAY[]::text[])
    FROM garrafeira.vinho_castas vc
    JOIN garrafeira.castas c ON c.id = vc.casta_id
   WHERE vc.vinho_id = p_vinho_id;
$$;
REVOKE ALL ON FUNCTION garrafeira.castas_do_vinho(bigint) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION garrafeira.ficha_catalogo(p_vinho_id bigint)
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v garrafeira.vinhos%ROWTYPE;
BEGIN
  SELECT * INTO v FROM garrafeira.vinhos WHERE id = p_vinho_id;
  IF v.id IS NULL THEN RETURN NULL; END IF;
  RETURN garrafeira.ficha_da_linha(v, garrafeira.castas_do_vinho(v.id));
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.ficha_catalogo(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION garrafeira.ficha_catalogo(bigint) TO service_role;

-- ---------------------------------------------------------------------
-- LEVAR a correção de um curador à linha ligada. Nunca rebenta: devolve o
-- que aconteceu (`ok`, ou o `motivo` de não ter ido) e regista.
-- Aberta a `authenticated` porque a `definir_castas` é SECURITY INVOKER —
-- e por isso confere tudo outra vez cá dentro: curador, e dono do vinho.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.curador_levar(p_vinho_id bigint, p_campos jsonb,
                                                    p_identidade boolean DEFAULT false)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v        garrafeira.vinhos%ROWTYPE;
  c        winecatalog.vinhos%ROWTYPE;
  v_cor    text;
  v_campos jsonb := '{}'::jsonb;
  k        text;
  x        jsonb;
  v_quem   text;
  v_res    jsonb;
  v_erro   text;
  v_mot    text;
BEGIN
  IF NOT COALESCE(winecatalog.sou_curador(), false) THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'nao_curador');
  END IF;
  SELECT * INTO v FROM garrafeira.vinhos WHERE id = p_vinho_id;
  IF v.id IS NULL OR NOT garrafeira.pode_mexer(v.garrafeira_id) THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'sem_permissao');
  END IF;

  IF v.catalogo_id IS NOT NULL THEN
    SELECT w.* INTO c FROM winecatalog.vinhos w
     WHERE w.id = COALESCE((SELECT a.id_para FROM winecatalog.alias a WHERE a.id_de = v.catalogo_id),
                           v.catalogo_id);
  END IF;
  v_cor := winecatalog.identidade(v.nome, COALESCE(v.produtor, ''), v.ano, v.tipo, true) ->> 'cor';
  v_mot := CASE WHEN c.id IS NULL                       THEN 'sem_ligacao'
                WHEN c.ano IS DISTINCT FROM v.ano       THEN 'outra_colheita'
                WHEN v_cor IS DISTINCT FROM c.cor       THEN 'outra_cor' END;

  -- As castas vêm sempre da BD (a `definir_castas` só diz que mudaram).
  IF jsonb_typeof(p_campos) = 'object' AND p_campos ? 'castas' THEN
    p_campos := p_campos || jsonb_build_object('castas', to_jsonb(garrafeira.castas_do_vinho(v.id)));
  END IF;
  IF p_campos IS NOT NULL AND jsonb_typeof(p_campos) = 'object' THEN
    FOR k, x IN SELECT key, value FROM jsonb_each(p_campos) LOOP
      CONTINUE WHEN k = 'tipo' OR winecatalog.vazio(x);
      v_campos := v_campos || jsonb_build_object(k, x);
    END LOOP;
  END IF;
  IF v_mot IS NULL AND v_campos = '{}'::jsonb AND NOT p_identidade THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'nada');
  END IF;

  IF v_mot IS NULL THEN
    v_quem := current_setting('winecatalog.quem', true);
    PERFORM set_config('winecatalog.quem', 'curador: ' || lower(auth.email()), true);
    BEGIN
      v_res := winecatalog.editar(c.id, v_campos,
                 CASE WHEN p_identidade THEN v.nome END,
                 CASE WHEN p_identidade THEN COALESCE(v.produtor, '') END,
                 c.ano, p_identidade);
    EXCEPTION WHEN OTHERS THEN
      v_erro := SQLERRM;
    END;
    PERFORM set_config('winecatalog.quem', COALESCE(v_quem, ''), true);
  END IF;

  INSERT INTO garrafeira.sync_log (origem, acao, estado, quem, detalhe)
  VALUES ('app', 'curador_catalogo',
          CASE WHEN v_mot IS NULL AND v_erro IS NULL THEN 'ok' ELSE 'erro' END,
          auth.email(),
          jsonb_strip_nulls(jsonb_build_object(
            'vinho_id', v.id, 'catalogo_id', c.id,
            'campos', (SELECT jsonb_agg(z) FROM jsonb_object_keys(v_campos) z),
            'identidade', CASE WHEN p_identidade THEN jsonb_build_object('nome', v.nome, 'produtor', v.produtor) END,
            'motivo', v_mot, 'erro', v_erro, 'resultado', v_res)));

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', v_mot IS NULL AND v_erro IS NULL, 'catalogo_id', c.id,
    'motivo', v_mot, 'erro', v_erro, 'resultado', v_res));
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.curador_levar(bigint, jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.curador_levar(bigint, jsonb, boolean) TO authenticated;

-- ---------------------------------------------------------------------
-- O que aconteceu às correções deste vinho no último minuto — é o que a
-- app mostra a um curador a seguir a gravar. Só as minhas.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.curador_resultado(p_vinho_id bigint)
  RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('estado', l.estado, 'em', l.criado_em) || l.detalhe
                            ORDER BY l.criado_em), '[]'::jsonb)
    FROM garrafeira.sync_log l
   WHERE l.acao = 'curador_catalogo'
     AND l.quem = auth.email()
     AND l.detalhe ->> 'vinho_id' = p_vinho_id::text
     AND l.criado_em > now() - interval '1 minute';
$$;
REVOKE ALL ON FUNCTION garrafeira.curador_resultado(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.curador_resultado(bigint) TO authenticated;

-- ---------------------------------------------------------------------
-- O TRIGGER que leva cada vinho ao catálogo: a um curador, primeiro a
-- correção (o que mudou), depois a `juntar` de sempre.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.vinhos_catalogo()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v_cur   boolean := false;
  v_idt   boolean := false;
  v_outro boolean := false;
  v_levou boolean := false;
  v_cast  text[];
  v_ant   jsonb;
  v_nov   jsonb;
  v_dif   jsonb := '{}'::jsonb;
  v_r     jsonb;
  k       text;
BEGIN
  IF COALESCE(current_setting('garrafeira.do_catalogo', true), '') = 'sim'
     OR COALESCE(current_setting('garrafeira.ligar', true), '') = 'sim' THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_idt   := NEW.nome IS DISTINCT FROM OLD.nome OR NEW.produtor IS DISTINCT FROM OLD.produtor;
    v_outro := NEW.ano  IS DISTINCT FROM OLD.ano  OR NEW.tipo     IS DISTINCT FROM OLD.tipo;
    -- A correção de um curador. Nunca deita a gravação abaixo.
    BEGIN
      v_cur := COALESCE(winecatalog.sou_curador(), false);
      IF v_cur AND NOT v_outro AND NEW.catalogo_id IS NOT NULL THEN
        v_cast := garrafeira.castas_do_vinho(NEW.id);
        v_ant  := garrafeira.ficha_da_linha(OLD, v_cast);
        v_nov  := garrafeira.ficha_da_linha(NEW, v_cast);
        FOR k IN SELECT jsonb_object_keys(v_nov) LOOP
          IF NOT (v_ant ? k) OR NOT winecatalog.igual(v_ant -> k, v_nov -> k) THEN
            v_dif := v_dif || jsonb_build_object(k, v_nov -> k);
          END IF;
        END LOOP;
        IF v_dif <> '{}'::jsonb OR v_idt THEN
          v_r := garrafeira.curador_levar(NEW.id, v_dif, v_idt);
          v_levou := v_idt AND COALESCE((v_r ->> 'ok')::boolean, false);
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  -- Nunca deita a gravação abaixo: alimentar o catálogo é um extra. A
  -- identidade que o curador já levou à linha ligada não é "outro vinho":
  -- fica ligado a ela.
  BEGIN
    PERFORM garrafeira.catalogar_e_ligar(NEW.id,
      TG_OP = 'INSERT' OR v_outro OR (v_idt AND NOT v_levou));
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.vinhos_catalogo() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- As castas: não vivem na linha do vinho, e por isso o trigger não as vê
-- mudar. A `definir_castas` guarda as de antes e, a um curador, leva as
-- novas quando mudaram. Cópia da de `functions.sql` (que é onde ela vale).
-- ---------------------------------------------------------------------
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
  -- ARRAY[]::text[] e não '{}': o literal sem tipo deixa o Postgres a
  -- adivinhar, e num FOREACH sobre um COALESCE isso dá erro de tipo.
  FOREACH v_nome IN ARRAY COALESCE(p_nomes, ARRAY[]::text[]) LOOP
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

  -- Um CURADOR do catálogo (migração 32, `migracao-curadores.sql`): as
  -- castas que mudou chegam à linha ligada do catálogo, com a força dele.
  -- Vai ANTES da `catalogar_vinho`. O valor é lido da BD lá dentro.
  BEGIN
    IF cardinality(v_ids) > 0
       AND v_antes IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(v_ids) x) THEN
      PERFORM garrafeira.curador_levar(p_vinho_id, '{"castas": null}'::jsonb);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  -- O catálogo partilhado (ver `db/catalogo-partilhado.sql`) é alimentado
  -- por um trigger em `garrafeira.vinhos` — mas as castas não vivem nessa
  -- linha, e por isso esse trigger não as vê mudar (num INSERT nem sequer
  -- existem ainda: é esta função que corre a seguir). Sem este gancho, o
  -- catálogo ficava com a ficha toda MENOS as castas, e a app ia à IA
  -- buscar castas que já estavam ali ao lado.
  --
  -- Nunca deita a gravação abaixo: alimentar o catálogo é um extra, e num
  -- schema `winecatalog` que ainda não exista isto tem de ser um silêncio, não
  -- um erro a impedir alguém de guardar as castas de uma garrafa.
  BEGIN
    PERFORM garrafeira.catalogar_vinho(p_vinho_id);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN cardinality(v_ids);
END;
$$;
