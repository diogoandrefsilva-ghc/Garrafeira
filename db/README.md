# Garrafeira — Base de dados (Supabase)

Fonte de verdade do schema `garrafeira`, no **mesmo projeto Supabase** das
outras apps (`diogoandrefsilva-personalapps-database`,
`https://gjweqwfbnkgnibhajldc.supabase.co`). É um schema à parte de `goals`,
`festasbv` e `splitbill` — tabelas, RLS e admin próprios, não toca em nada
do que já lá está.

## Estado

O SQL **já foi aplicado** neste projeto (2026-09-01), como três migrações:
`garrafeira_01_schema`, `garrafeira_02_functions` e `garrafeira_03_policies`
(esta última inclui o `seed.sql`). Estão em `supabase_migrations` e podem
ser vistas com `list_migrations`. Os ficheiros aqui continuam a ser a fonte
de verdade — numa base de dados limpa correm-se pela ordem abaixo.

Verificado depois de aplicar, com as sessões simuladas dentro de uma
transação desfeita no fim:

| quem | vê vinhos/garrafas | vê utilizadores | escreve |
|---|---|---|---|
| sem sessão (`anon`) | não | não | não |
| autenticado sem acesso | não | não | não |
| na lista, sem `pode_editar` | sim | só a sua linha | **não** |
| editor | sim | só a sua linha | sim |
| admin | sim | todos | sim |

Depois da migração 07 a coluna "vê vinhos/garrafas" passa a querer dizer
"da garrafeira que está aberta", e a tabela ganha uma linha que não existia:

| quem | vê a garrafeira do Barrona | escreve nela |
|---|---|---|
| o dono dela | sim | sim |
| a quem ele deu acesso de leitura | sim | **não** |
| outro editor da app | **não** | não |
| o admin da app, `admin_acesso='nenhuma'` (defeito) | **não** | não |
| o admin da app, `admin_acesso='leitura'` | sim | **não** |
| o admin da app, `admin_acesso='edicao'` | sim | sim |

E as funções: `definir_castas` junta as grafias repetidas e apaga as castas
que saíram da lista; `consumir_garrafa` recusa consumir a mesma garrafa duas
vezes (a data e a nota do primeiro consumo aguentam); `repor_garrafa` limpa
o carimbo; `definir_admin` recusa quem não é admin **e** recusa passar a app
a um email que não esteja em `allowed_users`; o `criado_por` dos vinhos é
carimbado pelo trigger, não pelo cliente.

### Migração 07 — uma garrafeira por pessoa (**por aplicar**)

`db/migracao-garrafeiras.sql`. É a única migração deste repo que ainda **não
está no Supabase**, e a única que a app não sabe contornar sozinha: sem ela
não há como saber de quem são as garrafas, e adivinhar era mostrar as de
toda a gente a toda a gente. Enquanto não correr, a app diz-o por palavras
em vez de dar um "erro a carregar" (ver `sbAposLogin` em `app.js`).

Correr no SQL Editor, **por esta ordem e de seguida**:

1. `db/migracao-garrafeiras.sql`
2. `db/functions.sql`
3. `db/policies.sql`

Entre o 1 e o 3 a app continua a mostrar tudo a toda a gente (as policies
velhas ainda lá estão e só olham para `is_allowed()`); o isolamento entra
em vigor no fim do 3.

O que ela faz:

- cria `garrafeiras` e `partilhas`, e a coluna `garrafeira_id` em `locais`,
  `vinhos` e `garrafas`;
- cria a **"Garrafeira do Barrona"** com tudo o que hoje lá está dentro. O
  dono fica a ser a conta que hoje é admin (`config.admin_email`) — que é a
  conta onde estes dados de facto vivem. A passagem ao Barrona faz-se depois
  na app (Definições › Garrafeiras › Passar a garrafeira), sem SQL;
- **empresta essa garrafeira a toda a gente que já estava em
  `allowed_users`**. Sem isto, quem já usava a app entrava no dia seguinte e
  encontrava o seu próprio vazio — uma app que se esvazia sozinha parece
  avariada. Passam a ver, deixam de mexer;
- `locais.nome` deixa de ser único no mundo e passa a ser único **dentro de
  cada garrafeira**: duas pessoas têm as duas uma "Garrafeira Principal";
- `admin_acesso` nasce a `nenhuma` em todas — o admin não fica a ver as
  garrafeiras de ninguém, é cada dono que decide.

Testada num Postgres 16 local com o schema antigo e dados dentro: as linhas
sobreviveram com o histórico de consumo intacto, correr a migração duas
vezes não duplica nada, e depois dela um recém-chegado não vê uma linha
(nem uma foto de rótulo). Os três valores do `admin_acesso` foram testados
um a um, mais as tentativas do admin de se subir a `edicao`, de renomear e
de passar a si próprio uma garrafeira alheia — todas recusadas.

### Migração 08 — planos de IA por utilizador (**por aplicar**)

`db/migracao-ia-planos.sql`. Acrescenta `allowed_users.ia_plano` e
`analises.plano_ia`. Os três valores são `sem_ia`, `gratis` e `premium`;
todas as contas existentes começam em `sem_ia`, exceto o admin, que a função
`garrafeira.plano_ia()` trata sempre como premium.

Correr no SQL Editor, por esta ordem:

1. `db/migracao-ia-planos.sql`
2. `db/functions.sql`

Depois publicar a nova `vinho-info` e definir o secret `GEMINI_FREE_API_KEY`.
O limite diário do modo **IA sem pesquisa web** é cinco pesquisas por
utilizador, mas pode ser alterado pelo secret opcional
`GEMINI_FREE_DAILY_LIMIT` (1–50).

### Migração 09 — importação a partir de imagens (**por aplicar**)

`db/migracao-importacao-imagens.sql`. Cria `garrafeira.importacoes`, a fila
privada onde fica apenas o resultado temporário da leitura; **nunca** os bytes
das fotografias. Cada pedido está associado ao utilizador e à garrafeira que
ele pode editar, e só a Edge Function (service role) o pode fechar.

Correr no SQL Editor, por esta ordem:

