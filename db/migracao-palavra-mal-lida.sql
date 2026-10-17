-- =====================================================================
-- Migração 57 — uma palavra mal lida no nome do vinho (17/10/2026)
--
-- O dono das apps, na pergunta livre com uma fotografia (Fraldinha
-- Grelhada): "achei estranho não ter feito match com o Vinho Crasto
-- Reserva". A leitura da foto escreveu "Castro Reserva" (Tinto, Douro,
-- 2022) — as letras de "Crasto" noutra ordem, um apelido que o modelo
-- conhece melhor —, e o Catálogo tem o "Crasto Reserva" 2022 (#12, Quinta
-- do Crasto). A `carta_achar` compara chaves (`castro-reserva` contra
-- `crasto-reserva`), não bateu, e o vinho apareceu "fora do Catálogo".
--
-- Agora, quando os três passos de antes não dão nada, há um quarto: a
-- linha do Catálogo cuja chave tem as MESMAS palavras do pedido menos UMA,
-- e essa uma está mal lida (`garrafeira.palavra_mal_lida`):
--   · as mesmas letras noutra ordem, com a primeira e a última no sítio
--     ("Castro"/"Crasto");
--   · ou uma letra trocada, a mais ou a menos ("Cristo"/"Crasto",
--     "Valado"/"Vallado") — a regra dos parecidos da app (`parUmaLetra`).
-- Só palavras de letras com 5 ou mais (nas curtas, uma letra já é outra
-- palavra), só chaves de duas palavras ou mais (a que fica igual confirma),
-- e com a mesma cor. A palavra lida não pode ser o nome de um produtor que o
-- Catálogo conhece: "Quinta dos Carvalhais" e "Quinta das Carvalhas" estão a
-- uma letra uma da outra e são dois produtores. E tem de sobrar UM vinho só
-- (as colheitas dele contam como um): com dois, não se escolhe. A colheita
-- do pedido primeiro, nunca uma linha fundida noutra.
--
-- Ensaiada a 17/10/2026 em funções temporárias (`pg_temp`), contra a base
-- real: nos 371 vinhos guardados (cartas, identificações, sugestões livres
-- e as fotos da pergunta livre; 197 sem ligação) só mudou o "Castro
-- Reserva", que passa a ligar ao #12. Com cada vinho do Catálogo escrito
-- com duas letras trocadas na palavra mais comprida, 391 de 391 ligaram ao
-- próprio vinho; com uma letra a menos, 351 de 392 (os outros 41 ficaram
-- com menos de 5 letras), e nenhum a outro vinho. Entre os vinhos do
-- Catálogo só há três pares a uma palavra mal lida um do outro: o
-- "Invisível Aragonês"/"Aragonez" da Ervideira (é dos Duplicados) e dois
-- Carvalhais/Carvalhas (que a regra do produtor separa).
--
-- A `carta_ligar` (cartas, Identificar) e a `livre_registar`/`livre_lista`
-- (a pergunta livre) passam por ela; a `achar` não muda, que é também a das
-- gravações. No fim, as sugestões livres "pendentes" ou "por carregar" que
-- agora ligam passam a "no Catálogo", e os vinhos lidos nas fotos da
-- pergunta livre ganham a linha (`cat`).
--
-- Corre depois da 55 e da 56. Idempotente.
-- =====================================================================

-- ── 1. Uma palavra mal lida ──────────────────────────────────────────
-- As palavras já vêm da chave (minúsculas, sem acentos).
CREATE OR REPLACE FUNCTION garrafeira.palavra_mal_lida(a text, b text)
  RETURNS boolean LANGUAGE plpgsql IMMUTABLE
  SET search_path = garrafeira, public
