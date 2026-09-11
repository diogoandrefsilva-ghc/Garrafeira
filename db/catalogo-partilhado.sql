-- =====================================================================
-- Garrafeira — O GANCHO PARA O CATÁLOGO (migração 12)
--
-- ⚠ ESTE FICHEIRO JÁ NÃO DEFINE O CATÁLOGO.
--
-- Até setembro de 2026 era aqui que vivia o schema `catalogo` inteiro: a
-- tabela `vinhos`, a chave, a força, e as três funções que as Edge
-- Functions chamam. Isso mudou. **A fonte de verdade do catálogo é agora
-- `db/catalogo.sql` no repo WineCatalog**, e o schema chama-se
-- `winecatalog`.
--
-- PORQUÊ. O catálogo nasceu num schema só dele porque não era de nenhuma
-- das duas apps que o liam, e pendurá-lo numa delas era dar a uma a chave
-- da casa da outra. Só que a DEFINIÇÃO dele ficou na mesma dentro deste
-- repo — ou seja, dentro de uma das consumidoras — e sem ecrã nenhum onde
-- se visse o que lá está. Passou a haver uma app própria (a WineCatalog),
-- com o seu admin (`winecatalog.config.admin_email`, que NÃO é o desta
-- app), e o catálogo mudou-se para lá inteiro.
--
-- O nome deste ficheiro fica como estava de propósito: é a migração 12, e
-- é por esse número que o `db/README.md` lhe chama. Renumerar histórico
-- custa mais do que um nome um bocado velho.
--
-- O QUE SOBRA AQUI, e continua a ser desta app: o gancho. Um vinho que
-- está numa garrafeira é a melhor fonte que há — alguém tem a garrafa na
-- mão — e é esta função que o leva para o catálogo. Pendura-se em
-- `garrafeira.vinhos`, que é uma tabela desta app, e por isso vive neste
-- repo. Só o destino da chamada mudou: `winecatalog.juntar`.
--
-- Correr DEPOIS de `db/schema.sql` e DEPOIS de o repo WineCatalog ter
-- corrido o `db/catalogo.sql` dele (senão a `winecatalog.juntar` ainda não
-- existe). Se vens do mundo antigo, o
-- `db/migracao-catalogo-para-winecatalog.sql` do repo WineCatalog já
-- reescreve esta função sozinha — este ficheiro é para a base ficar igual
-- ao que está escrito, e para quem montar isto de novo.
--
-- ⚠ O deploy da `vinho-info.ts` tem de acompanhar: ela fala ao catálogo
-- por RPC e o `Accept-Profile`/`Content-Profile` dela mudou de "catalogo"
-- para "winecatalog". Enquanto não for redeployada, ela FALHA CALADA — o
-- `try/catch` à volta do catálogo engole tudo, por desenho (o catálogo é
-- uma poupança, não uma dependência). Não se vê erro nenhum; vê-se a conta
-- da IA a subir.
-- =====================================================================

-- ---------------------------------------------------------------------
-- A Garrafeira alimenta o catálogo
--
-- Só entra o que é do VINHO — nunca `notas` (as minhas notas), nunca
-- `imagem_path` (a fotografia tirada em casa, que apanha a prateleira à
-- volta), nunca `criado_por`, nunca o `garrafeira_id`. Se um dia
-- acrescentares uma coluna a `garrafeira.vinhos`, a pergunta a fazer é
-- essa: isto é sobre o VINHO ou sobre QUEM O TEM? Só a primeira resposta
-- entra aqui.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.catalogar_vinho(p_vinho_id bigint)
  RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v       garrafeira.vinhos%ROWTYPE;
  v_cast  text[];
  v_ficha jsonb;
  v_curado boolean;