1. `db/migracao-importacao-imagens.sql`
2. `db/functions.sql`
3. `db/policies.sql`

Depois publicar `importar-vinhos`. A função usa exclusivamente
`GEMINI_FREE_API_KEY`, mesmo para o plano premium: não pesquisa na internet e
não usa a chave paga. Aceita até três imagens por pedido; por defeito, uma
conta no modo **IA sem pesquisa web** pode fazer três pedidos/dia. Altera-se
pelo secret opcional `GEMINI_IMPORT_FREE_DAILY_LIMIT` (1–20). A app mostra
sempre as propostas antes de criar vinhos ou garrafas.

### Migração 10 — layout opcional dos locais (**por aplicar**)

`db/migracao-layout-locais.sql`. Acrescenta `locais.layout`, o JSON com o
desenho da estante (`prateleiras:[{nome,capacidade,formato,mais_em}]`). Vazio
continua a ser o comportamento antigo; preenchido passa a dar ao separador
Locais uma grelha de lugares e permite validar se uma garrafa cabe ali. O
`formato` fica guardado por prateleira (`fila`, `ziguezague` ou
`sobrepostos`) e, em `sobrepostos` ímpar, `mais_em` decide se sobra um lugar
em cima ou em baixo.

Correr no SQL Editor:

1. `db/migracao-layout-locais.sql`

### Migração 11 — cache da pesquisa de vinhos (**por aplicar**)

`db/migracao-cache-vinho-info.sql`. Cria `garrafeira.catalogo_vinhos_cache`,
uma cache técnica da Edge Function `vinho-info` (chave normalizada + resultado
normalizado + fontes + modelo + validade). Serve para evitar repetir chamadas
à pesquisa externa e ao Gemini para pedidos iguais.

Correr no SQL Editor:

1. `db/migracao-cache-vinho-info.sql`

### Migração 12 — catálogo partilhado com a WineSelection (já aplicada)

`db/catalogo-partilhado.sql`. Criou o schema **`catalogo`**, que não era
deste schema nem do da WineSelection: era dos dois.

> **Setembro de 2026 — o catálogo mudou de casa.** Passou a ser o schema
> **`winecatalog`**, com a definição em `db/catalogo.sql` no repo
> **WineCatalog** — uma app própria, com o seu admin
> (`winecatalog.config.admin_email`, que não é o desta app) e com um ecrã
> onde se vê o que lá está. O `catalogo-partilhado.sql` deste repo passou a
> ser **só o gancho da Garrafeira**: a `catalogar_vinho` e o trigger, a
> chamar `winecatalog.juntar`. A migração está em
> `db/migracao-catalogo-para-winecatalog.sql` no repo WineCatalog, e leva
> junto o redeploy da `vinho-info` (o `Accept-Profile` dela mudou).
> O resto desta secção fica como estava: descreve por que é que o catálogo
> existe, e isso não mudou. É a memória comum do que já se
sabe sobre um vinho — o que a IA já procurou (nas duas apps) e o que alguém
já confirmou por ter a garrafa em casa. Antes de pagar uma pesquisa,
pergunta-se ali.

Não é a mesma coisa que a migração 11: aquela é uma cache TÉCNICA de um
pedido (mesma pergunta, mesmos campos, mesmo motor → mesma resposta) e
morre com o TTL. Esta é sobre o VINHO, atravessa as duas apps e não expira
por inteiro — só os campos que envelhecem (nota do Vivino, preço) é que
têm prazo; as castas de um vinho não mudam.

O que atravessa a fronteira é só FACTO SOBRE O VINHO. Nunca `notas` (as
minhas notas), nunca `imagem_path` (a fotografia tirada em casa, que apanha
a prateleira à volta), nunca preços de compra nem locais — esses são da
GARRAFA e da PESSOA, e continuam onde estavam. É a mesma linha que a app já
traça entre "vinho" e "garrafa", e é ela que torna isto partilhável sem
partilhar garrafeira nenhuma.

**Aplicada em 2026-09-10**, em três migrações:
`catalogo_12a_schema_chaves`, `catalogo_12b_juntar_procurar_trigger` e
`catalogo_12c_definir_castas_gancho`. A 12c é a `definir_castas` com o
gancho do catálogo — só essa função e não o `functions.sql` inteiro, porque
a definição que estava viva na base era idêntica à do repo e re-executar as
outras ~30 funções numa base com 166 vinhos era superfície a mais para
zero ganho. Numa base limpa a ordem continua a ser
`catalogo-partilhado.sql` → `functions.sql`.

O arranque também já correu (`SELECT count(garrafeira.catalogar_vinho(id))
FROM garrafeira.vinhos`): 166 vinhos deram **161 linhas** no catálogo — as
5 que faltam são vinhos repetidos que se juntaram na mesma linha, que é o
que se queria (o "Mouchão" e o "Herdade do Mouchão" são o mesmo vinho, e o
"Leo d'Honor" estava escrito com duas grafias do produtor).

**Falta um passo manual, e sem ele o catálogo nunca responde:** juntar
`catalogo` aos *Exposed schemas* no painel (ver mais abaixo). As Edge
Functions das duas apps falam-lhe por RPC do PostgREST. Até lá as três
funções continuam a trabalhar exatamente como antes — o catálogo é uma
poupança e não uma dependência, e um RPC que falha é engolido — o que se
nota não é um erro, é a conta da IA a não descer.

As três Edge Functions já foram publicadas com o código do catálogo:
`vinho-info` (v18), `sugerir-vinho` (v15) e `verificar-vinhos` (v5).

Expor o schema não abre nada a ninguém: a tabela tem RLS **sem uma única
policy** (o que a fecha a toda a gente menos à `service_role`, que passa por
cima da RLS) e as funções `catalogo.juntar`/`catalogo.procurar` são
revogadas a `anon` e `authenticated` no fim do ficheiro. Quem escreve do
lado do browser é o trigger da Garrafeira, e esse é `SECURITY DEFINER` —
escreve sem que a pessoa tenha (nem deva ter) direito nenhum ali.

(A migração 13, `db/migracao-blindagem.sql`, já está aplicada — fecha o que
o linter do Supabase apanhou. Auto-documentada no próprio ficheiro.)

