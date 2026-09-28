-- =====================================================================
-- Migração 28 — cada vinho sabe qual é a sua linha do catálogo
-- (28/09/2026, o dono das apps)
--
-- Até aqui a ligação entre um vinho de uma garrafeira e a linha do
-- catálogo não estava guardada em lado nenhum: era recalculada de cada vez
-- pela `winecatalog.achar`, a partir do nome, do produtor, do ano e da cor.
-- O nome ERA a ligação — e por isso nunca se podia sincronizar: quando o
-- catálogo corrigia um nome, a garrafeira deixava de achar a linha, e a
-- gravação seguinte fazia nascer outra com o nome antigo. A 28/09/2026
-- havia 34 vinhos nas garrafeiras cuja linha do catálogo dizia outro nome
-- ou outro produtor.
--
-- O que muda:
--   · `vinhos.catalogo_id` — a linha do catálogo deste vinho. SEM FK, de
--     propósito: o catálogo é uma poupança, não uma dependência, e um vinho
--     tem de se gravar mesmo que o catálogo mude ou não exista. Guarda-se o
--     id que a `achar`/`juntar` devolve; lê-se resolvendo o `alias` (uma
--     fusão posterior pode tê-lo posto a responder por outra linha);
--   · só as funções daqui o escrevem (`vinhos_ligacao_guard`): a app nunca
--     o manda, e um valor posto à mão punha o nome de outro vinho a chegar
--     a este;
--   · o trigger do catálogo (`vinhos_catalogo`) passa a guardá-lo e deixa
--     de procurar pelo NOME quando o vinho já está ligado e não mudou de
--     identidade: escreve na linha ligada (`catalogar_e_ligar`). Só volta a
--     procurar pelo nome quando o dono muda o nome, o produtor, o ano ou a
--     cor — aí pode ser outro vinho ("Cristo" → "Crasto");
--   · `receber_identidade` — o nome e o produtor que o catálogo mudou chegam
--     a todos os vinhos ligados, em todas as garrafeiras. Quem a chama é um
--     trigger do catálogo (`db/garrafeiras-identidade.sql` do repo
--     WineCatalog), e só nas mudanças que alguém DECIDIU (não nas da
--     `juntar`). Uma linha no `sync_log` por vinho (origem `winecatalog`,
--     acao `identidade_do_catalogo`). Nunca o ano (a ligação pode ser a
--     outra colheita) nem a cor (cor diferente é outro vinho); um produtor
--     vazio no catálogo não apaga o de cá;
--   · `religar_catalogo` — desfeita uma fusão (`separar`), os vinhos ligados
--     à linha que ficou procuram-se outra vez pelo nome.
--
-- Corre DEPOIS da 24 (`migracao-cor-na-chave.sql`, cujo `vinhos_nomes`
-- substitui) e do `catalogo-partilhado.sql` (cujo `vinhos_catalogo` e
-- `catalogar_vinho` substitui), e ANTES do `db/garrafeiras-identidade.sql`
-- da WineCatalog, que chama estas funções. Idempotente.
-- =====================================================================

ALTER TABLE garrafeira.vinhos ADD COLUMN IF NOT EXISTS catalogo_id bigint;
CREATE INDEX IF NOT EXISTS vinhos_catalogo_id_idx ON garrafeira.vinhos (catalogo_id);
COMMENT ON COLUMN garrafeira.vinhos.catalogo_id IS
  'A linha de winecatalog.vinhos deste vinho (sem FK: o catálogo é uma poupança). Só as funções da migração 28 a escrevem.';

-- ---------------------------------------------------------------------
-- A GUARDA: o `catalogo_id` só muda por `ligar_catalogo`. Tudo o resto
-- (a app, uma importação de um JSON antigo) fica com o que lá estava.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.vinhos_ligacao_guard()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
BEGIN
  IF COALESCE(current_setting('garrafeira.ligar', true), '') <> 'sim' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.catalogo_id := NULL;
    ELSE
      NEW.catalogo_id := OLD.catalogo_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.vinhos_ligacao_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS vinhos_ligacao_guard ON garrafeira.vinhos;
