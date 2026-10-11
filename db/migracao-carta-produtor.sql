-- =====================================================================
-- Migração 52 — o produtor (ou a casa-mãe) escrito no nome do vinho da
-- carta (11/10/2026)
--
-- O dono das apps, nas Sugestões: "na carta estava um Assobio Esporão Tinto
-- que eu acho que tinha um bom candidato no nosso Catálogo". Tinha: o #551,
-- "Assobio", produtor Quinta dos Murças, que tem casa-mãe Esporão (migração
-- 43). A carta imprime "Assobio Esporão" numa linha só, a leitura transcreve
-- o nome como está na carta e deixa o produtor vazio (fez isso nos 23
-- vinhos dessa carta), e a `achar` compara chaves: `assobio-esporao` contra
-- `assobio-murcas` (nome + produtor) e `assobio` (só o nome). Nenhuma bate,
-- e a carta dizia "sem dados".
--
-- Agora, quando um vinho da carta não liga, a `carta_achar` procura no nome
-- um produtor que o Catálogo conhece (`winecatalog.produtor_variantes`: o
-- nome oficial e as grafias, casas-mãe incluídas), tira-o do nome e
-- pergunta outra vez à `achar` com ele como produtor. Só aceita a linha que
-- vier se ela for DESSE produtor, ou de um produtor que o tenha como
-- casa-mãe — é aí que a casa-mãe conta: "Assobio Sogrape" não liga ao
-- Assobio do Esporão. As palavras comparam-se pela `winecatalog.tokens` (a
-- da chave), por isso o produtor pode vir antes ou depois do nome, e o que
-- sobra do nome tem de ter alguma palavra que não seja a cor.
--
-- Só corre quando a procura de sempre não deu nada: o que já ligava liga
-- exatamente como antes. A regra continua a ser a da `achar` (a cor, a
-- colheita da carta primeiro, uma linha fundida responde pela que ficou);
-- a `achar` não muda, que é também a das gravações.
--
-- Ensaiada a 11/10/2026 em funções temporárias (`pg_temp`), contra a base
-- real: nas 6 cartas guardadas, só mudou o Assobio Esporão Tinto (passou a
-- ligar ao #551; o branco e o rosé continuam sem linha, o Catálogo só tem o
-- tinto). Com cada vinho do Catálogo escrito como uma carta o escreveria —
-- o nome mais o produtor, à frente ou atrás (254 + 254), e o nome mais a
-- casa-mãe (96) — nenhum ligou a outro vinho: à própria linha, ou a outra
-- colheita do mesmo vinho. Com a casa-mãe, ligaram 92 dos 96 (antes, 0).
--
-- Corre depois da 40 (`carta_ligar`) e da 43 (`casa_mae_id`). Idempotente.
-- =====================================================================

-- ── 1. A linha do catálogo de UM vinho da carta ──────────────────────
-- Sem GRANT a ninguém: só a chama a `carta_ligar` (SECURITY DEFINER, corre
-- como o dono, que pode ler o `winecatalog`).
CREATE OR REPLACE FUNCTION garrafeira.carta_achar(p_nome text, p_produtor text, p_ano integer, p_tipo text)
  RETURNS bigint LANGUAGE plpgsql STABLE
  SET search_path = garrafeira, winecatalog, public
AS $$
DECLARE
  v_id  bigint;
  v_tok text[];
  c     record;
  v_lp  bigint;