### Migração 14 — vários comentários por consumo (já aplicada)

`db/migracao-notas-consumo.sql`. Um vinho muda ao longo de uma refeição —
"ainda fechado" no início, "abriu bem" depois de arejar — e a nota única de
sempre (`garrafas.consumo_nota`) só guardava a última: editar apagava a
anterior por cima. Cria `garrafeira.consumo_notas` (uma linha por
comentário, cada uma com a sua hora), migra para lá a nota que já existisse
por garrafa, e **apaga** `garrafas.consumo_nota` — uma coluna e a tabela que
a substitui não convivem sem uma delas ficar dessincronizada. Data, local e
avaliação continuam únicos por garrafa: não mudam a meio da refeição, só o
que se acha do vinho é que muda.

`consumir_garrafa` continua a aceitar `p_nota` (é a primeira linha do
histórico deste consumo); `repor_garrafa` passa a apagar também as notas da
garrafa, mesma lógica que já limpava local/avaliação — repor é desfazer o
consumo, não editá-lo. A app grava/apaga notas a mais diretamente (`POST`/
`DELETE` a `consumo_notas`), como já fazia com `vinho_castas`.

Correr no SQL Editor, por esta ordem:

1. `db/migracao-notas-consumo.sql`
2. `db/functions.sql`
3. `db/policies.sql`

### Migração 15 — a wishlist (já aplicada)

`db/migracao-wishlist.sql`. Acrescenta `vinhos.desejado` (boolean, `false`
por omissão): um vinho da wishlist é uma linha normal de `vinhos`, sem
garrafas e com a marca ligada. Nenhuma tabela nova, nenhuma policy nova —
é da garrafeira do vinho, como tudo o resto. A `catalogar_vinho` passa a
saltar estes vinhos (ninguém tem a garrafa na mão); quando um passa para a
garrafeira, o UPDATE que desliga a marca volta a disparar o trigger.

A app deteta a coluna sozinha (`TEM_DESEJO`, mesmo padrão do `imagem_url`):
enquanto a migração não correr, o separador Wishlist não aparece e nada
muda.

**Aplicada em 2026-09-25** como a migração `garrafeira_15_wishlist`: o
`migracao-wishlist.sql` mais a `catalogar_vinho` nova (só essa função do
`catalogo-partilhado.sql` — a definição que estava na base batia certo com o
repo, e as outras não mudaram). Numa base nova, por esta ordem:

1. `db/migracao-wishlist.sql`
2. `db/catalogo-partilhado.sql`

### `vinhos.imagem_url` (já aplicada)

Link para uma foto do rótulo/garrafa — a `vinho-info` (Edge Function) tenta
trazê-lo na procura da IA, e também se pode escrever à mão no formulário.
Já está no Supabase deste projeto (`ALTER TABLE` corrido diretamente no SQL
Editor); `db/schema.sql` tem a definição na `CREATE TABLE` para uma base
nova.

A app não depende de a coluna existir para funcionar: deteta-o sozinha
(`detetarImagem()` em `app.js`) e, se um dia faltar, esconde o campo e não
o manda nas gravações — em vez da foto mostra a garrafa desenhada, que é o
que aparece na mesma para todos os vinhos sem link.

### `vinhos.links` (já aplicada)

Coluna nova: `jsonb NOT NULL DEFAULT '[]'`, uma lista de `{titulo,url}`
escolhida à mão por quem usa a app (Ver no Vivino errado, a loja onde
comprou, um artigo sobre o produtor…). Não tem nada a ver com `ai_fontes` —
essa é o rasto da última procura da IA e é substituída por inteiro a cada
procura; `links` é só do utilizador e a IA nunca lhe mexe.

Aplicada como a migração `garrafeira_05_links_utilizador`. A app deteta-a
sozinha (mesmo padrão do `imagem_url`, `TEM_LINKS` em `app.js`) e esconde a
secção se um dia faltar — sem isso um PATCH rebentava as gravações com 400.

### `vinhos.atualizado_em` (já aplicada)

Coluna nova: `timestamptz NOT NULL DEFAULT now()`, carimbada pela app
(`guardarVinho()` em `app.js`) sempre que o vinho é criado ou editado à mão
no formulário. É o que separa "última pesquisa com IA" (`ai_atualizado_em`,
só quando o `ai_modelo` é mesmo `gemini…`) de "última atualização manual" no
separador "Atualizações" da página do vinho — a app deteta a coluna sozinha
(`TEM_ATUALIZADO`, mesmo padrão do `imagem_url`/`links`) e usa `criado_em`
como recurso se um dia faltar.

Aplicada como a migração `garrafeira_06_atualizado_manual`, com o
carregamento inicial e a pesquisa feita à mão (ChatGPT/Claude/confirmação
no rótulo) dos 85 vinhos já existentes contados como "atualização manual" —
só NÃO contou se a última coisa que mexeu na ficha foi mesmo uma pesquisa
Gemini feita pela app.

### `vinhos.imagem_path` + bucket `garrafeira-rotulos` (já aplicados)

A fotografia do rótulo tirada por quem tem a garrafa. Aplicado como a
migração `garrafeira_04_imagem_propria`: a coluna, o bucket **privado**
(5 MB, só jpeg/png/webp) e quatro policies em `storage.objects` presas ao
`bucket_id` — vê quem tem acesso, mexe quem é editor. É o primeiro bucket
deste projeto Supabase; as policies têm de ficar sempre presas ao bucket,
senão davam acesso aos buckets das outras apps.

**Falta o que não é SQL** — ver "Passos manuais" mais abaixo. Enquanto o
schema não estiver exposto na API, a app dá 404 em tudo.

### Migração 16 — sem colheita não há janela de consumo (já aplicada)

`db/migracao-janela-sem-colheita.sql`. Um trigger em `vinhos`
(`vinhos_sem_colheita`) que apaga `beber_de`/`beber_ate` sempre que o `ano`
é nulo — a janela são anos de UMA colheita, e sem ela seriam os de uma
qualquer. É a mesma regra do catálogo (`winecatalog.da_colheita`).
**Aplicada em 2026-09-25**; não havia nenhum vinho sem ano com janela.