AS $$
DECLARE la int := length(a); lb int := length(b); i int; d int := 0; c text; l text;
BEGIN
  IF a IS NULL OR b IS NULL OR a = b OR a !~ '^[a-z]{5,}$' OR b !~ '^[a-z]{5,}$' OR abs(la - lb) > 1 THEN
    RETURN false;
  END IF;
  IF la = lb THEN
    -- as mesmas letras noutra ordem, a primeira e a última no sítio
    IF left(a, 1) = left(b, 1) AND right(a, 1) = right(b, 1)
       AND (SELECT string_agg(x, '' ORDER BY x) FROM regexp_split_to_table(a, '') x)
         = (SELECT string_agg(x, '' ORDER BY x) FROM regexp_split_to_table(b, '') x) THEN
      RETURN true;
    END IF;
    -- uma letra trocada
    FOR i IN 1..la LOOP
      IF substr(a, i, 1) <> substr(b, i, 1) THEN
        d := d + 1;
        IF d > 1 THEN RETURN false; END IF;
      END IF;
    END LOOP;
    RETURN d = 1;
  END IF;
  -- uma letra a mais ou a menos
  IF la < lb THEN c := a; l := b; ELSE c := b; l := a; END IF;
  i := 1;
  WHILE i <= length(c) AND substr(c, i, 1) = substr(l, i, 1) LOOP i := i + 1; END LOOP;
  RETURN substr(c, i) = substr(l, i + 1);
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.palavra_mal_lida(text, text) FROM PUBLIC, anon, authenticated;

-- ── 2. A linha do catálogo de UM vinho da carta ──────────────────────
-- A da 55, com o passo 4. Sem GRANT a ninguém: só a chamam a `carta_ligar`
-- e as `livre_*` (SECURITY DEFINER, correm como o dono).
CREATE OR REPLACE FUNCTION garrafeira.carta_achar(p_nome text, p_produtor text, p_ano integer, p_tipo text)
  RETURNS bigint LANGUAGE plpgsql STABLE
  SET search_path = garrafeira, winecatalog, public
AS $$
DECLARE
  v_id  bigint;
  v_tok text[];
  c     record;
  v_lp  bigint;
  v_q   text[];
  v_cor text;
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

  -- 3. A casta escrita no nome: uma linha cuja chave é a do pedido menos
  --    umas palavras, e essas palavras são as castas DELA, todas e só elas.
  --    Primeiro as linhas cuja chave cabe na do pedido (é texto, não pesa);
  --    a ficha só se lê dessas.
  v_q   := string_to_array(winecatalog.chave_base(p_nome, p_produtor), '-');
  v_cor := COALESCE(winecatalog.cor_de(p_tipo), winecatalog.cor_do_nome(p_nome));
  WITH cand AS MATERIALIZED (
    SELECT w.id, w.ano, w.cor,
           ARRAY(SELECT t FROM unnest(v_q) t WHERE t <> ALL (string_to_array(w.chave_base, '-')) ORDER BY t) AS resto
      FROM winecatalog.vinhos w
     WHERE w.chave_base <> ''
       AND string_to_array(w.chave_base, '-') <@ v_q
       AND NOT (v_q <@ string_to_array(w.chave_base, '-'))
       AND (v_cor IS NULL OR w.cor IS NULL OR w.cor = v_cor)
       AND NOT EXISTS (SELECT 1 FROM winecatalog.alias a WHERE a.id_de = w.id)
  )
  SELECT k.id INTO v_id
    FROM cand k
    JOIN winecatalog.vinhos w ON w.id = k.id
   WHERE jsonb_typeof(w.ficha -> 'castas') = 'array'
     AND k.resto = ARRAY(SELECT DISTINCT t FROM unnest(winecatalog.tokens(
                           (SELECT string_agg(x, ' ') FROM jsonb_array_elements_text(w.ficha -> 'castas') x))) t
                         WHERE NOT winecatalog.palavra_cor(t) ORDER BY t)
   ORDER BY (k.ano IS NOT DISTINCT FROM p_ano) DESC, (k.cor = v_cor) DESC,
            (SELECT count(*) FROM jsonb_object_keys(w.ficha)) DESC, k.ano DESC NULLS LAST, k.id
   LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  -- 4. Uma palavra mal lida ("Castro Reserva" é o "Crasto Reserva"): as
  --    mesmas palavras menos uma, e essa uma a uma letra ou com as letras
  --    trocadas (`palavra_mal_lida`). Pelas duas chaves do pedido e das
  --    linhas, como a `achar` (o nome com o produtor, e o nome sozinho). Só
  --    com a cor, e só se sobrar UM vinho (as colheitas dele são uma).
  IF v_cor IS NULL THEN RETURN NULL; END IF;
  WITH q AS MATERIALIZED (
    SELECT DISTINCT string_to_array(k, '-') AS x
      FROM unnest(ARRAY[winecatalog.chave_base(p_nome, p_produtor), winecatalog.base_nome(p_nome)]) k
     WHERE k IS NOT NULL AND k LIKE '%-%'
  ), cand AS MATERIALIZED (
    SELECT DISTINCT w.id, w.ano, w.chave_base, (SELECT count(*) FROM jsonb_object_keys(w.ficha)) AS n
      FROM winecatalog.vinhos w
      CROSS JOIN q
      CROSS JOIN LATERAL unnest(ARRAY[w.chave_base, w.base_nome]) wk
      CROSS JOIN LATERAL (SELECT string_to_array(wk, '-') AS y) yy
      CROSS JOIN LATERAL (SELECT ARRAY(SELECT t FROM unnest(q.x) t WHERE t <> ALL (yy.y)) AS a,
                                 ARRAY(SELECT t FROM unnest(yy.y) t WHERE t <> ALL (q.x)) AS b) d
     WHERE w.cor = v_cor AND wk IS NOT NULL
       -- o mesmo número de palavras, e pelo menos uma igual (é texto, não pesa)
       AND cardinality(yy.y) = cardinality(q.x) AND yy.y && q.x
       AND cardinality(d.a) = 1 AND cardinality(d.b) = 1
       AND garrafeira.palavra_mal_lida(d.a[1], d.b[1])
       -- a palavra lida não é outro produtor que o Catálogo conhece
       AND NOT EXISTS (SELECT 1 FROM winecatalog.produtor_variantes pv WHERE d.a[1] = ANY (string_to_array(pv.chave, '-')))
       AND NOT EXISTS (SELECT 1 FROM winecatalog.alias al WHERE al.id_de = w.id)
  )
  SELECT CASE WHEN (SELECT count(DISTINCT chave_base) FROM cand) = 1
              THEN (SELECT id FROM cand ORDER BY (ano IS NOT DISTINCT FROM p_ano) DESC, n DESC, ano DESC NULLS LAST, id LIMIT 1) END
    INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.carta_achar(text, text, integer, text) FROM PUBLIC, anon, authenticated;