CREATE TRIGGER vinhos_ligacao_guard
  BEFORE INSERT OR UPDATE OF catalogo_id ON garrafeira.vinhos
  FOR EACH ROW EXECUTE FUNCTION garrafeira.vinhos_ligacao_guard();

-- ---------------------------------------------------------------------
-- LIGAR: o único sítio que escreve a coluna. A marca `garrafeira.ligar` é
-- o que a guarda de cima deixa passar e o que faz o `vinhos_catalogo`
-- ignorar esta escrita (não mudou nada do vinho).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.ligar_catalogo(p_vinho_id bigint, p_catalogo_id bigint)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('garrafeira.ligar', 'sim', true);
  UPDATE garrafeira.vinhos SET catalogo_id = p_catalogo_id
   WHERE id = p_vinho_id AND catalogo_id IS DISTINCT FROM p_catalogo_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('garrafeira.ligar', '', true);
  RETURN n > 0;
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.ligar_catalogo(bigint, bigint) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- ACHAR PELO NOME: a pergunta que a `juntar` faz (a identidade arrumada, a
-- mesma colheita) e, sem ela, a mesma que a `comparar` faz (qualquer
-- colheita). Sem escrever nada no catálogo.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.achar_no_catalogo(p_vinho_id bigint)
  RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v     garrafeira.vinhos%ROWTYPE;
  v_idt jsonb;
  v_ano integer;
BEGIN
  SELECT * INTO v FROM garrafeira.vinhos WHERE id = p_vinho_id;
  IF v.id IS NULL OR COALESCE(v.nome, '') = '' THEN RETURN NULL; END IF;
  v_idt := winecatalog.identidade(v.nome, COALESCE(v.produtor, ''), v.ano, v.tipo, true);
  IF COALESCE(v_idt ->> 'chave_base', '') = '' THEN RETURN NULL; END IF;
  v_ano := (v_idt ->> 'ano')::integer;
  RETURN COALESCE(
    winecatalog.achar(v_idt ->> 'nome', v_idt ->> 'produtor', v_ano, true,  NULL, v_idt ->> 'cor'),
    winecatalog.achar(v_idt ->> 'nome', v_idt ->> 'produtor', v_ano, false, NULL, v_idt ->> 'cor'));
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.achar_no_catalogo(bigint) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- CATALOGAR E LIGAR: o que a `catalogar_vinho` fazia (levar a ficha ao
-- catálogo pela `juntar`), agora a saber em que linha escreve.
-- SUBSTITUÍDA pela migração 29 (`migracao-desejos-catalogo.sql`): a
-- wishlist passou a escrever no catálogo, com força 1. A de lá é a que vale.
--
-- `p_religar` — o dono mudou o nome, o produtor, o ano ou a cor: procura-se
-- pelo nome, como sempre, e a ligação passa a ser a que a `juntar` der (ou
-- nenhuma). Sem ele, e com o vinho ligado a uma linha da MESMA colheita,
-- a `juntar` recebe a identidade DESSA linha (o nome do catálogo; o
-- produtor do catálogo, ou o de cá se lá estiver vazio) — é o que impede
-- um nome que divergiu de fazer nascer outra linha (e, até a `juntar` deixar
-- de renomear, o nome mais comprido de cá de renomear a linha do catálogo).
-- Só se a `juntar`
-- for de facto cair nessa linha (a mesma pergunta que ela faz): senão,
-- pelo nome.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.catalogar_e_ligar(p_vinho_id bigint, p_religar boolean DEFAULT false)
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
  v_nome   text;
  v_prod   text;
  v_id     bigint;
