-- =====================================================================
-- Migração 29 — a WISHLIST também alimenta o catálogo (28/09/2026, o dono
-- das apps: "wishlist não preenche o Catálogo? tem que preencher!")
--
-- A migração 15 deixou a wishlist de fora ("quem a escreveu não tem a
-- garrafa na mão, e o catálogo dar-lhe-ia essa força"), e a `vinho-info`
-- adia a escrita de um vinho novo com um nome que o catálogo não conhece
-- ("entra quando for gravado, pelo trigger"). Somadas, um desejo procurado
-- com IA nunca chegava ao catálogo: a IA não escrevia porque o trigger ia
-- escrever, e o trigger não escrevia porque era um desejo. A razão da 15
-- continua certa — é a FORÇA que estava errada, não a porta fechada:
--
-- 1. O desejo escreve com a origem `garrafeira-desejo`, que vale **1** em
--    todos os campos (`winecatalog.forca`, `catalogo.sql` da WineCatalog —
--    corre ANTES disto; sem ela a força é 0 e a `juntar` não escreve nada).
--    Enche o que está vazio e perde para qualquer coisa a sério: uma
--    garrafeira com a garrafa na mão, uma pesquisa, o admin. Quando o desejo
--    passa para a garrafeira, o UPDATE volta a disparar o trigger e a
--    `garrafeira`/`garrafeira-bruto` passam-lhe por cima.
-- 2. Um desejo NUNCA faz nascer uma segunda linha de um vinho que o catálogo
--    já tem. Escreve na linha a que está ligado (ou, sem ligação, na que a
--    `achar` der: a mesma colheita primeiro, senão qualquer uma), com o nome
--    e o produtor dela. Se a colheita não for a mesma — ou um dos dois não a
--    tiver (quase metade da wishlist não tem) —, só os factos ESTÁVEIS: nada
--    da `winecatalog.da_colheita` (a nota e as avaliações da colheita, o
--    preço, a janela), que são de UMA colheita. A nota de todas as colheitas
--    passa (é do vinho). Um vinho normal, com a garrafa na mão, faz nascer a
--    linha da sua colheita; um desejo não tem força para isso.
-- 3. Só quando o catálogo não conhece o vinho em colheita nenhuma é que o
--    desejo faz nascer a linha, pela `juntar` (com a colheita do desejo, se a
--    tiver). O nome é o que a pessoa GRAVOU: é por isso que a `vinho-info`
--    esperava pelo trigger (o "Cristo vinhas velhas").
--
-- Correr DEPOIS do `catalogo.sql` e do `historico.sql` da WineCatalog com a
-- `garrafeira-desejo` (28/09/2026). Substitui a `catalogar_e_ligar` da
-- migração 28. Idempotente.
-- =====================================================================

CREATE OR REPLACE FUNCTION garrafeira.catalogar_e_ligar(p_vinho_id bigint, p_religar boolean DEFAULT false)
  RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v        garrafeira.vinhos%ROWTYPE;
  c        winecatalog.vinhos%ROWTYPE;
  v_idt    jsonb;
  v_ficha  jsonb;
  v_castas integer;
  v_curado boolean;
  v_origem text;
  v_nome   text;
  v_prod   text;
  v_ano    integer;
  v_id     bigint;
  k        text;
BEGIN
  SELECT * INTO v FROM garrafeira.vinhos WHERE id = p_vinho_id;
  IF v.id IS NULL OR COALESCE(v.nome, '') = '' THEN RETURN NULL; END IF;

  -- A linha ligada, com o `alias` resolvido.
  IF NOT p_religar AND v.catalogo_id IS NOT NULL THEN
    SELECT w.* INTO c FROM winecatalog.vinhos w
     WHERE w.id = COALESCE((SELECT a.id_para FROM winecatalog.alias a WHERE a.id_de = v.catalogo_id),
                           v.catalogo_id);
  END IF;
  -- Um desejo sem linha: a que a `achar` der, a mesma colheita primeiro e
  -- senão qualquer uma (a mesma pergunta da ligação à entrada), antes de a
  -- `juntar` fazer nascer outra linha de um vinho que o catálogo já tem.
  IF v.desejado AND c.id IS NULL THEN
    SELECT w.* INTO c FROM winecatalog.vinhos w WHERE w.id = garrafeira.achar_no_catalogo(v.id);
  END IF;

  v_ficha := garrafeira.ficha_catalogo(v.id);
  IF v_ficha IS NULL THEN RETURN NULL; END IF;
  v_castas := COALESCE(jsonb_array_length(v_ficha -> 'castas'), 0);

  -- Um vinho a que ninguém tocou vale menos do que uma pesquisa (ver
  -- `catalogo-partilhado.sql`): o `tipo` nasce 'Tinto' por omissão nesta app.
  v_curado := v.ai_atualizado_em IS NOT NULL
              OR v_castas > 0
              OR v.vivino_nota IS NOT NULL
              OR v.vivino_nota_global IS NOT NULL
              OR v.preco_medio IS NOT NULL
              OR (COALESCE(v.regiao,'') <> '' AND COALESCE(v.produtor,'') <> '');
  -- A wishlist: sem a garrafa na mão, 1 em tudo (ver o cabeçalho).
  v_origem := CASE WHEN v.desejado THEN 'garrafeira-desejo'
                   WHEN v_curado   THEN 'garrafeira'
                   ELSE 'garrafeira-bruto' END;

  v_nome := v.nome;
  v_prod := COALESCE(v.produtor, '');
  v_ano  := v.ano;
  IF c.id IS NOT NULL AND (c.ano IS NOT DISTINCT FROM v.ano OR v.desejado) THEN
    v_idt := winecatalog.identidade(c.nome, COALESCE(NULLIF(c.produtor, ''), v_prod), c.ano, v.tipo, true);
    IF winecatalog.achar(v_idt ->> 'nome', v_idt ->> 'produtor', (v_idt ->> 'ano')::integer,
                         true, NULL, v_idt ->> 'cor') = c.id THEN
      v_nome := c.nome;
      v_prod := COALESCE(NULLIF(c.produtor, ''), v_prod);
      -- O desejo noutra colheita (ou sem ela): só o que é do VINHO.
      IF c.ano IS DISTINCT FROM v.ano THEN
        v_ano := c.ano;
        FOR k IN SELECT jsonb_object_keys(v_ficha) LOOP
          IF winecatalog.da_colheita(k) THEN v_ficha := v_ficha - k; END IF;
        END LOOP;
      END IF;
    END IF;
  END IF;

  v_id := winecatalog.juntar(
    v_nome, v_prod, v_ano, v_ficha, v_origem,
    CASE WHEN jsonb_typeof(v.ai_fontes) = 'array' THEN v.ai_fontes ELSE '[]'::jsonb END
  );
  -- Mudada a identidade e sem linha nenhuma, a ligação antiga era de OUTRO
  -- vinho: sai. Sem a identidade mudada, um "não sei" não desfaz a ligação.
  IF v_id IS NOT NULL OR p_religar THEN
    PERFORM garrafeira.ligar_catalogo(v.id, v_id);
  END IF;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION garrafeira.catalogar_e_ligar(bigint, boolean) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- Os desejos que já cá estão. Um de cada vez, e um que falhe não trava os
-- outros (a mesma regra do trigger: alimentar o catálogo é um extra).
-- Não mexe em nada da garrafeira além da ligação: a `juntar` escreve só no
-- catálogo, e o `atualizado_em` não é carimbado.
-- ---------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  -- o "quem" das linhas que nascem aqui (os campos dizem "uma garrafeira")
  PERFORM set_config('winecatalog.quem', 'migração 29 (a wishlist no catálogo)', true);
  FOR r IN SELECT id FROM garrafeira.vinhos WHERE desejado ORDER BY id LOOP
    BEGIN
      PERFORM garrafeira.catalogar_e_ligar(r.id, false);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'desejo %: %', r.id, SQLERRM;
    END;
  END LOOP;
END $$;
