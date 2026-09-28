-- =====================================================================
-- Migração 26 — comentários sobre um vinho e sugestões (28/09/2026, pedido
-- do dono das apps).
--
-- Corre DEPOIS do `db/comentarios.sql` do repo WineCatalog (a tabela e as
-- funções vivem no catálogo: quem as lê é o admin do catálogo, em Alertas e
-- no painel do PC). Isto são só as portas por onde a Garrafeira escreve e
-- lê — o mesmo desenho da `reportar_ao_catalogo` (catalogo-partilhado.sql).
--
--   · `comentar_vinho` — "há atributos errados", "atualizem a partir deste
--     site", "outro problema". O guarda é `pode_ver`, como no reportar: quem
--     vê um vinho (a sua garrafeira, ou uma emprestada) pode avisar de um
--     erro. Os valores dos campos de que se queixa saem da BD (a mesma
--     `ficha_catalogo`, mais nome/produtor/ano), não de uma caixa de texto;
--   · `sugerir` — uma ideia ou algo que não funciona, sem vinho;
--   · `meus_comentarios` — o que escrevi, com o estado e a resposta do admin.
--
-- Nada disto leva as notas pessoais, o preço de compra, o lugar nem a
-- fotografia: a `ficha_catalogo` não os tem, e é só dela que os valores saem.
-- =====================================================================

CREATE OR REPLACE FUNCTION garrafeira.comentar_vinho(
  p_vinho_id bigint, p_motivo text, p_texto text,
  p_campos text[] DEFAULT NULL, p_link text DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v        garrafeira.vinhos%ROWTYPE;
  v_campos text[];
  v_fic    jsonb;
  v_deles  jsonb;
BEGIN
  SELECT * INTO v FROM garrafeira.vinhos WHERE id = p_vinho_id;
  IF v.id IS NULL THEN RAISE EXCEPTION 'Vinho não encontrado.'; END IF;
  IF NOT garrafeira.pode_ver(v.garrafeira_id) THEN
    RAISE EXCEPTION 'Sem acesso a este vinho.';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT c), '{}') INTO v_campos
    FROM unnest(COALESCE(p_campos, '{}'::text[])) c
   WHERE c ~ '^[a-z_]{2,30}$';

  -- O que ESTÁ na garrafeira para esses campos: a ficha que atravessa para
  -- o catálogo, mais a identidade (que não atravessa — é por ela que se
  -- acha a linha — mas pode ser justamente o que está mal).
  IF cardinality(v_campos) > 0 THEN
    v_fic := COALESCE(garrafeira.ficha_catalogo(v.id), '{}'::jsonb)
             || jsonb_build_object('nome', v.nome, 'produtor', v.produtor, 'ano', v.ano);
    SELECT jsonb_object_agg(c, v_fic -> c) INTO v_deles FROM unnest(v_campos) c;
  END IF;

  RETURN winecatalog.comentar(
    'vinho', p_motivo, p_texto,
    v.nome, COALESCE(v.produtor, ''), v.ano, v.tipo,
    v_campos, v_deles, p_link, 'garrafeira');
END;
$$;

CREATE OR REPLACE FUNCTION garrafeira.sugerir(p_motivo text, p_texto text)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
BEGIN
  IF NOT garrafeira.is_allowed() THEN
    RAISE EXCEPTION 'Sem acesso à app.';
  END IF;
  RETURN winecatalog.comentar('sugestao', p_motivo, p_texto,
                              p_app => 'garrafeira');
END;
$$;

CREATE OR REPLACE FUNCTION garrafeira.meus_comentarios()
  RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
BEGIN
  IF NOT garrafeira.is_allowed() THEN RETURN '[]'::jsonb; END IF;
  -- O catálogo pode não responder (uma base montada só com este repo): não
  -- é um erro para quem abre as Definições, é não haver nada para mostrar.
  BEGIN
    RETURN winecatalog.meus_comentarios(50);
  EXCEPTION WHEN OTHERS THEN
    RETURN '[]'::jsonb;
  END;
END;
$$;

-- ---------------------------------------------------------------------
-- A CONVERSA (28/09/2026): o admin pode devolver uma dúvida em vez de
-- fechar, e quem escreveu responde daqui. As três são só a porta: a regra
-- (só a própria pessoa, a trava, o estado que volta a `aberto`) vive na
-- `winecatalog.comentario_do_autor` e irmãs, no db/comentarios.sql.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.comentario_responder(p_id bigint, p_texto text)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
BEGIN
  IF NOT garrafeira.is_allowed() THEN RAISE EXCEPTION 'Sem acesso à app.'; END IF;
  RETURN winecatalog.comentario_do_autor(p_id, p_texto);
END;
$$;

CREATE OR REPLACE FUNCTION garrafeira.comentarios_lidos()
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
BEGIN
  IF NOT garrafeira.is_allowed() THEN RETURN 0; END IF;
  RETURN winecatalog.comentarios_marcar_lidos();
END;
$$;

-- À entrada da app: o que há por ler, as dúvidas à espera e (ao admin do
-- catálogo) o que está por tratar. Nunca um erro — no pior caso, zeros.
CREATE OR REPLACE FUNCTION garrafeira.comentarios_avisos()
  RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
BEGIN
  IF NOT garrafeira.is_allowed() THEN RETURN jsonb_build_object('porLer', 0, 'duvidas', 0); END IF;
  BEGIN
    RETURN winecatalog.meus_avisos();
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('porLer', 0, 'duvidas', 0);
  END;
END;
$$;

-- GRANTs nomeados (ver o porquê no fim do catalogo-partilhado.sql). Cada uma
-- confirma lá dentro quem é (`pode_ver`/`is_allowed`).
REVOKE ALL ON FUNCTION garrafeira.comentar_vinho(bigint, text, text, text[], text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION garrafeira.sugerir(text, text)                              FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION garrafeira.meus_comentarios()                               FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION garrafeira.comentario_responder(bigint, text)              FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION garrafeira.comentarios_lidos()                              FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION garrafeira.comentarios_avisos()                             FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.comentar_vinho(bigint, text, text, text[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION garrafeira.sugerir(text, text)                              TO authenticated;
GRANT EXECUTE ON FUNCTION garrafeira.meus_comentarios()                               TO authenticated;
GRANT EXECUTE ON FUNCTION garrafeira.comentario_responder(bigint, text)              TO authenticated;
GRANT EXECUTE ON FUNCTION garrafeira.comentarios_lidos()                              TO authenticated;
GRANT EXECUTE ON FUNCTION garrafeira.comentarios_avisos()                             TO authenticated;