BEGIN
  SELECT * INTO v FROM garrafeira.vinhos WHERE id = p_vinho_id;
  IF v.id IS NULL OR COALESCE(v.nome, '') = '' THEN RETURN NULL; END IF;

  -- A linha ligada, com o `alias` resolvido.
  IF NOT p_religar AND v.catalogo_id IS NOT NULL THEN
    SELECT w.* INTO c FROM winecatalog.vinhos w
     WHERE w.id = COALESCE((SELECT a.id_para FROM winecatalog.alias a WHERE a.id_de = v.catalogo_id),
                           v.catalogo_id);
  END IF;

  -- A WISHLIST não alimenta o catálogo (migração 15: quem a escreveu não
  -- tem a garrafa na mão), mas liga-se, para lhe chegar o nome certo.
  IF v.desejado THEN
    IF c.id IS NULL THEN
      PERFORM garrafeira.ligar_catalogo(v.id, garrafeira.achar_no_catalogo(v.id));
    END IF;
    RETURN NULL;
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

  v_nome := v.nome;
  v_prod := COALESCE(v.produtor, '');
  IF c.id IS NOT NULL AND c.ano IS NOT DISTINCT FROM v.ano THEN
    v_idt := winecatalog.identidade(c.nome, COALESCE(NULLIF(c.produtor, ''), v_prod), c.ano, v.tipo, true);
    IF winecatalog.achar(v_idt ->> 'nome', v_idt ->> 'produtor', (v_idt ->> 'ano')::integer,
                         true, NULL, v_idt ->> 'cor') = c.id THEN
      v_nome := c.nome;
      v_prod := COALESCE(NULLIF(c.produtor, ''), v_prod);
    END IF;
  END IF;

  v_id := winecatalog.juntar(
    v_nome, v_prod, v.ano, v_ficha,
    CASE WHEN v_curado THEN 'garrafeira' ELSE 'garrafeira-bruto' END,
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
REVOKE ALL ON FUNCTION garrafeira.catalogar_e_ligar(bigint, boolean) FROM PUBLIC, anon, authenticated;

-- A `catalogar_vinho` fica com a assinatura de sempre (chama-a a
-- `definir_castas`, e o GRANT a `authenticated` é o da migração 13): é a
-- de cima sem mudar de identidade.
CREATE OR REPLACE FUNCTION garrafeira.catalogar_vinho(p_vinho_id bigint)
  RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
BEGIN
  RETURN garrafeira.catalogar_e_ligar(p_vinho_id, false);
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.catalogar_vinho(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.catalogar_vinho(bigint) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- O TRIGGER que leva cada vinho ao catálogo, agora a dizer se a
-- identidade mudou. Duas escritas não vão ao catálogo: a que VEIO dele
-- (`receber_identidade`) e a que só guarda a ligação (`ligar_catalogo`).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.vinhos_catalogo()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
BEGIN
  IF COALESCE(current_setting('garrafeira.do_catalogo', true), '') = 'sim'
     OR COALESCE(current_setting('garrafeira.ligar', true), '') = 'sim' THEN
    RETURN NULL;
  END IF;
  -- Nunca deita a gravação abaixo: alimentar o catálogo é um extra.
  BEGIN
    PERFORM garrafeira.catalogar_e_ligar(NEW.id,
      TG_OP = 'INSERT'
      OR NEW.nome     IS DISTINCT FROM OLD.nome
      OR NEW.produtor IS DISTINCT FROM OLD.produtor
      OR NEW.ano      IS DISTINCT FROM OLD.ano
      OR NEW.tipo     IS DISTINCT FROM OLD.tipo);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.vinhos_catalogo() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- O trigger dos nomes (migração 24) deixa passar tal e qual o que vem do
-- catálogo: já passou pela regra lá, e arrumá-lo outra vez aqui podia dar
-- outro nome — o vinho voltava a divergir no mesmo instante.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.vinhos_nomes()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  id jsonb;
BEGIN
  IF COALESCE(current_setting('garrafeira.do_catalogo', true), '') = 'sim' THEN
    RETURN NEW;
  END IF;
  BEGIN
    IF TG_OP = 'INSERT' OR NEW.nome IS DISTINCT FROM OLD.nome THEN
      id := winecatalog.identidade(NEW.nome, NEW.produtor, NEW.ano, NEW.tipo, true);
      NEW.nome     := COALESCE(NULLIF(id ->> 'nome', ''), NEW.nome);
      NEW.produtor := COALESCE(id ->> 'produtor', NEW.produtor);
      NEW.ano      := (id ->> 'ano')::integer;
    ELSE
      NEW.produtor := winecatalog.produtor_oficial(winecatalog.nome_proprio(NEW.produtor));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;   -- arrumação: nunca impede ninguém de guardar um vinho
  END;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.vinhos_nomes() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- RECEBER a identidade do catálogo: o nome e o produtor de uma linha do
-- catálogo em todos os vinhos ligados a ela (ou a uma linha fundida nela).
-- Não passa pela `vinhos_nomes` nem volta ao catálogo (a marca
-- `garrafeira.do_catalogo`), e não carimba `atualizado_em`: não foi o dono
-- a mexer — é esse o sinal que a `fichas_catalogo_rever` (19) usa.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.receber_identidade(p_catalogo_id bigint, p_nome text, p_produtor text)
  RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  r      record;
  v_prod text;
  v_quem text := COALESCE(NULLIF(current_setting('winecatalog.quem', true), ''),
                          NULLIF(auth.email(), ''), 'catálogo');
  n      integer := 0;
BEGIN
  IF p_catalogo_id IS NULL OR btrim(COALESCE(p_nome, '')) = '' THEN RETURN 0; END IF;
  FOR r IN
    SELECT g.id, g.nome, g.produtor, g.garrafeira_id
      FROM garrafeira.vinhos g
     WHERE g.catalogo_id = p_catalogo_id
        OR g.catalogo_id IN (SELECT a.id_de FROM winecatalog.alias a WHERE a.id_para = p_catalogo_id)
     ORDER BY g.id
       FOR UPDATE
  LOOP
    v_prod := CASE WHEN btrim(COALESCE(p_produtor, '')) <> '' THEN p_produtor ELSE r.produtor END;
    CONTINUE WHEN r.nome IS NOT DISTINCT FROM p_nome AND r.produtor IS NOT DISTINCT FROM v_prod;
    PERFORM set_config('garrafeira.do_catalogo', 'sim', true);
    UPDATE garrafeira.vinhos SET nome = p_nome, produtor = v_prod WHERE id = r.id;
    PERFORM set_config('garrafeira.do_catalogo', '', true);
    INSERT INTO garrafeira.sync_log (origem, acao, estado, quem, detalhe)
    VALUES ('winecatalog', 'identidade_do_catalogo', 'ok', v_quem,
            jsonb_build_object('vinho_id', r.id, 'garrafeira_id', r.garrafeira_id,
              'catalogo_id', p_catalogo_id,
              'antes',  jsonb_build_object('nome', r.nome, 'produtor', r.produtor),
              'depois', jsonb_build_object('nome', p_nome, 'produtor', v_prod)));
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.receber_identidade(bigint, text, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- RELIGAR pelo nome os vinhos ligados a uma linha. É o que a `separar` do
-- catálogo precisa: uma ligação guardada depois da fusão aponta para a
-- linha que ficou, e um vinho cujo nome é o da que saiu volta a ela.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.religar_catalogo(p_catalogo_id bigint)
  RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  r    record;
  v_id bigint;
  n    integer := 0;
BEGIN
  FOR r IN SELECT g.id, g.catalogo_id FROM garrafeira.vinhos g WHERE g.catalogo_id = p_catalogo_id LOOP
    v_id := garrafeira.achar_no_catalogo(r.id);
    IF v_id IS NOT NULL AND v_id <> r.catalogo_id THEN
      PERFORM garrafeira.ligar_catalogo(r.id, v_id);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.religar_catalogo(bigint) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- A LIGAÇÃO DOS QUE JÁ CÁ ESTÃO, pelo nome. Não escreve no catálogo (a
-- marca `garrafeira.ligar` cala o `vinhos_catalogo`). A 28/09/2026: 238
-- dos 243 vinhos ligados; os outros não têm linha no catálogo.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id FROM garrafeira.vinhos WHERE catalogo_id IS NULL ORDER BY id LOOP
    PERFORM garrafeira.ligar_catalogo(r.id, garrafeira.achar_no_catalogo(r.id));
  END LOOP;
END $$;

-- Confirmar (só o dono; a `catalogar_vinho` também a authenticated e à
-- service_role, como na migração 13):
-- select routine_name, grantee from information_schema.routine_privileges
--  where routine_schema = 'garrafeira'
--    and routine_name in ('vinhos_ligacao_guard','ligar_catalogo','achar_no_catalogo',
--                         'catalogar_e_ligar','catalogar_vinho','receber_identidade','religar_catalogo');
