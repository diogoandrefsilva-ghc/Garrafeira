-- =====================================================================
-- Migração 56 — Identificar vinhos numa fotografia (17/10/2026)
--
-- O dono das apps: "estou no supermercado ou num site e tiro fotografia ou
-- print a apanhar vários vinhos, e a app dizia quais conhecia (com um card
-- resumo do que encontrou e link para o detalhe) e dizia quais não conhecia
-- (com opção de pesquisar detalhe adicional — para adicionar ao Catálogo)".
-- E, depois de conversado: "para já coloca apenas uma opção no +, quando
-- estamos no catálogo" e um vinho que o Catálogo não conhece só entra lá
-- "só com fontes" — a regra da pergunta livre (migração 54).
--
-- Por isso quase tudo já existe:
--   · a LEITURA é a da carta (`garrafeira-carta`, `acao: "ler"`), com outra
--     instrução (`fonte: "prateleira"`: rótulos e etiquetas, não linhas de
--     uma carta), e fica numa linha de `garrafeira.cartas` — com a coluna
--     nova `fonte`, para as Sugestões não a mostrarem nas "Cartas
--     anteriores" nem o "Identificar" as cartas;
--   · a LIGAÇÃO ao Catálogo é a da carta (`carta_ligar`, feita pela app);
--   · PROCURAR um que o Catálogo não tem é a confirmação da pergunta livre:
--     uma linha em `garrafeira.livre_vinhos` (`livre_registar`) e a
--     `vinho-info` com o `livreId`, que só o faz nascer no Catálogo com o
--     produtor, as castas, o preço, a imagem e o Vivino COM FONTE; o resto
--     vai ao Backoffice, aos "Sugeridos pela IA".
--
-- O que esta migração faz:
--   · `garrafeira.cartas.fonte` ('carta' | 'prateleira') e `.livre` (o
--     índice de cada vinho lido → a linha de `livre_vinhos` que o foi
--     procurar: {"3": 41});
--   · `garrafeira.livre_vinhos.fotos`: quantas vezes foi identificado numa
--     fotografia (o `vezes` continua a ser quantas vezes a IA o sugeriu — um
--     vinho que só se viu numa foto tem `vezes` 0);
--   · `garrafeira.livre_registar`: um vinho com `"foto": true` conta nas
--     `fotos` e não nas `vezes`, e o que se leu na foto vai para
--     `sugerido.foto` (o preço da etiqueta, o nome como estava escrito) sem
--     apagar o que a pergunta livre lá tinha posto. Mesma assinatura: a
--     `garrafeira-carta` publicada continua a chamá-la como antes;
--   · `garrafeira.livre_vinho_json` e `livre_lista` levam as `fotos`, e a
--     lista do Backoffice ordena-se pelas duas contas somadas;
--   · `garrafeira.livre_estados(ids)`: os vinhos dados (para a app saber em
--     que pé está a confirmação dos que mandou procurar). Nunca quem pediu.
--
-- E a PERGUNTA LIVRE COM UMA FOTOGRAFIA (17/10/2026, o dono das apps: "na
-- parte da perguntar à IA, era muito giro que eu pudesse enviar uma
-- fotografia de vinhos (que tirei tipo no supermercado) e perguntar à IA,
-- para o que vou almoçar ou jantar, qual é o vinho mais recomendado"): a
-- IA escolhe ENTRE os vinhos da foto, e a resposta guarda-se como uma
-- pergunta livre (`livre_pedidos`, com os recomendados em `livre_vinhos`).
-- Como a foto leva tempo a ler, o pedido nasce `pendente` e a app sonda-o:
--   · `garrafeira.livre_pedidos.estado` ('pendente' | 'pronto' | 'erro', por
--     omissão 'pronto' — os pedidos de antes estão prontos), `.erro` e
--     `.foto` (o que se leu: os vinhos, com a linha do Catálogo de cada um,
--     e o aviso). Um pedido com foto tem a chave `foto#…`, que nunca é a de
--     outro pedido: não há memória para fotografias;
--   · `garrafeira.livre_ler` devolve o `estado`, o `erro` e a `foto`.
-- Idempotente.
-- =====================================================================

-- ── As identificações moram com as cartas ────────────────────────────
ALTER TABLE garrafeira.cartas ADD COLUMN IF NOT EXISTS fonte text NOT NULL DEFAULT 'carta';
-- Sem DROP (o MCP do Supabase pára num DROP à espera de confirmação):
-- acrescenta-se só se ainda não existir.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cartas_fonte_check'
                    AND conrelid = 'garrafeira.cartas'::regclass) THEN
    ALTER TABLE garrafeira.cartas ADD CONSTRAINT cartas_fonte_check CHECK (fonte IN ('carta', 'prateleira'));
  END IF;
