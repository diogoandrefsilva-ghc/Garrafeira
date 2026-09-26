-- ════════════════════════════════════════════════════════════════════
-- Migração 19 — o batch do admin acerta as fichas das garrafeiras pelo catálogo
-- ════════════════════════════════════════════════════════════════════
-- A irmã da 18 (`migracao-links-vivino.sql`), para o resto da ficha. Cada
-- pessoa já podia trazer do catálogo, campo a campo, para um vinho seu
-- (`aplicar_do_catalogo`, o "≠ catálogo" da ficha). Isto é a mesma coisa
-- vista de cima: todas as garrafeiras de uma vez, no painel do batch da
-- WineCatalog, no PC do admin (service_role).
--
-- `fichas_catalogo_rever(p_itens, p_aplicar)` compara cada vinho com o
-- catálogo pela MESMA `winecatalog.comparar` do botão da app, e propõe:
--   · `vazio`         — o campo está vazio na garrafeira e o catálogo tem-no;
--   · `mais_recente`  — os dois têm valor, diferente, e o do catálogo é mais
--                       recente do que a última vez que o dono gravou este
--                       vinho (`criado_em`/`atualizado_em`/`ai_atualizado_em`
--                       — a garrafeira não tem data por campo, e este é o
--                       único sinal honesto que há: se o dono mexeu depois,
--                       fica o dele).
-- Regras que não se discutem (decididas com o dono das apps, 26/09/2026):
--   · SÓ A MESMA COLHEITA (`mesmaColheita` da `comparar`), vazios incluídos;
--   · a COR não se toca, e um vinho com cor diferente da do catálogo não se
--     toca de todo: cor diferente é outro vinho (o Papa Figos branco não é
--     o tinto). Conta em `cor_diferente`;
--   · o link do Vivino é da 18 (tem regras próprias: confirmado, colheita);
--   · a imagem não se toca quando a pessoa tem fotografia SUA (`imagem_path`);
--   · as notas pessoais, o preço de compra e o lugar nem vão ao catálogo
--     (não estão na `ficha_catalogo`), por isso nem entram na conversa.
--
-- Escreve pela `escrever_do_catalogo` (a MESMA do botão da app), sem
-- carimbar `atualizado_em` — não foi o dono a mexer. `p_aplicar` só com
-- `p_itens` = [{vinho_id, campos:[…]}], os vistos do painel, e as regras
-- voltam a correr no momento: o que deixou de se aplicar não se aplica.
-- Cada vinho corrigido fica em `garrafeira.sync_log` (origem
-- `winecatalog-batch`, com o antes e o depois de cada campo).
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION garrafeira.fichas_catalogo_rever(
  p_itens jsonb DEFAULT NULL, p_aplicar boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
DECLARE
  -- Os campos que este batch pode trazer. Fora: `tipo` (a cor), `vivino_url`
  -- (migração 18) e a identidade/`precos`, que a `comparar` também devolve.
  c_campos CONSTANT text[] := ARRAY['estilo','mencao','classificacao','regiao',
    'sub_regiao','pais','teor','estagio_meses','estagio_texto','castas',
    'vivino_nota','vivino_avaliacoes','vivino_nota_global','vivino_avaliacoes_global',
    'imagem_url','preco_medio','beber_de',
    'beber_ate','notas_prova','harmonizacao','ai_resumo'];
  r        record;
  e        jsonb;
  k        text;
  v_cmp    jsonb;
  v_caso   text;
  v_pedidos text[];
  v_campos jsonb;
  v_cat    jsonb;
  v_linhas jsonb := '[]';
  v_n      jsonb := '{}';
  v_feitos int := 0;
  v_vinhos int := 0;
  v_erros  jsonb := '[]';
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Só o batch (service_role) chama isto.';
  END IF;
  IF p_aplicar AND (p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array') THEN
    RAISE EXCEPTION 'Aplicar só aos campos escolhidos (p_itens).';
  END IF;

  FOR r IN
    SELECT v.id, v.nome, v.produtor, v.ano, v.tipo, v.garrafeira_id,
           COALESCE(v.imagem_path, '') <> '' AS foto_propria,
           greatest(v.criado_em, v.atualizado_em, COALESCE(v.ai_atualizado_em, v.criado_em)) AS mexido,
           gf.nome AS garrafeira, gf.dono
      FROM garrafeira.vinhos v
      JOIN garrafeira.garrafeiras gf ON gf.id = v.garrafeira_id
     WHERE p_itens IS NULL
        OR v.id IN (SELECT (x ->> 'vinho_id')::bigint FROM jsonb_array_elements(p_itens) x)
     ORDER BY lower(v.nome), v.ano NULLS FIRST, v.id
  LOOP
    BEGIN
      v_cmp := winecatalog.comparar(r.nome, COALESCE(r.produtor, ''), r.ano,
                                    garrafeira.ficha_catalogo(r.id));
    EXCEPTION WHEN OTHERS THEN
      v_cmp := NULL;
    END;
    IF v_cmp IS NULL OR NOT COALESCE((v_cmp ->> 'encontrado')::boolean, false) THEN
      v_n := jsonb_set(v_n, '{sem_catalogo}', to_jsonb(COALESCE((v_n ->> 'sem_catalogo')::int, 0) + 1));
      CONTINUE;
    END IF;
    IF NOT COALESCE((v_cmp ->> 'mesmaColheita')::boolean, false) THEN
      v_n := jsonb_set(v_n, '{outra_colheita}', to_jsonb(COALESCE((v_n ->> 'outra_colheita')::int, 0) + 1));
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_cmp -> 'campos') x
                WHERE x ->> 'campo' = 'tipo' AND COALESCE((x ->> 'difere')::boolean, false)) THEN
      v_n := jsonb_set(v_n, '{cor_diferente}', to_jsonb(COALESCE((v_n ->> 'cor_diferente')::int, 0) + 1));
      CONTINUE;
    END IF;

    v_pedidos := NULL;
    IF p_aplicar THEN
      SELECT COALESCE(array_agg(c #>> '{}'), ARRAY[]::text[]) INTO v_pedidos
        FROM jsonb_array_elements(p_itens) x, jsonb_array_elements(COALESCE(x -> 'campos', '[]')) c
       WHERE (x ->> 'vinho_id')::bigint = r.id;
    END IF;

    v_campos := '[]'; v_cat := '{}';
    FOR e IN SELECT jsonb_array_elements(v_cmp -> 'campos') LOOP
      k := e ->> 'campo';
      CONTINUE WHEN NOT k = ANY (c_campos);
      CONTINUE WHEN k = 'imagem_url' AND r.foto_propria;
      CONTINUE WHEN (e -> 'catalogo') IS NULL OR jsonb_typeof(e -> 'catalogo') = 'null';
      -- dentro de coalesce: um NULL (sem data no `origens`) não pode passar.
      IF COALESCE((e ->> 'soCatalogo')::boolean, false) THEN
        v_caso := 'vazio';
      ELSIF COALESCE((e ->> 'difere')::boolean AND (e ->> 'em')::timestamptz > r.mexido, false) THEN
        v_caso := 'mais_recente';
      ELSE
        CONTINUE;
      END IF;
      CONTINUE WHEN p_aplicar AND NOT k = ANY (v_pedidos);
      v_campos := v_campos || jsonb_build_object('campo', k, 'antes', e -> 'meu',
        'depois', e -> 'catalogo', 'caso', v_caso, 'origem', e ->> 'origem', 'em', e ->> 'em');
      v_cat := v_cat || jsonb_build_object(k, e -> 'catalogo');
    END LOOP;
    CONTINUE WHEN jsonb_array_length(v_campos) = 0;

    v_linhas := v_linhas || jsonb_build_object(
      'vinho_id', r.id, 'nome', r.nome, 'produtor', r.produtor, 'ano', r.ano, 'tipo', r.tipo,
      'garrafeira_id', r.garrafeira_id, 'garrafeira', r.garrafeira, 'dono', r.dono,
      'catalogo_id', v_cmp -> 'id', 'campos', v_campos);

    IF p_aplicar THEN
      -- Um vinho de cada vez: um valor que a coluna recuse desfaz só esse
      -- vinho, e o painel diz qual — os outros gravam na mesma.
      BEGIN
        PERFORM garrafeira.escrever_do_catalogo(r.id, v_cat, false);
        v_feitos := v_feitos + jsonb_array_length(v_campos);
        v_vinhos := v_vinhos + 1;
        INSERT INTO garrafeira.sync_log (origem, acao, estado, quem, detalhe)
        VALUES ('winecatalog-batch', 'ficha_do_catalogo', 'ok', 'script no PC (admin)',
                jsonb_build_object('vinho_id', r.id, 'garrafeira_id', r.garrafeira_id,
                                   'catalogo_id', v_cmp -> 'id', 'campos', v_campos));
      EXCEPTION WHEN OTHERS THEN
        v_erros := v_erros || jsonb_build_object('vinho_id', r.id, 'nome', r.nome, 'erro', SQLERRM);
      END;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('linhas', v_linhas, 'contagens', v_n,
                            'aplicados', v_feitos, 'vinhos_aplicados', v_vinhos,
                            'erros', v_erros);
END;
$$;

REVOKE ALL ON FUNCTION garrafeira.fichas_catalogo_rever(jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION garrafeira.fichas_catalogo_rever(jsonb, boolean) TO service_role;

-- Confirmar (tem de dar só service_role e o dono; e a escrever_do_catalogo
-- só o dono):
-- select routine_name, grantee from information_schema.routine_privileges
--  where routine_schema = 'garrafeira'
--    and routine_name in ('fichas_catalogo_rever', 'escrever_do_catalogo');