### Migração 17 — os preços das lojas (já aplicada)

`db/migracao-precos-lojas.sql`. Só uma função, `garrafeira.precos_lojas(garrafeira_id)`:
devolve, por vinho, os preços loja a loja que o catálogo partilhado tem em
`ficha -> 'precos'` (Garrafeira Nacional, Granvine, Vinha, Vivino — com
link, colheita e data). Nada é copiado para `vinhos`: a app lê-os ao
carregar e escolhe o preço que conta (`precoPrincipal` no app.js). Sem
catálogo devolve `{}` e a app fica com o preço médio. Nenhuma tabela nova,
nenhuma policy nova — o guarda é `pode_ver`.

**Aplicada em 2026-09-26** como `garrafeira_17_precos_lojas`.

### Migração 18 — o batch do admin corrige links do Vivino (já aplicada)

`db/migracao-links-vivino.sql`. A função `garrafeira.links_vivino_rever`,
que o painel do batch da WineCatalog (no PC do admin) chama para comparar o
`vivino_url` de cada vinho das garrafeiras com o do catálogo e trocar os que
estão errados — sem `/w/<nº>`, ou a abrir outro vinho — ou vazios pelo link
do catálogo, quando esse está confirmado. Um link para uma colheita do mesmo
vinho nunca se toca. As regras estão no cabeçalho do ficheiro. Os "Por
confirmar" (link do catálogo ainda não confirmado) só se trocam se o admin
os marcar no painel (`p_forcar`, a 3.ª assinatura — a de dois argumentos
saiu com um `DROP`).

Só a `service_role` a executa (o `REVOKE`/`GRANT` estão no fim, com a
consulta de confirmação). Precisa do `winecatalog` já montado (usa a
`winecatalog.achar` e a `vivino_verificacoes`). Aplicada a 26/09/2026.
Desde 27/09/2026 o portão aceita também o admin do catálogo
(`winecatalog.sou_admin()`): a app WineCatalog chega-lhe pela
`winecatalog.garrafeiras_links_rever` (`db/garrafeiras-rever.sql` de lá), e o
GRANT continua só da `service_role`.

### Migração 19 — o batch do admin acerta as fichas pelo catálogo (já aplicada)

`db/migracao-fichas-catalogo.sql`. A `garrafeira.fichas_catalogo_rever`, a
irmã da 18 para o resto da ficha: só da mesma colheita, o que está vazio e
o que é diferente mas mais recente no catálogo. As regras estão no
cabeçalho do ficheiro. Escreve pela `garrafeira.escrever_do_catalogo`, que
saiu da `aplicar_do_catalogo` (em `catalogo-partilhado.sql`) para as duas
usarem o mesmo UPDATE — por isso, numa base existente, corre primeiro o
`catalogo-partilhado.sql` e só depois este. Só a `service_role` a executa;
a `escrever_do_catalogo` não se dá a ninguém. Aplicada a 26/09/2026. Desde
27/09/2026 aceita também o admin do catálogo, pela
`winecatalog.garrafeiras_fichas_rever` da app WineCatalog (como a 18).

### Migração 20 — os nomes sem CAPS LOCK (já aplicada)

`db/migracao-nomes.sql`. Um trigger em `vinhos` (`vinhos_nomes`) que arruma
o nome e o produtor a cada escrita — "HERDADE DO SOBROSO" → "Herdade do
Sobroso", "Quinta Do Crasto" → "Quinta do Crasto" — pela
`winecatalog.nome_proprio`, a MESMA função do catálogo (`db/nomes.sql` do
repo WineCatalog, que corre antes deste). A regra não tem cópia aqui. As
siglas ("CARM — …", "JCA", "DOC") ficam como estão; as regras estão no
`nomes.sql` de lá. Corrigiu os 9 vinhos que havia (em três garrafeiras) com
o `vinhos_catalogo` desligado — não foi o dono a gravar — e cada um ficou
no `sync_log` (`nome_capitalizado`). Aplicada a 26/09/2026.

### Migração 21 — a região normalizada, sem impedir um vinho sem região (já aplicada)

`db/migracao-regiao.sql`. O trigger `vinhos_normalizar_regiao` ("DOURO" →
"Douro", Península de Setúbal → "Setúbal") estava no Supabase desde
13/09/2026 sem nunca ter vindo para o repo, com a regra COPIADA do catálogo
e a devolver NULL para uma região vazia — numa coluna NOT NULL, ou seja,
gravar um vinho sem região (um desejo da wishlist, uma importação por foto,
o campo em branco) dava erro. Agora chama a `winecatalog.normalizar_regiao`
(a regra vive só lá) e uma região vazia fica `''`; a cópia
`garrafeira.normalizar_regiao` foi apagada. Aplicada a 26/09/2026.

### Migração 22 — a nota do Vivino de todas as colheitas (já aplicada)

`db/migracao-vivino-global.sql`. Duas colunas em `vinhos`,
`vivino_nota_global` e `vivino_avaliacoes_global`: a nota do vinho TODO (o
Vivino sem `?year=`), ao lado da da colheita (`vivino_nota`/
`vivino_avaliacoes`). Enche-as o script do Vivino no catálogo, e chegam cá
pela `ficha_catalogo`/`escrever_do_catalogo` — por isso, numa base
existente, a seguir a esta corre o `catalogo-partilhado.sql` e o
`migracao-fichas-catalogo.sql`. Os valores que já havia não se mexeram. A
que se mostra decide-a a app (`notaVivino`: a da colheita a partir de 100
avaliações). Aplicada a 26/09/2026.

### Migração 25 — a nota de um consumo com uma casa decimal (já aplicada)