BEGIN
  IF winecatalog.chave_base(p_nome, p_produtor) = '' THEN RETURN NULL; END IF;

  -- 1. Como sempre: a colheita da carta primeiro, depois qualquer uma.
  v_id := COALESCE(CASE WHEN p_ano IS NOT NULL THEN winecatalog.achar(p_nome, p_produtor, p_ano, true, NULL, p_tipo) END,
                   winecatalog.achar(p_nome, p_produtor, p_ano, false, NULL, p_tipo));
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  -- 2. O produtor (ou a casa-mãe) escrito no nome: tira-se do nome e vai
  --    como produtor. As palavras mais compridas primeiro ("Real Companhia
  --    Velha" antes de um produtor de uma palavra só que caiba lá dentro).
  v_tok := winecatalog.tokens(p_nome);
  FOR c IN
    SELECT p.id, p.nome,
           array_to_string(ARRAY(SELECT t FROM unnest(v_tok) t WHERE t <> ALL (k.pt)), ' ') AS resto
      FROM winecatalog.produtor_variantes pv
      JOIN winecatalog.produtores p ON p.id = pv.produtor_id
      CROSS JOIN LATERAL (SELECT string_to_array(pv.chave, '-') AS pt) k
     WHERE pv.chave <> '' AND k.pt <@ v_tok
       -- sobra alguma coisa do nome que não seja a cor ("Esporão Tinto" não)
       AND EXISTS (SELECT 1 FROM unnest(v_tok) t WHERE t <> ALL (k.pt) AND NOT winecatalog.palavra_cor(t))
     ORDER BY cardinality(k.pt) DESC, p.id
  LOOP
    v_id := COALESCE(CASE WHEN p_ano IS NOT NULL THEN winecatalog.achar(c.resto, c.nome, p_ano, true, NULL, p_tipo) END,
                     winecatalog.achar(c.resto, c.nome, p_ano, false, NULL, p_tipo));
    CONTINUE WHEN v_id IS NULL;
    -- Só se a linha for deste produtor, ou de um produtor que o tem como
    -- casa-mãe. Uma linha com um produtor que o Catálogo não conhece fica.
    SELECT pv.produtor_id INTO v_lp
      FROM winecatalog.vinhos w
      JOIN winecatalog.produtor_variantes pv ON pv.chave = winecatalog.chave_produtor(w.produtor)
     WHERE w.id = v_id;
    IF v_lp = c.id
       OR EXISTS (SELECT 1 FROM winecatalog.produtores m WHERE m.id = v_lp AND m.casa_mae_id = c.id) THEN
      RETURN v_id;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.carta_achar(text, text, integer, text) FROM PUBLIC, anon, authenticated;

-- ── 2. A `carta_ligar` passa por ela ──────────────────────────────────
-- A da 40, tal e qual, com a procura de cada vinho na `carta_achar`.
CREATE OR REPLACE FUNCTION garrafeira.carta_ligar(p_pedidos jsonb, p_ficha boolean DEFAULT false)
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = garrafeira, winecatalog, public
AS $$
BEGIN
  IF NOT (garrafeira.is_allowed() OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'Sem acesso.';
  END IF;
  IF jsonb_typeof(p_pedidos) IS DISTINCT FROM 'array' THEN RETURN '[]'::jsonb; END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(
             CASE WHEN w.id IS NULL THEN NULL
                  WHEN p_ficha THEN jsonb_build_object('id', w.id, 'ano', w.ano, 'cor', w.cor,
                                                       'nome', w.nome, 'produtor', w.produtor, 'ficha', w.ficha)
                  ELSE jsonb_build_object('id', w.id, 'ano', w.ano, 'cor', w.cor) END
             ORDER BY t.i), '[]'::jsonb)
      FROM jsonb_array_elements(p_pedidos) WITH ORDINALITY AS t(p, i)
      CROSS JOIN LATERAL (
        SELECT COALESCE(t.p ->> 'nome', '') AS n,
               COALESCE(t.p ->> 'produtor', '') AS pr,
               CASE WHEN jsonb_typeof(t.p -> 'ano') = 'number' THEN (t.p ->> 'ano')::integer END AS ano,
               NULLIF(t.p ->> 'tipo', '') AS tp
      ) c
      CROSS JOIN LATERAL (
        SELECT garrafeira.carta_achar(c.n, c.pr, c.ano, c.tp) AS rid
      ) x
      LEFT JOIN winecatalog.vinhos w ON w.id = x.rid
     WHERE t.i <= 80
  );
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.carta_ligar(jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.carta_ligar(jsonb, boolean) TO authenticated, service_role;
