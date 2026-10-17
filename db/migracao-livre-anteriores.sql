-- =====================================================================
-- Migração 58 — os pedidos anteriores da pergunta livre (17/10/2026)
--
-- O dono das apps: "corri uma sugestão para Fraldinha e não vejo
-- guardada". Estava guardada — `garrafeira.livre_pedidos` #9, com a foto,
-- os veredictos e os dois recomendados —, mas a pergunta livre não tinha
-- lista de anteriores: a app só sabia do pedido que estava no ecrã (e as
-- "Cartas anteriores" são só as cartas). As tabelas da pergunta livre não
-- se leem pela API (RLS sem policies, migração 54), e por isso a lista vem
-- de uma função.
--
-- `garrafeira.livre_meus(p_limite)` — os MEUS pedidos (o `quem` é o email de
-- quem perguntou), do mais recente para o mais antigo: o prato, o preço, se
-- teve fotografia (e quantos vinhos se leram nela), o estado e o primeiro
-- recomendado (o nome como o Catálogo o escreve, quando o tem). Mesmo ao
-- admin, só os dele — como as cartas. Abrir um é a `livre_ler` de sempre.
-- Um pedido respondido pela memória (o mesmo prato, preço e observações de
-- outra pessoa, há menos de uma semana) é de quem o fez primeiro.
--
-- Corre depois da 56. Idempotente.
-- =====================================================================

CREATE INDEX IF NOT EXISTS livre_pedidos_quem ON garrafeira.livre_pedidos (quem, criado_em DESC);

CREATE OR REPLACE FUNCTION garrafeira.livre_meus(p_limite integer DEFAULT 30)
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = garrafeira, winecatalog, public
AS $$
BEGIN
  IF NOT garrafeira.is_allowed() THEN RAISE EXCEPTION 'Sem acesso.'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'id', p.id, 'prato', p.prato, 'preco_min', p.preco_min, 'preco_max', p.preco_max,
             'criado_em', p.criado_em, 'estado', p.estado, 'erro', p.erro,
             'foto', p.foto IS NOT NULL,
             'lidos', CASE WHEN jsonb_typeof(p.foto -> 'vinhos') = 'array' THEN jsonb_array_length(p.foto -> 'vinhos') END,
             'n', CASE WHEN jsonb_typeof(p.sugestoes) = 'array' THEN jsonb_array_length(p.sugestoes) ELSE 0 END,
             'top', t.nome, 'top_combina', t.combina)
           ORDER BY p.criado_em DESC)
      FROM (SELECT * FROM garrafeira.livre_pedidos
             WHERE lower(quem) = lower(COALESCE(auth.email(), ''))
             ORDER BY criado_em DESC
             LIMIT LEAST(GREATEST(COALESCE(p_limite, 30), 1), 100)) p
      LEFT JOIN LATERAL (
        SELECT COALESCE(w.nome, l.nome) AS nome, p.sugestoes -> 0 ->> 'combina' AS combina
          FROM garrafeira.livre_vinhos l
          LEFT JOIN winecatalog.vinhos w ON w.id = l.catalogo_id
         WHERE jsonb_typeof(p.sugestoes) = 'array'
           AND (p.sugestoes -> 0 ->> 'v') ~ '^\d+$'
           AND l.id = (p.sugestoes -> 0 ->> 'v')::bigint
      ) t ON true
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.livre_meus(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.livre_meus(integer) TO authenticated;