`db/migracao-avaliacao-decimal.sql`. `garrafas.consumo_avaliacao` passa de
`integer` a `numeric(2,1)`: continua de 1 a 5, agora com uma casa decimal
(4,2). Os valores que havia passam tal e qual. A `consumir_garrafa` recebia
`p_avaliacao integer`, e trocar o tipo de um parâmetro com CREATE OR REPLACE
cria uma SEGUNDA função ao lado (o PostgREST deixa de saber qual chamar) —
por isso a migração apaga a de inteiro, e o `functions.sql` também, antes de
criar a nova. A `winecatalog.marcas_amigos` (as marcas dos amigos na
WineSelection) lê esta coluna com `avg()`/`round(…, 1)` e não muda. Corre
ANTES de publicar a app que a usa: a app antiga funciona com a base nova
(manda inteiros), mas a nova com a base antiga só grava notas redondas — um
4,2 dá erro. Aplicada a 28/09/2026 (só a `consumir_garrafa` do
`functions.sql`, mais o GRANT a `authenticated` que a de inteiro tinha).

1. `db/migracao-avaliacao-decimal.sql`
2. `db/functions.sql`

### Migração 26 — comentários sobre um vinho e sugestões (já aplicada)

`db/migracao-comentarios.sql`. Três portas para o admin do catálogo: a
`comentar_vinho` (a página do vinho, "Algo não está bem?": atributos
errados, um site de onde atualizar, outro problema — guarda `pode_ver`, e os
valores dos atributos apontados saem da `ficha_catalogo`), a `sugerir`
(Definições › Sugestões e comentários — `is_allowed`) e a `meus_comentarios`
(a lista de quem escreveu, com o estado e a resposta). A tabela e as funções
vivem no catálogo: corre ANTES o `db/comentarios.sql` do repo WineCatalog,
que é onde o admin as lê (Alertas e o painel do PC). Sem esta migração a app
funciona: o envio diz que falta correr a migração 26 e a lista fica vazia.
Aplicada a 28/09/2026 (`winecatalog_comentarios` e `garrafeira_26_comentarios`).
A 2.ª parte — a conversa (`comentario_responder`, `comentarios_lidos`,
`comentarios_avisos`) — no mesmo dia (`winecatalog_comentarios_conversa` e
`garrafeira_26b_comentarios_conversa`).

1. `db/comentarios.sql` (repo WineCatalog)
2. `db/migracao-comentarios.sql`

### Migração 27 — notificações push (já aplicada)

`db/migracao-push.sql`. As subscrições por aparelho (`push_subscriptions`,
só pelas funções `push_registar`/`push_retirar`/`push_estado`), a caixa de
saída (`push_avisos`, com o que aconteceu a cada aviso), os gatilhos em
`winecatalog.comentarios`/`comentarios_msgs` e o cron
`garrafeira-push-retry` (30 em 30 min). Precisa, fora do SQL:
- a Edge Function `garrafeira-push` publicada (`garrafeira-push.ts`);
- os secrets `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` do projeto (os mesmos
  das outras apps — já lá estão);
- o segredo `service_role_key` no Vault (o mesmo do `goals-push-retry`).
Corre depois da 26 e do `db/comentarios.sql` com a conversa. Para ver se os
avisos chegam: `SELECT estado, resultado, criado_em FROM
garrafeira.push_avisos ORDER BY id DESC LIMIT 20;`, e as respostas da
função em `net._http_response`. Aplicada a 28/09/2026 (`garrafeira_27_push`).

### Migração 28 — a ligação ao catálogo e o nome que vem de lá (já aplicada)

`db/migracao-catalogo-id.sql`. A coluna `vinhos.catalogo_id` (a linha do
catálogo de cada vinho, sem FK), a guarda que só a deixa escrever pela
`ligar_catalogo`, o `vinhos_catalogo`/`catalogar_vinho` a guardá-la e a
escrever na linha ligada (`catalogar_e_ligar`), o `vinhos_nomes` a deixar
passar o que vem do catálogo, a `receber_identidade` (o nome e o produtor
do catálogo nos vinhos ligados, com `sync_log`) e a `religar_catalogo`
(desfeita uma fusão). No fim liga os vinhos que já existem, pelo nome, sem
escrever no catálogo nem mexer em mais coluna nenhuma (a 28/09/2026: 238 dos
243). Corre depois da 24 e do `catalogo-partilhado.sql` (substitui funções
de ambos) e ANTES do `db/garrafeiras-identidade.sql` da WineCatalog, que
chama estas funções. Testada numa réplica local e aplicada a 28/09/2026
(`winecatalog_juntar_marca`, `garrafeira_28_catalogo_id` e
`winecatalog_garrafeiras_identidade`): 238 ligados, 5 sem linha no catálogo,
nenhuma outra coluna nem linha do catálogo mexida.

1. `db/cor-na-chave.sql` (repo WineCatalog — só a `juntar`, com a marca `winecatalog.juntar`)
2. `db/migracao-catalogo-id.sql`
3. `db/garrafeiras-identidade.sql` (repo WineCatalog)

### Migração 29 — a wishlist também alimenta o catálogo (já aplicada)

`db/migracao-desejos-catalogo.sql`. A `catalogar_e_ligar` deixa de saltar
os desejos: escrevem com a origem `garrafeira-desejo` (força 1 em tudo), na
linha a que estão ligados (ou na que a `achar` der, em qualquer colheita) —
com a colheita diferente, ou sem ela, só os factos do vinho —, e só fazem
nascer uma linha quando o catálogo não conhece o vinho. No fim passa pelos
desejos que já existem. Testada numa réplica local e aplicada a 28/09/2026:
25 desejos, 23 campos vazios cheios no catálogo, nenhuma linha nova,
nenhuma ligação mudada, nada mexido nas garrafeiras.

1. `db/catalogo.sql` e `db/historico.sql` (repo WineCatalog — só a `forca`
   e a `quem_escreve`, com a `garrafeira-desejo`; sem elas a força é 0 e a
   `juntar` não escreve nada)
2. `db/migracao-desejos-catalogo.sql`

### Migração 30 — que sites deixam ler as páginas (já aplicada)

`db/migracao-paginas-sites.sql`. Só uma função, `garrafeira.paginas_por_site`
(admin ou `service_role`), que conta por site as páginas que a `vinho-info`
abriu (o `detalhe.paginas` do `sync_log`). Serve o "Procurar links" e o
Diagnóstico. Sem tabela nova, nada mexido. Aplicada a 29/09/2026.

### Migração 31 — o Catálogo dentro da Garrafeira (já aplicada)

