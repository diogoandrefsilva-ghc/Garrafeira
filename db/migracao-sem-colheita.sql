-- =====================================================================
-- Migração 50 — a linha sem colheita ao lado das colheitas (09/10/2026)
--
-- O dono das apps: "Faz-me confusão ter vinhos que têm uma colheita
-- preenchida e depois têm outro registo com colheita vazia … deveria ter
-- uma espécie de alerta no backoffice, para poder eventualmente apagar o
-- vinho sem colheita e ficar apenas com o vinho com colheita preenchida.
-- As wishlists, que podem criar vinhos sem ano, teriam que ser ajustadas
-- para apontar à colheita que permanece."
--
-- A 09/10/2026 havia cinco: Quinta do Cidrô Marquis (s/a + 2014), Quinta
-- Dona Sancha Touriga Nacional (s/a + 2021), Sidónio de Sousa Garrafeira
-- (s/a + 2017), Quinta dos Sentidos (s/a + 2018) e Tapada de Coelheiros
-- (s/a + 2020). Três nasceram da mesma maneira: o vinho foi gravado numa
-- garrafeira sem ano (a 25–26/09), e a 08/10 ganhou o ano — o trigger
-- tratou a colheita como OUTRO vinho, fez nascer a linha dela, e a antiga
-- ficou órfã, com os preços das lojas e o Vivino que a nova não tinha.
--
-- O que muda:
--   · `garrafeira.colheita_absorver(de, para)` — JUNTA a linha sem
--     colheita a uma colheita, em vez de a apagar. É a `fundir` dos
--     Duplicados com uma trave a mais: na linha sem colheita, a nota da
--     colheita, o preço de referência, a janela, o link do Vivino e a
--     imagem são de uma colheita QUALQUER (`winecatalog.da_colheita`) e
--     não podem ir parar à 2021. Passa só o que é do VINHO (castas, região,
--     harmonização, notas de prova, a nota de todas as colheitas…), e só
--     para o que está VAZIO — na que fica e nas outras colheitas do mesmo
--     vinho. A nota de todas as colheitas e as avaliações dela vão juntas:
--     as avaliações nunca passam sozinhas para ao pé de outra nota. Os preços das lojas passam loja a loja para a que fica, só as
--     lojas que ela não tem (cada preço diz a sua colheita; um retirado não
--     passa). A linha sem colheita fica estacionada no `alias` (não se
--     apaga): qualquer pergunta sem ano — uma carta, uma wishlist sem ano —
--     passa a cair na colheita que fica, e o "Desfazer" da WineCatalog
--     (`separar`) devolve o que passou para ela. O que passou para as
--     outras colheitas fica no histórico de cada uma (`vinhos_historico`),
--     com "Repor";
--   · os vinhos das garrafeiras ligados à linha sem colheita (e às que já
--     tinham sido fundidas nela) passam a apontar à que fica
--     (`ligar_catalogo`). O ANO deles não muda: sem ano continua a querer
--     dizer "qualquer colheita";
--   · `winecatalog.sem_colheita_juntar(de, para)` — a porta do admin do
--     catálogo (o Backoffice › "Sem colheita"); a deteção vive na app,
--     como a das colheitas que não batem (`catFamChave` sobre o Catálogo
--     que ela já tem). O "Está certo" (um vinho que não tem colheita a
--     sério e outro que tem, com o mesmo nome) usa as `colheitas_aceites`
--     da migração 49, com o campo `sem_colheita`;
--   · `winecatalog.sem_colheita_ligados(ids)` — quantos vinhos das
--     garrafeiras estão ligados a cada linha (e quantos são desejos). Só os
--     números, nunca de quem;
--   · A CAUSA (`vinhos_colheita_nasceu`): quando um vinho de uma garrafeira
--     ganha o ano (ou um desejo que já o tinha passa para a garrafeira), a
--     linha a que estava ligado não tem colheita e a da colheita nova acabou
--     de NASCER nesta gravação, a sem colheita junta-se logo a ela. Se a colheita já existia, não se mexe: é o alerta do
--     Backoffice que decide. Fica uma linha no `sync_log` (acao
--     `colheita_nasceu`).
--
-- Corre depois da 28 (`ligar_catalogo`), da 39 (`vinhos_catalogo`) e da 49
-- (`colheitas_aceites`). Só cria — sem `DROP` nem `DELETE`, nem dentro das
-- funções (o MCP do Supabase pede confirmação a qualquer um e fica preso),
-- por isso corre pelo MCP. Idempotente (`CREATE OR REPLACE TRIGGER`, PG 14+).
-- =====================================================================

