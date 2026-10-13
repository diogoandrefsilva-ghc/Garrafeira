-- =====================================================================
-- Migração 54 — as Sugestões livres (13/10/2026)
--
-- O dono das apps: "sugestões sem ter por base uma carta, uma garrafeira
-- ou um catálogo. O utilizador simplesmente colocava o prato, o preço
-- (mínimo e máximo), um campo de observações … e pedíamos à IA 5 vinhos
-- … e nós criávamos os vinhos que ainda não existissem no Catálogo". E,
-- depois de conversado:
--   1) só nasce no Catálogo o vinho cujos campos principais (produtor,
--      castas, preço, imagem e Vivino) vieram com FONTE — nunca de
--      memória; e um filtro de ORIGEM no Detalhe do Catálogo, para se ver
--      de onde veio o carregamento e a última atualização de cada vinho;
--   2) no Backoffice, os sugeridos que NÃO ficaram no Catálogo, para o
--      admin os acrescentar à mão;
--   3) memória: o mesmo pedido na mesma semana dá a mesma resposta (e
--      "pedir outra vez" obriga a mais detalhe nas observações).
--
-- O que esta migração faz:
--   · `winecatalog.forca`: a porta nova `sugestao-livre` vale 2, como a
--     procura com IA (`vinho-info-*`) — é uma procura com IA, com a regra
--     mais apertada de todas à porta. A FONTE desta função é o
--     `db/catalogo.sql` da WineCatalog: quem a mexer lá leva esta linha.
--   · `winecatalog.vinhos.nasceu_de`: a porta por onde a linha NASCEU. O
--     `origens` diz a porta de cada campo agora, e os campos reescrevem-se;
--     esta coluna escreve-se uma vez (trigger `vinhos_nasceu_de`) e não
--     muda. As linhas que já existiam: a primeira escrita registada no
--     histórico (`alteracoes`, desde 25/09/2026) logo a seguir a nascer;
--     sem ela, a porta do campo mais antigo do `origens` — uma
--     aproximação para as linhas de antes do histórico.
--   · `garrafeira.catalogo_vinhos`: cada linha leva `nasceu_de` e
--     `alterado_de` (a porta da escrita mais recente no `origens`). Só a
--     PORTA, nunca quem — a regra desta função desde a 31.
--   · `garrafeira.livre_pedidos` (a memória dos pedidos) e
--     `garrafeira.livre_vinhos` (cada vinho sugerido, uma linha por vinho,
--     com o estado: no Catálogo, a confirmar, criado, por carregar…). RLS
--     ligada e SEM policies: escreve a `garrafeira-carta`/`vinho-info` com
--     a service role; a app lê pelas funções abaixo. Não levam
--     `garrafeira_id` (não são de garrafeira nenhuma, como as `cartas`).
--   · `garrafeira.livre_registar` (só service role), `livre_ler` (quem
--     entra), `livre_lista`/`livre_marcar`/`livre_contar` (o admin do
--     catálogo, para o Backoffice).
-- Idempotente.
-- =====================================================================

