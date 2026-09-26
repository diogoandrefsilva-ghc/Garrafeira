-- ════════════════════════════════════════════════════════════════════
-- Migração 18 — o batch do admin corrige links do Vivino nas garrafeiras
-- ════════════════════════════════════════════════════════════════════
-- A WineCatalog tem um script no PC do admin (batch/vivino-verificar.mjs +
-- painel.mjs) que abre as páginas do Vivino e corrige os links do CATÁLOGO.
-- As garrafeiras ficavam de fora: cada um gere a sua, e um link para uma
-- COLHEITA ("…/w/123?year=2019", "/pt/pt/…/w/123") é uma escolha legítima.
-- Mas um link que nem é do Vivino a sério (`/wines/<nº>` é o número de uma
-- colheita, `/Wines/<nome>` não existe — o que as pesquisas de memória
-- escreviam) ou que abre OUTRO vinho não é escolha de ninguém: é um erro, e
-- o catálogo já sabe o certo.
--
-- `links_vivino_rever(p_ids, p_aplicar)` compara cada vinho das garrafeiras
-- com o do catálogo (a MESMA `winecatalog.achar`, sem exigir colheita — o
-- número do Vivino é do vinho, não do ano) e propõe só três casos:
--   · `formato_invalido` — o link da garrafeira não tem `/w/<nº>`;
--   · `outro_vinho`      — tem, mas o número não é o do catálogo;
--   · `vazio`            — a garrafeira não tem link e o catálogo tem.
-- E só quando o link do catálogo está CONFIRMADO: escrito pelo script depois
-- de abrir a página (`vivino-pagina`), à mão pelo admin (`catalogo-admin`),
-- ou com uma verificação aceite do motor browser a dar o mesmo número — e
-- vai sempre na forma do VINHO (`https://www.vivino.com/<nome>/w/<nº>`, sem
-- país, língua nem `?year=`), mesmo que no catálogo ainda esteja por limpar. Um
-- link do catálogo que só veio de uma garrafeira não vale mais do que o da
-- outra garrafeira — esses vão para `por_confirmar` (o id do catálogo, para
-- se verificarem primeiro no Vivino) e não se mexe em nada.
--
-- Nunca se mexe num link com o MESMO número do catálogo (a colheita, o
-- país, a língua ficam como a pessoa os pôs), nem quando a cor da garrafeira
-- e a do catálogo discordam (a cor ainda não está na chave: o "Papa Figos"
-- branco acharia o tinto).
--
-- Só o batch (service_role). O admin vê tudo — vinho, garrafeira, dono,
-- antes e depois: não há segredos numa correção que melhora a informação
-- (decisão do dono das apps, 26/09/2026). Cada correção fica em
-- `garrafeira.sync_log` (origem `winecatalog-batch`), e o `vinhos_catalogo`
-- volta a levar o vinho ao catálogo com o mesmo link — inofensivo.
--
-- `p_aplicar` só com `p_ids` (os escolhidos no painel), e as regras voltam a
-- correr no momento: o que mudou entretanto não se aplica.
--
-- `p_forcar` (26/09/2026, pedido do dono): os "Por confirmar" que o admin
-- ABRIU e aceitou no painel ("usar o do catálogo"). Quem confirma é ele — o
-- visto é a confirmação que faltava. Só vale a aplicar, só para ids que
-- também vão em `p_ids`, e só com o link do catálogo num formato de vinho.
-- O registo diz `confirmado_por: admin`.
-- ════════════════════════════════════════════════════════════════════

-- A assinatura ganhou o `p_forcar`: a antiga sai, senão ficavam as duas.
DROP FUNCTION IF EXISTS garrafeira.links_vivino_rever(bigint[], boolean);

