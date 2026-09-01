-- =====================================================================
-- Garrafeira — Funções (schema `garrafeira`)
-- Ordem: schema.sql -> functions.sql -> policies.sql
--
-- Nota de segurança: `is_admin`, `is_allowed` e `is_editor` são
-- SECURITY DEFINER com search_path fixo. Têm de o ser: leem tabelas que
-- estão elas próprias por trás de RLS (`config`, `allowed_users`), e uma
-- policy que chama uma função que volta a bater na mesma tabela protegida
-- é recursão infinita (42P17) ou, pior, um `false` calado que tranca a app
-- toda sem erro visível.
-- =====================================================================

-- Quem é o admin? Vive numa linha de `garrafeira.config` (chave
-- 'admin_email') e não fixo aqui, porque esta app nasce com um dono para
-- testes e passa depois para outro. Trocar o dono passa a ser um clique
-- (garrafeira.definir_admin) em vez de um deploy de SQL.
-- O COALESCE é a rede de segurança: se alguém apagar a linha, a app não
-- fica sem admin nenhum (o que a trancaria para sempre — não haveria
-- ninguém com direito a repor a linha).
CREATE OR REPLACE FUNCTION garrafeira.admin_email()
  RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
  SELECT COALESCE(
    (SELECT lower(valor) FROM garrafeira.config WHERE chave = 'admin_email'),
    'diogo.andre.f.silva@gmail.com'
  );
$$;

CREATE OR REPLACE FUNCTION garrafeira.is_admin()
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
  SELECT lower(COALESCE(auth.email(), '')) = garrafeira.admin_email();
$$;

-- Tem acesso? (email consta em allowed_users). O admin conta sempre, mesmo
-- que se esqueça de se pôr na lista a si próprio.
CREATE OR REPLACE FUNCTION garrafeira.is_allowed()
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
  SELECT garrafeira.is_admin() OR EXISTS (
    SELECT 1 FROM garrafeira.allowed_users
     WHERE lower(email) = lower(COALESCE(auth.email(), ''))
  );
$$;

-- Pode ESCREVER (vinhos, garrafas, locais, castas)? O admin, e quem ele
-- marcar com `pode_editar`. É o meio-termo que o Goals não tem: numa
-- garrafeira de casa faz sentido que mais do que uma pessoa dê saída a uma
-- garrafa sem por isso mandar em quem tem acesso à app.
CREATE OR REPLACE FUNCTION garrafeira.is_editor()
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
  SELECT garrafeira.is_admin() OR EXISTS (
    SELECT 1 FROM garrafeira.allowed_users
     WHERE lower(email) = lower(COALESCE(auth.email(), ''))
       AND pode_editar
  );
$$;