-- ── A força da porta nova ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION winecatalog.forca(p_origem text, p_campo text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'winecatalog', 'public'
AS $function$
  SELECT CASE
    -- Ver o comentário grande acima: a força é da ORIGEM **e do CAMPO**, e
    -- as duas excepções aqui são a mesma ideia aplicada a duas pessoas
    -- diferentes.
    WHEN COALESCE(p_origem,'') = 'garrafeira'     AND winecatalog.volatil(p_campo) THEN 2
    WHEN COALESCE(p_origem,'') IN ('catalogo-admin','catalogo-curador') AND winecatalog.volatil(p_campo) THEN 3
    ELSE CASE COALESCE(p_origem, '')
      WHEN 'catalogo-admin'      THEN 4
      -- Um CURADOR do catálogo (db/curadores.sql, 30/09/2026): alguém a quem
      -- o admin deu a palavra sobre o catálogo. Vale o mesmo que o admin.
      WHEN 'catalogo-curador'    THEN 4
      WHEN 'garrafeira'          THEN 3
      WHEN 'ws-verificacao'      THEN 3
      WHEN 'catalogo-pesquisa'   THEN 3
      WHEN 'vivino-pagina'       THEN 3
      WHEN 'vivino-serper'       THEN 2
      WHEN 'loja-garrafeira-nacional' THEN 3
      WHEN 'loja-granvine'       THEN 3
      WHEN 'loja-vinha'          THEN 3
      WHEN 'loja-portugal-vineyards' THEN 3
      WHEN 'lojas-script'        THEN 3
      WHEN 'vinho-info-premium'  THEN 2
      WHEN 'vinho-info-gratis'   THEN 2
      -- As Sugestões livres da Garrafeira (migração 54): uma procura com IA,
      -- e só com os campos principais com fonte (ver a `vinho-info`).
      WHEN 'sugestao-livre'      THEN 2
      WHEN 'ws-sugestao'         THEN 2
      WHEN 'garrafeira-bruto'    THEN 1
      WHEN 'garrafeira-desejo'   THEN 1
      WHEN 'prenda'              THEN 1
      ELSE 0
    END
  END;
$function$;

-- ── Por onde nasceu cada linha ───────────────────────────────────────
ALTER TABLE winecatalog.vinhos ADD COLUMN IF NOT EXISTS nasceu_de text;

-- A porta do campo escrito há mais tempo (numa linha acabada de nascer,
-- são todos da mesma escrita).
CREATE OR REPLACE FUNCTION winecatalog.origem_primeira(p jsonb)
  RETURNS text LANGUAGE sql IMMUTABLE
  SET search_path = winecatalog, public
AS $$
  SELECT e.value ->> 'o'
    FROM jsonb_each(CASE WHEN jsonb_typeof(p) = 'object' THEN p ELSE '{}'::jsonb END) e
   WHERE jsonb_typeof(e.value) = 'object' AND COALESCE(e.value ->> 'o', '') <> ''
   ORDER BY (e.value ->> 'em') NULLS LAST, e.value ->> 'o'
   LIMIT 1;
$$;
-- A porta da escrita mais recente.
CREATE OR REPLACE FUNCTION winecatalog.origem_ultima(p jsonb)
  RETURNS text LANGUAGE sql IMMUTABLE
  SET search_path = winecatalog, public
AS $$
  SELECT e.value ->> 'o'
    FROM jsonb_each(CASE WHEN jsonb_typeof(p) = 'object' THEN p ELSE '{}'::jsonb END) e
   WHERE jsonb_typeof(e.value) = 'object' AND COALESCE(e.value ->> 'o', '') <> ''
   ORDER BY (e.value ->> 'em') DESC NULLS LAST, e.value ->> 'o'
   LIMIT 1;
$$;

-- Escreve-se uma vez: na primeira escrita com `origens` (a `criar` já o traz
-- no INSERT; a `juntar` insere vazio e escreve logo a seguir, num UPDATE).
CREATE OR REPLACE FUNCTION winecatalog.vinhos_nasceu_de()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = winecatalog, public
AS $$
BEGIN
  IF NEW.nasceu_de IS NULL AND jsonb_typeof(NEW.origens) = 'object' AND NEW.origens <> '{}'::jsonb THEN
    NEW.nasceu_de := winecatalog.origem_primeira(NEW.origens);
  END IF;
  RETURN NEW;
END;
$$;
-- CREATE OR REPLACE, e não DROP + CREATE: o MCP do Supabase pára num DROP à
-- espera de confirmação, e o pedido morre por tempo.
CREATE OR REPLACE TRIGGER vinhos_nasceu_de BEFORE INSERT OR UPDATE ON winecatalog.vinhos
  FOR EACH ROW WHEN (NEW.nasceu_de IS NULL) EXECUTE FUNCTION winecatalog.vinhos_nasceu_de();

-- As linhas que já existiam: primeiro o histórico (a primeira escrita com
-- porta, até 10 s depois de nascer), senão o campo mais antigo.
UPDATE winecatalog.vinhos v SET nasceu_de = x.o
  FROM (
    SELECT DISTINCT ON (a.vinho_id) a.vinho_id, a.origem AS o
      FROM winecatalog.alteracoes a
      JOIN winecatalog.alteracoes c ON c.vinho_id = a.vinho_id AND c.campo = '_criado'
     WHERE a.origem IS NOT NULL AND a.quando <= c.quando + interval '10 seconds'
     ORDER BY a.vinho_id, a.quando, a.id
  ) x
 WHERE v.id = x.vinho_id AND v.nasceu_de IS NULL;
UPDATE winecatalog.vinhos SET nasceu_de = winecatalog.origem_primeira(origens)
 WHERE nasceu_de IS NULL AND origens <> '{}'::jsonb;

-- ── O catálogo inteiro para a app, com as duas portas ─────────────────
-- A da migração 31, mais `nasceu_de` e `alterado_de`.
CREATE OR REPLACE FUNCTION garrafeira.catalogo_vinhos()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $function$
DECLARE
  v_res jsonb;
BEGIN
  IF NOT garrafeira.is_allowed() THEN
    RAISE EXCEPTION 'Sem acesso.';
  END IF;

  WITH mortos AS MATERIALIZED (
    SELECT id_de FROM winecatalog.alias
  ), fund AS (
    SELECT id_para, array_agg(id_de) AS ids FROM winecatalog.alias GROUP BY id_para
  )
  SELECT COALESCE(jsonb_agg(
           (c.ficha - 'precos' - 'produtor' - 'ano')
           || jsonb_build_object(
                'id',       c.id,
                'ids',      to_jsonb(ARRAY[c.id] || COALESCE(f.ids, ARRAY[]::bigint[])),
                'nome',     c.nome,
                'produtor', c.produtor,
                'ano',      c.ano,
                'tipo',     COALESCE(NULLIF(c.ficha ->> 'tipo', ''),
                              CASE c.cor WHEN 'tinto' THEN 'Tinto' WHEN 'branco' THEN 'Branco'
                                         WHEN 'rose' THEN 'Rosé' WHEN 'espumante' THEN 'Espumante'
                                         WHEN 'frisante' THEN 'Frisante' WHEN 'licoroso' THEN 'Licoroso' END),
                'criado_em',     c.criado_em,
                'atualizado_em', c.atualizado_em,
                -- As portas (migração 54): por onde nasceu, e a da escrita mais recente.
                'nasceu_de',     c.nasceu_de,
                'alterado_de',   winecatalog.origem_ultima(c.origens),
                'precos', COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                           'loja',     e.key,
                           'preco',    (e.value ->> 'preco')::numeric,
                           'url',      e.value ->> 'url',
                           'nome',     e.value ->> 'nome',
                           'colheita', CASE WHEN (e.value ->> 'colheita') ~ '^\d{4}$'
                                            THEN (e.value ->> 'colheita')::integer END,
                           'em',       e.value ->> 'em')
                         ORDER BY e.key)
                    FROM jsonb_each(CASE WHEN jsonb_typeof(c.ficha -> 'precos') = 'object'
                                         THEN c.ficha -> 'precos' ELSE '{}'::jsonb END) e
                   WHERE jsonb_typeof(e.value) = 'object'
                     AND NOT COALESCE((e.value ->> 'retirado')::boolean, false)
                     AND (e.value ->> 'preco') ~ '^\d+(\.\d+)?$'
                     AND (e.value ->> 'preco')::numeric > 0), '[]'::jsonb)
              )
           ORDER BY c.nome), '[]'::jsonb)
    INTO v_res
    FROM winecatalog.vinhos c
    LEFT JOIN fund f ON f.id_para = c.id
   WHERE c.id NOT IN (SELECT id_de FROM mortos);
  RETURN v_res;