`db/migracao-catalogo-na-app.sql`. Só uma função, `garrafeira.catalogo_vinhos`
(quem entra na app, `is_allowed()`), que devolve a ficha de todas as linhas
vivas do catálogo (sem os fundidos, sem `origens`/`fontes`/`vezes`) e os
preços das lojas no formato da `precos_lojas`. É o separador Catálogo da app.
Aplicada a 30/09/2026.

### Migração 32 — os curadores do catálogo (já aplicada)

`db/migracao-curadores.sql`, DEPOIS do `db/curadores.sql` da WineCatalog (a
lista `winecatalog.curadores` e a `sou_curador`, e a `criar`/`editar` a
aceitá-los — `cor-na-chave.sql` e `catalogo.sql` de lá). O que um curador
corrige na sua garrafeira chega à linha ligada do catálogo: `ficha_da_linha`
(a `ficha_catalogo` passa a usá-la), `curador_levar`, `curador_resultado`, e
novas versões do trigger `vinhos_catalogo` e da `definir_castas` (também em
`functions.sql`).

### Migração 33 — as notas de quem usa a Garrafeira aos vinhos do catálogo

`db/migracao-notas-catalogo.sql`. Uma tabela, `garrafeira.notas_catalogo`
(uma nota de 0 a 5, com uma casa decimal, por pessoa e por linha do
catálogo), com RLS e nenhum GRANT a quem tem login — só as duas funções lhe
chegam: `catalogo_notas()` (a média, o número de notas e a MINHA, de cada
vinho; nunca quem deu qual) e `catalogo_nota_definir(id, nota)` (`NULL`
tira-a). Um vinho fundido responde pela linha que ficou. Não mexe no
catálogo: uma nota é de uma pessoa, não do vinho.

**E, ao lado, no repo WineSelection**: a `wineselection.is_allowed()` passa a
deixar entrar quem tem IA aqui (`garrafeira.plano_ia()`), para o separador
Sugestões do Catálogo — ver `db/functions.sql` de lá. Corre a nova
`is_allowed()` e volta a publicar as duas Edge Functions (`sugerir-vinho`,
`verificar-vinhos`), que passam a perguntar-lhe.

### Migração 34 — as imagens das lojas passam a viver no Supabase

`db/migracao-imagens.sql`. Um bucket PÚBLICO, `garrafeira-imagens` (só a
service_role escreve), e `garrafeira.imagens_copia`: um link de origem por
linha, com a cópia, o estado e o erro. A Edge Function
`garrafeira-imagens` (deploy: `supabase functions deploy garrafeira-imagens`,
verify_jwt ligado) descarrega cada link e a `imagem_resultado` troca-o pelo
da cópia no catálogo e em todas as garrafeiras (`imagem_trocar`, sem voltar
ao catálogo nem carimbar `atualizado_em`). O cron `garrafeira-imagens`
(minuto 17 de cada hora) apanha os links novos; o admin vê o estado e copia
já em Definições › Diagnóstico (`imagens_resumo`). Publica a função ANTES de
correr o SQL, senão o cron chama uma função que não existe.

A primeira corrida (30/09/2026): 307 links, 300 copiados (35 MB), 7 com o
link morto (404), recusado (403) — esses ficam com o
link de origem.

### Migração 35 — as imagens copiadas ficam pequenas

`db/migracao-imagens-reduzir.sql`. `imagens_copia.reduzida`, e a
`garrafeira-imagens` passa cada imagem pelas transformações de imagem do
Supabase (no máximo 800×800, WebP a 80), guarda o resultado e apaga a
original; as já copiadas reduzem-se na volta seguinte
(`imagens_por_reduzir` → `imagem_reduzida`, que troca o link velho do
Supabase pelo novo em todo o lado). A `imagem_resultado` ganha
`p_reduzida` (outra assinatura: a velha sai). Publica a função depois do
SQL.

### Migração 36 — trocar a imagem de um vinho do catálogo pela app

`db/migracao-imagem-catalogo.sql`. Uma policy no `storage.objects`: os
curadores e o admin do catálogo (`winecatalog.sou_curador()`/`sou_admin()`)
podem ENVIAR para `garrafeira-imagens/cat/` — e só isso. A app grava depois
o link na linha pela `winecatalog.editar`.

### Migração 37 — as regiões escritas com um sinónimo (já aplicada)

`db/migracao-regioes-sinonimos.sql`, depois do `db/regioes.sql` do
WineCatalog (a regra). "Alentejano" (o Vinho Regional), "Évora" (uma
sub-região), "Evoramonte" (uma terra), "Terras do Sado", "DOC Douro"
estavam gravados como região e eram facetas à parte nos filtros. A
`winecatalog.normalizar_regiao` passa-os à região a sério, e o trigger
`vinhos_normalizar_regiao` (`migracao-regiao.sql`, atualizado) guarda a
sub-região que traziam (`winecatalog.subregiao_de`) quando a `sub_regiao`
está vazia. A migração corrige o que já estava escrito (com a marca
`garrafeira.do_catalogo`: não volta ao catálogo nem carimba
`atualizado_em`), e os dois "Beiras" com a sub-região escrita (Silgueiros →
Dão; Bairrada). Aplicada a 30/09/2026: 14 vinhos.

### Migração 38 — uma grafia por casta (POR APLICAR)

`db/migracao-castas.sql`, depois do `db/castas.sql` do WineCatalog (a
regra, já aplicada a 01/10/2026: 19 fichas do catálogo arrumadas). A
`casta_id` e a `definir_castas` passam pela `winecatalog.normalizar_castas`
("Aragonês" → "Aragonez", "Touriga Nacional e Merlot" → duas castas), e as
castas que já lá estavam juntam-se na de referência. Cola-se inteira no SQL
Editor (o MCP do Supabase não a corre: tem `DELETE`).

### Migração 39 — o Catálogo fidedigno (POR APLICAR)

