-- =====================================================================
-- Migração 30 — que sites deixam ler as páginas (29/09/2026, o dono das
-- apps: "dar um link ao Gemini e dizer 'lê só isto'" é o que traz a
-- informação mais fidedigna — e um site que recusa sempre não vale a pena
-- ser proposto).
--
-- Não há tabela nova: cada procura da `vinho-info` já deixa no
-- `garrafeira.sync_log` o que aconteceu a cada página que tentou abrir
-- (`detalhe.paginas`: site, url, estado `lida` · `recusada` · `vazia` ·
-- `erro`, motivo). Isto só as conta, por site. Contam só as que foram
-- ABERTAS (têm `url`): as `nao_encontrada`/`sem_pesquisa` nunca chegaram a
-- ser pedidas ao site.
--
-- "Não deixa ler" é tudo o que não é `lida` — uma recusa, uma página que
-- vem vazia (montada em JavaScript) e uma que não responde a tempo têm o
-- mesmo efeito prático (o dono das apps: "é como se fosse um Vivino").
--
-- Quem a chama: o "Procurar links" da `vinho-info` (service_role), para
-- dizer ao lado de cada link como o site se tem portado, e o admin em
-- Definições › Diagnóstico. Idempotente.
-- =====================================================================

CREATE OR REPLACE FUNCTION garrafeira.paginas_por_site(p_dias integer DEFAULT 60)
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = garrafeira, public
AS $$
BEGIN
  IF NOT (COALESCE(auth.role(), '') = 'service_role' OR garrafeira.is_admin()) THEN
    RAISE EXCEPTION 'Só o admin (ou a vinho-info) vê isto.';
  END IF;
  RETURN COALESCE((
    WITH p AS (
      SELECT s.criado_em, e->>'site' AS site, e->>'estado' AS estado, NULLIF(e->>'motivo', '') AS motivo
        FROM garrafeira.sync_log s, jsonb_array_elements(s.detalhe->'paginas') e
       WHERE s.acao = 'vinho-info'
         AND s.criado_em >= now() - make_interval(days => GREATEST(COALESCE(p_dias, 60), 1))
         AND jsonb_typeof(s.detalhe->'paginas') = 'array'
         AND COALESCE(e->>'url', '') <> '' AND COALESCE(e->>'site', '') <> ''
    ), m AS (
      SELECT DISTINCT ON (site) site, motivo
        FROM p WHERE estado <> 'lida' AND motivo IS NOT NULL
       GROUP BY site, motivo ORDER BY site, count(*) DESC
    )
    SELECT jsonb_agg(jsonb_build_object(
             'site', g.site, 'tentativas', g.tentativas, 'lidas', g.lidas,
             'recusadas', g.recusadas, 'vazias', g.vazias, 'erros', g.erros,
             'ultima', g.ultima, 'motivo', m.motivo)
           ORDER BY g.tentativas DESC, g.site)
      FROM (SELECT site, count(*) AS tentativas,
                   count(*) FILTER (WHERE estado = 'lida') AS lidas,
                   count(*) FILTER (WHERE estado = 'recusada') AS recusadas,
                   count(*) FILTER (WHERE estado = 'vazia') AS vazias,
                   count(*) FILTER (WHERE estado NOT IN ('lida', 'recusada', 'vazia')) AS erros,
                   max(criado_em) AS ultima
              FROM p GROUP BY site) g
      LEFT JOIN m USING (site)
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION garrafeira.paginas_por_site(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.paginas_por_site(integer) TO authenticated, service_role;

-- Confirmar (tem de dar só authenticated, service_role e o dono):
--   SELECT grantee, privilege_type FROM information_schema.routine_privileges
--    WHERE routine_schema = 'garrafeira' AND routine_name = 'paginas_por_site';