CREATE OR REPLACE FUNCTION garrafeira.links_vivino_rever(
  p_ids bigint[] DEFAULT NULL, p_aplicar boolean DEFAULT false,
  p_forcar bigint[] DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'public'
AS $$
DECLARE
  r        record;
  v_linhas jsonb := '[]';
  v_porc   jsonb := '[]';
  v_n      jsonb := '{}';
  v_feitos int := 0;
  v_forcado boolean;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Só o batch (service_role) chama isto.';
  END IF;
  IF p_aplicar AND p_ids IS NULL THEN
    RAISE EXCEPTION 'Aplicar só aos vinhos escolhidos (p_ids).';
  END IF;

  FOR r IN
    WITH g AS (
      SELECT v.id, v.nome, v.produtor, v.ano, v.tipo, v.garrafeira_id,
             gf.nome AS garrafeira, gf.dono,
             COALESCE(v.vivino_url, '') AS url,
             winecatalog.achar(v.nome, COALESCE(v.produtor, ''), v.ano, false) AS cid
        FROM garrafeira.vinhos v
        JOIN garrafeira.garrafeiras gf ON gf.id = v.garrafeira_id
       WHERE p_ids IS NULL OR v.id = ANY (p_ids)
    ), c AS (
      SELECT g.*, w.nome AS cat_nome, w.ano AS cat_ano, w.ficha ->> 'tipo' AS cat_tipo,
             -- o link do catálogo na forma do VINHO: sem país, língua nem
             -- `?year=` (a mesma regra do `urlLimpo` do script).
             CASE WHEN w.ficha ->> 'vivino_url' ~* '^https?://([a-z]+\.)?vivino\.com/.*/w/[0-9]+'
                  THEN COALESCE('https://www.vivino.com/'
                       || lower(substring(w.ficha ->> 'vivino_url' FROM '/([A-Za-z0-9-]+)/w/[0-9]+'))
                       || '/w/' || substring(w.ficha ->> 'vivino_url' FROM '/w/([0-9]+)'), '')
                  ELSE '' END AS cat_url,
             w.origens -> 'vivino_url' ->> 'o' AS cat_origem,
             substring(g.url FROM '/w/([0-9]+)') AS g_num,
             substring(w.ficha ->> 'vivino_url' FROM '/w/([0-9]+)') AS c_num
        FROM g LEFT JOIN winecatalog.vinhos w ON w.id = g.cid
    )
    SELECT c.*,
      -- dentro de coalesce: um NULL aqui passava pelo `IF NOT` sem entrar.
      COALESCE(c.cat_url ~ '^https://www\.vivino\.com/[a-z0-9-]+/w/[0-9]+$'
       AND (c.cat_origem IN ('vivino-pagina', 'catalogo-admin')
            OR EXISTS (SELECT 1 FROM winecatalog.vivino_verificacoes x
                        WHERE x.vinho_id = c.cid AND x.revisao = 'aceite'
                          AND x.detalhe ->> 'motor' = 'browser'
                          AND substring(x.proposta ->> 'vivino_url' FROM '/w/([0-9]+)') = c.c_num)), false
      ) AS confirmado,
      CASE
        WHEN c.cid IS NULL                          THEN 'sem_catalogo'
        WHEN c.c_num IS NULL                        THEN 'catalogo_sem_link'
        WHEN c.url = ''                             THEN 'vazio'
        WHEN c.url !~* '^https?://([a-z]+\.)?vivino\.com/' OR c.g_num IS NULL
                                                    THEN 'formato_invalido'
        WHEN c.g_num = c.c_num                      THEN 'mesmo_vinho'
        ELSE                                             'outro_vinho'
      END AS caso
    FROM c
    ORDER BY lower(c.nome), c.ano NULLS FIRST, c.id
  LOOP
    IF r.caso IN ('vazio', 'formato_invalido', 'outro_vinho')
       AND COALESCE(r.cat_tipo, '') <> '' AND lower(r.cat_tipo) <> lower(COALESCE(r.tipo, '')) THEN
      v_n := jsonb_set(v_n, '{cor_diferente}', to_jsonb(COALESCE((v_n ->> 'cor_diferente')::int, 0) + 1));
      CONTINUE;
    END IF;
    v_n := jsonb_set(v_n, ARRAY[r.caso], to_jsonb(COALESCE((v_n ->> r.caso)::int, 0) + 1));
    CONTINUE WHEN r.caso NOT IN ('vazio', 'formato_invalido', 'outro_vinho');

    v_forcado := NOT r.confirmado AND p_aplicar AND r.caso <> 'vazio'
                 AND r.id = ANY (COALESCE(p_forcar, ARRAY[]::bigint[]))
                 AND COALESCE(r.cat_url ~ '^https://www\.vivino\.com/[a-z0-9-]+/w/[0-9]+$', false);
    IF NOT r.confirmado AND NOT v_forcado THEN
      -- o `vazio` não é um erro na garrafeira: sem link confirmado, cala-se.
      IF r.caso <> 'vazio' THEN
        v_porc := v_porc || jsonb_build_object(
          'vinho_id', r.id, 'nome', r.nome, 'ano', r.ano, 'garrafeira', r.garrafeira,
          'dono', r.dono, 'antes', r.url, 'catalogo_id', r.cid, 'catalogo_url', r.cat_url,
          'catalogo_origem', r.cat_origem, 'caso', r.caso);
      END IF;
      CONTINUE;
    END IF;

    v_linhas := v_linhas || jsonb_build_object(
      'vinho_id', r.id, 'nome', r.nome, 'produtor', r.produtor, 'ano', r.ano, 'tipo', r.tipo,
      'garrafeira_id', r.garrafeira_id, 'garrafeira', r.garrafeira, 'dono', r.dono,
      'antes', r.url, 'depois', r.cat_url, 'caso', r.caso,
      'catalogo_id', r.cid, 'catalogo_nome', r.cat_nome, 'catalogo_ano', r.cat_ano,
      'catalogo_origem', r.cat_origem);

    IF p_aplicar THEN
      UPDATE garrafeira.vinhos SET vivino_url = r.cat_url
       WHERE id = r.id AND COALESCE(vivino_url, '') = r.url;
      IF FOUND THEN
        v_feitos := v_feitos + 1;
        INSERT INTO garrafeira.sync_log (origem, acao, estado, quem, detalhe)
        VALUES ('winecatalog-batch', 'link_vivino_corrigido', 'ok', 'script no PC (admin)',
                jsonb_build_object('vinho_id', r.id, 'garrafeira_id', r.garrafeira_id,
                                   'antes', r.url, 'depois', r.cat_url, 'caso', r.caso,
                                   'catalogo_id', r.cid,
                                   'confirmado_por', CASE WHEN v_forcado THEN 'admin' ELSE 'catalogo' END));
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('linhas', v_linhas, 'por_confirmar', v_porc,
                            'contagens', v_n, 'aplicados', v_feitos);
END;
$$;

REVOKE ALL ON FUNCTION garrafeira.links_vivino_rever(bigint[], boolean, bigint[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION garrafeira.links_vivino_rever(bigint[], boolean, bigint[]) TO service_role;

-- Confirmar (tem de dar só service_role e o dono):
-- select grantee, privilege_type from information_schema.routine_privileges
--  where routine_schema = 'garrafeira' and routine_name = 'links_vivino_rever';
