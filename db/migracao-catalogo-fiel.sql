-- =====================================================================
-- Migração 39 — o Catálogo fidedigno (01/10/2026, o dono das apps: "o meu
-- objetivo é que o Catálogo fique fidedigno").
--
-- Até aqui cada gravação de um vinho levava a ficha INTEIRA da garrafeira à
-- linha ligada pela `juntar`, que substitui com força IGUAL ou maior: a
-- garrafeira vale 3 no rótulo e 2 na nota e no preço, e tapava o que as
-- lojas, o Vivino e a IA tinham lá posto (3 e 2) — numa gravação qualquer,
-- de qualquer pessoa, até ao mudar só o lugar de uma garrafa. Só o que o
-- admin ou um curador escreveu (4) resistia. Agora:
--
--  · O NOME E O PRODUTOR de um vinho gravado não se mudam na garrafeira
--    (`vinhos_identidade_fixa`). Vêm do catálogo (`receber_identidade`); se
--    estiverem errados, é o "Algo não está bem?" que avisa o admin. Quem
--    escreve pela API (`authenticated`) fica com o que estava; as funções
--    da BD (SECURITY DEFINER: o catálogo, os batches do admin) e a
--    service_role passam como sempre.
--  · O RESTO DA FICHA só corrige o catálogo quando a linha é SÓ DESTE VINHO
--    (`linha_so_minha`): nasceu com ele, nenhum outro vinho de garrafeira
--    nenhuma está ligado a ela, nada foi fundido nela, e ninguém além da
--    garrafeira e da procura com IA lhe escreveu (nem o admin, nem um
--    curador, nem as lojas, nem o Vivino, nem a WineSelection). Aí a
--    gravação vai por inteiro, como sempre foi.
--  · Em qualquer outra linha, a garrafeira SÓ ENCHE O QUE O CATÁLOGO TEM
--    VAZIO (`catalogar_e_ligar(…, p_so_vazios)`). E o que a pessoa MUDOU
--    nessa gravação para um valor diferente do que o catálogo tem é uma
--    DIVERGÊNCIA: fica na garrafeira dela, e o admin recebe um comentário
--    (`catalogo_divergencia` → `winecatalog.comentar`, motivo `atributos`,
--    com os valores dela e os do catálogo) — e com ele o push de sempre
--    (migração 27). A nota e o preço (`winecatalog.volatil`) não contam:
--    mudam de mês para mês e não são um erro de ninguém.
--  · Os curadores continuam como na migração 32 (as correções vão pela
--    `curador_levar`, com a força do admin), sem o nome nem o produtor.
--  · Um vinho NOVO numa linha que já existe só enche o vazio e não avisa
--    ninguém: o que se escreve ao criar vem quase sempre do próprio
--    catálogo (o "Procurar informação"), e a importação por fotografias
--    encheria a caixa do admin. A divergência continua à vista no Alertas
--    da WineCatalog ("As garrafeiras × o catálogo").
--
-- A app lê o que aconteceu a seguir a gravar (`curador_resultado`, que
-- passa a dizer também `catalogo_dono` e `catalogo_divergencia`).
-- Idempotente. Corre depois da 32 (curadores) e da 38 (castas).
-- =====================================================================

-- ---------------------------------------------------------------------
-- O nome e o produtor ficam como estavam, a quem escreve pela API.
-- SECURITY INVOKER de propósito: o `current_user` é quem fez o UPDATE —
-- `authenticated` num PATCH da app, o dono das funções numa função
-- SECURITY DEFINER (a `receber_identidade`, os batches do catálogo),
-- `service_role` no painel do PC. Chama-se `…_identidade_fixa` para correr
-- ANTES da `vinhos_nomes` (os BEFORE correm por ordem alfabética).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.vinhos_identidade_fixa()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path TO 'garrafeira', 'public'
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    NEW.nome     := OLD.nome;
    NEW.produtor := OLD.produtor;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.vinhos_identidade_fixa() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER vinhos_identidade_fixa
  BEFORE UPDATE OF nome, produtor ON garrafeira.vinhos
  FOR EACH ROW EXECUTE FUNCTION garrafeira.vinhos_identidade_fixa();

-- ---------------------------------------------------------------------
-- A linha ligada é SÓ deste vinho, e ninguém mais lhe mexeu?
-- O catálogo guarda, por campo, a ORIGEM de quem escreveu (`origens`), não
-- a pessoa: daí as quatro perguntas. A procura com IA conta como dele — a
-- linha nasceu com o vinho, por isso quem a procurou foi quem o tem.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.linha_so_minha(p_vinho_id bigint)
  RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v garrafeira.vinhos%ROWTYPE;
  c winecatalog.vinhos%ROWTYPE;
BEGIN
  SELECT * INTO v FROM garrafeira.vinhos WHERE id = p_vinho_id;
  IF v.id IS NULL OR v.catalogo_id IS NULL THEN RETURN false; END IF;
  SELECT w.* INTO c FROM winecatalog.vinhos w
   WHERE w.id = COALESCE((SELECT a.id_para FROM winecatalog.alias a WHERE a.id_de = v.catalogo_id),
                         v.catalogo_id);
  IF c.id IS NULL THEN RETURN false; END IF;

  -- nasceu com este vinho (o trigger fá-la nascer no INSERT)
  IF c.criado_em < v.criado_em - interval '2 minutes' THEN RETURN false; END IF;
  -- nenhum outro vinho, de garrafeira nenhuma, ligado a ela
  IF EXISTS (SELECT 1 FROM garrafeira.vinhos o
              WHERE o.id <> v.id
                AND (o.catalogo_id = c.id
                     OR o.catalogo_id IN (SELECT a.id_de FROM winecatalog.alias a WHERE a.id_para = c.id))) THEN
    RETURN false;
  END IF;
  -- nada fundido nela
  IF EXISTS (SELECT 1 FROM winecatalog.alias a WHERE a.id_para = c.id) THEN RETURN false; END IF;
  -- só a garrafeira e a procura com IA lhe escreveram
  IF EXISTS (SELECT 1 FROM jsonb_each(COALESCE(c.origens, '{}'::jsonb)) e
              WHERE COALESCE(e.value ->> 'o', '') NOT IN
                    ('garrafeira', 'garrafeira-bruto', 'garrafeira-desejo',
                     'vinho-info-premium', 'vinho-info-gratis')) THEN
    RETURN false;
  END IF;
  -- e o admin/curador não a editou (um campo apagado não deixa origem)
  IF EXISTS (SELECT 1 FROM winecatalog.sync_log l
              WHERE l.acao = 'editar' AND l.detalhe ->> 'vinho_id' = c.id::text) THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.linha_so_minha(bigint) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- A DIVERGÊNCIA: os campos que a pessoa mudou para um valor diferente do
-- que o catálogo tem preenchido. Fica na garrafeira dela; o admin recebe
-- um comentário (e o push). Nunca rebenta, e nunca a nota nem o preço.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.catalogo_divergencia(p_vinho_id bigint, p_campos text[])
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v       garrafeira.vinhos%ROWTYPE;
  c       winecatalog.vinhos%ROWTYPE;
  f       jsonb;
  k       text;
  v_dif   text[] := '{}';
  v_deles jsonb  := '{}'::jsonb;
  v_res   jsonb;
  v_erro  text;
BEGIN
  SELECT * INTO v FROM garrafeira.vinhos WHERE id = p_vinho_id;
  IF v.id IS NULL OR v.catalogo_id IS NULL OR p_campos IS NULL THEN RETURN NULL; END IF;
  SELECT w.* INTO c FROM winecatalog.vinhos w
   WHERE w.id = COALESCE((SELECT a.id_para FROM winecatalog.alias a WHERE a.id_de = v.catalogo_id),
                         v.catalogo_id);
  IF c.id IS NULL THEN RETURN NULL; END IF;
  f := COALESCE(garrafeira.ficha_catalogo(v.id), '{}'::jsonb);

  FOREACH k IN ARRAY p_campos LOOP
    CONTINUE WHEN k = 'tipo' OR winecatalog.volatil(k) OR k = ANY(v_dif);
    CONTINUE WHEN NOT (f ? k) OR winecatalog.vazio(f -> k);
    CONTINUE WHEN NOT (c.ficha ? k) OR winecatalog.vazio(c.ficha -> k);
    CONTINUE WHEN winecatalog.igual(c.ficha -> k, f -> k);
    v_dif   := array_append(v_dif, k);
    v_deles := v_deles || jsonb_build_object(k, f -> k);
  END LOOP;
  IF cardinality(v_dif) = 0 THEN RETURN NULL; END IF;

  BEGIN
    v_res := winecatalog.comentar(
      'vinho', 'atributos',
      'Divergência automática: alterei na minha garrafeira '
        || CASE WHEN cardinality(v_dif) = 1 THEN 'um campo que o Catálogo tem diferente'
                ELSE cardinality(v_dif) || ' campos que o Catálogo tem diferentes' END
        || ' (' || array_to_string(v_dif, ', ') || '). Revê se o Catálogo deve mudar.',
      v.nome, COALESCE(v.produtor, ''), v.ano, v.tipo,
      v_dif, v_deles, NULL, 'garrafeira');
  EXCEPTION WHEN OTHERS THEN
    v_erro := SQLERRM;
  END;

  INSERT INTO garrafeira.sync_log (origem, acao, estado, quem, detalhe)
  VALUES ('app', 'catalogo_divergencia', CASE WHEN v_erro IS NULL THEN 'ok' ELSE 'erro' END,
          auth.email(),
          jsonb_strip_nulls(jsonb_build_object(
            'vinho_id', v.id, 'catalogo_id', c.id, 'campos', to_jsonb(v_dif),
            'comentario', v_res -> 'id', 'erro', v_erro)));
  RETURN jsonb_build_object('campos', to_jsonb(v_dif), 'erro', v_erro);
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.catalogo_divergencia(bigint, text[]) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- CATALOGAR E LIGAR, agora com `p_so_vazios`: numa linha que já existe, só
-- vão os campos que ela tem vazios. A cor (`tipo`) vai sempre — é por ela
-- que a `juntar` acha a linha. A de dois argumentos (migração 29) fica, a
-- chamar esta com `p_so_vazios` falso — sem DROP, e sem defaults nesta,
-- para nenhuma chamada ser ambígua entre as duas.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.catalogar_e_ligar(p_vinho_id bigint, p_religar boolean,
                                                        p_so_vazios boolean)
  RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v        garrafeira.vinhos%ROWTYPE;
  c        winecatalog.vinhos%ROWTYPE;
  v_idt    jsonb;
  v_ficha  jsonb;
  v_castas integer;
  v_curado boolean;
  v_origem text;
  v_nome   text;
  v_prod   text;
  v_ano    integer;
  v_id     bigint;
  v_alvo   jsonb;
  k        text;
BEGIN
  SELECT * INTO v FROM garrafeira.vinhos WHERE id = p_vinho_id;
  IF v.id IS NULL OR COALESCE(v.nome, '') = '' THEN RETURN NULL; END IF;

  -- A linha ligada, com o `alias` resolvido.
  IF NOT p_religar AND v.catalogo_id IS NOT NULL THEN
    SELECT w.* INTO c FROM winecatalog.vinhos w
     WHERE w.id = COALESCE((SELECT a.id_para FROM winecatalog.alias a WHERE a.id_de = v.catalogo_id),
                           v.catalogo_id);
  END IF;
  -- Um desejo sem linha: a que a `achar` der, a mesma colheita primeiro e
  -- senão qualquer uma, antes de a `juntar` fazer nascer outra linha de um
  -- vinho que o catálogo já tem.
  IF v.desejado AND c.id IS NULL THEN
    SELECT w.* INTO c FROM winecatalog.vinhos w WHERE w.id = garrafeira.achar_no_catalogo(v.id);
  END IF;

  v_ficha := garrafeira.ficha_catalogo(v.id);
  IF v_ficha IS NULL THEN RETURN NULL; END IF;
  v_castas := COALESCE(jsonb_array_length(v_ficha -> 'castas'), 0);

  -- Um vinho a que ninguém tocou vale menos do que uma pesquisa (ver
  -- `catalogo-partilhado.sql`): o `tipo` nasce 'Tinto' por omissão nesta app.
  v_curado := v.ai_atualizado_em IS NOT NULL
              OR v_castas > 0
              OR v.vivino_nota IS NOT NULL
              OR v.vivino_nota_global IS NOT NULL
              OR v.preco_medio IS NOT NULL
              OR (COALESCE(v.regiao,'') <> '' AND COALESCE(v.produtor,'') <> '');
  -- A wishlist: sem a garrafa na mão, 1 em tudo.
  v_origem := CASE WHEN v.desejado THEN 'garrafeira-desejo'
                   WHEN v_curado   THEN 'garrafeira'
                   ELSE 'garrafeira-bruto' END;

  v_nome := v.nome;
  v_prod := COALESCE(v.produtor, '');
  v_ano  := v.ano;
  IF c.id IS NOT NULL AND (c.ano IS NOT DISTINCT FROM v.ano OR v.desejado) THEN
    v_idt := winecatalog.identidade(c.nome, COALESCE(NULLIF(c.produtor, ''), v_prod), c.ano, v.tipo, true);
    IF winecatalog.achar(v_idt ->> 'nome', v_idt ->> 'produtor', (v_idt ->> 'ano')::integer,
                         true, NULL, v_idt ->> 'cor') = c.id THEN
      v_nome := c.nome;
      v_prod := COALESCE(NULLIF(c.produtor, ''), v_prod);
      -- O desejo noutra colheita (ou sem ela): só o que é do VINHO.
      IF c.ano IS DISTINCT FROM v.ano THEN
        v_ano := c.ano;
        FOR k IN SELECT jsonb_object_keys(v_ficha) LOOP
          IF winecatalog.da_colheita(k) THEN v_ficha := v_ficha - k; END IF;
        END LOOP;
      END IF;
    END IF;
  END IF;

  -- Só o vazio: a linha onde a `juntar` vai escrever é a que ela própria
  -- vai achar (a mesma pergunta, com a mesma identidade). Não havendo
  -- linha, nasce com tudo — é dele.
  IF p_so_vazios THEN
    v_idt := winecatalog.identidade(v_nome, v_prod, v_ano, v_ficha ->> 'tipo', true);
    SELECT w.ficha INTO v_alvo FROM winecatalog.vinhos w
     WHERE w.id = winecatalog.achar(v_idt ->> 'nome', v_idt ->> 'produtor', (v_idt ->> 'ano')::integer,
                                    true, NULL, v_idt ->> 'cor');
    IF v_alvo IS NOT NULL THEN
      FOR k IN SELECT jsonb_object_keys(v_ficha) LOOP
        CONTINUE WHEN k = 'tipo';
        IF (v_alvo ? k) AND NOT winecatalog.vazio(v_alvo -> k) THEN
          v_ficha := v_ficha - k;
        END IF;
      END LOOP;
    END IF;
  END IF;

  v_id := winecatalog.juntar(
    v_nome, v_prod, v_ano, v_ficha, v_origem,
    CASE WHEN jsonb_typeof(v.ai_fontes) = 'array' THEN v.ai_fontes ELSE '[]'::jsonb END
  );
  -- Mudada a identidade e sem linha nenhuma, a ligação antiga era de OUTRO
  -- vinho: sai. Sem a identidade mudada, um "não sei" não desfaz a ligação.
  IF v_id IS NOT NULL OR p_religar THEN
    PERFORM garrafeira.ligar_catalogo(v.id, v_id);
  END IF;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.catalogar_e_ligar(bigint, boolean, boolean) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION garrafeira.catalogar_e_ligar(p_vinho_id bigint, p_religar boolean DEFAULT false)
  RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
BEGIN
  RETURN garrafeira.catalogar_e_ligar(p_vinho_id, p_religar, false);
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.catalogar_e_ligar(bigint, boolean) FROM PUBLIC, anon, authenticated;

-- A de sempre (a `definir_castas` chama-a): a linha só minha recebe tudo,
-- as outras só o vazio.
CREATE OR REPLACE FUNCTION garrafeira.catalogar_vinho(p_vinho_id bigint)
  RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
BEGIN
  RETURN garrafeira.catalogar_e_ligar(p_vinho_id, false, NOT garrafeira.linha_so_minha(p_vinho_id));
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.catalogar_vinho(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.catalogar_vinho(bigint) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- O TRIGGER. A um curador, a correção (o que mudou) pela `curador_levar`;
-- a quem é dono da linha, a ficha inteira; aos outros, só o vazio e a
-- divergência ao admin.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.vinhos_catalogo()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v_cur   boolean := false;
  v_idt   boolean := false;
  v_outro boolean := false;
  v_minha boolean := false;
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
    -- O nome e o produtor só mudam por uma função da BD (a app já não os
    -- muda: `vinhos_identidade_fixa`).
    v_idt   := NEW.nome IS DISTINCT FROM OLD.nome OR NEW.produtor IS DISTINCT FROM OLD.produtor;
    v_outro := NEW.ano  IS DISTINCT FROM OLD.ano  OR NEW.tipo     IS DISTINCT FROM OLD.tipo;
    BEGIN
      IF NOT v_outro AND NOT v_idt AND NEW.catalogo_id IS NOT NULL THEN
        v_cast := garrafeira.castas_do_vinho(NEW.id);
        v_ant  := garrafeira.ficha_da_linha(OLD, v_cast);
        v_nov  := garrafeira.ficha_da_linha(NEW, v_cast);
        FOR k IN SELECT jsonb_object_keys(v_nov) LOOP
          IF NOT (v_ant ? k) OR NOT winecatalog.igual(v_ant -> k, v_nov -> k) THEN
            v_dif := v_dif || jsonb_build_object(k, v_nov -> k);
          END IF;
        END LOOP;
        v_cur   := COALESCE(winecatalog.sou_curador(), false);
        v_minha := NOT v_cur AND garrafeira.linha_so_minha(NEW.id);
        IF v_dif <> '{}'::jsonb THEN
          IF v_cur THEN
            v_r := garrafeira.curador_levar(NEW.id, v_dif, false);
          ELSIF v_minha THEN
            INSERT INTO garrafeira.sync_log (origem, acao, estado, quem, detalhe)
            VALUES ('app', 'catalogo_dono', 'ok', auth.email(),
                    jsonb_build_object('vinho_id', NEW.id, 'catalogo_id', NEW.catalogo_id,
                      'campos', (SELECT jsonb_agg(z) FROM jsonb_object_keys(v_dif) z)));
          ELSE
            PERFORM garrafeira.catalogo_divergencia(NEW.id,
              ARRAY(SELECT jsonb_object_keys(v_dif)));
          END IF;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  -- Nunca deita a gravação abaixo: alimentar o catálogo é um extra. Mudada
  -- a colheita ou a cor (ou o nome, por uma função da BD), procura-se pelo
  -- nome — pode ser outra linha. A linha só minha recebe a ficha inteira;
  -- qualquer outra, só o que tem vazio.
  BEGIN
    PERFORM garrafeira.catalogar_e_ligar(NEW.id,
      TG_OP = 'INSERT' OR v_outro OR v_idt,
      NOT v_minha);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.vinhos_catalogo() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- As castas mudaram, a quem não é curador: regista a correção do dono da
-- linha, ou manda a divergência ao admin. É SECURITY DEFINER (a
-- `definir_castas` não é) e por isso confere outra vez quem pode mexer.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.castas_mudaram(p_vinho_id bigint)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v garrafeira.vinhos%ROWTYPE;
BEGIN
  SELECT * INTO v FROM garrafeira.vinhos WHERE id = p_vinho_id;
  IF v.id IS NULL OR v.catalogo_id IS NULL OR NOT garrafeira.pode_mexer(v.garrafeira_id) THEN RETURN; END IF;
  IF COALESCE(winecatalog.sou_curador(), false) THEN RETURN; END IF;
  -- um vinho acabado de criar não avisa ninguém (as castas vêm num segundo pedido)
  IF v.criado_em > now() - interval '2 minutes' THEN RETURN; END IF;
  IF garrafeira.linha_so_minha(v.id) THEN
    INSERT INTO garrafeira.sync_log (origem, acao, estado, quem, detalhe)
    VALUES ('app', 'catalogo_dono', 'ok', auth.email(),
            jsonb_build_object('vinho_id', v.id, 'catalogo_id', v.catalogo_id, 'campos', '["castas"]'::jsonb));
  ELSE
    PERFORM garrafeira.catalogo_divergencia(v.id, ARRAY['castas']);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.castas_mudaram(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.castas_mudaram(bigint) TO authenticated;

-- ---------------------------------------------------------------------
-- As castas: não vivem na linha do vinho. Mudadas, um curador leva-as
-- (`curador_levar`); aos outros, a `castas_mudaram`. Cópia da de
-- `functions.sql`.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.definir_castas(p_vinho_id bigint, p_nomes text[])
  RETURNS integer LANGUAGE plpgsql
  SET search_path TO 'garrafeira', 'public'
AS $$
DECLARE
  v_nome  text;
  v_ids   bigint[] := '{}';
  v_id    bigint;
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

  -- Um CURADOR (migração 32): as castas que mudou chegam à linha ligada,
  -- com a força dele. Quem não é curador (migração 39): o dono da linha
  -- corrige-a (a `catalogar_vinho` leva tudo); os outros avisam o admin.
  -- Vai ANTES da `catalogar_vinho`.
  BEGIN
    IF cardinality(v_ids) > 0
       AND v_antes IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(v_ids) x) THEN
      PERFORM garrafeira.curador_levar(p_vinho_id, '{"castas": null}'::jsonb);
      PERFORM garrafeira.castas_mudaram(p_vinho_id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  -- O catálogo partilhado: as castas não vivem na linha do vinho, por isso
  -- o trigger não as vê mudar. Nunca deita a gravação abaixo.
  BEGIN
    PERFORM garrafeira.catalogar_vinho(p_vinho_id);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN cardinality(v_ids);
END;
$$;

-- ---------------------------------------------------------------------
-- O que aconteceu a este vinho no catálogo no último minuto — a app
-- mostra-o a seguir a gravar. Só as minhas. Passa a dizer também a
-- correção do dono da linha e a divergência.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.curador_resultado(p_vinho_id bigint)
  RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('estado', l.estado, 'em', l.criado_em, 'acao', l.acao)
                            || l.detalhe ORDER BY l.criado_em), '[]'::jsonb)
    FROM garrafeira.sync_log l
   WHERE l.acao IN ('curador_catalogo', 'catalogo_dono', 'catalogo_divergencia')
     AND l.quem = auth.email()
     AND l.detalhe ->> 'vinho_id' = p_vinho_id::text
     AND l.criado_em > now() - interval '1 minute';
$$;
REVOKE ALL ON FUNCTION garrafeira.curador_resultado(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.curador_resultado(bigint) TO authenticated;

-- ---------------------------------------------------------------------
-- Confirmar:
-- SELECT tgname FROM pg_trigger WHERE tgrelid = 'garrafeira.vinhos'::regclass AND NOT tgisinternal;
-- SELECT id, nome, garrafeira.linha_so_minha(id) FROM garrafeira.vinhos ORDER BY id;
-- =====================================================================
