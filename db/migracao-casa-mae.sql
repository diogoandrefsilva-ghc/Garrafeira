-- ════════════════════════════════════════════════════════════════════════
-- Migração 43 — a CASA-MÃE de um produtor (05/10/2026)
-- ════════════════════════════════════════════════════════════════════════
-- O dono das apps: "criar o conceito de Casa-mãe do Produtor (tipo o Grupo —
-- Sogrape, Real Companhia Velha). Seria um atributo do produtor e não do
-- vinho … gerido através do menu de Produtores."
--
-- Mexe no schema `winecatalog` (é lá que vivem os produtores oficiais), por
-- isso a fonte de verdade devia ser o repo da WineCatalog — está aqui porque
-- o Backoffice já vive na Garrafeira e a WineCatalog vai ser fundida nela.
--
-- Regras:
-- - É do PRODUTOR, nunca do vinho: o vinho chega à casa-mãe pelo produtor.
--   Mudar o grupo de uma casa muda-o em todos os vinhos de uma vez, no
--   catálogo e nas garrafeiras, sem escrever numa linha de `vinhos`.
-- - UM nível: uma casa-mãe não tem casa-mãe, e quem é casa-mãe de alguém não
--   pode passar a ter uma. Grupos de grupos não acrescentam nada e davam
--   ciclos.
-- - Uma casa-mãe é um produtor oficial como os outros: pode ter vinhos com o
--   nome dela (Real Companhia Velha) ou nenhum (Sogrape).
-- - Só o admin do catálogo (`produtores_autorizado`). Quem lê o mapa
--   produtor → casa-mãe é toda a gente com sessão (`produtores_casas`), como
--   o nome completo (`produtores_completos`).
-- Corre no SQL Editor depois de tudo o resto; é idempotente.

ALTER TABLE winecatalog.produtores
  ADD COLUMN IF NOT EXISTS casa_mae_id bigint REFERENCES winecatalog.produtores(id) ON DELETE SET NULL;
DO $$ BEGIN
  ALTER TABLE winecatalog.produtores ADD CONSTRAINT produtores_casa_mae_outra CHECK (casa_mae_id IS DISTINCT FROM id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS produtores_casa_mae_idx ON winecatalog.produtores (casa_mae_id);

-- Definir (ou tirar, com p_mae NULL) a casa-mãe de um produtor.
CREATE OR REPLACE FUNCTION winecatalog.produtor_casa_mae(p_id bigint, p_mae bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'winecatalog', 'public' AS $$
DECLARE
  v_nome text; v_mae text; v_avo bigint; v_filhos text;
BEGIN
  IF NOT winecatalog.produtores_autorizado() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  SELECT nome INTO v_nome FROM winecatalog.produtores WHERE id = p_id;
  IF v_nome IS NULL THEN RAISE EXCEPTION 'Produtor não encontrado.'; END IF;
  IF p_mae IS NOT NULL THEN
    IF p_mae = p_id THEN RAISE EXCEPTION 'Um produtor não é a casa-mãe de si próprio.'; END IF;
    SELECT nome, casa_mae_id INTO v_mae, v_avo FROM winecatalog.produtores WHERE id = p_mae;
    IF v_mae IS NULL THEN RAISE EXCEPTION 'Casa-mãe não encontrada.'; END IF;
    IF v_avo IS NOT NULL THEN
      RAISE EXCEPTION '"%" já pertence a "%" — uma casa-mãe não tem casa-mãe.',
        v_mae, (SELECT nome FROM winecatalog.produtores WHERE id = v_avo);
    END IF;
    SELECT string_agg(nome, ', ' ORDER BY nome) INTO v_filhos FROM winecatalog.produtores WHERE casa_mae_id = p_id;
    IF v_filhos IS NOT NULL THEN
      RAISE EXCEPTION '"%" já é casa-mãe de % — não pode ter casa-mãe.', v_nome, v_filhos;
    END IF;
  END IF;
  UPDATE winecatalog.produtores SET casa_mae_id = p_mae WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'casa_mae_id', p_mae, 'casa_mae', v_mae);
END $$;
REVOKE ALL ON FUNCTION winecatalog.produtor_casa_mae(bigint, bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION winecatalog.produtor_casa_mae(bigint, bigint) TO authenticated;

-- Produtor oficial → casa-mãe, para a ficha do vinho, a grelha e a procura.
CREATE OR REPLACE FUNCTION winecatalog.produtores_casas()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'winecatalog', 'public' AS $$
  SELECT COALESCE(jsonb_object_agg(p.nome, m.nome), '{}'::jsonb)
    FROM winecatalog.produtores p JOIN winecatalog.produtores m ON m.id = p.casa_mae_id;
$$;
REVOKE ALL ON FUNCTION winecatalog.produtores_casas() FROM public, anon;
GRANT EXECUTE ON FUNCTION winecatalog.produtores_casas() TO authenticated;

-- A lista do Backoffice passa a dizer a casa-mãe e quantas casas tem cada um.
CREATE OR REPLACE FUNCTION winecatalog.produtores_listar()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'winecatalog', 'public' AS $function$
BEGIN
  IF NOT winecatalog.produtores_autorizado() THEN
    RAISE EXCEPTION 'Só o admin do catálogo.';
  END IF;
  RETURN (
    WITH n AS MATERIALIZED (
      SELECT x.chave, sum(x.n_catalogo) AS c, sum(x.n_garrafeiras) AS g
        FROM winecatalog.produtores_grafias() x GROUP BY x.chave
    ), o AS MATERIALIZED (
      SELECT p.*, winecatalog.chave_produtor(p.nome) AS k FROM winecatalog.produtores p
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', o.id, 'nome', o.nome, 'nome_completo', o.nome_completo, 'criado_em', o.criado_em,
             'chave', o.k,
             'casa_mae_id', o.casa_mae_id,
             'casa_mae', (SELECT m.nome FROM winecatalog.produtores m WHERE m.id = o.casa_mae_id),
             'casas', (SELECT COALESCE(jsonb_agg(f.nome ORDER BY lower(f.nome)), '[]'::jsonb)
                         FROM winecatalog.produtores f WHERE f.casa_mae_id = o.id),
             'no_nome', EXISTS (SELECT 1 FROM winecatalog.produtores_no_nome m WHERE m.chave = o.k),
             'catalogo', (SELECT COALESCE(sum(n.c), 0) FROM winecatalog.produtor_variantes v
                            JOIN n ON n.chave = v.chave WHERE v.produtor_id = o.id),
             'garrafeiras', (SELECT COALESCE(sum(n.g), 0) FROM winecatalog.produtor_variantes v
                               JOIN n ON n.chave = v.chave WHERE v.produtor_id = o.id),
             'variantes', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                     'chave', v.chave, 'escrito', v.escrito, 'oficial', v.chave = o.k,
                                     'escritos', to_jsonb(CASE WHEN cardinality(v.escritos) > 0 THEN v.escritos
                                                               ELSE ARRAY[v.escrito] END))
                                   ORDER BY v.chave = o.k DESC, lower(v.escrito)), '[]'::jsonb)
                             FROM winecatalog.produtor_variantes v WHERE v.produtor_id = o.id))
           ORDER BY lower(o.nome)), '[]'::jsonb)
      FROM o
  );
END;
$function$;