END $$;
-- {"<índice em vinhos>": <livre_vinhos.id>}
ALTER TABLE garrafeira.cartas ADD COLUMN IF NOT EXISTS livre jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ── Vistos numa fotografia ───────────────────────────────────────────
ALTER TABLE garrafeira.livre_vinhos ADD COLUMN IF NOT EXISTS fotos integer NOT NULL DEFAULT 0;

-- ── Registar (só a `garrafeira-carta`) ───────────────────────────────
-- A da 54, com o `foto` de cada vinho (ver acima).
CREATE OR REPLACE FUNCTION garrafeira.livre_registar(p_vinhos jsonb, p_prato text DEFAULT '')
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = garrafeira, winecatalog, public
AS $$
DECLARE
  x jsonb; v_idt jsonb; v_chave text; v_cat bigint; v_row garrafeira.livre_vinhos;
  v_tipo text; v_nome text; v_prod text; v_ano integer; v_prato text := left(trim(COALESCE(p_prato,'')), 120);
  v_out jsonb := '[]'::jsonb; v_verificar boolean; v_foto boolean;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN RAISE EXCEPTION 'Só o servidor.'; END IF;
  IF jsonb_typeof(p_vinhos) IS DISTINCT FROM 'array' THEN RETURN '[]'::jsonb; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(p_vinhos) LIMIT 8 LOOP
    v_nome := left(trim(COALESCE(x ->> 'nome', '')), 120);
    v_prod := left(trim(COALESCE(x ->> 'produtor', '')), 90);
    v_tipo := NULLIF(x ->> 'tipo', '');
    v_ano  := CASE WHEN jsonb_typeof(x -> 'ano') = 'number' THEN (x ->> 'ano')::integer END;
    v_foto := COALESCE(x ->> 'foto', '') = 'true';
    IF v_nome = '' OR v_tipo IS NULL THEN v_out := v_out || 'null'::jsonb; CONTINUE; END IF;
    v_idt := winecatalog.identidade(v_nome, v_prod, NULL, v_tipo, true);
    v_chave := v_idt ->> 'chave';
    IF COALESCE(v_chave, '') = '' THEN v_out := v_out || 'null'::jsonb; CONTINUE; END IF;
    v_cat := garrafeira.carta_achar(v_nome, v_prod, v_ano, v_tipo);

    INSERT INTO garrafeira.livre_vinhos AS l (chave, nome, produtor, ano, tipo, regiao, sugerido, estado, catalogo_id, pratos, vezes, fotos)
    VALUES (v_chave, COALESCE(v_idt ->> 'nome', v_nome), COALESCE(v_idt ->> 'produtor', v_prod), v_ano, v_tipo,
            NULLIF(left(trim(COALESCE(x ->> 'regiao', '')), 60), ''),
            COALESCE(x -> 'sugerido', '{}'::jsonb),
            CASE WHEN v_cat IS NOT NULL THEN 'no_catalogo' ELSE 'pendente' END, v_cat,
            CASE WHEN v_prato <> '' THEN ARRAY[v_prato] ELSE '{}'::text[] END,
            CASE WHEN v_foto THEN 0 ELSE 1 END, CASE WHEN v_foto THEN 1 ELSE 0 END)
    ON CONFLICT (chave) DO UPDATE SET
      vezes = l.vezes + CASE WHEN v_foto THEN 0 ELSE 1 END,
      fotos = l.fotos + CASE WHEN v_foto THEN 1 ELSE 0 END,
      -- juntar: o que a foto leu não apaga o que a pergunta livre disse, nem o contrário
      sugerido = COALESCE(l.sugerido, '{}'::jsonb) || EXCLUDED.sugerido,
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