END;
$function$;

-- ── As tabelas das Sugestões livres ──────────────────────────────────
-- Cada vinho que a IA sugeriu, uma vez só (pela chave do catálogo, sem a
-- colheita). `sugerido` é o que a IA disse DE MEMÓRIA (castas, região, um
-- preço aproximado) — nunca vai para o catálogo; `verificado` é o que a
-- procura com fontes trouxe (a resposta da `vinho-info`, com a origem de
-- cada campo), e é com isso que o Backoffice pré-enche o vinho novo.
--   pendente      → ainda não se procurou
--   a_verificar   → a procura está a correr
--   criado        → nasceu no Catálogo sozinho (os campos principais com fonte)
--   no_catalogo   → o Catálogo já o tinha (ou passou a ter)
--   por_carregar  → procurou-se e faltou alguma coisa (`falta`): vai ao Backoffice
--   carregado     → o admin acrescentou-o à mão
--   descartado    → o admin disse que não (um vinho que a IA inventou)
CREATE TABLE IF NOT EXISTS garrafeira.livre_vinhos (
  id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  chave         text NOT NULL UNIQUE,
  nome          text NOT NULL,
  produtor      text NOT NULL DEFAULT '',
  ano           integer,
  tipo          text NOT NULL,
  regiao        text,
  sugerido      jsonb NOT NULL DEFAULT '{}'::jsonb,
  estado        text NOT NULL DEFAULT 'pendente'
                CHECK (estado IN ('pendente','a_verificar','criado','no_catalogo','por_carregar','carregado','descartado')),
  falta         text[] NOT NULL DEFAULT '{}',
  verificado    jsonb,
  verificado_em timestamptz,
  catalogo_id   bigint,
  vezes         integer NOT NULL DEFAULT 1,
  pratos        text[] NOT NULL DEFAULT '{}',
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS livre_vinhos_estado ON garrafeira.livre_vinhos (estado);

-- A memória: um pedido por chave (o prato pelos conceitos, o preço, as
-- palavras das observações). As observações não se guardam por extenso —
-- só as palavras que entram na chave (`obs_chave`).
CREATE TABLE IF NOT EXISTS garrafeira.livre_pedidos (
  id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  chave       text NOT NULL,
  prato       text NOT NULL DEFAULT '',
  preco_min   numeric,
  preco_max   numeric,
  obs_chave   text NOT NULL DEFAULT '',
  quem        text,
  -- [{"v": livre_vinhos.id, "razao": "…", "recomendado": true}], pela ordem
  sugestoes   jsonb NOT NULL DEFAULT '[]'::jsonb,
  modelo      text,
  vezes       integer NOT NULL DEFAULT 1,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  ultimo_em   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS livre_pedidos_chave ON garrafeira.livre_pedidos (chave, criado_em DESC);

ALTER TABLE garrafeira.livre_vinhos  ENABLE ROW LEVEL SECURITY;
ALTER TABLE garrafeira.livre_pedidos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON garrafeira.livre_vinhos, garrafeira.livre_pedidos FROM anon, authenticated;
GRANT ALL ON garrafeira.livre_vinhos, garrafeira.livre_pedidos TO service_role;

-- ── Registar os vinhos de uma resposta (só a `garrafeira-carta`) ──────
-- Uma linha por vinho (a chave do catálogo, sem colheita). Liga-se ao
-- Catálogo pela mesma procura da carta (`carta_achar`); o que o Catálogo
-- não tem e nunca se procurou — ou ficou preso a meio da procura há mais de
-- 10 minutos — volta com `verificar` e passa já a `a_verificar`.
CREATE OR REPLACE FUNCTION garrafeira.livre_registar(p_vinhos jsonb, p_prato text DEFAULT '')
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = garrafeira, winecatalog, public
AS $$
DECLARE
  x jsonb; v_idt jsonb; v_chave text; v_cat bigint; v_row garrafeira.livre_vinhos;
  v_tipo text; v_nome text; v_prod text; v_ano integer; v_prato text := left(trim(COALESCE(p_prato,'')), 120);
  v_out jsonb := '[]'::jsonb; v_verificar boolean;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Só o servidor.'; END IF;
  IF jsonb_typeof(p_vinhos) IS DISTINCT FROM 'array' THEN RETURN '[]'::jsonb; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(p_vinhos) LIMIT 8 LOOP
    v_nome := left(trim(COALESCE(x ->> 'nome', '')), 120);
    v_prod := left(trim(COALESCE(x ->> 'produtor', '')), 90);
    v_tipo := NULLIF(x ->> 'tipo', '');
    v_ano  := CASE WHEN jsonb_typeof(x -> 'ano') = 'number' THEN (x ->> 'ano')::integer END;
    IF v_nome = '' OR v_tipo IS NULL THEN v_out := v_out || 'null'::jsonb; CONTINUE; END IF;
    v_idt := winecatalog.identidade(v_nome, v_prod, NULL, v_tipo, true);
    v_chave := v_idt ->> 'chave';
    IF COALESCE(v_chave, '') = '' THEN v_out := v_out || 'null'::jsonb; CONTINUE; END IF;
    v_cat := garrafeira.carta_achar(v_nome, v_prod, v_ano, v_tipo);

    INSERT INTO garrafeira.livre_vinhos AS l (chave, nome, produtor, ano, tipo, regiao, sugerido, estado, catalogo_id, pratos)
    VALUES (v_chave, COALESCE(v_idt ->> 'nome', v_nome), COALESCE(v_idt ->> 'produtor', v_prod), v_ano, v_tipo,
            NULLIF(left(trim(COALESCE(x ->> 'regiao', '')), 60), ''),
            COALESCE(x -> 'sugerido', '{}'::jsonb),
            CASE WHEN v_cat IS NOT NULL THEN 'no_catalogo' ELSE 'pendente' END, v_cat,
            CASE WHEN v_prato <> '' THEN ARRAY[v_prato] ELSE '{}'::text[] END)
    ON CONFLICT (chave) DO UPDATE SET
      vezes = l.vezes + 1,
      sugerido = EXCLUDED.sugerido,
      pratos = CASE WHEN v_prato = '' OR v_prato = ANY(l.pratos) THEN l.pratos
                    ELSE (l.pratos || v_prato)[GREATEST(1, cardinality(l.pratos) - 18):] END,
      catalogo_id = COALESCE(v_cat, l.catalogo_id),
      estado = CASE WHEN l.estado IN ('criado','carregado','descartado') THEN l.estado
                    WHEN v_cat IS NOT NULL THEN 'no_catalogo'
                    WHEN l.estado = 'no_catalogo' THEN 'pendente'
                    -- uma procura que ficou presa (a função morreu a meio)
                    WHEN l.estado = 'a_verificar' AND l.atualizado_em < now() - interval '10 minutes' THEN 'pendente'
                    ELSE l.estado END,
      atualizado_em = now()
    RETURNING * INTO v_row;

    v_verificar := v_row.estado = 'pendente';
    IF v_verificar THEN
      UPDATE garrafeira.livre_vinhos SET estado = 'a_verificar', atualizado_em = now() WHERE id = v_row.id
        RETURNING * INTO v_row;
    END IF;
    v_out := v_out || jsonb_build_object('id', v_row.id, 'estado', v_row.estado, 'catalogo_id', v_row.catalogo_id,
      'nome', v_row.nome, 'produtor', v_row.produtor, 'ano', v_row.ano, 'tipo', v_row.tipo, 'regiao', v_row.regiao,
      'verificar', v_verificar);
  END LOOP;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.livre_registar(jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION garrafeira.livre_registar(jsonb, text) TO service_role;

-- Os vinhos como a app os lê: nunca quem pediu, nunca o que a procura
-- trouxe (isso é do Backoffice).
CREATE OR REPLACE FUNCTION garrafeira.livre_vinho_json(l garrafeira.livre_vinhos)
  RETURNS jsonb LANGUAGE sql STABLE
  SET search_path = garrafeira, public
AS $$
  SELECT jsonb_build_object('id', l.id, 'nome', l.nome, 'produtor', l.produtor, 'ano', l.ano, 'tipo', l.tipo,
    'regiao', l.regiao, 'sugerido', l.sugerido, 'estado', l.estado, 'falta', to_jsonb(l.falta),
    'catalogo_id', l.catalogo_id, 'verificado_em', l.verificado_em);
$$;
REVOKE ALL ON FUNCTION garrafeira.livre_vinho_json(garrafeira.livre_vinhos) FROM PUBLIC, anon, authenticated;

-- ── Ler um pedido (a app, enquanto a procura corre) ──────────────────
CREATE OR REPLACE FUNCTION garrafeira.livre_ler(p_id bigint)
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = garrafeira, public
AS $$
DECLARE p garrafeira.livre_pedidos;
BEGIN
  IF NOT garrafeira.is_allowed() THEN RAISE EXCEPTION 'Sem acesso.'; END IF;
  SELECT * INTO p FROM garrafeira.livre_pedidos WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'id', p.id, 'prato', p.prato, 'preco_min', p.preco_min, 'preco_max', p.preco_max,
    'criado_em', p.criado_em, 'sugestoes', p.sugestoes,
    'vinhos', COALESCE((SELECT jsonb_agg(garrafeira.livre_vinho_json(l))
                          FROM garrafeira.livre_vinhos l
                         WHERE l.id IN (SELECT (e ->> 'v')::bigint FROM jsonb_array_elements(p.sugestoes) e
                                         WHERE (e ->> 'v') ~ '^\d+$')), '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.livre_ler(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.livre_ler(bigint) TO authenticated, service_role;

-- ── O Backoffice: os que não ficaram no Catálogo ─────────────────────
-- Antes de responder, volta a perguntar ao Catálogo por cada um que está
-- por carregar: se entretanto lá entrou (por qualquer caminho), sai da lista.
CREATE OR REPLACE FUNCTION garrafeira.livre_lista(p_todos boolean DEFAULT false)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = garrafeira, winecatalog, public
AS $$
DECLARE r garrafeira.livre_vinhos; v_cat bigint;
BEGIN
  IF NOT winecatalog.sou_admin() THEN RAISE EXCEPTION 'Só o admin do catálogo.'; END IF;
  FOR r IN SELECT * FROM garrafeira.livre_vinhos WHERE estado = 'por_carregar' LOOP
    v_cat := garrafeira.carta_achar(r.nome, r.produtor, r.ano, r.tipo);
    IF v_cat IS NOT NULL THEN
      UPDATE garrafeira.livre_vinhos SET estado = 'no_catalogo', catalogo_id = v_cat, atualizado_em = now() WHERE id = r.id;
    END IF;
  END LOOP;
  RETURN COALESCE((
    SELECT jsonb_agg(garrafeira.livre_vinho_json(l) || jsonb_build_object(
             'verificado', l.verificado, 'vezes', l.vezes, 'pratos', to_jsonb(l.pratos),
             'criado_em', l.criado_em, 'atualizado_em', l.atualizado_em)
           ORDER BY l.vezes DESC, l.atualizado_em DESC)
      FROM garrafeira.livre_vinhos l
     WHERE l.estado = 'por_carregar' OR (p_todos AND l.estado IN ('criado','carregado','descartado','no_catalogo'))
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.livre_lista(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.livre_lista(boolean) TO authenticated;

CREATE OR REPLACE FUNCTION garrafeira.livre_contar()
  RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = garrafeira, winecatalog, public
AS $$
BEGIN
  IF NOT winecatalog.sou_admin() THEN RETURN 0; END IF;
  RETURN (SELECT count(*) FROM garrafeira.livre_vinhos WHERE estado = 'por_carregar');
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.livre_contar() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.livre_contar() TO authenticated;

-- "Acrescentado ao Catálogo" (com a linha nova), "Descartar", ou devolver à lista.
CREATE OR REPLACE FUNCTION garrafeira.livre_marcar(p_id bigint, p_estado text, p_catalogo_id bigint DEFAULT NULL)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = garrafeira, winecatalog, public
AS $$
DECLARE r garrafeira.livre_vinhos;
BEGIN
  IF NOT winecatalog.sou_admin() THEN RAISE EXCEPTION 'Só o admin do catálogo.'; END IF;
  IF p_estado NOT IN ('carregado','descartado','por_carregar') THEN RAISE EXCEPTION 'Estado desconhecido.'; END IF;
  UPDATE garrafeira.livre_vinhos
     SET estado = p_estado,
         catalogo_id = CASE WHEN p_estado = 'carregado' THEN COALESCE(p_catalogo_id, catalogo_id) ELSE catalogo_id END,
         atualizado_em = now()
   WHERE id = p_id
  RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'Não encontrei esse vinho.'; END IF;
  RETURN garrafeira.livre_vinho_json(r);
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.livre_marcar(bigint, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.livre_marcar(bigint, text, bigint) TO authenticated;