`db/migracao-catalogo-fiel.sql`, depois da 32 e da 38. O nome e o produtor
de um vinho gravado deixam de se mudar pela app (`vinhos_identidade_fixa`:
a quem escreve pela API, ficam como estavam). O resto da ficha só corrige o
catálogo quando a linha é só deste vinho (`linha_so_minha`); nas outras, a
garrafeira só enche o que o catálogo tem vazio (`catalogar_e_ligar` com
`p_so_vazios`), e o que se mudou para um valor diferente do catálogo vai ao
admin como comentário, com push (`catalogo_divergencia`, `castas_mudaram`).
Novas versões do `vinhos_catalogo`, da `catalogar_vinho`, da
`definir_castas` (também em `functions.sql`) e da `curador_resultado`. Sem
DROP: a `catalogar_e_ligar` de dois argumentos fica, a chamar a de três.
Ensaiada a 01/10/2026 numa transação desfeita no fim, contra a base real
(sem a `definir_castas`): um vinho de linha só sua corrigiu o catálogo; outro, com
dados das lojas, deixou o catálogo como estava e abriu o comentário (e o
push) ao admin; o nome e o produtor ficaram como estavam. Cola-se inteira no
SQL Editor (o MCP do Supabase não a corre: tem `DELETE`, na `definir_castas`).

## Regra de ouro

**O repo é a fonte; o Supabase segue atrás.** Quando muda o schema, as
funções ou as policies, edita-se primeiro o `.sql` aqui e só depois se cola
no SQL Editor do Supabase — nunca ao contrário.

## Ordem de execução

Numa base de dados limpa:

1. **`schema.sql`** — schema, tabelas, constraints, GRANTs e
   `ENABLE ROW LEVEL SECURITY`.
   Inclui o `GRANT USAGE ON SCHEMA garrafeira TO service_role` (+ tabelas e
   sequences). Sem isso a `service_role` (a Edge Function `vinho-info`) não
   lê nem escreve **nada** em `garrafeira.*`: falha com "permission denied
   for schema garrafeira" (42501), e falha **em silêncio** do lado de quem
   chama. Foi assim que as notificações push do Goals passaram semanas a
   reportar sucesso sem nunca chegarem a lado nenhum. O bypass de RLS
   (`BYPASSRLS`) só ignora *policies* — os GRANTs continuam a ser precisos,
   e só são automáticos no schema `public`.
2. **`catalogo-partilhado.sql`** — o gancho para o catálogo: a
   `catalogar_vinho` e o trigger que o alimenta a partir de
   `garrafeira.vinhos`. Vem antes das funções porque a `definir_castas` (a
   seguir) chama a `garrafeira.catalogar_vinho` que nasce aqui.
   O catálogo em si já não é definido aqui — é `db/catalogo.sql` no repo
   WineCatalog, e tem de ter corrido antes deste (senão a
   `winecatalog.juntar` ainda não existe).
3. **`functions.sql`** — `admin_email`, `is_admin`, `is_allowed`,
   `is_editor`, `definir_admin`, `admin_pass_temp`, `consumir_garrafa`,
   `repor_garrafa`, `casta_id`, `definir_castas` e os triggers de guarda.
4. **`policies.sql`** — as RLS policies (dependem das funções acima).
   É aqui que vive o isolamento: `locais`, `vinhos`, `garrafas` e
   `vinho_castas` andam por `pode_ver()`/`pode_mexer()`, não por
   `is_allowed()`/`is_editor()` sozinhos.
5. **`seed.sql`** — põe o admin na lista de acesso. Sem isto a app abre na
   mesma (o admin tem acesso por ser admin), mas ele não aparece na lista de
   utilizadores e a passagem da app a outra pessoa fica bloqueada —
   `definir_admin()` exige que o novo dono já esteja na lista.
6. **`migracao-links-vivino.sql`** — a função do batch do admin para os
   links do Vivino (migração 18). Só depois do `winecatalog`.
7. **`migracao-fichas-catalogo.sql`** — a do resto da ficha (migração 19).
8. **`migracao-nomes.sql`** — os nomes sem CAPS LOCK (migração 20). Só
   depois do `db/nomes.sql` do WineCatalog (usa a `winecatalog.nome_proprio`).
9. **`migracao-regiao.sql`** — a região normalizada pela
   `winecatalog.normalizar_regiao` (migração 21); desde 30/09/2026 enche
   também a sub-região, com a `winecatalog.subregiao_de` do `db/regioes.sql`
   do WineCatalog.
10. **`migracao-regioes-sinonimos.sql`** — os sinónimos de região já
   gravados (migração 37). Só depois do `db/regioes.sql` do WineCatalog.
11. **`migracao-castas.sql`** — uma grafia por casta (migração 38). Só
   depois do `db/castas.sql` do WineCatalog.

(Numa base limpa, a migração 22 — `migracao-vivino-global.sql` — já está no
`schema.sql`; só é precisa numa base que venha de antes.)

Todos são idempotentes: podem ser corridos outra vez sem estragar nada.

## Passos manuais no painel do Supabase

Estes não se fazem por SQL:

1. **Expor os schemas na API.** Settings › API › *Exposed schemas*: juntar
   `garrafeira` à lista (`public`, `goals`, `splitbill`, …). **Sem isto,
   todos os pedidos da app dão 404** e parece que as tabelas não existem.
   Juntar **também `catalogo`** (migração 12): é por aí que as Edge
   Functions das duas apps falam com o catálogo partilhado. Sem ele
   exposto, o catálogo nunca responde — e como não pode deitar uma procura
   abaixo, o que se nota não é um erro, é a conta da IA a não descer.
2. **Redirect URLs.** Authentication › URL Configuration › *Redirect URLs*:
   juntar o endereço do GitHub Pages desta app (ex.:
   `https://diogoandrefsilva-ghc.github.io/Garrafeira/`) e, se usares,
   `http://localhost:*`. É para onde volta o login com Google e o link de
   recuperação de password.