-- Os vinhos como a app os lê (a da 54, com as `fotos`).
CREATE OR REPLACE FUNCTION garrafeira.livre_vinho_json(l garrafeira.livre_vinhos)
  RETURNS jsonb LANGUAGE sql STABLE
  SET search_path = garrafeira, public
AS $$
  SELECT jsonb_build_object('id', l.id, 'nome', l.nome, 'produtor', l.produtor, 'ano', l.ano, 'tipo', l.tipo,
    'regiao', l.regiao, 'sugerido', l.sugerido, 'estado', l.estado, 'falta', to_jsonb(l.falta),
    'catalogo_id', l.catalogo_id, 'verificado_em', l.verificado_em, 'fotos', l.fotos);
$$;
REVOKE ALL ON FUNCTION garrafeira.livre_vinho_json(garrafeira.livre_vinhos) FROM PUBLIC, anon, authenticated;

-- ── Em que pé estão os que se mandaram procurar (a app) ──────────────
CREATE OR REPLACE FUNCTION garrafeira.livre_estados(p_ids bigint[])
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = garrafeira, public
AS $$
BEGIN
  IF NOT garrafeira.is_allowed() THEN RAISE EXCEPTION 'Sem acesso.'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(garrafeira.livre_vinho_json(l))
                     FROM garrafeira.livre_vinhos l
                    WHERE l.id = ANY((COALESCE(p_ids, '{}'::bigint[]))[1:40])), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.livre_estados(bigint[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.livre_estados(bigint[]) TO authenticated, service_role;

-- ── O Backoffice (a da 54, com as `fotos` e a ordem pelas duas contas) ─
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
           ORDER BY l.vezes + l.fotos DESC, l.atualizado_em DESC)
      FROM garrafeira.livre_vinhos l
     WHERE l.estado = 'por_carregar' OR (p_todos AND l.estado IN ('criado','carregado','descartado','no_catalogo'))
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.livre_lista(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.livre_lista(boolean) TO authenticated;

-- ── A pergunta livre com uma fotografia ──────────────────────────────
ALTER TABLE garrafeira.livre_pedidos ADD COLUMN IF NOT EXISTS estado text NOT NULL DEFAULT 'pronto';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'livre_pedidos_estado_check'
                    AND conrelid = 'garrafeira.livre_pedidos'::regclass) THEN
    ALTER TABLE garrafeira.livre_pedidos ADD CONSTRAINT livre_pedidos_estado_check CHECK (estado IN ('pendente', 'pronto', 'erro'));
  END IF;
END $$;
ALTER TABLE garrafeira.livre_pedidos ADD COLUMN IF NOT EXISTS erro text;
-- {fotos, vinhos: [{nome, produtor, ano, tipo, regiao, preco, cat}], aviso}
ALTER TABLE garrafeira.livre_pedidos ADD COLUMN IF NOT EXISTS foto jsonb;

-- A da 54, com o estado, o erro e a foto.
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
    'estado', p.estado, 'erro', p.erro, 'foto', p.foto,
    'vinhos', COALESCE((SELECT jsonb_agg(garrafeira.livre_vinho_json(l))
                          FROM garrafeira.livre_vinhos l
                         WHERE l.id IN (SELECT (e ->> 'v')::bigint FROM jsonb_array_elements(p.sugestoes) e
                                         WHERE (e ->> 'v') ~ '^\d+$')), '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.livre_ler(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.livre_ler(bigint) TO authenticated, service_role;
