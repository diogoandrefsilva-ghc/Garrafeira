-- =====================================================================
-- Migração 55 — a casta escrita no nome do vinho da carta (17/10/2026)
--
-- O dono das apps, na pergunta livre das Sugestões: "achas normal que a
-- pesquisa livre não tenha feito match do Soalheiro que estava no
-- Catálogo?". A IA sugeriu o "Soalheiro Alvarinho" (Quinta de Soalheiro,
-- branco) e o Catálogo tem-no como "Soalheiro" (#451, o mesmo produtor e
-- 100% Alvarinho). A `carta_achar` compara chaves, e a chave junta as
-- palavras do nome e do produtor: `alvarinho-soalheiro` contra `soalheiro`.
-- Não bateu, a sugestão apareceu "fora do Catálogo", e a `vinho-info` foi
-- confirmá-la na net — só não nasceu outra linha ao lado da #451 porque
-- faltou a imagem.
--
-- Agora, quando a procura de sempre e a do produtor no nome (a 52) não dão
-- nada, a `carta_achar` procura uma linha do Catálogo cuja chave seja a do
-- pedido MENOS umas palavras, e essas palavras sejam EXATAMENTE as castas
-- dessa linha (sem as palavras de cor): "Soalheiro Alvarinho" é o
-- "Soalheiro" se o "Soalheiro" for só Alvarinho. Com outra casta no nome,
-- ou com uma casta a mais ou a menos, não liga — "Mouchão Alicante
-- Bouschet" não é o "Mouchão" (Alicante Bouschet e Trincadeira). A mesma
-- cor (ou uma das duas sem cor), a colheita do pedido primeiro, e nunca uma
-- linha fundida noutra. É a regra de sempre — contenção não junta "Quinta
-- do Crasto" com "Quinta do Crasto Reserva" —, com a única palavra que se
-- pode conferir na ficha: a casta.
--
-- Só olha para a ficha das linhas cuja chave cabe na do pedido (umas
-- poucas), por isso quase não pesa: as 6 cartas guardadas e as sugestões
-- livres (328 vinhos) leem-se em 1,73 s contra 1,55 s.
--
-- Ensaiada a 17/10/2026 em funções temporárias (`pg_temp`), contra a base
-- real: nas cartas guardadas e nas sugestões livres só mudou o Soalheiro
-- Alvarinho (passou a ligar ao #451). Com cada vinho do Catálogo cujas
-- castas não estão no nome escrito como "nome + castas" (422), com o
-- produtor ligaram 416 à própria linha; o único outro foi o "Quinta da
-- Bacalhoa Cabernet Sauvignon" (Cabernet e Merlot), escrito "… Cabernet
-- Sauvignon Cabernet Sauvignon Merlot", que ligou ao "Quinta da Bacalhôa"
-- (as mesmas castas) — é o mesmo vinho, e é dos Duplicados. Com uma casta
-- que não é a dele no nome (422 + 422), nenhum ligou.
--
-- A `carta_ligar` (cartas) e a `livre_registar`/`livre_lista` (a pergunta
-- livre) passam por ela; a `achar` não muda, que é também a das gravações.
-- No fim, as sugestões livres que estavam "por carregar" e agora ligam
-- passam a "no Catálogo" (o que a `livre_lista` faria ao abrir o
-- Backoffice).
--
-- Corre depois da 52 e da 54. Idempotente.
-- =====================================================================

-- ── 1. A linha do catálogo de UM vinho da carta ──────────────────────
-- A da 52, com o passo 3. Sem GRANT a ninguém: só a chamam a `carta_ligar`
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
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.carta_achar(text, text, integer, text) FROM PUBLIC, anon, authenticated;

-- ── 2. As sugestões livres que agora ligam ───────────────────────────
-- O mesmo que a `livre_lista` faz a cada vez que o admin abre o Backoffice.
UPDATE garrafeira.livre_vinhos l
   SET estado = 'no_catalogo', catalogo_id = x.cat, atualizado_em = now()
  FROM (SELECT id, garrafeira.carta_achar(nome, produtor, ano, tipo) AS cat
          FROM garrafeira.livre_vinhos WHERE estado = 'por_carregar') x
 WHERE l.id = x.id AND x.cat IS NOT NULL;