-- ── 3. As sugestões livres que agora ligam ───────────────────────────
-- O que a `livre_lista` faria ao abrir o Backoffice (e a `livre_registar`
-- na próxima vez que fossem sugeridas).
UPDATE garrafeira.livre_vinhos l
   SET estado = 'no_catalogo', catalogo_id = x.cat, atualizado_em = now()
  FROM (SELECT id, garrafeira.carta_achar(nome, produtor, ano, tipo) AS cat
          FROM garrafeira.livre_vinhos WHERE estado IN ('pendente', 'por_carregar')) x
 WHERE l.id = x.id AND x.cat IS NOT NULL;

-- E os vinhos lidos nas fotos da pergunta livre (a linha de cada um, `cat`,
-- fica no pedido quando a foto é lida).
UPDATE garrafeira.livre_pedidos p
   SET foto = jsonb_set(p.foto, '{vinhos}', x.vinhos)
  FROM (SELECT p2.id,
               jsonb_agg(CASE WHEN v ->> 'cat' IS NULL AND COALESCE(v ->> 'nome', '') <> ''
                              THEN v || jsonb_build_object('cat', garrafeira.carta_achar(v ->> 'nome', COALESCE(v ->> 'produtor', ''),
                                         CASE WHEN jsonb_typeof(v -> 'ano') = 'number' THEN (v ->> 'ano')::integer END, v ->> 'tipo'))
                              ELSE v END ORDER BY o) AS vinhos
          FROM garrafeira.livre_pedidos p2,
               jsonb_array_elements(p2.foto -> 'vinhos') WITH ORDINALITY AS e(v, o)
         WHERE jsonb_typeof(p2.foto -> 'vinhos') = 'array'
         GROUP BY p2.id) x
 WHERE p.id = x.id AND p.foto -> 'vinhos' IS DISTINCT FROM x.vinhos;
