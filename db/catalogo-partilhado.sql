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
-- ---------------------------------------------------------------------
-- A TRADUÇÃO — colunas da Garrafeira -> ficha do catálogo
--
-- Estava dentro da `catalogar_vinho` e saiu para aqui porque passou a ter
-- DOIS leitores: a `catalogar_vinho` (que escreve no catálogo) e a
-- `comparar_catalogo` (que pergunta ao catálogo o que é que ele tem de
-- diferente). As duas TÊM de falar da mesma ficha.
--
-- Se fossem duas cópias, o dia em que uma ganhasse um campo e a outra não
-- dava uma marca de divergência num campo que nunca chegou a ser enviado —
-- ou seja, a app a acusar o catálogo de não saber uma coisa que ela
-- própria nunca lhe disse. É a mesma razão por que a CHAVE vive só no SQL.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.ficha_catalogo(p_vinho_id bigint)
  RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v       garrafeira.vinhos%ROWTYPE;
  v_cast  text[];
BEGIN
  SELECT * INTO v FROM garrafeira.vinhos WHERE id = p_vinho_id;
  IF v.id IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(array_agg(c.nome ORDER BY c.nome), ARRAY[]::text[])
    INTO v_cast
    FROM garrafeira.vinho_castas vc
    JOIN garrafeira.castas c ON c.id = vc.casta_id
   WHERE vc.vinho_id = v.id;

  RETURN jsonb_strip_nulls(jsonb_build_object(
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
END;
$$;

CREATE OR REPLACE FUNCTION garrafeira.catalogar_vinho(p_vinho_id bigint)
  RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v        garrafeira.vinhos%ROWTYPE;
  v_ficha  jsonb;
  v_castas integer;
  v_curado boolean;
BEGIN
  SELECT * INTO v FROM garrafeira.vinhos WHERE id = p_vinho_id;
  IF v.id IS NULL OR COALESCE(v.nome, '') = '' THEN RETURN NULL; END IF;

  v_ficha := garrafeira.ficha_catalogo(v.id);
  IF v_ficha IS NULL THEN RETURN NULL; END IF;
  v_castas := COALESCE(jsonb_array_length(v_ficha -> 'castas'), 0);

  -- Um vinho a que ninguém tocou vale menos do que uma pesquisa: o `tipo`
  -- nasce 'Tinto' por omissão nesta app, e sem esta distinção uma linha
  -- escrita à pressa carimbava "Tinto" com a força de quem tem a garrafa
  -- na mão — por cima de uma pesquisa que dizia Branco. "Curado" é ter
  -- sinais de alguém ter passado por lá.
  v_curado := v.ai_atualizado_em IS NOT NULL
              OR v_castas > 0
              OR v.vivino_nota IS NOT NULL
              OR v.preco_medio IS NOT NULL
              OR (COALESCE(v.regiao,'') <> '' AND COALESCE(v.produtor,'') <> '');

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


-- =====================================================================
-- O CATÁLOGO A RESPONDER DE VOLTA
--
-- Até aqui esta relação era de sentido único: a garrafeira escrevia no
-- catálogo e nunca ouvia nada. Isso deixava a avaria mais chata de todas
-- sem forma de aparecer — o mesmo vinho com números diferentes nos dois
-- sítios, e ninguém a saber qual está certo.
--
-- Três funções, e cada uma responde a uma pergunta que uma pessoa faz com
-- a garrafa na mão:
--   · `comparar_catalogo`      — "isto que eu tenho bate certo com o que
--                                 se sabe deste vinho?"
--   · `aplicar_do_catalogo`    — "o catálogo está certo, traz-me isso"
--   · `reportar_ao_catalogo`   — "não, o errado é o catálogo" (e aí o que
--                                 é preciso é avisar quem o pode corrigir,
--                                 senão o erro fica lá para os outros)
--
-- NENHUMA delas pode deitar a app abaixo se o catálogo não responder: a
-- primeira devolve "sem catálogo" e as outras duas explicam-se. O catálogo
-- é uma poupança e um espelho, nunca uma dependência — a mesma regra que
-- já governa o trigger aqui em cima.
-- =====================================================================

-- ---------------------------------------------------------------------
-- COMPARAR: o que é que o catálogo tem de diferente do que eu tenho
--
-- O guarda é `pode_ver`: quem vê o vinho vê a comparação. Não é preciso
-- ser editor — saber que um número meu está em desacordo com o catálogo é
-- informação sobre o vinho, não uma escrita.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.comparar_catalogo(p_vinho_id bigint)
  RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v garrafeira.vinhos%ROWTYPE;
BEGIN
  SELECT * INTO v FROM garrafeira.vinhos WHERE id = p_vinho_id;
  IF v.id IS NULL THEN RETURN NULL; END IF;
  IF NOT garrafeira.pode_ver(v.garrafeira_id) THEN
    RAISE EXCEPTION 'Sem acesso a este vinho.';
  END IF;

  -- O catálogo pode não existir (uma base montada só com este repo) ou
  -- estar a meio de uma migração. Isso não é um erro para quem está a
  -- abrir um vinho: é não haver nada para comparar.
  BEGIN
    RETURN winecatalog.comparar(v.nome, COALESCE(v.produtor,''), v.ano,
                                garrafeira.ficha_catalogo(v.id));
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('encontrado', false, 'semCatalogo', true);
  END;
END;
$$;

-- ---------------------------------------------------------------------
-- APLICAR: trazer para a minha garrafeira o que o catálogo diz
--
-- Campo a campo e só os que forem pedidos — nunca "sincroniza tudo". A
-- ficha de um vinho numa garrafeira tem coisas que são DE QUEM A TEM (as
-- notas, a fotografia, o preço que pagou) e o botão que traz tudo é o
-- botão que um dia apaga isso sem ninguém perceber. Aqui só entram os
-- campos que a `ficha_catalogo` manda, que são por definição os que são do
-- VINHO e não do dono.
--
-- Escrever exige `pode_mexer`: é a minha garrafeira e tem de ser minha.
--
-- Repara que isto dispara o trigger de cima e devolve os valores ao
-- catálogo. Não é um ciclo: o que volta é o que de lá veio, e a
-- `winecatalog.forca` trata do resto — uma cópia de garrafeira nunca tapa
-- o que a pôs lá.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.aplicar_do_catalogo(
  p_vinho_id bigint, p_campos text[])
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v      garrafeira.vinhos%ROWTYPE;
  v_cmp  jsonb;
  v_cat  jsonb := '{}'::jsonb;
  e      jsonb;
  k      text;
  v_n    integer := 0;
  v_cast text[];
BEGIN
  SELECT * INTO v FROM garrafeira.vinhos WHERE id = p_vinho_id;
  IF v.id IS NULL THEN RAISE EXCEPTION 'Vinho não encontrado.'; END IF;
  IF NOT garrafeira.pode_mexer(v.garrafeira_id) THEN
    RAISE EXCEPTION 'Este vinho não é teu para mexeres.';
  END IF;
  IF p_campos IS NULL OR cardinality(p_campos) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'campos', 0);
  END IF;

  BEGIN
    v_cmp := winecatalog.comparar(v.nome, COALESCE(v.produtor,''), v.ano,
                                  garrafeira.ficha_catalogo(v.id));
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'O catálogo não respondeu — tenta daqui a pouco.';
  END;
  IF v_cmp IS NULL OR NOT COALESCE((v_cmp ->> 'encontrado')::boolean, false) THEN
    RAISE EXCEPTION 'Este vinho ainda não está no catálogo.';
  END IF;

  -- Só os campos que o catálogo DEVOLVEU agora. Pedir um campo que ele não
  -- tem não pode apagar o meu — "não sei" nunca substitui "sei".
  FOR e IN SELECT jsonb_array_elements(v_cmp -> 'campos') LOOP
    k := e ->> 'campo';
    IF k = ANY(p_campos) AND (e -> 'catalogo') IS NOT NULL
       AND jsonb_typeof(e -> 'catalogo') <> 'null' THEN
      v_cat := v_cat || jsonb_build_object(k, e -> 'catalogo');
      v_n := v_n + 1;
    END IF;
  END LOOP;
  IF v_n = 0 THEN RETURN jsonb_build_object('ok', true, 'campos', 0); END IF;

  -- O COALESCE por campo é o que faz "só os pedidos": o que não vier em
  -- `v_cat` fica exatamente como estava.
  UPDATE garrafeira.vinhos SET
    tipo          = COALESCE(v_cat ->> 'tipo',          tipo),
    estilo        = COALESCE(v_cat ->> 'estilo',        estilo),
    mencao        = COALESCE(v_cat ->> 'mencao',        mencao),
    classificacao = COALESCE(v_cat ->> 'classificacao', classificacao),
    regiao        = COALESCE(v_cat ->> 'regiao',        regiao),
    sub_regiao    = COALESCE(v_cat ->> 'sub_regiao',    sub_regiao),
    pais          = COALESCE(v_cat ->> 'pais',          pais),
    teor          = COALESCE((v_cat ->> 'teor')::numeric,             teor),
    estagio_meses = COALESCE((v_cat ->> 'estagio_meses')::integer,    estagio_meses),
    estagio_texto = COALESCE(v_cat ->> 'estagio_texto', estagio_texto),
    vivino_nota   = COALESCE((v_cat ->> 'vivino_nota')::numeric,      vivino_nota),
    vivino_avaliacoes = COALESCE((v_cat ->> 'vivino_avaliacoes')::integer, vivino_avaliacoes),
    vivino_url    = COALESCE(v_cat ->> 'vivino_url',    vivino_url),
    imagem_url    = COALESCE(v_cat ->> 'imagem_url',    imagem_url),
    preco_medio   = COALESCE((v_cat ->> 'preco_medio')::numeric,      preco_medio),
    beber_de      = COALESCE((v_cat ->> 'beber_de')::integer,         beber_de),
    beber_ate     = COALESCE((v_cat ->> 'beber_ate')::integer,        beber_ate),
    notas_prova   = COALESCE(v_cat ->> 'notas_prova',   notas_prova),
    harmonizacao  = COALESCE(v_cat ->> 'harmonizacao',  harmonizacao),
    ai_resumo     = COALESCE(v_cat ->> 'ai_resumo',     ai_resumo),
    atualizado_em = now()
  WHERE id = v.id;

  -- As castas não vivem na linha (ver `definir_castas`), por isso vão à
  -- parte — e por isso é que este ramo existe.
  IF v_cat ? 'castas' AND jsonb_typeof(v_cat -> 'castas') = 'array' THEN
    SELECT COALESCE(array_agg(x #>> '{}'), ARRAY[]::text[]) INTO v_cast
      FROM jsonb_array_elements(v_cat -> 'castas') x;
    PERFORM garrafeira.definir_castas(v.id, v_cast);
  END IF;

  RETURN jsonb_build_object('ok', true, 'campos', v_n);
END;
$$;

-- ---------------------------------------------------------------------
-- REPORTAR: "o errado é o catálogo"
--
-- O valor que segue é o QUE ESTÁ NA MINHA GARRAFEIRA para esse campo,
-- tirado da mesma `ficha_catalogo` — não é texto escrito à mão numa caixa.
-- Assim o admin do catálogo vê exatamente os dois números, lado a lado, e
-- não uma descrição deles.
--
-- `pode_ver` e não `pode_mexer`: quem vê um erro pode avisar, mesmo que o
-- vinho seja de uma garrafeira que lhe foi partilhada.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION garrafeira.reportar_ao_catalogo(
  p_vinho_id bigint, p_campo text, p_nota text DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'garrafeira', 'winecatalog', 'public'
AS $$
DECLARE
  v     garrafeira.vinhos%ROWTYPE;
  v_fic jsonb;
BEGIN
  SELECT * INTO v FROM garrafeira.vinhos WHERE id = p_vinho_id;
  IF v.id IS NULL THEN RAISE EXCEPTION 'Vinho não encontrado.'; END IF;
  IF NOT garrafeira.pode_ver(v.garrafeira_id) THEN
    RAISE EXCEPTION 'Sem acesso a este vinho.';
  END IF;

  v_fic := COALESCE(garrafeira.ficha_catalogo(v.id), '{}'::jsonb);
  RETURN winecatalog.reportar(
    v.nome, COALESCE(v.produtor,''), v.ano,
    p_campo, v_fic -> p_campo, p_nota, 'garrafeira');
END;
$$;


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

-- A tradução é chamada de DENTRO das outras (SECURITY DEFINER alcança-a
-- lá) e lê a linha do vinho sem perguntar de quem ela é — por isso não vai
-- para o browser.
REVOKE ALL ON FUNCTION garrafeira.ficha_catalogo(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION garrafeira.ficha_catalogo(bigint) TO service_role;

-- As três do espelho: chamadas pela app, com o JWT de quem está a olhar
-- para o vinho. Cada uma confirma lá dentro de quem é a garrafeira
-- (`pode_ver` para ler, `pode_mexer` para escrever).
REVOKE ALL ON FUNCTION garrafeira.comparar_catalogo(bigint)                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION garrafeira.aplicar_do_catalogo(bigint, text[])      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION garrafeira.reportar_ao_catalogo(bigint, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION garrafeira.comparar_catalogo(bigint)                TO authenticated;
GRANT EXECUTE ON FUNCTION garrafeira.aplicar_do_catalogo(bigint, text[])      TO authenticated;
GRANT EXECUTE ON FUNCTION garrafeira.reportar_ao_catalogo(bigint, text, text) TO authenticated;

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