-- ---------------------------------------------------------------------
-- JUNTAR: a linha sem colheita (`p_de`) passa à colheita `p_para`. Sem
-- porta própria: chamam-na a do admin (abaixo) e o trigger da causa.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.colheita_absorver(
  p_de bigint, p_para bigint, p_quem text DEFAULT NULL, p_auto boolean DEFAULT false)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  de        winecatalog.vinhos%ROWTYPE;
  para      winecatalog.vinhos%ROWTYPE;
  o         winecatalog.vinhos%ROWTYPE;
  v_ficha   jsonb;
  v_origens jsonb;
  v_mov     jsonb := '{}'::jsonb;
  v_of      jsonb;
  v_oo      jsonb;
  v_mudou   boolean;
  v_outras  integer := 0;
  v_pre     jsonb;
  v_pre_de  jsonb;
  v_lojas   integer := 0;
  v_fontes  jsonb;
  v_antigos bigint[];
  v_chave   text;
  v_lig     integer := 0;
  k         text;
  v         jsonb;
  r         record;
BEGIN
  SELECT * INTO de   FROM winecatalog.vinhos WHERE id = p_de   FOR UPDATE;
  SELECT * INTO para FROM winecatalog.vinhos WHERE id = p_para FOR UPDATE;
  IF de.id IS NULL OR para.id IS NULL THEN
    RAISE EXCEPTION 'Linha não encontrada.';
  END IF;
  IF de.ano IS NOT NULL THEN
    RAISE EXCEPTION 'A linha a juntar tem colheita (%) — isto é só para a linha sem colheita.', de.ano;
  END IF;
  IF para.ano IS NULL THEN
    RAISE EXCEPTION 'A linha que fica tem de ter colheita.';
  END IF;
  IF EXISTS (SELECT 1 FROM winecatalog.alias WHERE id_de IN (de.id, para.id)) THEN
    RAISE EXCEPTION 'Uma das linhas já foi fundida noutra.';
  END IF;
  -- O mesmo vinho: a mesma chave de nome e produtor, e a mesma cor.
  IF de.chave_base IS DISTINCT FROM para.chave_base
     OR (de.cor IS NOT NULL AND para.cor IS NOT NULL AND de.cor <> para.cor) THEN
    RAISE EXCEPTION 'Não são o mesmo vinho (o nome, o produtor ou a cor são outros).';
  END IF;
  IF COALESCE(p_quem, '') <> '' THEN
    PERFORM set_config('winecatalog.quem', p_quem, true);
  END IF;

  -- 1. Na que fica: o que é do VINHO, para o que está vazio.
  v_ficha   := COALESCE(para.ficha, '{}'::jsonb);
  v_origens := COALESCE(para.origens, '{}'::jsonb);
  FOR k, v IN SELECT key, value FROM jsonb_each(COALESCE(de.ficha, '{}'::jsonb)) LOOP
    CONTINUE WHEN k IN ('tipo', 'produtor', 'ano', 'nome') OR winecatalog.da_colheita(k)
               OR winecatalog.vazio(v);
    CONTINUE WHEN (v_ficha ? k) AND NOT winecatalog.vazio(v_ficha -> k);
    -- A nota de todas as colheitas e as avaliações dela são um par: as
    -- avaliações não vão sozinhas para ao pé de outra nota.
    CONTINUE WHEN k = 'vivino_avaliacoes_global'
              AND NOT winecatalog.vazio(para.ficha -> 'vivino_nota_global');
    v_mov := v_mov || jsonb_build_object(k, jsonb_build_object(
      'antes', v_ficha -> k, 'antes_origem', v_origens -> k,
      'depois_origem', COALESCE(de.origens -> k, '{}'::jsonb)));
    v_ficha   := v_ficha   || jsonb_build_object(k, v);
    v_origens := v_origens || jsonb_build_object(k, COALESCE(de.origens -> k, '{}'::jsonb));
  END LOOP;

  -- Os preços das lojas, loja a loja: só as que a que fica não tem. Cada
  -- preço diz a sua colheita, e a app sabe pesá-la (`precosLojaDe`).
  v_pre_de := CASE WHEN jsonb_typeof(de.ficha -> 'precos') = 'object' THEN de.ficha -> 'precos' END;
  IF v_pre_de IS NOT NULL THEN
    v_pre := CASE WHEN jsonb_typeof(v_ficha -> 'precos') = 'object' THEN v_ficha -> 'precos' ELSE '{}'::jsonb END;
    FOR k, v IN SELECT key, value FROM jsonb_each(v_pre_de) LOOP
      CONTINUE WHEN jsonb_typeof(v) <> 'object'
                 OR COALESCE((v ->> 'retirado')::boolean, false)
                 OR (v_pre ? k);
      v_pre   := v_pre || jsonb_build_object(k, v);
      v_lojas := v_lojas + 1;
    END LOOP;
    IF v_lojas > 0 THEN
      v_mov := v_mov || jsonb_build_object('precos', jsonb_build_object(
        'antes', v_ficha -> 'precos', 'antes_origem', v_origens -> 'precos',
        'depois_origem', COALESCE(v_origens -> 'precos', de.origens -> 'precos', '{}'::jsonb)));
      v_ficha   := v_ficha || jsonb_build_object('precos', v_pre);
      v_origens := v_origens || jsonb_build_object('precos',
                     COALESCE(v_origens -> 'precos', de.origens -> 'precos', '{}'::jsonb));
    END IF;
  END IF;

  -- As fontes juntam-se sem repetir, e ficam pelas 8 (como na `fundir`).
  SELECT COALESCE(jsonb_agg(f), '[]'::jsonb) INTO v_fontes FROM (
    SELECT DISTINCT ON (f ->> 'url') f
      FROM jsonb_array_elements(COALESCE(para.fontes, '[]'::jsonb) || COALESCE(de.fontes, '[]'::jsonb)) f
     WHERE COALESCE(f ->> 'url', '') <> ''
     ORDER BY (f ->> 'url')
     LIMIT 8
  ) x;

  UPDATE winecatalog.vinhos
     SET ficha = v_ficha, origens = v_origens, fontes = v_fontes,
         produtor = CASE WHEN COALESCE(produtor, '') = '' THEN COALESCE(de.produtor, '') ELSE produtor END,
         atualizado_em = now()
   WHERE id = para.id;

  -- 2. As outras colheitas do mesmo vinho: o mesmo, só no vazio. Ficam no
  -- histórico de cada uma (o trigger `vinhos_historico`), com "Repor". O
  -- mesmo vinho é o mesmo NOME (e produtor), não só a mesma `chave_base`:
  -- essa junta o "Coelheiros" e o "Tapada de Coelheiros" do mesmo produtor,
  -- que são dois vinhos.
  FOR o IN SELECT w.* FROM winecatalog.vinhos w
            WHERE w.chave_base = de.chave_base
              AND lower(w.nome) = lower(de.nome)
              AND (COALESCE(de.produtor, '') = '' OR lower(COALESCE(w.produtor, '')) = lower(de.produtor))
              AND w.id NOT IN (de.id, para.id)
              AND w.ano IS NOT NULL
              AND w.cor IS NOT DISTINCT FROM para.cor
              AND NOT EXISTS (SELECT 1 FROM winecatalog.alias a WHERE a.id_de = w.id)
            FOR UPDATE LOOP
    v_of := COALESCE(o.ficha, '{}'::jsonb);
    v_oo := COALESCE(o.origens, '{}'::jsonb);
    v_mudou := false;
    FOR k, v IN SELECT key, value FROM jsonb_each(COALESCE(de.ficha, '{}'::jsonb)) LOOP
      CONTINUE WHEN k IN ('tipo', 'produtor', 'ano', 'nome') OR winecatalog.da_colheita(k)
                 OR winecatalog.vazio(v);
      CONTINUE WHEN (v_of ? k) AND NOT winecatalog.vazio(v_of -> k);
      CONTINUE WHEN k = 'vivino_avaliacoes_global'
                AND NOT winecatalog.vazio(o.ficha -> 'vivino_nota_global');
      v_of := v_of || jsonb_build_object(k, v);
      v_oo := v_oo || jsonb_build_object(k, COALESCE(de.origens -> k, '{}'::jsonb));
      v_mudou := true;
    END LOOP;
    IF v_mudou THEN
      UPDATE winecatalog.vinhos SET ficha = v_of, origens = v_oo, atualizado_em = now()
       WHERE id = o.id;
      v_outras := v_outras + 1;
    END IF;
  END LOOP;

  -- 3. A linha sem colheita fica estacionada: as perguntas sem ano passam a
  -- cair na que fica. As que já tinham sido fundidas nela passam à que fica
  -- (a `achar` resolve UM salto). Se a chave dela já é de outra fusão (uma
  -- linha mais antiga com a mesma chave, fundida nela), essa fusão já leva
  -- a chave à que fica, e esta entra com a chave marcada pelo id — a
  -- `chave_de` é única.
  v_antigos := ARRAY(SELECT id_de FROM winecatalog.alias WHERE id_para = de.id);
  UPDATE winecatalog.alias SET id_para = para.id, chave_para = para.chave
   WHERE id_para = de.id;
  v_chave := de.chave;
  IF EXISTS (SELECT 1 FROM winecatalog.alias WHERE chave_de = v_chave) THEN
    v_chave := de.chave || '#' || de.id;
  END IF;
  INSERT INTO winecatalog.alias (chave_de, chave_para, id_de, id_para, nome_de, ano_de, campos_movidos, quem)
  VALUES (v_chave, para.chave, de.id, para.id, de.nome, NULL, v_mov,
          COALESCE(NULLIF(p_quem, ''), auth.email(), NULLIF(current_setting('winecatalog.quem', true), '')))
  ON CONFLICT (chave_de) DO UPDATE
    SET chave_para = EXCLUDED.chave_para, id_para = EXCLUDED.id_para, id_de = EXCLUDED.id_de,
        nome_de = EXCLUDED.nome_de, ano_de = NULL,
        campos_movidos = EXCLUDED.campos_movidos, quem = EXCLUDED.quem, quando = now();
  -- Um "não são o mesmo" que houvesse entre as duas fica onde está: a linha
  -- estacionada já não aparece nos Duplicados.

  -- 4. Os vinhos das garrafeiras ligados à que saiu passam à que fica. O
  -- ano deles fica como está.
  FOR r IN SELECT id FROM garrafeira.vinhos
            WHERE catalogo_id = ANY (ARRAY[de.id] || v_antigos) LOOP
    IF garrafeira.ligar_catalogo(r.id, para.id) THEN v_lig := v_lig + 1; END IF;
  END LOOP;

  INSERT INTO garrafeira.sync_log (origem, acao, estado, quem, detalhe)
  VALUES ('app', CASE WHEN p_auto THEN 'colheita_nasceu' ELSE 'sem_colheita_juntar' END, 'ok',
          COALESCE(NULLIF(p_quem, ''), auth.email()),
          jsonb_build_object('de', de.id, 'para', para.id, 'ano', para.ano, 'nome', para.nome,
            'campos', (SELECT count(*) FROM jsonb_object_keys(v_mov)),
            'lojas', v_lojas, 'outras', v_outras, 'ligados', v_lig));

  RETURN jsonb_build_object('ok', true, 'id', para.id, 'ano', para.ano,
    'campos', (SELECT count(*) FROM jsonb_object_keys(v_mov)),
    'lojas', v_lojas, 'outras', v_outras, 'ligados', v_lig);
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.colheita_absorver(bigint, bigint, text, boolean) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- A PORTA DO ADMIN (Backoffice › Sem colheita).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION winecatalog.sem_colheita_juntar(p_de bigint, p_para bigint)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  IF NOT winecatalog.sou_admin() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  RETURN garrafeira.colheita_absorver(p_de, p_para, lower(COALESCE(auth.email(), '')), false);
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.sem_colheita_juntar(bigint, bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION winecatalog.sem_colheita_juntar(bigint, bigint) TO authenticated;

-- Quantos vinhos das garrafeiras estão ligados a cada linha (também pelas
-- que foram fundidas nela), e quantos desses são desejos. Só os números.
CREATE OR REPLACE FUNCTION winecatalog.sem_colheita_ligados(p_ids bigint[])
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'winecatalog', 'public'
AS $$
BEGIN
  IF NOT winecatalog.sou_admin() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_object_agg(x.id::text, jsonb_build_object('n', x.n, 'desejos', x.d))
      FROM (
        SELECT COALESCE(a.id_para, g.catalogo_id) AS id,
               count(*) AS n, count(*) FILTER (WHERE g.desejado) AS d
          FROM garrafeira.vinhos g
          LEFT JOIN winecatalog.alias a ON a.id_de = g.catalogo_id
         WHERE COALESCE(a.id_para, g.catalogo_id) = ANY (COALESCE(p_ids, ARRAY[]::bigint[]))
         GROUP BY 1
      ) x), '{}'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION winecatalog.sem_colheita_ligados(bigint[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION winecatalog.sem_colheita_ligados(bigint[]) TO authenticated;

-- ---------------------------------------------------------------------
-- A CAUSA: o vinho que ganha o ano não deixa a linha sem colheita órfã.
-- Corre DEPOIS do `vinhos_catalogo` (os triggers da mesma vez correm por
-- ordem alfabética: "vinhos_catalogo" < "vinhos_colheita_nasceu") — é ele
-- que liga o vinho à linha da colheita nova. O NEW daqui não vê essa
-- ligação (foi escrita por outro UPDATE, o da `ligar_catalogo`), por isso
-- relê-se a linha.
-- Só quando a colheita nova NASCEU nesta gravação (`criado_em` é o `now()`
-- da transação): se já existia, é o alerta do Backoffice que decide.
-- Nunca deita a gravação abaixo.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.vinhos_colheita_nasceu()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v_novo bigint;
  v_de   bigint;
  de     winecatalog.vinhos%ROWTYPE;
  para   winecatalog.vinhos%ROWTYPE;
BEGIN
  IF COALESCE(current_setting('garrafeira.do_catalogo', true), '') = 'sim'
     OR COALESCE(current_setting('garrafeira.ligar', true), '') = 'sim' THEN
    RETURN NULL;
  END IF;
  BEGIN
    SELECT catalogo_id INTO v_novo FROM garrafeira.vinhos WHERE id = NEW.id;
    IF v_novo IS NULL OR v_novo = OLD.catalogo_id THEN RETURN NULL; END IF;
    v_de := COALESCE((SELECT a.id_para FROM winecatalog.alias a WHERE a.id_de = OLD.catalogo_id),
                     OLD.catalogo_id);
    SELECT * INTO de   FROM winecatalog.vinhos WHERE id = v_de;
    SELECT * INTO para FROM winecatalog.vinhos WHERE id = v_novo;
    IF de.id IS NULL OR para.id IS NULL OR de.id = para.id THEN RETURN NULL; END IF;
    IF de.ano IS NOT NULL OR para.ano IS DISTINCT FROM NEW.ano OR para.criado_em <> now() THEN
      RETURN NULL;
    END IF;
    -- O mesmo vinho: a mesma chave, o mesmo nome e a mesma cor.
    IF de.chave_base IS DISTINCT FROM para.chave_base
       OR lower(de.nome) IS DISTINCT FROM lower(para.nome)
       OR (de.cor IS NOT NULL AND para.cor IS NOT NULL AND de.cor <> para.cor) THEN
      RETURN NULL;
    END IF;
    PERFORM garrafeira.colheita_absorver(de.id, para.id, auth.email(), true);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.vinhos_colheita_nasceu() FROM PUBLIC, anon, authenticated;

-- Dois caminhos até à colheita nascer: o vinho sem ano que o ganha, e o
-- desejo que já tinha a colheita escolhida (o seletor da wishlist, sem
-- fazer nascer linha nenhuma) e passa para a garrafeira.
CREATE OR REPLACE TRIGGER vinhos_colheita_nasceu
  AFTER UPDATE OF ano, desejado ON garrafeira.vinhos
  FOR EACH ROW
  WHEN (NEW.ano IS NOT NULL AND OLD.catalogo_id IS NOT NULL
        AND (OLD.ano IS NULL OR OLD.desejado IS DISTINCT FROM NEW.desejado))
  EXECUTE FUNCTION garrafeira.vinhos_colheita_nasceu();