-- ---------------------------------------------------------------------
-- Passar a app a outro dono (Definições › Utilizadores)
-- ---------------------------------------------------------------------
-- Só o admin ATUAL pode fazer isto, e o novo dono tem de já ter acesso —
-- passar a app a um email que não está em `allowed_users` é ficar sem
-- admin nenhum e sem forma de voltar atrás pela UI.
-- SECURITY DEFINER porque `config` não tem policy de UPDATE para ninguém:
-- é esta função a ÚNICA porta de entrada, e a verificação é dela.
CREATE OR REPLACE FUNCTION garrafeira.definir_admin(p_email text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
DECLARE
  v_novo text := lower(trim(COALESCE(p_email, '')));
BEGIN
  IF NOT garrafeira.is_admin() THEN
    RAISE EXCEPTION 'Só o admin pode passar a app a outra pessoa.';
  END IF;
  IF v_novo = '' OR v_novo NOT LIKE '%@%' THEN
    RAISE EXCEPTION 'Email inválido.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM garrafeira.allowed_users WHERE lower(email) = v_novo) THEN
    RAISE EXCEPTION 'Esse email ainda não tem acesso à app — aprova-o primeiro na lista de utilizadores.';
  END IF;

  INSERT INTO garrafeira.config (chave, valor) VALUES ('admin_email', v_novo)
  ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;

  -- O novo dono fica também com `pode_editar`: se um dia deixar de ser
  -- admin, continua a poder mexer nas garrafas em vez de ficar de fora.
  UPDATE garrafeira.allowed_users SET pode_editar = true WHERE lower(email) = v_novo;

  RETURN v_novo;
END;
$$;

-- ---------------------------------------------------------------------
-- Password temporária dada pelo admin
-- ---------------------------------------------------------------------
-- Mesma rede de segurança do Goals/FestasBV: este projeto Supabase não tem
-- SMTP próprio, por isso o "esqueci-me da password" fica dependente do
-- template genérico (sem código, e vulnerável aos scanners de email que
-- gastam o link antes da pessoa lá chegar). Em vez disso, o admin gera uma
-- password, dita-a por telefone, e a pessoa troca-a em Definições › Conta.
--
-- A app NUNCA escreve em `auth.users` — a chave que ela tem é a `anon`
-- pública. Quem faz o trabalho é esta função, e a verificação é do lado do
-- servidor (is_admin()), não da UI.
CREATE OR REPLACE FUNCTION garrafeira.admin_pass_temp(p_email text, p_pass text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER
  -- 'auth' NÃO entra no search_path: `auth.users` vai sempre qualificado, e
  -- deixar esse schema à frente numa função SECURITY DEFINER é dar-lhe
  -- prioridade sobre tudo o resto por uma conveniência de escrita.
  SET search_path TO 'garrafeira', 'public', 'extensions'
AS $$
DECLARE
  v_email text := lower(trim(COALESCE(p_email, '')));
  v_id    uuid;
BEGIN
  IF NOT garrafeira.is_admin() THEN
    RAISE EXCEPTION 'Só o admin pode gerar passwords.';
  END IF;
  IF length(COALESCE(p_pass, '')) < 8 THEN
    RAISE EXCEPTION 'A password tem de ter pelo menos 8 caracteres.';
  END IF;
  IF v_email = garrafeira.admin_email() THEN
    -- A conta do próprio admin muda-se no painel do Supabase. Deixá-la
    -- aqui era dar a quem apanhasse a sessão do admin uma forma de lhe
    -- trocar a password e ficar com a app.
    RAISE EXCEPTION 'A password do admin muda-se no Supabase, não por aqui.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM garrafeira.allowed_users WHERE lower(email) = v_email) THEN
    RAISE EXCEPTION 'Esse email não tem acesso à app.';
  END IF;

  SELECT id INTO v_id FROM auth.users WHERE lower(email) = v_email;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Não existe conta com esse email.';
  END IF;

  UPDATE auth.users
     -- crypt()/gen_salt() vêm do pgcrypto (schema `extensions`, já no
     -- search_path). Custo 10 explícito: é o que o GoTrue usa, e o defeito
     -- do gen_salt é 6 — uma password gerada aqui ficaria com um hash mais
     -- fraco do que as que o próprio Supabase escreve.
     SET encrypted_password = crypt(p_pass, gen_salt('bf', 10)),
         updated_at = now()
   WHERE id = v_id;

  RETURN v_email;
END;
$$;

-- ---------------------------------------------------------------------
-- Consumir uma garrafa (uma transação, não dois PATCH)
-- ---------------------------------------------------------------------
-- Podia ser um PATCH simples da app, mas "consumir" mexe em cinco colunas
-- de uma vez e o CHECK `garrafas_consumo_chk` exige que estado e data
-- andem juntos. Numa função, ou entra tudo ou não entra nada — e a app
-- fica sem forma de gravar meia saída por a rede ter caído a meio.
CREATE OR REPLACE FUNCTION garrafeira.consumir_garrafa(
  p_garrafa_id bigint,
  p_data       date,
  p_local      text DEFAULT '',
  p_nota       text DEFAULT '',
  p_avaliacao  integer DEFAULT NULL
) RETURNS bigint LANGUAGE plpgsql SECURITY INVOKER
  SET search_path TO 'garrafeira', 'public'
AS $$
DECLARE
  v_id bigint;
BEGIN
  UPDATE garrafeira.garrafas
     SET estado = 'consumida',
         consumido_em = COALESCE(p_data, CURRENT_DATE),
         consumo_local = COALESCE(p_local, ''),
         consumo_nota = COALESCE(p_nota, ''),
         consumo_avaliacao = p_avaliacao
   WHERE id = p_garrafa_id
     -- só garrafas que ainda lá estão: sem isto, tocar duas vezes no botão
     -- reescrevia a data e a nota de um consumo já registado.
     AND estado = 'na_garrafeira'
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Essa garrafa já não está na garrafeira.';
  END IF;
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------
-- Repor uma garrafa consumida (enganou-se no botão)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.repor_garrafa(p_garrafa_id bigint)
  RETURNS bigint LANGUAGE sql SECURITY INVOKER
  SET search_path TO 'garrafeira', 'public'
AS $$
  UPDATE garrafeira.garrafas
     SET estado = 'na_garrafeira', consumido_em = NULL,
         consumo_local = '', consumo_nota = '', consumo_avaliacao = NULL
   WHERE id = p_garrafa_id AND estado = 'consumida'
  RETURNING id;
$$;

-- ---------------------------------------------------------------------
-- Casta por nome, criando-a se ainda não existir
-- ---------------------------------------------------------------------
-- Sem isto, gravar as castas de um vinho eram N pedidos "existe?" seguidos
-- de N pedidos "cria" — e duas pessoas a gravar ao mesmo tempo rebentavam
-- na constraint UNIQUE. Aqui o ON CONFLICT resolve a corrida.
-- Devolve sempre o id, tenha sido criada agora ou não.
CREATE OR REPLACE FUNCTION garrafeira.casta_id(p_nome text)
  RETURNS bigint LANGUAGE plpgsql SECURITY INVOKER
  SET search_path TO 'garrafeira', 'public'
AS $$
DECLARE
  v_nome text := regexp_replace(trim(COALESCE(p_nome, '')), '\s+', ' ', 'g');
  v_id   bigint;
BEGIN
  IF v_nome = '' THEN RETURN NULL; END IF;
  SELECT id INTO v_id FROM garrafeira.castas WHERE lower(nome) = lower(v_nome);
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO garrafeira.castas (nome) VALUES (v_nome)
  ON CONFLICT (nome) DO UPDATE SET nome = EXCLUDED.nome
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Substitui de uma vez as castas de um vinho pela lista dada (apaga as que
-- saíram, cria as que faltam). É uma transação só — a app manda a lista
-- final e não tem de andar a calcular diferenças nem a apanhar meio estado.
CREATE OR REPLACE FUNCTION garrafeira.definir_castas(p_vinho_id bigint, p_nomes text[])
  RETURNS integer LANGUAGE plpgsql SECURITY INVOKER
  SET search_path TO 'garrafeira', 'public'
AS $$
DECLARE
  v_nome text;
  v_ids  bigint[] := '{}';
  v_id   bigint;
BEGIN
  -- ARRAY[]::text[] e não '{}': o literal sem tipo deixa o Postgres a
  -- adivinhar, e num FOREACH sobre um COALESCE isso dá erro de tipo.
  FOREACH v_nome IN ARRAY COALESCE(p_nomes, ARRAY[]::text[]) LOOP
    v_id := garrafeira.casta_id(v_nome);
    IF v_id IS NOT NULL AND NOT (v_id = ANY(v_ids)) THEN
      v_ids := array_append(v_ids, v_id);
    END IF;
  END LOOP;

  DELETE FROM garrafeira.vinho_castas
   WHERE vinho_id = p_vinho_id AND NOT (casta_id = ANY(v_ids));

  INSERT INTO garrafeira.vinho_castas (vinho_id, casta_id)
  SELECT p_vinho_id, x FROM unnest(v_ids) AS x
  ON CONFLICT DO NOTHING;

  RETURN cardinality(v_ids);
END;
$$;

-- ---------------------------------------------------------------------
-- Guarda de inserção dos pedidos de acesso
-- ---------------------------------------------------------------------
-- O que a app manda não decide nada: o pedido é sempre carimbado com o
-- email do JWT e a hora do servidor.
CREATE OR REPLACE FUNCTION garrafeira.ar_guard_ins()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
BEGIN
  NEW.email := lower(COALESCE(auth.email(), NEW.email));
  NEW.requested_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS access_requests_guard_ins ON garrafeira.access_requests;
CREATE TRIGGER access_requests_guard_ins
  BEFORE INSERT ON garrafeira.access_requests
  FOR EACH ROW EXECUTE FUNCTION garrafeira.ar_guard_ins();

-- O `quem` de uma análise é sempre o email do JWT. A Edge Function já o
-- preenche assim, mas quem falar com o PostgREST à mão não tem de o fazer —
-- e uma linha carimbada com o email de outra pessoa é uma linha que nem quem
-- a criou consegue depois ler (a policy de SELECT vai por `quem`).
CREATE OR REPLACE FUNCTION garrafeira.analises_guard_ins()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
BEGIN
  NEW.quem      := lower(COALESCE(auth.email(), ''));
  NEW.criado_em := now();
  NEW.estado    := 'pendente';   -- nasce sempre pendente; quem a fecha é a função
  NEW.resultado := NULL;
  NEW.erro      := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS analises_guard_ins ON garrafeira.analises;
CREATE TRIGGER analises_guard_ins
  BEFORE INSERT ON garrafeira.analises
  FOR EACH ROW EXECUTE FUNCTION garrafeira.analises_guard_ins();

-- Carimba quem criou o vinho, sem confiar no cliente.
CREATE OR REPLACE FUNCTION garrafeira.vinhos_guard_ins()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
BEGIN
  NEW.criado_por := COALESCE(auth.email(), '');
  NEW.criado_em  := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vinhos_guard_ins ON garrafeira.vinhos;
CREATE TRIGGER vinhos_guard_ins
  BEFORE INSERT ON garrafeira.vinhos
  FOR EACH ROW EXECUTE FUNCTION garrafeira.vinhos_guard_ins();

-- ---------------------------------------------------------------------
-- GRANT de execução
-- ---------------------------------------------------------------------
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA garrafeira TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA garrafeira GRANT EXECUTE ON FUNCTIONS TO authenticated;