3. **Secrets da Edge Function.** Já existem no projeto e são partilhados por
   todas as functions (são por PROJETO, não por function):
   `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
   Para a `vinho-info` com pesquisa externa, acrescentar `SEARCH_API_KEY`
   (opcionalmente `SEARCH_API_URL` e `VINHO_CACHE_TTL_HOURS`).
   Para as funções no modo IA sem pesquisa web (`vinho-info` legado / `importar-vinhos`),
   manter `GEMINI_FREE_API_KEY`; `GEMINI_FREE_DAILY_LIMIT` é opcional e vale 5
   por defeito.
4. **Deploy da função:** `supabase functions deploy vinho-info` (o ficheiro
   está na raiz do repo, `vinho-info.ts`).

## O que fica onde

| Tabela | O que guarda |
|---|---|
| `garrafeiras` | **de quem é cada garrafeira** (`dono` = email) e o que o dono deixa o admin da app lá fazer (`admin_acesso`). É isto que isola uma pessoa da outra |
| `partilhas` | a quem mais foi emprestada uma garrafeira — sempre **só para ver** |
| `allowed_users` | quem entra. `pode_editar` marca quem tem garrafeira própria e lhe mexe |
| `access_requests` | pedidos à espera de aprovação do admin |
| `config` | `admin_email` — quem é o dono da app. Só se muda por `definir_admin()` |
| `locais` | os sítios da casa (garrafeira, aparador, frigorífico…) |
| `vinhos` | a REFERÊNCIA: nome, ano, castas, região e o que a IA descobriu |
| `castas` + `vinho_castas` | as castas, normalizadas, para se poder procurar por elas |
| `garrafas` | a coisa FÍSICA: onde está, quanto custou, e quando/onde foi bebida |
| `analises` | as procuras à IA em curso (o polling da app lê daqui) |
| `catalogo_vinhos_cache` | cache técnica da `vinho-info` para reduzir chamadas repetidas e custo |
| `sync_log` | rasto de cada procura, para quando o browser só diz "502", incluindo os `usageMetadata` devolvidos pelo Gemini |

**Vinho ≠ garrafa.** Duas garrafas do mesmo vinho em prateleiras diferentes
são duas linhas em `garrafas` e **uma** em `vinhos`. É isso que evita ter a
ficha da IA copiada duas vezes, e é isso que deixa "consumir" dar saída a
uma garrafa sem apagar o que se sabe do vinho.

## As fronteiras

```
is_allowed()   →  entra na app
is_editor()    →  escreve  (admin + quem tiver pode_editar)
is_admin()     →  manda em quem tem acesso e em quem é editor
pode_ver(g)    →  vê a garrafeira g       (é dono dela, ou foi-lhe emprestada)
pode_mexer(g)  →  escreve na garrafeira g (is_editor() E é dono dela)
```

`is_allowed()` já não chega para ver um vinho: diz que a pessoa entra na
app, não de quem são as garrafas. As duas últimas é que decidem isso.

**Uma garrafeira emprestada é só de leitura, e não há exceção.** Não existe
caminho nenhum — nem por engano, nem à força — para escrever na garrafeira
de outra pessoa: `pode_mexer()` exige ser dono, e é ela que está em todas as
policies de escrita.

**O `is_admin()` sozinho não abre garrafeiras.** O que abre é o convite do
dono: `garrafeiras.admin_acesso`, com três valores —

| valor | o admin da app… |
|---|---|
| `nenhuma` (defeito) | nem sabe que a garrafeira existe |
| `leitura` | vê e procura, não mexe |
| `edicao` | vê e mexe nas garrafas |

Escolhe-se em Definições › Garrafeiras › *Permissões ao admin*, e só o dono
lá chega. Mesmo com `edicao`, o admin mexe nas GARRAFAS e não na fechadura:
renomear, dar acesso a outros, passar a garrafeira e mudar o próprio
`admin_acesso` são só do dono — as policies de `garrafeiras` e `partilhas`
comparam o `dono` à mão e não passam por `pode_mexer()`. Sem isso o admin
subia-se de `leitura` a `edicao` sozinho.

É uma permissão dada ao **papel**, não à pessoa. Por isso `definir_admin()`
repõe todas a `nenhuma` ao passar a app — o admin seguinte não herda calado
a chave da garrafeira de toda a gente.

Nada é legível pelo role `anon`: todas as policies são `TO authenticated`.
Não há modo convidado — ao contrário do calendário de jogos do Goals, isto
diz onde estão garrafas caras dentro da casa de alguém.

## Passar a app a outra pessoa

O admin não está fixo em código (ao contrário do Goals): está na linha
`admin_email` de `garrafeira.config`. Trocá-lo é **Definições ›
Utilizadores › Passar a app**, que chama `garrafeira.definir_admin()`.

A função recusa passar a app a um email que ainda não esteja em
`allowed_users` — de propósito: era ficar sem admin nenhum e sem forma de
voltar atrás pela interface. O dono anterior fica como editor.

**Passar a APP é coisa diferente de passar uma GARRAFEIRA.** A app é quem
manda em quem entra (`definir_admin`); a garrafeira são as garrafas
(`transferir_garrafeira`, em Definições › Garrafeiras). Passar a app ao
Barrona não lhe dá as garrafas, e passar-lhe a garrafeira não lhe dá a app —
são dois cliques, e a entrega inicial precisa dos dois.

`transferir_garrafeira` só aceita o **dono** (nem o admin) e só entrega a
quem já tenha `pode_editar` — entregar as garrafas a quem não lhes pode
mexer era deixá-las presas numa conta que não as sabe usar.

## Recuperação de password

Este projeto **não tem SMTP próprio configurado**, e sem ele o painel não
deixa editar os templates de email — o "esqueci-me da password" fica só com
o template genérico do Supabase (sem o código de 6 dígitos, e sujeito aos
scanners de segurança do email, que gastam o link antes de a pessoa lá
chegar). A rede de segurança é a mesma do Goals: o admin gera uma password
em **Definições › Utilizadores › Password temporária**, dita-a por telefone,
e a pessoa troca-a em **Definições › Conta**.

A app **nunca escreve em `auth.users`** — a chave que ela tem é a `anon`
pública. Quem faz o trabalho é `garrafeira.admin_pass_temp()`
(SECURITY DEFINER), e a verificação é do servidor, não da interface. A
função recusa: quem não é admin, contas fora de `allowed_users`, passwords
com menos de 8 caracteres, e a conta do próprio admin (essa muda-se no
painel do Supabase).