BEGIN
  SELECT * INTO v FROM garrafeira.vinhos WHERE id = p_vinho_id;
  IF v.id IS NULL OR COALESCE(v.nome, '') = '' THEN RETURN NULL; END IF;

  SELECT COALESCE(array_agg(c.nome ORDER BY c.nome), ARRAY[]::text[])
    INTO v_cast
    FROM garrafeira.vinho_castas vc
    JOIN garrafeira.castas c ON c.id = vc.casta_id
   WHERE vc.vinho_id = v.id;

  -- Um vinho a que ninguém tocou vale menos do que uma pesquisa: o `tipo`
  -- nasce 'Tinto' por omissão nesta app, e sem esta distinção uma linha
  -- escrita à pressa carimbava "Tinto" com a força de quem tem a garrafa
  -- na mão — por cima de uma pesquisa que dizia Branco. "Curado" é ter
  -- sinais de alguém ter passado por lá.
  v_curado := v.ai_atualizado_em IS NOT NULL
              OR cardinality(v_cast) > 0
              OR v.vivino_nota IS NOT NULL
              OR v.preco_medio IS NOT NULL
              OR (COALESCE(v.regiao,'') <> '' AND COALESCE(v.produtor,'') <> '');

  v_ficha := jsonb_strip_nulls(jsonb_build_object(
    'tipo',              NULLIF(COALESCE(v.tipo, ''), ''),
    'estilo',            NULLIF(COALESCE(v.estilo, ''), ''),
    'mencao',            NULLIF(COALESCE(v.mencao, ''), ''),
    'classificacao',     NULLIF(COALESCE(v.classificacao, ''), ''),
    'regiao',            NULLIF(COALESCE(v.regiao, ''), ''),
    'sub_regiao',        NULLIF(COALESCE(v.sub_regiao, ''), ''),
    'pais',              NULLIF(COALESCE(v.pais, ''), ''),
    'teor',              v.teor,
    'estagio_meses',     v.estagio_meses,
    'estagio_texto',     NULLIF(COALESCE(v.estagio_texto, ''), ''),
    'castas',            CASE WHEN cardinality(v_cast) > 0 THEN to_jsonb(v_cast) ELSE NULL END,
    'vivino_nota',       v.vivino_nota,
    'vivino_avaliacoes', v.vivino_avaliacoes,
    'vivino_url',        NULLIF(COALESCE(v.vivino_url, ''), ''),
    'imagem_url',        NULLIF(COALESCE(v.imagem_url, ''), ''),
    'preco_medio',       v.preco_medio,
    'beber_de',          v.beber_de,
    'beber_ate',         v.beber_ate,
    'notas_prova',       NULLIF(COALESCE(v.notas_prova, ''), ''),
    'harmonizacao',      NULLIF(COALESCE(v.harmonizacao, ''), ''),
    'ai_resumo',         NULLIF(COALESCE(v.ai_resumo, ''), '')
  ));

  RETURN winecatalog.juntar(
    v.nome, COALESCE(v.produtor, ''), v.ano, v_ficha,
    CASE WHEN v_curado THEN 'garrafeira' ELSE 'garrafeira-bruto' END,
    CASE WHEN jsonb_typeof(v.ai_fontes) = 'array' THEN v.ai_fontes ELSE '[]'::jsonb END
  );
END;
$$;

CREATE OR REPLACE FUNCTION garrafeira.vinhos_catalogo()
  RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
BEGIN
  -- Nunca deita a gravação abaixo: alimentar o catálogo é um extra, e um
  -- extra que impedisse alguém de guardar uma garrafa era um mau negócio.
  BEGIN
    PERFORM garrafeira.catalogar_vinho(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS vinhos_catalogo ON garrafeira.vinhos;
CREATE TRIGGER vinhos_catalogo
  AFTER INSERT OR UPDATE ON garrafeira.vinhos
  FOR EACH ROW EXECUTE FUNCTION garrafeira.vinhos_catalogo();

-- As castas não vivem na linha do vinho (são uma tabela à parte, ver
-- CLAUDE.md) e por isso o trigger de cima não as vê mudar — muito menos
-- num INSERT, em que `definir_castas` só corre a seguir. O gancho que
-- falta está DENTRO da `garrafeira.definir_castas`, em `functions.sql`,
-- que é a fonte de verdade dela. Este ficheiro chegou a trazer uma segunda
-- cópia dessa função, "para quem corre só este ficheiro" — e uma função
-- escrita em dois sítios é uma que um dia diverge sem ninguém dar por
-- isso, que é a avaria contra a qual está escrito o aviso grande lá em
-- cima. Por isso: numa base que já existe, corre `functions.sql` a seguir
-- a este ficheiro (o mesmo passo que a migração 08 já pede).


-- ---------------------------------------------------------------------
-- GRANTs: NOMEADOS, e não em bloco.
--
-- O ficheiro original acabava com
-- `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA garrafeira TO authenticated`.
-- Ali fazia sentido — criava dezenas de funções e o
-- `migracao-blindagem.sql` corria a seguir e voltava a fechar o que era
-- para fechar. Mas agora este ficheiro é pequeno e pode ser corrido
-- sozinho, e nesse caso o grant em bloco DESFAZIA a blindagem: voltava a
-- dar ao `authenticated` as sete funções de trigger que a migração 13
-- revogou de propósito — a `vinhos_catalogo()` aqui em baixo incluída.
--
-- Por isso, só as duas desta migração, e com a mesma postura da
-- blindagem: a `catalogar_vinho` é chamada pela `definir_castas` em nome
-- de quem está a gravar, por isso precisa do `authenticated`; a
-- `vinhos_catalogo` é um trigger e não se chama de fora.
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION garrafeira.vinhos_catalogo()        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION garrafeira.catalogar_vinho(bigint)  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.catalogar_vinho(bigint) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- As castas não vivem na linha do vinho (são uma tabela à parte, ver
-- CLAUDE.md) e por isso o trigger de cima não as vê mudar — muito menos
-- num INSERT, em que `definir_castas` só corre a seguir. O gancho que
-- falta está DENTRO da `garrafeira.definir_castas`, em `functions.sql`,
-- que é a fonte de verdade dela. Este ficheiro chegou a trazer uma segunda
-- cópia dessa função, "para quem corre só este ficheiro" — e uma função
-- escrita em dois sítios é uma que um dia diverge sem ninguém dar por
-- isso. Por isso: numa base que já existe, corre `functions.sql` a seguir
-- a este ficheiro.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- Arranque: leva para o catálogo o que já está nas garrafeiras
--
-- Correr UMA vez, depois de tudo o resto. São os vinhos que já lá estão —
-- daqui em diante é o trigger que trata disto. Numa base com poucas
-- centenas de vinhos é instantâneo.
-- ---------------------------------------------------------------------
-- SELECT count(garrafeira.catalogar_vinho(id)) FROM garrafeira.vinhos;
