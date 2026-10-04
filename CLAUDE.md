# Garrafeira — guia para o assistente

Gestão de uma garrafeira caseira: o que lá está, **onde** está (local,
prateleira, lugar), e o que já se bebeu. **Sem build, sem npm.** Site
estático (GitHub Pages), PWA. Dados e login em **Supabase** — o **mesmo
projeto** do Goals/FestasBV/SplitBill (`gjweqwfbnkgnibhajldc`), num schema à
parte e isolado: `garrafeira`.

**Uma garrafeira por pessoa.** A app é a mesma, as tabelas são as mesmas —
mas cada um só vê as suas garrafas. Ver "Cada um vê a sua garrafeira" mais
abaixo antes de mexer em qualquer coisa que leia ou escreva dados: é a
decisão que segura tudo o resto, ao lado do "vinho ≠ garrafa".

## Estrutura
- `index.html` — só markup: os três ecrãs de autenticação (`page-login`,
  `page-nova-pass`, `page-sem-acesso`), o splash, os 5 separadores e os 5
  modais (que são preenchidos por JS, vazios no HTML) — mais a folha
  `modal-formato`, que abre por cima do modal do local.
- `app.js` — **toda a lógica** (~2000 linhas). Secções (`grep` pelo título,
  não leias o ficheiro todo):
  Sessão Supabase (`sbHeaders`/`sbFetch`/`sbReq`/`sbRpc`) ·
  **A garrafeira aberta** (`GA_ID`) · Permissões ·
  **DB** (`carregar` + `carregarGarrafeira`) · Índices e cálculos ·
  Navegação · **Resumo** (ecrã
  inicial) · Pesquisa (Detalhe + Locais) · Filtros · **Detalhe** (lista
  organizada) · **Mapa dos locais** (um local de cada vez) · Consumidos · **Página do vinho** ·
  Modal editar/novo · Consumir garrafa · Modal da garrafa · **IA** ·
  Auth (Supabase) · Definições · Locais · **Garrafeiras** ·
  **Utilizadores (admin)** · Exportar · Diagnóstico · Init.
- `style.css` — todo o CSS. Ver **"A linguagem visual"** mais abaixo antes
  de lhe mexer: as cores e os tipos de letra são um sistema, não gosto.
- `sw.js` — service worker (cache PWA).
- `vinho-info.ts` — a Edge Function que procura a ficha do vinho na net
  (deploy à parte: `supabase functions deploy vinho-info`).
- `garrafeira-imagens.ts` — a Edge Function que copia as imagens das lojas
  para o bucket `garrafeira-imagens` (migração 34). Deploy:
  `supabase functions deploy garrafeira-imagens`.
- `garrafeira-carta.ts` — a Edge Function das Sugestões: lê a carta e faz
  a sugestão (migração 40; ver "As Sugestões"). Deploy:
  `supabase functions deploy garrafeira-carta`.
- `garrafeira-push.ts` — a Edge Function das notificações push (a chave
  pública VAPID para a app, e o envio da caixa de saída `push_avisos`; ver
  "Comentários e sugestões"). Deploy: `supabase functions deploy garrafeira-push`.
- `db/` — `schema.sql` → `functions.sql` → `policies.sql` → `seed.sql`
  (+ `README.md` com os passos manuais no painel do Supabase). Fonte de
  verdade do schema. `migracao-garrafeiras.sql` é a migração 07 (uma
  garrafeira por pessoa); `migracao-ia-planos.sql` é a 08 (planos de IA por
  utilizador) e, numa base existente, é seguida por `functions.sql`.
  `catalogo-partilhado.sql` é a 12 e era a única que criava um schema que **não
  é desta app**: o `catalogo`, partilhado com a WineSelection (ver secção
  própria). Também é seguida por `functions.sql`.
  `migracao-wishlist.sql` é a 15 (a wishlist, `vinhos.desejado`), seguida
  por `catalogo-partilhado.sql`.
  `migracao-links-vivino.sql` é a 18: a função do batch do admin que
  corrige os links do Vivino nas garrafeiras (ver "Cada um vê a sua
  garrafeira").
  `migracao-fichas-catalogo.sql` é a 19: a irmã, para o resto da ficha.
  `migracao-nomes.sql` é a 20: os nomes sem CAPS LOCK (ver "O vocabulário
  do tipo" › "Os nomes").
  `migracao-regiao.sql` é a 21: o trigger que normaliza a região ("DOURO"
  → "Douro"), com a regra do catálogo — esteve no Supabase sem estar aqui,
  e a devolver NULL numa coluna NOT NULL (um vinho sem região não gravava).
  `migracao-vivino-global.sql` é a 22: a nota do Vivino de todas as
  colheitas, ao lado da da colheita (ver "A nota do Vivino: duas").
  `migracao-produtores.sql` é a 23: o trigger dos nomes passa a trocar a
  grafia do produtor pela OFICIAL (`winecatalog.produtor_oficial`) — ver o
  `CLAUDE.md` da WineCatalog, "Os produtores oficiais e o nome
  normalizado". O que já estava escrito corrige-se do lado de lá, quando o
  admin confirma um produtor (vale para todas as garrafeiras, com uma
  linha no `sync_log` por vinho, origem `winecatalog-batch`); o mesmo para
  o nome normalizado (acao `nome_normalizado`).
  `migracao-cor-na-chave.sql` é a 24 (fase 4 dos nomes, depois do
  `cor-na-chave.sql` da WineCatalog): o trigger dos nomes aplica a regra
  INTEIRA do catálogo (`winecatalog.identidade`) quando o nome é escrito —
  um vinho novo ou o nome mudado: "Papa Figos Tinto 2021" fica "Papa
  Figos", colheita 2021; "Casa Ferreirinha Quinta da Leda" fica "Quinta da
  Leda"; "Cartuxa Colheita" fica, porque se chama pelo produtor. Nos vinhos
  dos produtores que o admin pôs na lista ("Companhia das Lezírias 1836
  Grande Reserva") o produtor nunca sai da frente — a lista é do catálogo
  (`winecatalog.produtores_no_nome`, `db/nomes-manter.sql` da WineCatalog). Mudar só o
  produtor troca-o pelo oficial e não mexe no nome (os nomes antigos
  arrumam-se pela simulação do painel do admin). Ver "O nome, a cor e o
  produtor".
  `migracao-avaliacao-decimal.sql` é a 25: a nota de um consumo passa a
  ter uma casa decimal (`consumo_avaliacao numeric(2,1)`, 4,2), e a
  `consumir_garrafa` com ela — seguida por `functions.sql`.
  `migracao-comentarios.sql` é a 26: as portas dos comentários sobre um
  vinho e das sugestões, e da conversa (ver "Comentários e sugestões");
  corre depois do `db/comentarios.sql` da WineCatalog, onde vive a tabela.
  `migracao-push.sql` é a 27: as notificações push — as subscrições, a
  caixa de saída, os gatilhos nos comentários e o cron da nova tentativa.
  `migracao-catalogo-id.sql` é a 28: cada vinho guarda a sua linha do
  catálogo (`vinhos.catalogo_id`), e o nome e o produtor que o catálogo
  muda chegam cá sozinhos (ver "O catálogo partilhado" › "A ligação").
  `migracao-desejos-catalogo.sql` é a 29: a wishlist também alimenta o
  catálogo, com força 1 (ver "A wishlist é um vinho sem garrafas");
  corre depois da `garrafeira-desejo` na `forca()` da WineCatalog.
  `migracao-catalogo-na-app.sql` é a 31: `catalogo_vinhos`, o catálogo
  inteiro para o separador Catálogo (ver "O Catálogo dentro da app").
  `migracao-curadores.sql` é a 32: os curadores do catálogo — o que um
  curador corrige na sua garrafeira chega à linha ligada (ver "Os
  curadores do catálogo"); corre depois do `db/curadores.sql` da WineCatalog.
  `migracao-notas-catalogo.sql` é a 33: as notas (0 a 5) de quem usa a
  Garrafeira aos vinhos do catálogo (ver "O Catálogo dentro da app" ›
  "As notas da casa").
  `migracao-imagens.sql` é a 34: as imagens das lojas copiadas para o
  Supabase (ver "A imagem de cada vinho" › "As imagens das lojas vivem no
  Supabase").
  `migracao-imagens-reduzir.sql` é a 35: essas imagens ficam pequenas
  (800×800 em WebP, pelas transformações de imagem do Supabase).
  `migracao-imagem-catalogo.sql` é a 36: os curadores trocam a imagem de
  um vinho do catálogo pela app (a pasta `cat/` do bucket público).
  `migracao-regioes-sinonimos.sql` é a 37: "Alentejano", "Évora",
  "Evoramonte", "Terras do Sado" deixam de ser regiões — passam a
  "Alentejo"/"Setúbal", e a sub-região que traziam vai para a `sub_regiao`
  (a regra é a `winecatalog.normalizar_regiao`, `db/regioes.sql` da
  WineCatalog; o trigger é o da 21).
  `migracao-castas.sql` é a 38: uma grafia por casta ("Aragonês" →
  "Aragonez", "Souzão" → "Sousão", "Touriga Nacional e Merlot" → duas);
  corre depois do `db/castas.sql` da WineCatalog (ver "Monocasta / várias
  castas é CALCULADO" › "Uma grafia por casta").
  `migracao-catalogo-fiel.sql` é a 39: o Catálogo fidedigno — o nome e o
  produtor de um vinho gravado não se mudam na garrafeira, e o resto só
  corrige o catálogo na linha que é só desse vinho; nas outras, enche o
  vazio e a divergência vai ao admin (ver "Os curadores do catálogo" ›
  "E quem não é curador").
  `migracao-sugestoes.sql` é a 40: as Sugestões passam a ser da
  Garrafeira — as cartas lidas (`garrafeira.cartas`), a ligação de cada
  vinho da carta ao catálogo com a cor (`carta_ligar`) e as marcas dos
  amigos que já não baralham tintos com brancos (`garrafeira.marcas_amigos`).
  `migracao-paginas-sites.sql` é a 30: `paginas_por_site`, que sites
  deixam a `vinho-info` ler as páginas (ver "A procura da IA" › "Procurar
  links").
  `migracao-blindagem.sql` é a 13: fecha o que o linter do Supabase apanhou
  (as tabelas de backup de setembro estavam com RLS DESLIGADA num schema
  exposto — qualquer pessoa com a chave `anon` lia os vinhos de toda a gente
  sem login). Traz escrito o que NÃO se revoga e porquê; lê-o antes de
  "arrumar" mais algum aviso do linter.
- Não mexer à mão: `apple-touch-icon.png`, `icone.png`, `icone-claro.png`, `icone-512.png`,
  `icone-maskable.png` e `nota-g.png` (são gerados — ver "Ícones").

## Os cinco separadores (o ecrã inicial não é a lista)
**Locais e Consumidos só aparecem quando fazem falta** (30/09/2026, o dono):
Locais só com um local DESENHADO (`temLocaisDesenhados`), Consumidos só com
garrafas bebidas (`sincronizarTabs`, no `renderLista`). Sem local desenhado
também não se escolhe local nem lugar a uma garrafa (o "Mover" passa a
"Editar", e os campos ficam escondidos com o valor que já tinham) nem há o
filtro Local. O ⇄ do catálogo vive no canto direito do cabeçalho (o título
continua a trocar). As Definições têm uma linha de texto por cartão, não um
parágrafo.

`Garrafeira` (resumo) · `Detalhe` · `Locais` · `Consumidos` · `Definições`
— mais a **`Wishlist`** (antes do ⚙️), que só aparece depois da migração 15
(ver "A wishlist é um vinho sem garrafas").

O ecrã inicial (`Garrafeira`) é **só o resumo** — nada de procura aqui. Já
teve os cards em cima e a procura por baixo, mas com a procura a viver
também em Detalhe e Locais (ver abaixo), ter uma terceira cópia era ter três
sítios com a mesma pergunta; o ecrã inicial ficou só para o retrato de
conjunto. De propósito: a primeira versão copiou demasiado do Goals
(painel cheio de números **e** a lista toda logo à entrada) e ficou
carregada para o que é.

Os cards são os `.sc` de sempre, na grelha (2 colunas no telemóvel) — não
mudes isso para uma lista vertical, já se tentou e ficou pobre. São **oito**:
vinhos, monocasta, regiões, castas, os dois **dourados** de preferência
(região e casta preferida — ver abaixo), **valor estimado** e **a completar**.

O **valor** é uma estimativa e diz-se isso no subtítulo: vale o que se pagou
(`preco_compra`) quando se sabe, e o **preço que conta** do vinho
(`precoPrincipal`, ver "O preço de um vinho") quando não se sabe; garrafas sem nenhum dos dois não entram na conta (inventar um preço
era pôr no cartão um número que ninguém podia conferir). Abre por
**intervalo de preço** (`FAIXAS_PRECO`/`faixaIndice`: até 15€, 15€–30€,
30€–50€, acima de 50€) — é a pergunta que se faz a seguir a "quanto vale
isto": está sobretudo em garrafas baratas ou caras? O painel também mostra
o **valor médio por garrafa** (só ali, não no card fechado — o card fechado
já tem o total).

**A completar** são os vinhos a quem falta alguma coisa que a app usa —
imagem, castas, preço médio ou classificação (`FALTAS`/`faltasDe`). A
MESMA lista é o filtro **Em falta** da fita (ver a seguir), com mais umas
faltas que só lá aparecem (`resumo:false`).

Os dois cards **dourados** (`scCardFav`) vêm logo a seguir aos de Regiões e
Castas: **Região preferida** e **Casta preferida**, cada um com a região/
casta com mais vinhos agora — "Douro · 10 vinhos", "Syrah · 15 vinhos, 6
monocasta". Não é guardado em lado nenhum, é sempre o topo de `regRows`/
`casRows` (as mesmas contagens do card de Regiões/Castas). Dourado porque é
a cor da distinção nesta app (ver "A linguagem visual"), e um topo é
exatamente isso — não mais um número, um destaque.

Sete dos oito abrem ao tocar (`renderResumo`, `scCard`, `scCardFav`,
`resumoPainel`, `contarPor`): uma contagem casta a casta, região a região,
faixa de preço a faixa de preço ou falta a falta; tocar numa linha dessa
contagem mostra os vinhos (`resumoDrill`). Os dois dourados vão direto à
linha do topo — tocar neles é o mesmo que abrir o card de Regiões/Castas e
já tocar na primeira linha. O painel (`.sc-det`) abre **por baixo da grelha
toda**, com `grid-column:1/-1` — pô-lo logo a seguir ao card aberto partia a
grelha ao meio e deixava buracos.

O painel tem **barra própria** (`.rdet-bar`): ‹ voltar à esquerda, a migalha
do sítio onde se está no meio, ✕ à direita (`resumoFechar`). Antes o voltar
era um link solto no meio do conteúdo e não havia como fechar sem ir outra
vez ao card lá em cima. O card aberto fica preenchido e com o chevron
virado — é o que liga o painel ao sítio de onde saiu.

Um clique numa casta na página do vinho (`filtrarPorCasta`) muda para o
separador `Detalhe` já com esse filtro aplicado — é lá (e em `Locais`) que
os filtros vivem agora.

## A procura vive em dois sítios, é a MESMA procura
`Detalhe` e `Locais` partilham literalmente **o mesmo nó** `#filtros` (texto
+ chips + pastilhas) — não duas cópias com ids repetidos, que não davam em
HTML válido nem em `getElementById` a funcionar nos dois. `posicionarFiltros`
muda-o de sítio dentro do `tab()`: fica dentro de `#s-detalhe` por defeito no
HTML — **em PRIMEIRO, antes da barra da lista** (`#det-barra`) — e sobe para
`#s-locais` (antes do `#mapa`) quando se entra lá; ao voltar a Detalhe, desce
outra vez. A ordem já foi a inversa (a barra por cima, a procura por baixo) e
está trocada de propósito: escreve-se o que se procura e só DEPOIS se decide
como arrumar o que sobrou. É também a ordem do Catálogo da WineCatalog. Por ser o mesmo `<input>`, o texto e os filtros
ligados não se perdem ao trocar de separador.

**"MOB" é "M.O.B."** (03/10/2026, o dono das apps): a procura livre junta as
siglas escritas com pontos (`siglas`, por cima do `chave()`) — no texto do
vinho e no que se escreve na caixa —, e os parecidos do vinho novo e o
"é um da wishlist?" também (`palavrasDesejo`). Uma letra solta não é sigla
("S. Miguel" fica). É a regra da chave do catálogo (`winecatalog.tokens`,
`db/siglas.sql` da WineCatalog), que por isso também acha a linha do "M.O.B.
Lote 3" a quem escreve "MOB" (a `colheitas` da 1.ª etapa, a ligação ao
catálogo ao gravar). Mexer numa é mexer na outra.

**E "Qt.ª" é "Quinta"** (03/10/2026, o dono das apps): a mesma `siglas`
troca "Qta.", "Qt.ª", "Qtª", "Qt." e "Q.ta" por "quinta" — e a chave do
catálogo também (`db/abreviaturas.sql` da WineCatalog). Uma carta das
Sugestões escrevia "Qt.ª das Carvalhas Touriga Nacional"; a chave só
conhecia o "Qta.", ficava com um "qt" a mais, a `carta_ligar` não achou a
linha do Catálogo, e o "Procurar informação" fez nascer outra ao lado. No
PRODUTOR, a BD escreve "Quinta" por extenso (`winecatalog.produtor_oficial`,
pela qual o trigger `vinhos_nomes` daqui passa): "Qta. do Vallado" grava-se
"Quinta do Vallado". E o nome do vinho também (`winecatalog.identidade`,
a mesma conta): "Qt.ª de Cidrô Arinto" grava-se "Quinta de Cidrô Arinto".
E as castas abreviadas também, no nome, na chave e na lista das castas
(`db/castas-abreviadas.sql` da WineCatalog): "T. Nacional" é Touriga
Nacional, "Tª Roriz" é Tinta Roriz, "Cab. Sauvignon" é Cabernet Sauvignon.
E "Quinta de Cidrô", "Quinta das Carvalhas" e "Quinta dos Aciprestes" no
produtor gravam "Real Companhia Velha" (grafias da oficial), sem sair da
frente do nome do vinho (`db/marcas-do-produtor.sql` de lá). A procura no
browser não faz as castas: os nomes já chegam arrumados da BD.

### O painel abre numa FITA de campos, não numa pilha de grupos
Já foi tudo ou nada (um botão "Filtros" e onze filtros abertos por trás
dele) e já foi por **andares** (a procura, depois cor/região/castas,
depois os outros oito). O problema dos andares era o mesmo do "tudo": ao
subir ao segundo, três grupos com todas as suas opções abertas ao mesmo
tempo davam um painel mais alto do que o ecrã, e a lista — que é o que se
está a filtrar — desaparecia por baixo dele.

Agora são **dois** estados e uma fita:
- **fechado.** Só a procura livre, que fica **sempre** visível, e o botão
  "Filtros" com o número de filtros ligados ao lado.
- **aberto** (`FILTROS_ABERTO`, `filtrosToggle`). Por baixo da procura
  aparece uma **fita horizontal** (`.fcampos`, `#f-campos`) com os doze
  campos, um por pastilha, que rola de lado. Tocar num campo abre **os
  valores DESSE campo e só desse** por baixo dela (`FILTRO_CAMPO`,
  `abrirCampo`, `#f-dominio`); tocar no mesmo outra vez fecha-os.

É isso que mantém o painel baixo: o que ocupa altura é um campo de cada
vez, não três. E a fita diz quais os campos que estão a filtrar sem se
abrir nenhum — a pastilha acende (`.fcampo.ativo`) e leva a contagem de
valores escolhidos (`.fcn`).

**Um campo aberto é `.fcampo.aberto` (bordô cheio), um campo COM FILTROS é
`.fcampo.ativo` (contorno bordô).** São coisas diferentes e têm de se ver
como diferentes: um campo pode estar aberto sem nada escolhido (acabei de
lhe tocar) e pode estar a filtrar sem estar aberto (é o caso normal).

**O ESTADO fica gravado** (`gf_filtros_aberto`), o CAMPO ABERTO não: o
primeiro é como a pessoa gosta de trabalhar, o segundo é onde ela ia a
meio de uma pergunta. Por isso o arranque impõe a classe ao `#filtros`
antes de o `carregar()` responder — sem isso a barra abria-se e fechava-se
outra vez assim que os dados chegavam.

**O `<input>` da procura vive no `index.html` e NUNCA é reescrito por JS.**
Quem se repinta a cada tecla são os contentores vazios (`#f-campos`,
`#f-dominio`, `#f-activos`) — reescrever o campo perdia o cursor a meio de
uma palavra.

`renderFiltrados()` continua a ser o despachante: atualiza o painel e volta
a desenhar **Detalhe e Locais os dois**, sem tentar adivinhar qual está
aberto (o mesmo raciocínio do `renderLista()`).

**AS PASTILHAS DIZEM O QUE NÃO SE VÊ.** É a regra de sempre, agora fácil:
mostram-se todos os filtros ligados EXCETO os do campo que está aberto —
esses já se leem nos cartões acesos por cima, e repeti-los por baixo era
dizer a mesma coisa duas vezes.

### Quatro filtros são LISTAS, os outros são um valor só
Cor, região e castas aceitam mais do que um valor; os outros nove não. Não é
simetria por simetria: são as três perguntas que se fazem sempre ("um tinto
do Douro de Touriga?") e são as únicas onde escolher DUAS opções quer dizer
alguma coisa. "Tinto ou Branco" e "Douro ou Alentejo" são perguntas
legítimas; "2019 ou 2021" responde-se melhor pela organização por ano, e
"Reserva ou Grande Reserva" quase nunca se pergunta.

**O quarto é o "Em falta"** (🧩, `falta`, 02/10/2026, o dono: "as
atualizações massivas são interessantes principalmente para filtros sobre
dados em falta"): sem imagem, castas, preço, classificação, nota Vivino,
link do Vivino (um link fora do formato `/w/<nº>` conta como sem link),
harmonização, notas de prova, resumo, grau, estágio (o "Sem informação"
do filtro do Estágio) e janela de consumo (só com colheita). Não é uma
pergunta sobre o vinho mas sobre a ficha, e por isso é lista: "sem preço
OU sem nota" é o lote que se quer encher de uma vez. Sai da `FALTAS`, a
lista do card **A completar** do Resumo — UMA lista para as duas
perguntas, senão o card e o filtro diziam números diferentes para "sem
preço" (`f` é o valor no filtro, `fr` o rótulo curto, `resumo:false` só no
filtro). E liga-se à **atualização massiva** pelos dois lados: na barra da
seleção, **Marcar 10** (`loteSelVisiveis`) marca os seguintes da lista,
pela ordem em que se vêem; e os campos que enchem as faltas escolhidas
(`ia` de cada falta) vêm já marcados no passo dos campos. O "selecionados"
da barra cala-se no telemóvel, que com o botão a mais já não cabia.

Quem sabe a diferença é o próprio `F`: `ehLista(k)` pergunta se o valor
guardado é um array, e `campoToggle` acrescenta/tira num caso e troca no
outro (tocar no valor já escolhido limpa-o — é como se desmarca um campo
de valor único sem um "qualquer" postiço na lista).

**Os doze passam pelo MESMO desenho** — a fita, os cartões com contagem —
e os `<select>` nativos invisíveis por cima de chips, que os oito
costumavam usar, desapareceram com eles. Um seletor nativo não mostra
contagens, e a contagem é o que faz este painel valer a pena.

Os cartões são uma **GRELHA**, não um `flex-wrap`, e é a mesma pedra da
WineCatalog: com `flex-grow`, o último cartão de uma linha ímpar
estica-se sozinho de ponta a ponta. E o texto QUEBRA em vez de cortar —
com reticências, "Alicante Bousc…" e "Alicante Branco" são o mesmo cartão.
As colunas são `auto-fill`/`minmax(150px,1fr)` e não duas fixas: duas
colunas fixas num ecrã largo davam um cartão de 700px com "Alentejo 3" lá
dentro. O mínimo de 150px é o que garante as DUAS colunas no telemóvel
(2×150+6 cabe nos ~334px úteis do cartão, 3 não cabem) e o que impede um
cartão estreito de mais para "Península de Setúbal".

**As CASTAS têm duas regras que os outros não podem ter**
(`castasRegrasHTML`), porque só nelas a mesma escolha tem mais do que uma
leitura:

- **"todas em simultâneo"** (`CASTAS_TODAS`) — qualquer uma delas (o
  costume) ou os lotes que levam **todas**. É "levar todas", não "ser
  exatamente estas": um lote com uma terceira casta conta. Um vinho tem UMA
  cor e UMA região, "tinto E branco" não existe, e por isso o visto não
  aparece nos outros grupos. Mesmas palavras e mesmo desenho do
  `p_castas_todas` do Catálogo da WineCatalog, de propósito. Só aparece com
  duas ou mais castas escolhidas — com uma só, as duas leituras dão a mesma
  lista e o visto era uma decisão falsa.
- **"só monocasta"** (`CASTAS_MONO`) — os vinhos feitos SÓ daquela casta.
  Foi um VALOR do campo "Nº de castas", que por isso deixou de existir:
  das três respostas que esse campo dava (monocasta · várias castas · sem
  castas registadas) só a primeira se perguntava, e faz-se onde se escolhe
  a casta — "Syrah" + "só monocasta" são "os meus 100% Syrah", que é a
  pergunta a seguir à casta e não uma pergunta sobre números. (Quem quiser
  os vinhos sem castas continua a tê-los no card **A completar** do
  Resumo, que é onde essa pergunta vive.)
  **Não vive no `F` e por isso tem três pontas soltas de que é preciso
  lembrar**, todas já atadas: o `haFiltros()` pergunta-lhe à parte (senão
  "só monocasta" sozinho cortava a lista com a app a dizer que não estava
  a filtrar), o `esquecerFiltros()` repõe-no, e há uma pastilha própria
  para ele — com as castas fechadas, era a única coisa a filtrar sem nada
  no ecrã a dizê-lo.
  **E NÃO se grava**, ao contrário do `CASTAS_TODAS`. A diferença não é
  descuido: o "todas em simultâneo" só morde com castas escolhidas, e
  essas não sobrevivem ao recarregar; este morde sozinho, e gravado era
  abrir a app noutro dia com metade da garrafeira escondida.

As duas são **mutuamente exclusivas, por aritmética e não por arrumação**:
um vinho de uma casta só nunca leva duas, por isso ter as duas ligadas era
pedir uma lista que não pode existir — e a app respondia "Nada encontrado"
sem dizer porquê. Ligar uma desliga a outra, e com monocasta ligado o outro
visto nem aparece.

Com o campo das castas fechado, a regra do "todas" lê-se nas pastilhas: vão
separadas por **+** (`.fjunta`); no costume ficam lado a lado como as outras.

### Um campo é UMA definição, usada nos dois sentidos (`valorDe`)
`valorDe(v,k)` diz que valor (ou valores) um vinho tem para o campo `k`, e
é a **única** definição disso na app: `passaFiltros` usa-a para decidir se
um vinho passa, `opcoesCampo` usa-a para contar quantos vinhos dá cada
opção. Antes eram dois pedaços de código a responder à mesma pergunta —
um `switch` a filtrar e outro a contar — e duas cópias destas divergem no
dia em que alguém acrescentar um campo a uma só: o cartão a dizer "Syrah
28" com a lista a mostrar três vinhos, sem erro nenhum à vista.

Os VALORES possíveis de cada campo saem de `valoresDe(k)` — dos dados
(cor, região, castas, produtor, ano, local, menção) ou de uma lista fixa
(preço, grau, Vivino, maturação, nº de castas) — e `rotuloFiltro(k,val)`
vai lá buscar o nome por extenso para a pastilha.

### Os cartões CONTAM e CORTAM (`opcoesCampo`)
Cada cartão diz quantos vinhos dá, e é isso que separa este painel de uma
lista de caixas: escolher deixa de ser adivinhar. Sem os números, qualquer
escolha podia dar "Nada encontrado" a quem tinha acabado de tocar numa opção
que a app lhe ofereceu; com eles, um caminho sem saída nem chega a aparecer.

A regra é a da `facetas` da WineCatalog e não é detalhe: **conta-se com os
OUTROS campos aplicados mas NÃO com o próprio** — é o `ignorar` do
`passaFiltros`. É isso que faz "Branco 7" continuar visível depois de se
escolher Tinto — senão, escolher uma cor apagava todas as outras e não
havia como acrescentar uma segunda. Uma opção que dê zero não aparece; uma
ESCOLHIDA aparece sempre, mesmo a zero, senão não havia como a desmarcar.

Contar só o campo ABERTO (e não os doze de uma vez) é também o que torna
isto barato: são doze varreduras da lista a cada tecla se for tudo, uma se
for só o que está à vista.

As castas em "todas em simultâneo" são a exceção dentro da exceção: deixam
de ignorar o campo inteiro e contam POR CIMA das outras castas já escolhidas
(só a PRÓPRIA opção é ignorada). De outro modo o cartão dizia "Syrah 28" com
a lista a mostrar três vinhos.

O **"só monocasta" não obedece ao `ignorar`** e é de propósito: fica fora do
ciclo do `passaFiltros`, por isso continua a valer mesmo quando se está a
contar o próprio campo das castas, e as contagens passam a ser as dos
MONOVARIETAIS de cada casta — que é exatamente a pergunta que o cartão tem
de responder nesse modo. Ficar fora do ciclo é também o que o deixa morder
sem casta nenhuma escolhida ("mostra-me os meus monovarietais"): o ciclo
salta os campos vazios.

Duas armadilhas que as listas deixaram atrás de si: **uma lista vazia é
truthy** — daí o `filtroLigado()`, sem o qual `haFiltros()` dava sempre
verdadeiro e a app abria sempre em modo "a filtrar"; e **`esquecerFiltros()`
repõe os vistos**, porque um visto que sobrevivesse à limpeza era uma regra
escondida a filtrar por baixo na escolha seguinte.


O grupo da cor chama-se **"Cor"** e não "Tipo": é assim que a app já lhe
chama onde interessa (o vinho novo pede-a antes de qualquer procura), e é a
pergunta que uma pessoa faz. Que Espumante e Licoroso não sejam cores é
verdade, e é o mesmo compromisso que o `db/schema.sql` já faz — a coluna
chama-se `tipo` e a pergunta chama-se cor.

A **maturação** não filtra por "No ponto" — filtra pelo **terço da janela**:
*No ponto · a abrir*, *· a meio*, *· a fechar*, mais *Ainda cedo* e *Já
passou* (`valoresDe`, valores `ponto:abrir`/`ponto:meio`/`ponto:fechar`).
"No ponto" sozinho está em quase todos os vinhos e devolvia a lista quase
inteira; a pergunta que sobra é em que parte da janela se está, e *a fechar*
é a lista do que se deve beber primeiro. As palavras são as mesmas que a
ficha do vinho escreve (`FASES`) — quem filtra por uma tem de a reconhecer
quando abre o vinho.

O **estágio** (`estagioDe`, `ESTAGIO_OPCOES`) é texto livre, e nos dados
quase tudo é "barrica de carvalho francês" — filtrar pela madeira ou pela
origem do carvalho devolvia a lista quase inteira. O que varia é o TEMPO em
madeira e, nalguns, onde estagiou em vez dela. Daí nove opções num campo:
*Sem madeira* · *Madeira · até 6 meses* · *· 7 a 12* · *· 13 a 18* · *·
+ 18 meses* (e não "mais de 18 meses", que quebrava a linha no cartão) · *Tonel / balseiro* · *Ânfora / talha* · *Outras opções de
estágio* · *Sem informação* — as duas últimas garantem que TODOS os vinhos
caem em alguma (pedido do dono, 28/09/2026). Um vinho pode estar em
duas ("18 meses em tonéis" é 13–18 E tonel; uma talha é também sem madeira)
— o `valorDe` devolve lista, como nas castas. Os meses saem do TEXTO primeiro
(o primeiro "N meses" que fala de madeira ou de nada — salta "24 meses em
garrafa" e "sobre borras"; anos só com madeira à frente, senão "vinhas com
mais de 60 anos" era estágio) e o `estagio_meses` só vale quando o texto não
diz: é o texto que a ficha mostra, e o número às vezes está errado. Um
estágio sem texto e com 0 meses é *Sem informação* — é o valor por defeito
da importação, não "sem madeira"; um estágio escrito que não encaixa em
nenhuma das outras ("Estágio em barricas", sem meses) é *Outras opções de
estágio*.

`Locais` (`renderMapa`) é **um local de cada vez, a ocupar o ecrã**: a
barra com ‹ › (o nome, a contagem "**35** / 45 garrafas" e ✎ editar ao
lado), os pontos que dizem em que local se está, e por baixo as
prateleiras nível a nível — de cima para baixo como na estante a sério (o
Nível 1 é o de baixo, `prateleirasDesc`). Cada lugar é um círculo **cheio
com o nº do vinho** ou **vazio com o nº do lugar**, com a legenda no fim.

**A estante inteira tem de caber no ecrã sem scroll** — é essa a medida
de tudo o resto aqui, e é o que separa este ecrã de uma lista. Duas
coisas o garantem:
- cada nível é **uma linha só** (`.mprat-layout`): o nome encostado à
  esquerda e a estante no meio. O nome já teve linha própria por cima, com
  o filete a atravessar, e custava ~24px por nível — em oito níveis, um
  terço da altura do ecrã gasto em rótulos. E encosta-se à esquerda em vez
  de andar colado à estante: colado, mudava de sítio de nível para nível
  conforme a prateleira era mais larga ou mais estreita, e a coluna dos
  nomes deixava de se ler de uma vez. Entre os dois há um **fio tracejado
  muito leve** (`.mp-fio`), que vai do fim do nome até onde a caixa da
  prateleira começa e mais nada — é só uma ajuda a ver de que nível são
  aquelas garrafas, não uma peça do móvel. Do lado direito não há fio:
  há um **espaçador** (`.mp-esp`) do mesmo tamanho, que é o que mantém a
  estante centrada;
- **não há contagem por nível.** Era um "3/3" à direita, e o fio que lhe
  ia dar atravessava a linha inteira: o que se via era um traço contínuo
  do nome do nível até ao outro extremo, com a prateleira apanhada no
  meio. A contagem do local já está no cabeçalho ("37 / 42 garrafas");
  garrafa a garrafa lê-se na estante, que é o que este ecrã mostra;
- o tamanho de um lugar (`--slot`) é **calculado**, não escrito no CSS
  (`ajustarEstantes`). Mede-se o que sobra do ecrã abaixo do cartão e
  procura-se por bissecção o maior lugar que ainda cabe, entre
  `SLOT_MIN` (18px, onde se desiste porque o número deixa de se ler e de
  se acertar com o dedo) e `SLOT_MAX` (54px, onde deixa de fazer sentido
  crescer). Bissecção e não uma conta: a altura depende de paddings, do
  número de filas de cada formato e de quanto cada nome quebra de linha —
  refazer isso em JS era duplicar o `style.css` e ficar a discordar dele
  no dia em que alguém lhe mexesse. Corre uma vez por desenho do mapa e
  ao redimensionar, nunca por scroll.

Duas armadilhas que isto já apanhou, e que valem para qualquer coisa que
lhes toque:
- **o default do `--slot` vive no `.ml` e não no `.est`.** Uma custom
  property declarada no PRÓPRIO elemento ganha à que ele herdaria — com
  `.est{--slot:34px}` o valor calculado nunca lá chegava, e a estante
  ficava sempre do mesmo tamanho sem um erro à vista;
- **o `<svg>` da fita precisa de `width` E `height` declaradas.** É um
  elemento de substituição: a dimensão que falta sai da proporção do
  viewBox e não do `left`/`right`/`bottom` do posicionamento. Sem as
  duas, a fita ficava tão alta quanto a prateleira é larga (três vezes a
  caixa) e o que se via eram as cristas de um ziguezague gigante a
  espreitar por baixo dos lugares.

**As garrafas por posicionar (as que estão neste local mas sem um lugar
válido no desenho) vivem FORA do cartão e FECHADAS** (`mapaExtrasHTML`,
um `<details>`): são uma lista que pode ter dezenas de linhas — numa
garrafeira acabada de importar são quase todas — e aberta, ou dentro do
cartão, empurrava a estante para fora do ecrã, que é exatamente o que
este separador não pode fazer. Quem as quer ver rola até elas e abre.
Por estarem fora do `.ml`, também não entram na conta do `ajustarEstantes`.

**Tocar num lugar VAZIO põe lá um vinho** (`mapaLugarVazio`,
`guardarLugarVazio`, o `#modal-lugar`) — é a outra metade de "onde está o
quê". Até aqui só os lugares ocupados respondiam, e a única forma de
arrumar uma garrafa era abrir o vinho e usar "Mover": obrigava a saber de
antemão qual o vinho, quando a pergunta que se faz à frente da estante é a
inversa ("este buraco, o que é que lhe ponho?"). O que se guarda depende
do que já existe, e é isso que evita duplicar: se houver uma garrafa DESTE
vinho por arrumar (sem lugar), é ELA que se move para aqui — preferindo
uma que já esteja neste local; só quando não há nenhuma é que se
acrescenta uma garrafa nova. Numa garrafeira acabada de importar está tudo
por arrumar, e sem isto cada toque criava uma segunda garrafa do mesmo
vinho e a contagem inflava sozinha. No seletor, os vinhos com garrafas por
arrumar vêm num grupo à parte e primeiro — são a resposta provável.

**O + flutuante entra na conta** (`ajustarEstantes` reserva-lhe espaço):
fica por cima do canto de baixo à direita, que é onde acaba o último
nível, e com tudo a caber já não há scroll que o desvie — sem a reserva,
o último lugar ficava à vista e sem se conseguir tocar. Nota que
`offsetParent` de um elemento `position:fixed` é SEMPRE null (regra do
DOM, não sinal de estar escondido), por isso ele mede-se pelo retângulo.
O "+ Novo local" é que fica de fora do que tem de caber — é uma ação, não
faz parte da estante, e exigir que coubesse custava dois pixels em cada
lugar.

**A prateleira que encaixa SOBREPÕE-SE à de baixo** — é a sobreposição
que desenha o encaixe. Chegou a não haver nenhuma (as duas filas
separadas), por causa da FITA que a versão antiga esticava por trás dos
lugares: tapada, sobravam uns arcos soltos. Com a régua fina de agora é
ao contrário — os vales dela passam entre as garrafas de baixo, e é isso
que se quer ver. Três medidas seguram-no, e não são gosto:
- a margem é `-0,42 × slot` de pitch entre as duas linhas (a linha mede
  1,22 — o lugar mais a folga onde o berço desce), que é onde um círculo
  desviado meia coluna assenta no V entre dois de baixo;
- vive em **`margin-bottom` e não `margin-top`**: os níveis desenham-se
  do mais alto para o mais baixo (`prateleirasDesc`), por isso a
  prateleira que encaixa aparece ACIMA daquela em que assenta e o
  intervalo que tem de fechar é o de BAIXO. Com `margin-top` cada par
  encaixava no par errado, e o desenho ficava certo de longe e trocado ao
  perto;
- os lugares VAZIOS são quase opacos. Com as linhas sobrepostas, a régua
  de cima passa por trás dos lugares de baixo — e num círculo translúcido
  via-se o traço a atravessá-lo, como se a madeira lhe passasse por
  dentro.
Passa-se de local com os ‹ ›, com os pontos, ou **arrastando de lado**
(`mapaSwipe` — exceto sobre uma prateleira que rola de lado, que aí o
gesto é dela). Dá a volta: do último passa ao primeiro.

**Não há vista de conjunto nem cartões de pré-visualização.** Chegou a
haver (um local em destaque com a estante em miniatura, mais um cartão por
local) e eram dois ecrãs para a mesma pergunta: os locais são poucos,
andar de lado chega, e o que se quer ver são as garrafas. Por isso também
não há passo na história do browser nem ‹ voltar — não se "entra" em
lado nenhum, muda-se de local. `MAPA_LOCAL` é o que está no ecrã (fica no
`localStorage` como preferência e só vale enquanto o local existir;
`renderMapa()` passa ao primeiro sozinho se for apagado ou se trocar a
garrafeira). Um local sem desenho mostra a lista de sempre
(`mapaLocalListaHTML`), e as garrafas sem local entram como o local a
fingir `POR_ARRUMAR`, que não se edita.

A estante em HTML é **uma função só** (`estanteHTML`) para o ecrã do local
e para o seletor de posição da garrafa (`renderPickerPosicoes`): o formato
dá a madeira — barra na fila, bloco nos sobrepostos, e no ziguezague uma
**fita** que é um SVG esticado por trás dos lugares (`ziguezagueBgSVG`,
`non-scaling-stroke`). A grelha do ziguezague **não tem gap** de
propósito: é o que garante que a fita passa pelo centro de cada lugar
(colunas a (i-½)/cols, filas a 25% e 75%).

**OS LUGARES SÃO NUMERADOS DE FORMA CORRIDA NO LOCAL** e não dentro de
cada prateleira: um Nível 1 de 4 lugares tem 1 a 4 e o Nível 2 a seguir
começa no 5. É como se numera uma estante a sério (cada garrafa tem um
número só dela no móvel) e é como os dados desta app já estavam gravados
antes de haver desenho nenhum. Cada prateleira leva por isso um `base`
(quantos lugares vêm antes dela) e **a ordem do array é que manda**:
trocar prateleiras de ordem renumera os lugares.

Daí que o número do lugar diga sozinho em que prateleira ele está
(`prateleiraDoLugar`) — e é por isso que a chave da ocupação é o NÚMERO e
não o par prateleira+lugar. O nome gravado na garrafa passou a ser uma
confirmação: vale quando bate com a prateleira a que o número pertence, e
vale também quando está VAZIO (garrafas antigas, de antes de haver
desenho, que só têm o número). Quando CONTRADIZ o desenho, a garrafa não
entra — vai para "por posicionar", que é onde se vê que há uma
discordância para resolver, em vez de a app escolher sozinha entre duas
versões. Ao gravar, é a app que preenche o nome (`nomeDaPosicao`): no
modal da garrafa o campo da prateleira fica só de leitura num local com
desenho, porque dois campos a dizer a mesma coisa só dão para se
contradizerem.

**UM ZIGUEZAGUE SÃO DOIS NÍVEIS**, não um. Era um formato — uma
prateleira com duas filas alternadas — e não é o que está no móvel: a
fila de baixo e a de cima são prateleiras diferentes, com contagens
diferentes (4 e 3, tipicamente). Foi um entendido de vinhos que o
apontou, e os dados desta app já estavam gravados assim, com os lugares
corridos a alternar 4 e 3 — era o DESENHO que discordava deles. Sobram
dois formatos: `fila` e `sobrepostos`.

Os layouts antigos são convertidos em `layoutLocal`, **ao ler**, e não
numa migração da base de dados: assim qualquer garrafeira fica certa sem
ninguém correr nada, e os dados só mudam quando alguém guardar o local.

**Os níveis são números seguidos.** Um local que teve ziguezagues passa a
ter o dobro das prateleiras, e os nomes gravados deixam de servir de
numeração: por isso são todos refeitos, "Nível 1..N". A metade de cima
chegou a ganhar " · cima" e ficava um local com dois "Nível 8", um deles
com um sufixo — um nível é um número, não uma nota de rodapé. Renumerar
mexe nos NOMES, e o nome gravado na garrafa é a confirmação de que ela
está onde diz; daí o **`origem`**, o nome que a prateleira tinha antes da
conversão. `nomeBatePrateleira()` aceita o nome de agora, o `origem` ou
nenhum — uma garrafa que diga "Nível 8" continua no seu lugar em vez de
ir parar a "por posicionar" só porque o desenho passou a contar de outra
maneira.

O que restou do ziguezague é o **`encaixe`**: uma marca por prateleira a
dizer que ela assenta na de baixo, desencontrada. Não muda lugares nem
contagens — só o desenho:
- **`desvio`** é o desencontro horizontal em frações de coluna. Com as
  duas prateleiras centradas na mesma largura, os lugares já caem uns
  entre os outros quando as capacidades têm paridades diferentes (4 e 3);
  quando são iguais (4 e 4) ficariam alinhados e é preciso meia coluna;
- **`ondulada`** é quem desenha a RÉGUA (`ondaBgSVG`) — e é **de todas as
  prateleiras**, seja qual for o formato. Chegou a ser só das que
  encaixam, e um móvel com dois desenhos de prateleira (uma tábua maciça
  aqui, berços ali) lia-se como dois móveis: uma garrafa assenta num berço
  em U em qualquer nível, e o que o `encaixe` decide é o DESENCONTRO, não
  a madeira. Quem fica sem ela é o seletor de posição, que passa
  `ondulada:false`. É uma tira fina que faz um **berço em U**
  debaixo de cada lugar e sobe entre eles — as réguas onduladas de uma
  garrafeira a sério, onde a garrafa assenta deitada. Quatro coisas que
  se aprenderam a desenhá-la: não é uma tábua MACIÇA (preencher a metade
  de baixo lia-se como um bloco de madeira com o cimo às ondas, não como
  a prateleira que é); o fundo do berço é ACHATADO, porque uma onda de
  seno punha a garrafa a assentar num ponto só; a sombra é o mesmo
  caminho DESCIDO, não um traço mais grosso — mais grosso, ela assomava
  dos dois lados e lia-se como duas réguas paralelas; e **a régua acaba
  logo a seguir ao último berço** (`PONTA`, três décimos de coluna) e não
  na borda da caixa. Atravessar o móvel todo dava-lhe dois troços retos e
  compridos, e o que se lia era uma LINHA a ir de um extremo ao outro da
  fila, com a prateleira apanhada no meio — em vez dos U, que são o
  desenho todo. Que cada nível fique com uma régua mais curta ou mais
  comprida é o certo: é a prateleira dele; a CAIXA é que continua a ser a
  do móvel, e é ela que alinha os lugares de nível para nível. Os berços
  vão sob a fila de BAIXO e só sob ela: nos `sobrepostos` as garrafas de
  cima assentam nas de baixo, e dar-lhes berço era desenhar uma
  prateleira que não existe. E a régua é uma TIRA colada ao fundo da
  caixa, com altura própria em `--slot` — não `inset:0`: esticada à caixa
  inteira, o mesmo viewBox dava uma régua mais alta nos `sobrepostos`
  (duas filas) do que na `fila`, e os berços fugiam de debaixo dos
  lugares;
- em **`sobrepostos` de capacidade ÍMPAR** as duas filas ficam
  desencontradas meia coluna, e a de cima **assenta nos vãos** da de baixo
  (`.desenc`) em vez de flutuar por cima dela — é como se empilham
  garrafas a sério, e é o mesmo passo (0,8 do diâmetro) do encaixe entre
  níveis. Com capacidade par ficam alinhadas e apenas se sobrepõem;
- **todas as prateleiras de um local têm a largura do MÓVEL** (`colsw`: o
  nível mais largo, mais uma coluna de folga de cada lado) e os lugares
  ficam centrados nela. Antes cada prateleira valia o que os seus lugares
  mediam, e uma estante de 4/3/4/3 lia-se como uma pilha de tábuas
  irregulares. A folga é o que deixa uma prateleira desviar-se meia
  coluna sem sair da caixa.

A grelha é toda em **meias-colunas** (`gridCols = 2 × colsw`, cada lugar
com `span:2`) porque meia coluna é exatamente o desencontro que se quer, e
uma grelha de colunas inteiras não sabe fazer meio passo. As colunas têm
largura FIXA (`--colw`, tirada do `--slot`) e não frações: em frações, a
largura do lugar deixava de vir do `--slot` e o cálculo da altura passava
a discordar do que se via.

Por isso o `ajustarEstantes` decide **duas** coisas e não uma: a ALTURA
disponível dá o TAMANHO do lugar (`--slot`), a LARGURA dá o ESPAÇO entre
lugares (`--colr`, quanto mede uma coluna em lugares, entre 1,18 e 1,36).
Numa estante de poucos lugares por nível a coluna abre até ao teto; numa
de muitos, aperta-se o espaçamento antes de encolher a garrafa. Com um
espaçamento fixo, dois níveis de seis lugares num telemóvel punham o
lugar no mínimo por causa da largura, com meio ecrã de altura vazio por
baixo. O teto era 1,8 ("as garrafas devem respirar") e é aí que o
ENCAIXE se perdia: com colunas largas, a garrafa de cima cai meia coluna
à frente mas no meio de um vão onde cabia outra, e não entre duas —
ficavam filas soltas em vez de um ziguezague. Pouco mais do que um lugar
é o que as põe quase a tocarem-se, e é isso que o encaixe precisa.

**`--colr` e o passo do encaixe são medidas INDEPENDENTES** — e é preciso
que continuem a ser. O passo já saiu de uma conta a partir do `--colr`
(para os lugares se manterem tangentes à medida que o espaçamento
abrisse), e o efeito foi mexer no espaço entre NÍVEIS quando o que se
tinha pedido era ar entre as garrafas do MESMO nível. O `--colr` é do ar
dentro da prateleira; o `-0,56` do `.encaixa` é de como as prateleiras
assentam umas nas outras.

Em **`sobrepostos`** com capacidade ímpar, `mais_em` diz em que fila fica
o lugar a mais; a outra fica centrada e não encostada à esquerda, que é
como a fila mais curta assenta na de baixo num móvel a sério.

No **seletor de posição** não há onda nem desencontro (`renderPickerPosicoes`
passa uma cópia da prateleira sem eles): ali a prateleira é para se tocar,
e o que interessa é acertar com o dedo.

**O móvel está encostado a uma PAREDE, e o vão ao lado dela também guarda
garrafas** (`paredesLocal`, `layout.paredes`). Um local pode ter parede à
esquerda, à direita e/ou em cima; havendo parede, cada nível pode abrir UM
lugar de **encosto** entre o fim da prateleira e ela (`encosto_dir`/
`encosto_esq`, códigos `15D`/`15E`) e o cimo do móvel leva uma fila
(`layout.topo.capacidade`, códigos `T1…Tn`). Nenhum deles mexe na
numeração corrida: o encosto cai na coluna de folga que o `colsw` já tinha
(o `+2`) e a fila de cima é uma prateleira A FINGIR (`prateleiraTopo`), sem
`base`. Quem os conta à parte é `especiaisLocal`.

São **DUAS peças a desenhar**: a parede (o fundo) e a garrafa encostada.
A primeira versão tinha uma barra clara na borda do ecrã — lida como uma
barra de scroll do iOS, que é o que ela era: cinco pixels, cantos redondos
e uma textura em diagonal:
- a **parede** é reboco: sem cantos redondos (é no canto quadrado que ela
  encontra a do topo), sem textura, e com a SOMBRA lançada para dentro —
  essa sombra é a única pista que transforma uma tira numa parede;
- o **lugar de encosto é MENOR** do que um lugar de prateleira, e é a única
  coisa que o diz sozinho: não é um lugar do móvel, é uma garrafa de pé no
  vão ao lado dele. Do mesmo tamanho, seis encostos empilhados liam-se como
  uma sétima coluna da estante. E **vazio cala-se**: a tracejado cheio, seis
  buracos faziam a coluna mais forte do ecrã a dizer "não tenho nada aqui".

**NÃO VOLTES A PÔR O NICHO.** Houve um (`.pd-nicho`): um recesso sombreado
de uma coluna, do primeiro ao último encosto, medido no
`posicionarParedes`. Existia para resolver o "as garrafas estão a
flutuar" — a régua de cada prateleira acaba logo a seguir ao último berço
(de propósito: uma garrafa encostada não está deitada na prateleira), e
sem nada por baixo o círculo ficava suspenso no ar. O remédio saiu pior
do que a doença: o que se via era uma MANCHA CINZENTA de vários níveis de
altura encostada à borda do ecrã — o elemento mais escuro de um separador
feito de madeira clara, a tapar meia estante para dizer "aqui ao lado não
há prateleira". As garrafas de encosto já se dizem sozinhas: são menores
do que um lugar do móvel, e a parede atrás delas diz onde estão.

**O móvel acaba UMA vez, e é em cima** (`.est-topo`). A fila de cima teve
uma tábua de madeira colada por baixo, a fazer de tampo — e com o tecto
(`.pd-h`) por cima dela ficavam duas barras a dizer a mesma coisa, uma de
cada lado das garrafas: o fim do móvel desenhado a dobrar. Fica só o
tecto, em cima.

**E não há vão nenhum por baixo: estas garrafas ASSENTAM NAS DO ÚLTIMO
NÍVEL.** Ficaram a um terço de lugar de distância (o `padding-bottom` da
`.est-topo`) e o espaço lia-se como uma prateleira que falta — como se
houvesse ainda uma madeira invisível a segurá-las. A fila de cima encosta
às garrafas de baixo com o MESMO passo de qualquer outro nível
(`.mprat-layout.mp-emcima`, `margin-bottom` negativo): é o encosto que diz
em que é que ela assenta.

**E a fila de cima fica CENTRADA**, como todas as outras. Encostava-se à
parede que houvesse (era o `alinha` do `prateleiraTopo`, que já não
existe), e o que se lia não era uma fila em cima do móvel: era uma
prateleira torta, com todos os níveis centrados e esta a fugir para um
lado. Quem diz que estas garrafas estão em cima é o sítio onde a fila
está — acima de tudo, debaixo do tecto — não o canto a que encosta.

O rótulo da fila de cima **não leva dourado**. Levou, e é o erro clássico
nesta app: o dourado é a distinção do VINHO (menção, nota do Vivino) e
gastá-lo a dizer "esta fila fica mais acima" é gastar a única cor que quer
dizer alguma coisa. O que a separa dos "NÍVEL n" é já não ser um número —
fica em itálico, sem o espacejamento de versalete.

No editor, os encostos só aparecem depois de a parede desse lado estar
ligada (sem parede não há vão) e usam a **mesma pele** do "Encaixa na de
baixo" (`ll-enc`). Um `.chk` genérico não serve: dentro de um modal,
`.mbox label` ganha-lhe (duas classes contra uma) e punha o rótulo em
MAIÚSCULAS a 10px, em bloco e sem quebrar linha — saía pela borda do cartão
fora ("CABE U…") com a caixa nativa azul por baixo.

**Isto vale para QUALQUER visto dentro de um modal**, e foi o que apanhou o
"Vem em caixa de madeira" do modal da garrafa: nasceu `.chk` e saía
exatamente assim ("VEM …" cortado, a caixa nativa azul por baixo). É o
mesmo visto do editor do local, tem de se ver igual — `ll-enc`, sempre.

Com a procura ligada, só se anda pelos locais com garrafas que passam nela
(a contagem passa a "4 encontradas · de 35") e a estante responde em **três
pesos**, não em dois (`.ml.procurando`, o bloco "O LUGAR DURANTE A PROCURA"
no `style.css`):
- **encontrada** (`.msdot.achada`) — o vidro escurece e ganha um **arco** à
  volta. É um destaque a sério e não a ausência de apagado: sem ele, a
  resposta ficava com exatamente o aspeto que tem quando não se procura
  nada, e era preciso saber de cor como é a estante em repouso para
  perceber o que tinha sido encontrado. Bordô e não dourado — o dourado é a
  distinção do VINHO (menção, nota do Vivino) e uma garrafa encontrada não
  distingue vinho nenhum: é a app a apontar para o que lhe perguntaram, o
  mesmo que o sombreado da `.vc-match` faz no cartão;
- **ocupado mas não passa** (`.msdot.fora`) — apagado, como sempre foi;
- **vazio** — baixa de contraste enquanto se procura. Não é resposta a
  pergunta nenhuma, e branco sobre madeira era o maior contraste do ecrã:
  gritava mais alto do que a garrafa encontrada.

O arco é feito só de `box-shadow` (e de uma medida em `--slot`) porque
`box-shadow` **não ocupa espaço de layout** — um `outline` ou uma `border`
mais grossa mudavam a altura do lugar e o `ajustarEstantes` passava a
discordar do que se vê. Pára nos `.09` de `--slot`: o vão entre dois
lugares vizinhos é `(--colr - 1)`, que no mínimo (1,18) dá `.09` de cada
lado — mais do que isso e dois arcos lado a lado colavam-se num só.

**E os estados do lugar vivem NO FIM da folha, depois das três peles de
prateleira** (`.est-fila`/`.est-sobrepostos`/`.est-regua`), nunca ao pé do
`.msdot`. `.est-fila .msdot` e `.msdot.fora` têm a MESMA especificidade
(duas classes cada), por isso ganha a que vier por último — e era a pele, a
repintar o ponto a bordô cheio. O apagado da procura esteve **morto** assim
nas três peles, sem um erro à vista: procurava-se e a estante não mexia um
pixel. Um estado novo do lugar entra nesse bloco. Pela mesma razão o arco
vive numa variável (`--arco`): `.msdot.cheia:hover` tem mais especificidade
e, sem ela, passar o rato por cima apagava-o.

Em **Definições › Locais da garrafeira** cada local é uma `.loc-row`: o ponto
da cor, o NOME numa linha só dele e, por baixo, o que ele é — a contagem de
garrafas, a descrição, as prateleiras. Os dois comandos ficam **juntos, num
grupo com moldura** à direita (`.loc-acoes`), em SVG e não em emoji. Era a
`.ua-row` dos utilizadores e não servia: ali o texto leva `flex:1 1 100%`
(ocupa a linha toda e empurra o resto para baixo) e **cada** `.jdel` leva
`margin-left:auto` — o lápis ficava a meio de uma linha vazia e o ✕ no
extremo oposto, a lerem-se como comandos de coisas diferentes, com a
contagem entalada entre os dois. A contagem é informação, e informação
lê-se no texto, não entre botões.

O **editor do local** (`abrirLocalModal`, `renderLocalLayoutEditor`) é uma
linha por prateleira: o nome editável no sítio (sem caixa — é um título),
e por baixo **Formato** e **Lugares**. O formato é um botão com os
pontinhos do desenho atual (`prateleiraPreviewHTML`) que abre a folha
"Formato da prateleira" (`#modal-formato`, `abrirFormatoPrat`) com as três
opções ilustradas — um `<select>` não mostra desenhos, e aqui a diferença
entre os três É o desenho. A folha abre por cima do modal do local e o
Escape fecha só a folha. O terceiro campo (`MAIS_EM`) só aparece onde tem
resposta — "Começa" no ziguezague, "Lugar a mais" nos sobrepostos ímpares
— e a prateleira nova copia a anterior, que numa estante os níveis são
quase sempre iguais.

Quando a procura tem **texto**, cada cartão que passou por causa de um campo
que o cartão não mostra ganha a **faixa do match** por baixo — ver "A
linguagem visual". `renderDetalhe` passa os termos (`termosProcura()`) ao
`vinhoCardHTML(v,termos)`; sem termos, o cartão é exatamente o de sempre.

`Detalhe` (`renderDetalhe`) é a lista organizada por região, por ano ou por
casta (`agruparVinhos`, `detAgrupar`) — **sem filtro nenhum** por defeito
(a lista toda), e com a mesma organização mas só os vinhos que passam na
procura quando ela tem alguma coisa ligada (`haFiltros()`).

**A barra da lista (`.dbar`) NÃO é um cartão** — era, e com a procura a
passar para cima dela ficavam dois cartões encostados que se liam como dois
painéis, quando isto é só a legenda da lista que vem a seguir. Sem moldura,
o cartão que se vê é o da procura, que é o que se usa; a contagem e os
comandos flutuam sobre o papel. Mesmo desenho da `.cat-barra` do Catálogo da
WineCatalog: contagem à esquerda, comandos à direita. Em troca, os grupos de
botões (`.segbtns`) ganham o fundo de CARTÃO que a barra perdeu — um botão em
tom de papel sobre papel deixava de se ler como um comando.

**O topo do separador tem três pesos, e é isso que o segura**: os
separadores são uma pílula em tom de papel (`--bg2`), a procura é um cartão
BRANCO, a barra da lista não tem moldura nenhuma. Antes eram três lozangos
brancos do mesmo tamanho e do mesmo feitio empilhados, e nenhum mandava —
foi essa a queixa. Duas medidas fecham-no:
- **a caixa de texto é que tem cantos de PÍLULA** (`.fsearch-box`), dentro
  do cartão: é assim que uma caixa de procura se parece, e é o que a separa
  do painel que abre por baixo dela. Foram os CANTOS DO CARTÃO inteiro a
  mudar de raio conforme estava aberto ou fechado — deixou de fazer falta
  quando a procura passou a ser uma caixa própria lá dentro, sempre igual;
- **a SOMBRA fica nas duas.** Tirá-la à fechada foi a primeira tentativa de
  aliviar o topo e deu nisto: `--card` (#fffdfb) sobre `--bg` (#f6f1ea) com
  um bordo `--bo` é diferença a menos — a barra desaparecia no papel. É a
  sombra que a põe à tona, e é por isso que os `.segbtns` da barra, esses,
  NÃO a levam: são pequenos, têm um botão bordô aceso lá dentro e uma sombra
  a mais punha-os ao nível do cartão de cima.

A ordem dentro dela é **contagem · agrupamento · vista**, e o agrupamento
leva um **⇅** à frente (`.segico`), FORA da pílula: dentro, ocupava uma
célula do tamanho de um botão e lia-se como um quarto botão apagado. É uma
MARCA, não um interruptor: diz que os três botões a seguir arrumam a lista,
porque sem ele "Região · Ano · Casta" lia-se como mais um filtro, encostado
aos filtros que estão mesmo por cima. E `.dbar-a` leva `margin-left:auto`
por causa do `flex-shrink:0`: sem ele, e com `space-between` sozinho, um
item que encolhe deixava os comandos a boiar.

**A barra é `flex-wrap:nowrap`, e a contagem das GARRAFAS esconde-se abaixo
dos 560px** (`.det-gar`). Tinha duas alturas: uma com "8 vinhos · 11
garrafas" e outra com "170 vinhos · 210 garrafas", que quebrava a linha e
empurrava a ordenação e a vista para baixo — a barra mudava de feitio
consoante o que o filtro tinha deixado passar. `min-width:0` na contagem
não o evita: quem decide quebrar a linha num `flex-wrap` é a largura de
CONTEÚDO de cada item, não o mínimo declarado. O número que fica no
telemóvel é o dos VINHOS, que é o que a lista mostra; as garrafas
continuam à vista no painel da procura logo acima. Não há ascendente/descendente para trocar — a ordem DENTRO de cada
grupo é sempre a nota do Vivino (`ordenarPorVivino`), e o que estes três
botões escolhem é por que critério se AGRUPA (`agruparVinhos`). Se um dia
houver ordenação a sério, é este ⇅ que passa a interruptor.

**Dentro dos grupos há duas vistas: lista ou grelha** (`DET_VISTA`,
`detVista`, os dois botões de ícone na `.dbar`). É **ortogonal** ao
agrupamento — os grupos de região/ano/casta são os mesmos, só muda o que
está lá dentro — e a escolha guarda-se (`gf_det_vista`): é uma preferência
de quem usa, não um estado do ecrã. Daí o `detVistaBotoes()` à parte,
chamado também no arranque; o HTML nasce com "Lista" ligada e sem isso quem
tinha deixado a grelha via os dois botões a mentir.

A grelha (`vinhoGrelhaHTML`) **não é o cartão da lista encolhido — é outra
pergunta**. Na lista lê-se o que um vinho É (castas, menção, preço,
maturação, onde está); na grelha procura-se um RÓTULO que já se viu, e por
isso a garrafa cresce e o resto encolhe até ao que identifica: nome, ano,
produtor/região e a NOTA do Vivino, numa linha só dela. Ficam de fora os
crachás: numa coluna de 150px cada um é uma linha a mais, e o que se perde
é a fotografia, que é a razão de a grelha existir. **O "onde está" saiu
daqui** — ele e a nota disputavam a mesma linha, e a nota (que é o que faz
escolher entre dois rótulos) ficava a competir com um "Sala +1" que já se
lê na lista e na ficha do vinho. A faixa da
procura entra nas duas — na grelha com mais razão ainda, que o cartão
mostra menos — e é a MESMA `trechosMatch`, nunca uma segunda versão mais
curta; só o CSS a empilha (o nome do campo por cima do trecho), porque
lado a lado "HARMONIZA COM" comia a coluna toda e sobrava "… pratos".
A garrafa tem `max-width` de propósito: sem tecto, num ecrã largo cada
vinho virava um poster e a grelha deixava de dar muitos rótulos de uma vez.
O `sitiosDe()` saiu para fora do cartão da lista para as duas vistas
contarem os sítios da mesma maneira.

**Os cartões de uma mesma linha da grelha têm a mesma altura, e o que está
dentro deles alinha** (01/10/2026, o dono das apps: um nome de duas linhas
ao lado de um de uma deixava a origem, o produtor e as notas
desencontrados). É `subgrid`: cada `.vgcard` ocupa SEIS filas da
`.vgrelha` — garrafa, nome, origem, produtor, notas, faixa da procura — e
partilha-as com os vizinhos da mesma linha. Cada fila mede o que mede a
mais alta dessa linha, e o que é mais baixo fica centrado nela: o nome de
uma linha fica a meio das duas do vizinho. Três coisas que isto obriga:
- **o produtor e as notas vão SEMPRE no HTML, mesmo vazios**
  (`vinhoGrelhaHTML`), e dentro do `@supports` não podem ter
  `display:none` — um item que desaparece faz subir os seguintes para a
  fila errada. A faixa da procura pode faltar porque é a última;
- **o `row-gap:0` do cartão** é o que impede as peças de herdarem os 10px
  que separam os cartões; o espaço entre elas é o das margens de sempre;
- **a faixa da procura estica-se** (`align-self:stretch`) para chegar ao
  rebordo de baixo mesmo quando a do vizinho tem mais linhas.
Sem `subgrid` (browsers antigos) fica como era, cada cartão com a sua altura.

Por **casta** vêm primeiro os monocasta, um grupo por casta ("100% Syrah",
"100% Touriga Nacional", por ordem alfabética), e só no fim "Várias Castas"
— é a pergunta "o que é isto, puro?" antes da mistura. Dentro de QUALQUER
organização (região, ano ou casta), os vinhos vêm ordenados pela nota do
Vivino, do melhor para o pior (`ordenarPorVivino`) — sem nota fica no fim,
por nome.

A lista exporta-se para PDF em Definições › Dados, ao lado do JSON
(`exportarPDF`). Sem biblioteca nenhuma, que aqui não há build: monta-se um
**documento completo** — o seu próprio `<html>`, com o seu próprio CSS
(`PDF_CSS`) — abre-se numa **pré-visualização** (`pdfPreAbrir`) e é o botão
dessa barra que chama o `print()` do documento (`pdfPreImprimir`); quem
imprime escolhe "Guardar como PDF". A folha vai na horizontal porque são
doze colunas, e os grupos são os mesmos que estão no ecrã (a organização
escolhida em Detalhe, mesmo exportando a partir de Definições).

**O documento vive num `<iframe srcdoc>` e nunca na página da app** — e não é
detalhe de arrumação, é a correção do bug de a folha sair em branco. Antes a
tabela era montada num `#print-area` dentro da app, com um `@media print` a
esconder tudo o resto (`body>*{display:none!important}`) e o `window.print()`
a sair de dois `requestAnimationFrame`. Três maneiras de sair papel vazio:
a folha ficava refém da cascata do `style.css` (um modal `fixed`, o `@page` a
discordar do iOS); o `afterprint` limpava o `#print-area` **antes** de o
WebKit ter acabado de rasterizar o trabalho — daí ser "muitas vezes" e não
sempre; e o `print()` fora do gesto do utilizador é travado pelo Safari
("impedido de imprimir automaticamente") e nem chega a correr num telemóvel
que troca de ecrã. Isolado no iframe, nada da app lhe toca, nada é apagado por
baixo do trabalho de impressão, e o `print()` sai de um clique a sério.
Se houver uma segunda folha um dia, passa pelo `pdfPreAbrir`/`pdfDocumento` —
não voltes a montar um documento à mão nem a imprimir a página da app.

**A tabela usa `border-collapse:separate` (com `border-spacing:0`), nunca
`collapse`.** É um bug antigo do WebKit/Chromium: com `collapse`, o
`break-inside:avoid` de uma `<tr>` costuma ser ignorado. Fica como rede de
segurança de baixo custo — mas não é ele que garante nada a sério, ver
abaixo. Visualmente não muda nada — a tabela só tem `border-bottom` (nunca
laterais nem topo), por isso não há bordos a duplicar-se nos cantos que o
`collapse` evitava. Se um dia precisares de bordos verticais, tem isto em
mente antes de os acrescentar.

**AS QUEBRAS DE PÁGINA CALCULAM-SE EM JS (`calcularQuebras`, dentro do
`PDF_SCRIPT`), não se deixam ao motor de impressão.** Havia só CSS
(`break-inside:avoid` na `<tr>`, `break-after:avoid` no cabeçalho do
grupo) — e um vinho com garrafas em locais diferentes (linha alta, várias
sub-linhas) continuou a sair **cortado a meio entre duas páginas num
iPhone a sério** (AirPrint/WebKit), mesmo com `border-collapse:separate`.
Confirmado com o PDF real de um utilizador: a linha de um "Carmim" com
garrafas em dois locais tinha o produtor, as castas e o "onde está" a
começar numa página e a acabar na seguinte. `avoid` é um PEDIDO ("se
puderes, não partas isto") e este motor, quando a linha não cabe no que
sobra da página, ignora o pedido e parte-a na mesma — não há CSS que force
isso a sério. A spec tem outro mecanismo, **fragmentação forçada**
(`break-before:always/page`), que É uma ordem e todos os motores
respeitam — e é aí que a correção se agarra:
- Antes de imprimir, mede-se a altura REAL de cada `<tr>` **sob o CSS de
  impressão** — a classe `.medir-impressao` ativa por CLASSE (não por
  `@media`) as mesmas regras do `@media print` (`PDF_CSS_IMPRESSAO`,
  gerada uma vez só e reaproveitada nos dois sítios por `cssComPrefixo` —
  nunca escrevas essas regras a dobrar, ou um dia deixam de bater certo);
- **a LARGURA da medição é a do PAPEL, imposta em `.pwrap` durante a
  medição** (`larguraUtil`, os mesmos 297mm do `@page` menos as margens),
  nunca a do ecrã onde a pré-visualização está aberta. Sem isto, um
  telemóvel estreito (390px) media a tabela toda enrolada — mais palavras
  a quebrar linha, linhas mais altas, quebras a mais e no sítio errado —
  e dava um número DIFERENTE do de um ecrã largo para o MESMO documento
  (foi assim que se apanhou o bug: desktop e telemóvel discordavam);
- a linha que não cabe no que resta da página leva a classe
  `quebra-pagina` (`break-before:page`), e só essa. Como cada página passa
  a começar exatamente onde este código disse, o motor nunca chega a ter
  de decidir "isto não cabe, corto ou empurro?" — a pergunta que ele
  responde mal deixa de se pôr;
- o cabeçalho de um grupo é medido **junto com o vinho a seguir**: se os
  dois não cabem, a quebra fica ANTES do cabeçalho, nunca entre ele e o
  primeiro vinho — por isso não há `break-after:avoid` na `.pgrupo` no
  CSS: com as quebras já calculadas ao pormenor, um `avoid` a mais só
  arriscava discordar do que este código decidiu.

**O `<script>` do `PDF_SCRIPT` vem ANTES de qualquer `<link
rel=stylesheet>` no `<head>`, nunca depois.** Um script clássico colocado
DEPOIS de uma folha de estilos pendente espera por ela antes de correr —
é regra do próprio browser, para o caso de precisar do CSSOM — mesmo este
código nunca olhando para CSS nenhum. Com a rede das Google Fonts lenta
ou em baixo, isso atrasava (ou travava) o `calcularQuebras()` sem
necessidade nenhuma. Por vir tão cedo, a tabela ainda não existe quando
este script corre; por isso espera pelo `DOMContentLoaded` (que não
depende de CSS nenhum, ao contrário de `load`) antes de tocar no DOM.

**`document.fonts.ready` NÃO TEM PRAZO** — sem rede (ou com uma ligação
parva a meio caminho) pode nunca resolver, e o botão "Imprimir" ficava
preso em "A preparar…" para sempre, pior do que o problema que isto veio
corrigir. Por isso tem um limite de 3s (`semPrazo`): passado isso,
mede-se com o que houver (Georgia/system-ui, já na cascata) em vez de
continuar à espera. E o código exterior (`pdfPreAbrir`) que espera pela
promessa **espreita-a repetidamente em vez de esperar pelo `load` do
iframe** — `load` só dispara depois de TODOS os recursos, incluindo essa
mesma folha de estilos lenta, o que dava o mesmo problema visto de fora.

**O botão "Imprimir" nasce DESLIGADO e só liga quando `calcularQuebras()`
já correu.** É o que evita o `pdfPreImprimir()` ter de dar `await` numa
promessa antes do `w.print()` — um `await` ali tirava a chamada de dentro
do gesto síncrono do clique, e é exatamente isso que o Safari trava como
"impressão automática" (a mesma lição do `afterprint`/`rAF` lá em cima).

**`w.focus()` (antes do `w.print()`) desloca o foco do teclado para
dentro do iframe — e sem o repor, o Escape deixava de fechar a
pré-visualização** (o `keydown` da app não recebe eventos de outro
documento). `pdfPreImprimir()` chama `window.focus()` depois de imprimir,
de propósito.

`renderLista()` ficou como o despachante chamado depois de QUALQUER
mutação (guardar, apagar, consumir, mover): chama `renderResumo()` e
`renderFiltrados()` (que por sua vez refaz Detalhe e Locais), sem tentar
adivinhar qual separador está aberto — o dataset é pequeno, refazer tudo é
mais simples e mais seguro.

## O Catálogo dentro da app (fase 1, 30/09/2026, o dono das apps)
"Quero incluir na garrafeira o catálogo de vinhos" — a WineCatalog passa a
ser o back-office. **Tocar no título do cabeçalho ("Garrafeira ⇄") troca
para o Catálogo** (`modoAlternar`, `MODO`): o cabeçalho fica verde-garrafa,
o título passa a "Catálogo", e só ficam o Resumo, o Detalhe, as **Sugestões**
(ver abaixo) e as Definições (abre no Detalhe). Não se
grava: a app abre sempre na garrafeira. Decisões do dono:
- **É o MESMO Detalhe e a MESMA página do vinho**, com outra fonte. Os
  filtros varrem `vinhosUniverso()`/`vinhosBase()` (o catálogo ou a
  garrafeira), e o campo Local não aparece no catálogo (`camposVisiveis`).
- **Toda a gente que entra vê o catálogo inteiro** (decisão de 30/09/2026):
  `garrafeira.catalogo_vinhos` (migração 31) dá a FICHA de cada linha, nunca
  quem a tem nem de onde veio cada campo. ~300 linhas de uma vez (~380 KB,
  só da primeira vez que se abre); se passar dos milhares, pagina-se ali.
- **Os vinhos do catálogo têm o id NEGATIVO** (`catNormalizar`: `-id`). É a
  marca `v.id<0` em todo o lado, não colide no `IDXV` nem nos `onclick`, e os
  preços deles vivem em `CAT_PRECOS` (o `precosLojaDe` escolhe).
- **O cartão diz o que tenho** ("🍾 Na tua garrafeira", "⭐ Na tua wishlist",
  `catTensHTML`) pela ligação `catalogo_id` (e as linhas fundidas nela). E
  di-lo também um **selo redondo no canto de cima à esquerda do CARTÃO**,
  meio fora dele (`catSeloHTML`, 01/10/2026, o dono; esteve no canto da
  imagem e tapava a garrafa): uma garrafa em verde-garrafa = tenho, estrela dourada = wishlist,
  visto em papel = já bebido — a mesma regra do crachá (`catEstado`), que na
  lista fica (com o texto, e com a cor do estado) e na grelha sai (o selo
  já o diz). **O número de garrafas não vai no cartão** (o dono, 01/10/2026):
  só na página do vinho, em "Na tua garrafeira". Foi o FUNDO do cartão (`catFundoCls`, verde/dourado) até o
  cartão passar a dizer a COR do vinho (ver "A linguagem visual"). A
  página troca o "Onde está" por **"Na tua garrafeira"** (`catNaMinhaHTML`):
  uma linha baixa por vinho meu ligado — "🍾 2 garrafas na garrafeira",
  "⭐ Na wishlist" ou "📖 Já bebido" — e o **Ver**, sem o nome (é o da
  página; a colheita só quando não é a desta linha). **Pôr na garrafeira /
  Pôr na wishlist** (`catPor`: o formulário do vinho novo de sempre, já
  preenchido e aberto por inteiro) só aparecem quando ainda não o tenho nem
  o quero (01/10/2026, o dono das apps): com ele na garrafeira ou na
  wishlist o caminho é o Ver; já bebido conta como não o ter. Saem as minhas notas, o
  comentário e o Apagar (o Procurar e o Editar só a quem corrige o catálogo,
  a seguir); a capa é verde (`.mhero-cat`).
- **O "Procurar informação" num vinho do catálogo** (30/09/2026, o dono:
  "quando entro no detalhe de um vinho, não tenho opção de procurar
  informação") — só aos curadores e ao admin do catálogo (`catPodeCriar`), e
  com IA. É o MESMO ecrã (`catAbrirProcura`), sem a etapa do Catálogo (é a
  linha) nem a frase a dizê-lo — estando no Catálogo, "este vinho é do
  Catálogo" não diz nada (o dono, 30/09/2026); a revisão diz só que guardar
  muda o vinho para toda a gente —, sem a da cor, sem o aviso da última procura e sem
  `vinhoId` na `vinho-info` (o id é do catálogo, não de uma garrafeira). O
  que se marcar corrige a LINHA pela `winecatalog.editar` (`pqGuardarCat`,
  origem `catalogo-curador`/`catalogo-admin`); o produtor vai à parte, com o
  interruptor da identidade — se a linha passar a ser outra, a `editar`
  recusa e o resto fica. Como em qualquer procura da Garrafeira, a
  `vinho-info` já enche sozinha, com força 2, os campos vazios de um nome que
  o catálogo conhece: o Guardar é o que decide por cima.
- **E o Editar** (30/09/2026, o dono: "incluir as operações de procurar
  informação e editar, no catálogo, para quem tem acesso") — aos mesmos
  (`catPodeCriar`), com ou sem IA. É o formulário do Editar de sempre
  (`abrirEditarVinho` com o id negativo), sem o formato das garrafas nem as
  minhas notas, e grava pela `winecatalog.editar` (`catGuardarEditar`). **Só
  vai o que mudou** em relação à linha (`catIgual`): mandar o formulário
  inteiro apagava lá o que a `catalogo_vinhos` por acaso não trouxesse. Um
  campo esvaziado apaga-o no catálogo, e um link do Vivino fora do formato
  não se grava. O nome, o produtor e o ano vão numa segunda chamada, com o
  interruptor da identidade (e chegam às garrafeiras ligadas — é a regra do
  catálogo); se a linha passar a ser outra, a `editar` recusa, o toast di-lo
  e o resto fica gravado.
- **O "+" só onde se acrescenta** (`fabSincronizar`): o Detalhe da
  garrafeira e a Wishlist (aí vai direto a "Adicionar à wishlist"). Nem no
  Resumo (o separador "Garrafeira" passou a chamar-se **Resumo**), nem em
  Locais, Consumidos, Definições. No catálogo, no Detalhe e só aos
  curadores (ver "A atualização massiva e a importação no Catálogo").
- **O Resumo do catálogo** (30/09/2026, o dono) é o MESMO `renderResumo`
  sobre o catálogo inteiro (`cat`), com três diferenças: sem **Valor
  estimado**; os cartões **Tintos** e **Brancos** (abrem "Vinhos por cor");
  e, em vez da região e da casta preferidas, **Top Região Tintos / Brancos**
  e **Top Casta Tintos / Brancos** (painéis `regiao_tinto`… com a contagem
  só dessa cor). O que está aberto fecha-se ao trocar de modo.
- **A atualização massiva e a importação no Catálogo** (02/10/2026, o dono:
  "no separador do Catálogo, não tenho atualização massiva ou importação por
  fotos"). O "+" do Catálogo é o MESMO menu da garrafeira, menos a wishlist
  (`.so-gar`): Vinho novo, Atualização massiva, Importar por imagens — aos
  curadores e ao admin do catálogo (`catPodeCriar`), mesmo com uma
  garrafeira emprestada aberta (o `fabSincronizar` tira-lhe o `ro-hide` no
  catálogo). São os mesmos ecrãs; muda para onde se grava:
  - **a atualização massiva** escolhe na lista do Catálogo e grava cada
    vinho pela `winecatalog.editar` (`iaAplicarCat`, origem
    `catalogo-curador`/`catalogo-admin`), como o "Procurar informação" de um
    vinho do catálogo. Sem o produtor nem o ano (identidade — vão pelo
    Editar, `iaCampoFora`); o catálogo relê-se UMA vez no fim do lote
    (`LOTE_CAT_MUDOU`). Os ids vão à `vinho-info` e ao prompt manual em
    valor absoluto (`loteIdPedido`): o "-123" é o que um modelo copia mal.
    Como na procura de um vinho, a `vinho-info` responde primeiro com o
    catálogo — num campo que a linha já tem (e não envelheceu), a IA não é
    chamada e não há nada a propor;
  - **a importação por imagens** lê pela mesma `importar-vinhos` (que grava
    o pedido numa garrafeira em que se pode mexer: a aberta se for minha,
    senão a minha — `importarGid`) e cria cada vinho escolhido pela
    `winecatalog.criar` (`importarGuardarCat`), sem garrafas. A cor é
    obrigatória — é chave da linha, e a leitura põe "Tinto" quando não a vê
    —, por isso a revisão pede-a no lugar das garrafas e do formato. Uma
    recusa (o vinho e a colheita já lá estão) não pára os outros: fica dita
    ao pé do botão, com esse vinho ainda marcado.

### As notas da casa (30/09/2026, migração 33)
O dono das apps: "gostava que os utilizadores da garrafeira pudessem dar
notas/avaliações aos vinhos do catálogo (notas de 0 a 5, com possibilidade de
colocar valores decimais - uma casa apenas)". Na página de um vinho do
catálogo, **"A tua nota"** (`catNotasHTML`): as cinco estrelas e, ao lado,
um **seletor que se roda** (`select.cn-roda` — no iPhone, a roda nativa do
`<select>`) de 5,0 a 0,0, de décima em décima, mais o "—" de sem nota; de
cima para baixo, porque as notas que se dão estão quase sempre lá em cima.
**E mais nada** (01/10/2026, o dono das apps: "retira todos os comentários,
deixa só as estrelas e o campo"): saíram a linha de ajuda por baixo das
estrelas e a média de quem usa a Garrafeira — essa lê-se no cartão. Era uma
caixa de texto livre, e o dono pediu "daqueles seletores que rodo para cima
ou para baixo". Tocar na estrela da nota que já se deu tira-a; o "—" também.
No cartão, o **G** da app
e a média (`catNotaBdgHTML`; o G é o `nota-g.png`, no `::before` do
`.cat-nota`): branco com a letra dourada, ao lado da do Vivino, que é
dourada com a letra cor de vinho (01/10/2026, o dono das apps; era 👥 em
papel). Na LISTA as duas vão à direita do nome, uma por baixo da outra
(`.vc-anofloat`); na GRELHA lado a lado. Nos cartões só a média — quantas
notas são diz o `title` e a página do vinho.
- **Não é do vinho, é de uma pessoa**: vive em `garrafeira.notas_catalogo`,
  nunca na ficha do catálogo (a invariante 1 da WineCatalog). Só se lê pela
  `catalogo_notas()` — a média, o número e a MINHA; nunca quem deu qual
  (invariante 2) — e escreve-se pela `catalogo_nota_definir`. Um vinho
  fundido responde pela linha que ficou.
- **Não é a nota de um consumo** (`garrafas.consumo_avaliacao`, 1 a 5, de uma
  garrafa bebida): esta vai de 0 a 5 e é dada no Catálogo, sem garrafa.
- Lê-se com o catálogo (`catCarregar`); sem a migração, a secção não aparece
  (`TEM_NOTAS_CAT`).
- **Dois filtros só do Catálogo** (01/10/2026, o dono das apps): **Nota da
  casa** (a média, nas faixas do Vivino) e **A minha nota** (dei nota · ainda
  sem nota minha). Estão no `F_CAMPOS` mas só aparecem no catálogo e com a
  migração (`F_SO_CAT`, `campoVisivel`); fora disso o `passaFiltros` salta-os,
  e trocar de modo limpa-os — como o Local, ao contrário.

### As Sugestões: que vinho peço? (30/09/2026, por passos desde 03/10/2026)
Nasceram como a página "Sugerir" da WineSelection transposta (30/09/2026, o
dono das apps: "teríamos um separador de Sugestões, onde importaríamos
aquela página da WineSelection (que depois descontinuarei)"), com as Edge
Functions de lá — `sugerir-vinho` lia a carta, perguntava ao catálogo e
recomendava, tudo de uma vez; `verificar-vinhos` fazia a "pesquisa a sério",
e ao admin ainda havia a profunda e o 🧠. O dono, a 03/10/2026: "quero mudar
aqui a mecânica da coisa … aquilo da pesquisa simples e pesquisa avançada, é
confuso!". Agora são **passos**, cada um à vista, e todos da Garrafeira
(secção "SUGESTÕES" no app.js, `ws*`; a Edge Function `garrafeira-carta.ts`;
a migração 40; o CSS debaixo de `#s-sugestoes`):
1. **Ler a carta** (`wsLer` → `garrafeira-carta`, `acao:'ler'`): as fotos, o
   prato e o orçamento. É SÓ a transcrição — os vinhos, com produtor, ano,
   cor, região e preço da garrafa — guardada em `garrafeira.cartas`, em
   segundo plano (a app sonda a linha, e retoma-a se se sair da app). A cor
   pede-se com as palavras da Garrafeira (Tinto · Branco · Rosé · Espumante ·
   Licoroso · Frisante; um Vinho Verde diz-se pela cor): é a chave do
   catálogo. **E no fim da leitura, a ORDEM** (`ordenarCarta`, 03/10/2026, o
   dono: "a ordem dos vinhos que aparece podia aparecer pela sugestão do
   Gemini"): uma chamada só de texto que ordena os vinhos que cabem no
   orçamento pelo interesse para o prato — a harmonização provável, a
   reputação do vinho e do produtor, a nota do Vivino quando o Catálogo a
   tem, a relação preço/qualidade —, para se saber por onde começar a
   procurar. Era o que o `pesquisar` da `sugerir-vinho` fazia, para a lista
   toda. Aqui a memória do modelo pode entrar, porque é só a ORDEM: nada do
   que ele pensa aparece como facto. Fica em `cartas.ordem`; se falhar, fica
   nula e a lista sai pela ordem da carta, sem a leitura falhar.
2. **A carta no ecrã** (`wsCartaHTML`), **pela ordem da IA** (`wsOrdenar`,
   com uma linha a dizê-lo): **só os vinhos até ao orçamento, com
   5 € de margem** (`wsCabe`, e o `cabe` da função — a carta diz 31 € e o
   orçamento é 30: entra); sem preço da garrafa não entra (um vinho a copo
   não é uma garrafa). O que ficou de fora diz-se numa linha. De cada vinho,
   a linha do Catálogo (`carta_ligar`, COM A COR: o branco nunca responde
   pelo tinto; a colheita da carta primeiro), e daí a nota do Vivino
   (`notaVivino`), as castas, o preço de referência (`precoPrincipal`) e o
   nome como o Catálogo o escreve; **tocar no nome abre a página do vinho**,
   a mesma do Detalhe. O que o Catálogo não tem diz "sem dados".
3. **Procurar informação, até 5 de cada vez** (`wsDetalhe`): os vistos da
   lista (nenhum vem marcado) vão ao "Procurar informação" com IA de sempre —
   a `vinho-info`, com o motor do plano de cada um — e **o que se encontrar
   fica logo no Catálogo** (`daCarta`: o nome impresso na carta é a
   confirmação, ver "A procura da IA"). Um vinho que o Catálogo tem vai com
   o nome, o produtor e a colheita DA LINHA (é nela que a `vinho-info`
   escreve); um que não tem vai como a carta o escreve, e nasce lá. Nunca se
   pede o produtor, o ano nem a cor (`wsPedidoIA`): são a identidade, e uma
   cor errada da IA fazia nascer outra linha. Depois, mais 5, até **15 por
   carta** (`WS_DET_TOTAL`); o que falhou pode tentar-se outra vez.
4. **Sugerir** (`wsRecomendar` → `garrafeira-carta`, `acao:'recomendar'`):
   uma chamada só de texto que ordena os vinhos que cabem no orçamento e de
   que o Catálogo sabe alguma coisa (lidos de novo pela `carta_ligar`, com a
   ficha), com os 2 ou 3 recomendados e o porquê. Devolve só a ORDEM e a
   frase; a nota, o preço e o "preço justo" (2 a 3 vezes o preço de
   referência é o normal, `wsAvaliarPreco`) saem dos dados, nunca do texto
   do modelo. Um vinho sem nota não passa à frente de um com nota nos
   recomendados — no prompt e em código. Pode pedir-se outra vez depois de
   procurar mais.
- **Uma carta no ecrã de cada vez** (`WS`): as "Cartas anteriores" são as
  linhas de `garrafeira.cartas` (as minhas — a policy é por `quem`, mesmo ao
  admin), e abrir uma põe-na no lugar da de agora, com o que o Catálogo sabe
  HOJE. As cartas de antes de 03/10/2026 ficaram no schema `wineselection`
  e já não aparecem.
- **Só no catálogo** (`.so-cat`): é "que vinho peço?", não "o que tenho".
- **Só com IA** (`body.sem-sugestoes`, no `sincronizarTabs`): quem é `sem_ia`
  não vê o separador, e a `garrafeira-carta` pergunta o mesmo à BD
  (`plano_ia()`). O "Procurar informação" é a `vinho-info`, que só atende
  EDITORES.
- **As marcas dos amigos** (🍾 🍷 💭 🎁) são da `garrafeira.marcas_amigos`
  (ver "A exceção: as marcas dos amigos").

### Os curadores do catálogo (30/09/2026, migração 32)
O dono das apps: "eu quero definir quem cria novos vinhos no catálogo… e se
esses utilizadores fizerem alguma alteração num vinho da sua garrafeira, essa
correção deverá atualizar também o vinho no catálogo".
- **Quem é curador decide-o o admin do CATÁLOGO**, em Definições ›
  Utilizadores (o visto "Curador do catálogo", `admDefinirCurador`). A lista é
  do catálogo (`winecatalog.curadores`, `db/curadores.sql` da WineCatalog) e
  só o admin dele a vê: a quem é só admin da Garrafeira o visto não aparece.
  `EU.curador`/`EU.admin_catalogo` leem-se no `carregar()`.
- **Vinho novo no Catálogo**: o "+" do Catálogo aparece a um curador (e ao
  admin do catálogo) e o "Novo vinho" abre o formulário do vinho novo em modo `catalogo`
  (`catNovoVinho`, `FORM_CAT`): sem garrafa nem notas minhas, gravado pela
  `winecatalog.criar` (`catGuardarNovo`), que recusa um vinho e colheita que
  já lá estejam. **Antes de criar, os PARECIDOS** (30/09/2026, o dono: "uma
  pesquisa prévia… só para o utilizador ter certeza que o vinho não existe
  antes de o inserir"): a 1.ª etapa do "Procurar informação" — e o "Preencher
  à mão" também passa por ela (`pqAbrirNovo(true)`, `soVer`: só essa etapa,
  e depois o formulário) — mostra os do mesmo nome (`colheitas`) e os
  parecidos (`catParecidos`, no catálogo que já está na app): palavras
  iguais, a uma letra ("Cristo"/"Crasto") ou o princípio de outra
  ("Harvest"/"Harvested"); tem de bater metade das palavras do nome que
  identificam um vinho (nem gama, cor, casta, região nem "quinta" —
  `PAR_GENERICAS`), e outra cor fica de fora. Até 8. Um da mesma colheita
  (ou escolhido sem ano escrito) É este vinho: abre-se em vez de nascer
  outra linha; de outra colheita, cria-se a nossa com os factos desse (e o
  nome dele). "Nenhum destes: é um vinho novo" segue. Na garrafeira a
  etapa continua a ser "qual destes é o teu?", só com o mesmo nome.
- **As correções chegam ao catálogo pela BD, não pela app**: o trigger
  `vinhos_catalogo`, a um curador, leva o que MUDOU nessa gravação (o antes e
  o depois da linha, `ficha_da_linha`) à linha ligada, pela `winecatalog.editar`
  com a origem `catalogo-curador` (a força do admin), ANTES da `juntar` de
  sempre. As castas vão pela `definir_castas`. Só a linha ligada da MESMA
  colheita e cor (mudar o ano ou a cor é outro vinho); um campo esvaziado não
  apaga nada lá; o nome e o produtor vão com o interruptor da identidade — se
  a linha passar a ser a mesma que outra, fica registado e segue-se como antes.
  Cada ida fica no `sync_log` (acao `curador_catalogo`), e a app di-lo num
  aviso a seguir ao "Guardado" (`curadorAviso` → `curador_resultado`).
- **O vinho NOVO também** (30/09/2026, o dono: "escolho obter da pesquisa
  valores que já vêm do catálogo e substituo esses valores… devia atualizar
  no catálogo"). A gravar não há "antes", e a `juntar` só enche o vazio; mas
  o "Procurar informação" MOSTROU a linha do catálogo (`_catBaseNovo`, os
  valores que o `pqCatalogoUsar` trouxe), e o que o curador gravou diferente
  disso — o valor da IA, ou escrito à mão — é uma correção:
  `curadorNovo` → `garrafeira.curador_levar_novo(vinho, base)` → a mesma
  `curador_levar`. Um campo que o catálogo não mostrou não vai.
  Quem não é curador continua a alimentar o catálogo — com as regras a seguir.

### E quem não é curador (01/10/2026, migração 39)
O dono das apps: "o meu objetivo é que o Catálogo fique fidedigno". Até
aqui cada gravação levava a ficha INTEIRA à `juntar`, que substitui com
força igual ou maior — a garrafeira (3/2) tapava as lojas, o Vivino e a IA,
em qualquer gravação de qualquer pessoa (até ao mudar uma garrafa de
lugar). Agora:
- **O nome e o produtor de um vinho gravado não se mudam na garrafeira.**
  No Editar ficam só de leitura (com a nota a apontar para o "Algo não está
  bem?"), a procura com IA e a atualização massiva já não propõem o
  produtor, e a BD deixa-os como estavam a quem escreve pela API
  (`vinhos_identidade_fixa`, SECURITY INVOKER: o `current_user` de um PATCH
  é `authenticated`; as funções da BD e a `service_role` passam). Chegam do
  catálogo pela `receber_identidade`, como antes. O ano e a cor continuam a
  mudar-se (são outro vinho: a ligação procura-se outra vez).
- **O resto só corrige o catálogo quando a linha é SÓ deste vinho**
  (`linha_so_minha`): nasceu com ele, mais nenhum vinho está ligado a ela,
  nada foi fundido nela, e só a garrafeira e a procura com IA lhe
  escreveram (as `origens`; e nenhum `editar` no `sync_log` do catálogo).
  O catálogo guarda a ORIGEM de cada campo, não a pessoa — daí as quatro
  perguntas.
- **Nas outras linhas, a garrafeira só enche o que o catálogo tem vazio**
  (`catalogar_e_ligar(…, p_so_vazios)`), e o que a pessoa MUDOU para um
  valor diferente do que o catálogo tem é uma **divergência**: fica na
  garrafeira dela e o admin recebe um comentário ("Divergência automática",
  motivo `atributos`, com os valores dela e os do catálogo) e o push
  (`catalogo_divergencia`; as castas pela `castas_mudaram`). A nota e o
  preço (`winecatalog.volatil`) não contam, e um vinho acabado de criar não
  avisa ninguém (enche o vazio e mais nada).
- A app diz o que aconteceu a seguir a gravar (`curadorAviso`, para toda a
  gente: "Corrigido também no catálogo" ou "Fica diferente do Catálogo em …
  — o admin foi avisado para rever").

## O detalhe do vinho é uma PÁGINA, não um modal
Tocar num vinho não abre uma folha por cima da lista: entra-se numa
**página** (`verVinho`, secção "PÁGINA DO VINHO" no app.js e no style.css).
Ecrã inteiro, papel do princípio ao fim, e o **cabeçalho do vinho colado ao
topo** — quem rola até "já bebidas" continua a ver de que vinho se trata.
Colado mas não do tamanho todo: ao rolar encolhe até uma barra com a
garrafa pequena, o nome e o ano. Fixo em tamanho grande comia meio
telemóvel; e no encolhido é a **origem** que desaparece, não o ano
(`.mhero-o`) — sem a garrafa à vista, o ano é o que falta saber.

**O encolher não tem dois estados, tem um cursor** (`pgCabecalho`): `--pg`
vai de 0 a 1 ao longo do scroll e o `style.css` desenha cada medida com
`calc()` a partir dele — garrafa, espaçamentos, recortes, a sombra que
aparece por baixo da barra. Uma classe ligada num limiar (era o que estava)
faz a mesma coisa num salto só, e sente-se.

Isto é desenho **e** orçamento: acontece a cada passo do scroll, e cada
passo tem 16ms para tudo. Foi preciso duas voltas para lá chegar (a
primeira ficou a andar aos bocados — "à Robocop"), e o que se aprendeu:
- **o cabeçalho é `fixed`, não `sticky`.** Preso ao fluxo, cada pixel que
  ele encolhia obrigava a recalcular a folha toda por baixo: 2,4ms de
  layout por passo. Fora do fluxo (e com `contain`), 0,6ms. Em troca, a
  `.mbox` leva um `padding-top` do tamanho do cabeçalho aberto;
- **nada muda de `font-size`, nem o nome.** Mudar o tamanho da letra
  obriga o browser a remontar o texto letra a letra: eram 3ms por passo só
  nos três pedaços pequenos, mais do que tudo o resto junto. O que
  desaparece fecha-se por **recorte** (`max-height`) e opacidade; o nome
  fica sempre a 21px e perde LINHAS inteiras, com reticências
  (`-webkit-line-clamp`), as que cabem na moldura de agora — daí a
  tabelinha `PG_TAB` (quanto mede o cabeçalho com 1, 2, 3 linhas, aberto e
  fechado), medida uma vez por vinho aberto. Com um `max-height` contínuo
  no nome via-se o "Reserva" cortado a meio da altura das letras, e a
  encolher-lhe a letra as palavras saltavam de linha a meio do caminho;
- **nada muda de largura à esquerda do nome** (o `gap` é fixo, a garrafa
  só encolhe de ALTURA e o desenho lá dentro é escalado): mexer na largura
  da coluna do texto é outra forma de o mandar remontar;
- **a altura é imposta** (`PG_H0`→`PG_H1`, ambos medidos, não adivinhados),
  senão a curva não é linear: o nome a perder uma linha, ou as pastilhas a
  caberem finalmente na mesma, tiravam 30px de uma vez a meio do caminho.
  Com a altura imposta, o que reflui lá dentro fica escondido pelo
  `overflow:hidden` e centrado pelo `justify-content`;
- **o percurso é o próprio encolher** (`PG_H0-PG_H1`): o scroll que se
  gasta é o que o cabeçalho liberta, e como a ficha começa logo por baixo
  dele, o primeiro pixel dela anda colado ao seu rebordo de baixo enquanto
  ele fecha — nada é engolido pelo caminho.

O ano aparece **duas vezes** no HTML de propósito (`.mhero-ab`): a linha da
origem inteira não cabe numa barra e cortá-la levava a região atrás, por
isso fecha-se toda e a barra tem a sua própria cópia do ano, que abre no
fim. Sem a garrafa à vista, o ano é o que falta saber.

Por baixo continua a ser o **mesmo `#modal-vinho`**, só com outra pele
(`.pagina`). É de propósito e é o que mantém isto pequeno: os
`fecharModal('modal-vinho')` espalhados pelo app.js, os modais que abrem
POR CIMA da página (editar, consumir, foto, IA) e o `refrescarVinhoAberto()`
continuam a funcionar sem saber de nada disto. Uma `.sec` a sério — com o
`tab()` a mandar — obrigava a mexer nos cinco separadores, no
`posicionarFiltros` e em todos os pontos de saída, para o mesmo resultado.
Se um dia isso for preciso, é aqui que se paga.

Sai-se por **quatro** caminhos, e todos passam por `fecharModal` para
gastarem o mesmo passo de história:
- o **✕** à direita do cabeçalho. Não há ‹ à esquerda: chegou a haver, e
  custava 40px de recuo a toda a coluna do nome para repetir o que os
  outros três já faziam;
- **Escape**;
- o **voltar do telemóvel/browser**: abrir a página faz `history.pushState`
  e o `popstate` fecha-a (e o que estiver aberto por cima — é tudo o mesmo
  contexto, este vinho). Quem sai pelo ‹/✕ faz `history.back()`. Os dois
  caminhos põem `PG_HIST` a falso ANTES de mexer na história, que é o que
  impede o pingue-pongue entre um e o outro;
- **arrastar o dedo de lado** (`pgSwipe`). Segue o dedo nos **dois**
  sentidos — pediu-se para a esquerda, mas quem vem do iOS/Android arrasta
  para a direita, e travar um dos lados era ensinar uma regra nova sem
  necessidade. Sai a um quarto do ecrã (ou 110px); menos do que isso volta
  ao lugar. Só pega se o gesto for claramente horizontal (senão roubava o
  scroll), nunca começa dentro de um campo/link/botão e desliga-se se
  houver um modal por cima. Precisa de `touch-action:pan-y` na página —
  sem isso o browser fica com o gesto e o `preventDefault` chega tarde.

Clicar **na margem não fecha** (ao contrário dos modais): numa página
ninguém espera sair por tocar ao lado. E `.modal.pagina.on` é `display:block`
e não `flex` — um item de flex não cresce com o que tem dentro, e a folha
parava à altura do ecrã com a ficha a continuar por cima do papel.

## O nome, a cor e o produtor (fase 4 dos nomes, 27/09/2026)
O nome é o que distingue o vinho; a cor e o produtor são campos à parte e
dizem-se como tal — decisão do dono das apps, igual na WineCatalog. No
cartão da lista (revisto a 27/09/2026, pedido do dono): em cima o **nome**
em Fraunces seguido de **[cor] · [região] · [ano]** (`vinhoMetaHTML`, a cor
em itálico), na mesma linha e a quebrar com ele quando o nome é comprido —
cada pedaço em `nowrap`, a quebra cai entre eles; por baixo só o
**produtor** em itálico (`.vc-prod`). O ano saiu do float da direita, que
ficou só com a nota do Vivino; o estilo saiu do cartão. Na grelha: o nome;
por baixo cor · região · ano; mais abaixo o produtor (`.vg-prod`). O mesmo
desenho no Catálogo da WineCatalog (`wcMetaHTML`).
Na página do vinho, a cor em itálico a seguir ao nome (`.mhero-cor`) e o
produtor em itálico na linha da origem (`.mhero-p`); por isso a cor saiu do
pré-título (`.mhero-k`). **A cor é obrigatória ao gravar** um vinho (o
`guardarVinho` recusa sem ela; o `Tinto` de omissão já não passa): é parte
da chave do catálogo. E o vinho novo que vem de um candidato do catálogo
fica com o NOME do catálogo (`pqCatalogoUsar`). Na linha "Produtor" da ficha
aparece, por baixo e em itálico, o **nome completo** do produtor oficial
quando o catálogo o tem (`PROD_COMPLETO`, lido com a
`winecatalog.produtores_completos` no `carregarGarrafeira`; "Quinta Nova" →
"Quinta Nova de Nossa Senhora do Carmo").

## A linguagem visual (o "charme")
Duas famílias e uma regra de cor. **Fraunces** (serifa) para o que se lê
devagar — nomes de vinhos, anos, números, títulos; **Inter** para a
interface. A cor é informação, não decoração: **bordô** = a app, **dourado**
= distinção (menção portuguesa e nota do Vivino), e o resto vive em tons de
papel. O fundo tem uma textura de pontos em CSS puro (nada de imagens).

**O REBORDO do cartão é a cor do vinho** (`corFundoCls`, 01/10/2026, o
dono das apps), na lista e na grelha, na garrafeira e no catálogo: cor de
vinho no tinto, dourado no branco, cor-de-rosa no rosé; espumante,
licoroso e frisante ficam com o rebordo de sempre. **O fundo fica
branco**: esteve tingido (tinto num cor-de-vinho suave, branco num
amarelo) e o dono preferiu voltar atrás. O que um vinho do catálogo é para
mim (tenho, wishlist, bebido) vive no selo do canto do cartão.

Não voltes a dar cor própria a cada crachá: a versão anterior tinha sete
famílias de cor lado a lado no mesmo cartão e nenhuma queria dizer nada.

**O cartão do vinho tem três zonas e é a POSIÇÃO que diz o que a coisa é:**
1. a **garrafa** (a imagem, com a quantidade ao canto);
2. a **identidade** — nome, ano (com a nota do Vivino por baixo, em
   `.vc-anofloat`), produtor/tipo/região, castas, menção, preço médio. A
   classificação (DOC/Vinho Regional) não vem aqui — já está na ficha do
   vinho, e cabia pouco para repetir nos dois sítios;
3. depois de um filete, o **rodapé do que é físico** — onde está a garrafa e
   se está no ponto de beber.
Um crachá novo entra numa destas zonas; não há uma quarta.

Isto é do cartão da LISTA. O cartão da **grelha** (`.vgcard`) é outro
desenho e não lhe deve obediência: ali a garrafa é a largura toda e o que
sobra é só identidade — ver "os cinco separadores", `vinhoGrelhaHTML`. As
três zonas continuam a valer onde há espaço para três zonas.

**A faixa da procura é a exceção que confirma isto** (`trechosMatch`,
`.vc-match`): enquanto há texto na caixa de procura, o cartão ganha em
baixo — a toda a largura, fora do `.vc-top` — o **campo onde a palavra foi
encontrada** e o pedaço de texto à volta dela, com a palavra sombreada. Não
é uma quarta zona da identidade do vinho: o que diz é da PROCURA, não do
vinho, e desaparece com ela. Existe porque a procura livre lê muito mais do
que o cartão mostra (sub-região, notas de prova, harmonização, as minhas
notas) — procurar "caça" devolvia vinhos sem uma letra da palavra à vista,
e a lista respondia certo a parecer enganada.

Só entra o que **não se vê no cartão**, termo a termo: quem procura
"esporão" está a ver "Esporão" em serifa dois centímetros acima, e repeti-lo
por baixo era ruído; "esporão caça" mostra a harmonização e cala-se sobre o
nome. As castas contam como visíveis só as duas que o cartão mostra — a que
está escondida no "+2" aparece. Aparecem **todos** os campos onde a palavra
está (pela ordem da ficha do vinho, até `MAX_MATCH`): "sabe a caça" e
"come-se com caça" são respostas diferentes. De cada campo mostra-se uma
janela de ~120 caracteres à volta do primeiro match, cortada a espaços e
com reticências — a nota de prova inteira lê-se na ficha do vinho.

O sombreado é **bordô**, não dourado: o dourado é a distinção (menção, nota
do Vivino) e uma palavra encontrada não distingue vinho nenhum — é a app a
apontar para o que lhe perguntaram. `normPos()` é o que permite sombrear no
texto ORIGINAL (com acentos e maiúsculas) a partir de um match feito sem
eles: normaliza caracter a caracter, mantendo as posições, porque o
`chave()` normal encurta a string e os índices deixavam de servir.

**O crachá da maturação enche-se** (`janelaBadge`, `.bdg.jan.cheio`). Dizer
"No ponto" deixou de separar alguma coisa — está em quase todos os vinhos —
por isso o crachá passou a mostrar **onde** dentro da janela: enche-se até
ao ano em que estamos (`janelaPos`, 0 no primeiro ano da janela, 1 no
último) e o rebordo do enchimento é o marcador. Não é um crachá novo nem
uma linha nova: a informação entra dentro do que já lá estava, e o rodapé
não alarga um pixel. Só o estado `ponto` se enche — em `cedo`/`passou` a
posição era sempre o princípio ou o fim, e um risco encostado à borda
lia-se como defeito; sem as duas pontas (ou com uma janela de um ano) não
há posição e o crachá fica como sempre foi. A **palavra** da fase só
aparece onde há espaço: na ficha do vinho (*Beber entre* → "2021 – 2030
🍷 No ponto · a meio") e na pesquisa, nunca no cartão.

`.vc-anofloat` é um **float** (`float:right`), não uma coluna flex ao lado
do nome: com flex, a altura da linha do nome ficava presa à do lado do
ano+nota, e um nome de vinho curto (ou que quebrasse para a segunda linha)
sobrava com um espaço em branco antes do resto da ficha começar. Com float,
o nome contorna a caixa do ano+nota em vez de esperar por ela — sobe para o
lado dela. `.vc-main` é `display:flow-root` (não `flex`) de propósito: um
item de flex ignora `float`, é a própria spec do CSS.

## A imagem de cada vinho
`garrafaSVG(v)` desenha a garrafa em SVG inline: o vidro toma a cor do
`tipo` (`VIDRO`), o rótulo leva o ano. Se o vinho tiver `imagem_url` (foto
do rótulo), essa vai por cima — e o `onerror` tira-a se o link estiver
morto, ficando a garrafa desenhada em vez de um quadrado vazio.

É desenhada e não uma pasta de imagens porque **não há build nem servidor
de imagens aqui**: assim não custa um pedido à rede, não falha offline e
não depende de um link de terceiros que um dia morre. A garrafa aparece
também no mapa dos locais (versão `mini`, sem rótulo) e na capa da página
do vinho.

### Duas origens, uma ordem
Um vinho pode ter DUAS imagens e a ordem nunca muda:
1. **`imagem_path`** — a MINHA fotografia, no bucket privado
   `garrafeira-rotulos`. Ganha sempre: quem tem a garrafa na mão sabe melhor
   do que a IA qual é o rótulo.
2. **`imagem_url`** — o link que a procura encontrou numa loja.
3. nenhuma — fica a garrafa desenhada.

São duas colunas e não uma de propósito: tirar a minha faz **reaparecer** a
que a IA encontrou, em vez de deixar o vinho sem nada. Quem decide é
`imagemDe(v)` — usa-se esse, nunca `v.imagem_url` à mão.

**Como cabem nas molduras depende da FORMA de cada imagem** (a miniatura
da lista, a grelha, o mapa, a capa da página), e decide-o o
`fotoCarregou(img)` quando ela chega: mais **larga** do que a moldura — a
foto quadrada da loja com a garrafa ao meio, a de um rótulo, a minha —
enche a altura e perde só os lados (`cover`, como sempre foi); mais **alta**
(`.alta`: mais estreita do que 3:5 ou do que a moldura, porque a da lista é
mais estreita do que qualquer garrafa) — a garrafa recortada rente ao vidro
do Vivino e de muitas lojas —
vê-se inteira (`contain`, com `multiply` para o fundo branco se fundir com o
papel). Foram duas voltas (29/09/2026): `cover` para todas cortava as
garrafas altas na grelha 3:4 (ficava o ombro e meio rótulo — parecia imagem
mal carregada); `contain` para todas encolhia as quadradas na lista, cuja
moldura é alta e estreita (a garrafa, um terço da foto, ficava um risco no
meio do papel).

### As imagens das lojas vivem no Supabase (migração 34, 30/09/2026)
O dono: "tendo link fico sempre refém dos sites mudarem o link". Um link
morto não se via — o `onerror` troca-o pela garrafa desenhada, calado. Agora
a Edge Function `garrafeira-imagens` descarrega cada `imagem_url` de fora
para o bucket PÚBLICO `garrafeira-imagens` e a BD troca o link pelo da cópia
no catálogo e em TODAS as garrafeiras que tinham o mesmo (`imagem_trocar`).
A app não sabe de nada disto: continua a ler `imagem_url`, e a minha
fotografia continua a ganhar.
- **O link de origem fica** em `garrafeira.imagens_copia` (uma linha por
  link, não por vinho), com o estado e o erro. Um link já copiado que volte
  a aparecer (a IA voltou a propô-lo) troca-se sem descarregar outra vez.
- **O cron de hora a hora** (`garrafeira-imagens`, minuto 17) apanha os
  links novos; o admin vê como vai e copia já em Definições › Diagnóstico
  › 🖼️ (`renderImagens`). Três tentativas e desiste: o link fica como
  estava.
- **Só o que os BYTES dizem ser imagem** (JPEG/PNG/WebP/GIF/AVIF, nunca
  SVG), até 6 MB, com a prudência da `abrirPagina` da `vinho-info`: quem
  escreve os links é qualquer editor.
- **E ficam PEQUENAS** (migração 35, o dono: "uma imagem de 3 MBs para um
  vinho não faz sentido"): cada cópia passa pelas transformações de imagem
  do Supabase (`/storage/v1/render/image`, ligadas neste projeto) — no
  máximo 800×800, WebP a 80 — e guarda-se o RESULTADO, apagando a original
  (`reduzir` na função). A PNG de 3,3 MB ficou em 17 KB; as 302 do primeiro
  lote passaram de 39 MB para uns poucos. Transforma-se UMA vez por imagem,
  não a cada visita: o Supabase cobra por imagem de origem diferente por
  mês. Se a transformação falhar, fica a original.
- **Num vinho do CATÁLOGO troca-se no zoom** (migração 36, 30/09/2026, o
  dono: "quando fazemos zoom à imagem do vinho, temos que ter lá um botão de
  alterar imagem"). O `abrirFoto` escondia os botões a um id negativo; agora
  um curador ou o admin do catálogo (`catPodeCriar`) tem "📷 Trocar a
  imagem" (`enviarFotoCat`): encolhida no browser a 800 px, vai para
  `garrafeira-imagens/cat/` (a policy do Storage deixa só eles, e só nessa
  pasta) e a linha passa a apontar para lá pela `winecatalog.editar`. Não vai
  para o `garrafeira-rotulos`: é a imagem de toda a gente, não a de uma
  garrafeira. A anterior não se apaga — pode ser a cópia que as garrafeiras
  ainda usam.
- **Público e não privado** porque são fotografias de lojas, iguais para
  toda a gente; as minhas continuam no `garrafeira-rotulos`, privado.

O bucket é **privado** (as fotos são tiradas em casa e apanham a prateleira
à volta), por isso um `<img src>` não lhe chega com o JWT. A saída são links
assinados: `assinarImagens()` pede-os TODOS num pedido só ao carregar e
guarda-os em `IMG_ASSINADA` por vinho.

A app **encolhe a imagem no browser** antes de a enviar (`encolherImagem`,
lado maior 1000px, JPEG): uma foto de telemóvel são 4 MB e o rótulo cabe em
~120 KB. O `imageOrientation:'from-image'` trata do EXIF — sem isso as fotos
tiradas na vertical apareciam deitadas. Cada envio gera um nome novo (um
caminho fixo ficava preso à cache do browser e da CDN) e apaga o anterior;
apagar o vinho leva a foto atrás, senão ficava lixo pago no bucket.

`vinhos.imagem_url` já está aplicada no Supabase deste projeto — a
`vinho-info` (Edge Function) também tenta trazê-la na procura da IA (link
DIRETO da fotografia, não o da página; ver `vinho-info.ts`). Mesmo assim a
app **deteta** se a coluna existe (`detetarImagem()`) e, se um dia faltar
numa base nova antes do `db/schema.sql` correr, esconde o campo e não o
manda nas gravações — sem isso um PATCH rebentava **todas** as gravações
com 400.

## Comentários e sugestões (28/09/2026, migração 26)
Duas conversas com o admin, que as lê na WineCatalog (Alertas › dois
cartões) e no painel do PC (dois separadores) — ver o `CLAUDE.md` de lá:
- **"Algo não está bem?"**, no fim da página de cada vinho (`abrirComentario`,
  `#modal-comentario`): atributos que não estão bem (com os atributos
  apontados), atualizar a partir de um site (o link é obrigatório), outro
  problema. **Não é o "⚠ O errado é o catálogo"** do espelho: esse só existe
  quando a comparação vê um campo diferente, e o caso mais comum é o
  catálogo e a garrafeira estarem IGUAIS e errados. Corrigido no catálogo,
  chega às garrafeiras (fichas × catálogo, ou "≠ catálogo").
- **"Enviar uma sugestão"**, em Definições › Sugestões e comentários
  (`abrirSugestao`): uma ideia, ou algo que não funciona. O mesmo cartão
  lista os meus, com o estado e a **resposta** do admin
  (`renderMeusComentarios`, só com Definições à vista).
Nada disto é `ro-hide`: avisar não é mexer, e numa garrafeira emprestada
também se dá com erros (guarda `pode_ver`, como o reportar). Os valores dos
atributos apontados saem da BD (`comentar_vinho` → `ficha_catalogo`), nunca
da caixa de texto — e nunca as notas, o preço de compra, o lugar ou a foto.
A tabela é do catálogo (`winecatalog.comentarios`), não daqui: quem a lê é o
admin do catálogo, como os reportes.

**A conversa** (28/09/2026, o dono: "um estado de devolver uma dúvida"). O
admin pode fechar com uma resposta ou devolver uma PERGUNTA — o estado
`duvida` é a vez de quem escreveu, e a caixa de responder abre-se sozinha no
cartão. Quem escreveu responde daí (`comentario_responder`), e o comentário
volta a `aberto` — também depois de fechado ("continua mal"). Cada fala é uma
linha em `winecatalog.comentarios_msgs`, e a lista mostra-as todas.

**Três avisos, do mais forte ao mais fraco — e nenhum pode faltar:**
- **o push no telemóvel** (migração 27, `garrafeira-push.ts`). Liga-se por
  APARELHO em Definições › Sugestões e comentários (`pushLigar`: a
  autorização é a primeira coisa depois do toque, que o Safari recusa-a fora
  do gesto). No iPhone só com a app no ecrã principal, e o cartão di-lo.
  Quem ENVIA é a base, não a app: os gatilhos em `comentarios` e
  `comentarios_msgs` escrevem na caixa de saída (`garrafeira.push_avisos`) e
  acordam a função pelo `pg_net`, com a `service_role_key` do cofre; o cron
  `garrafeira-push-retry` tenta outra vez de 30 em 30 minutos, até 10.
  Comentário novo e resposta de quem escreveu → o admin do catálogo (o toque
  abre o Alertas do WineCatalog); pergunta ou fecho do admin → quem escreveu
  (o toque abre `#comentarios`, que leva a Definições). Venha a fala da
  Garrafeira, do WineCatalog ou do painel do PC — é por isso que está num
  gatilho e não em cada ecrã;
- **o toast à entrada e o número no ⚙️** (`comentariosAvisos`,
  `garrafeira.comentarios_avisos`): as respostas por ler, as perguntas à
  espera e, ao admin do catálogo, o que está por tratar (com "Abrir no
  WineCatalog");
- **o realce na lista** (`.cm-item.novo`), até ela se voltar a desenhar.
**A caixa de saída diz o que aconteceu a cada aviso** (`estado` e
`resultado`: enviado a N aparelhos · ninguém com as notificações ligadas ·
o erro do serviço), e o cartão mostra o último. É a lição do Goals, que
passou semanas a "enviar" sem nada chegar. E a função confere o PAPEL do
token (`service_role`), não a chave letra a letra: a do cofre e a do
ambiente das funções deixaram de ser a mesma cadeia — a comparação dava 403
a um token certo, e é o que está a acontecer ao `push-retry-goals` do Goals
(visto a 28/09/2026 no `net._http_response`).

## A exceção: as marcas dos amigos na WineSelection (25/09/2026)
Por decisão do dono das apps, **dentro do grupo das Prendas de Anos**
(`anniversarygifts.amigos`) a WineSelection mostra que um amigo TEM um
vinho (garrafas na garrafeira), o BEBEU e lhe deu nota
(`garrafas.consumo_avaliacao`) ou o tem na WISHLIST (`vinhos.desejado`).
Quem lê é a `winecatalog.marcas_amigos` (SECURITY DEFINER, `db/amigos.sql`
no repo WineCatalog): só responde a quem é do grupo e só conta as
garrafeiras cujo dono é do grupo. Nunca sai a linha — nem notas, preço,
local ou fotografia: só o nome do amigo, quantas garrafas, as colheitas, a
nota e a data. As partilhas e a RLS daqui ficam exatamente como estavam.
**As Sugestões daqui usam a irmã `garrafeira.marcas_amigos`** (migração 40,
03/10/2026, o dono: "estás a baralhar tintos com brancos"): as chaves do
nome (`chave_base`, `base_nome`) deixam a cor de fora — "Papa Figos Branco"
e "Papa Figos" dão a mesma —, e a de lá nunca olhava para a cor; um branco
da carta acendia o tinto da garrafeira de um amigo. A daqui liga primeiro
pela linha do catálogo (`vinhos.catalogo_id`) e, pela chave, só quando a cor
não discorda. O resto é a regra de lá, tal e qual.
**Se mexeres em `garrafas.estado`, `consumo_avaliacao` ou `desejado`**
(nomes ou significado), vê as duas funções no mesmo dia.

## Cada um vê a sua garrafeira (a outra decisão que segura o resto)
Um **vinho**, uma **garrafa** e um **local** pertencem sempre a uma
**garrafeira** (`garrafeiras`, com um `dono` que é um email), e ninguém vê
uma linha de uma garrafeira que não seja sua. Mesma app, mesmas tabelas,
mesma base de dados — o que muda é o `garrafeira_id`.

`GA_ID` é a que está aberta no ecrã. Fica no `localStorage`, mas isso é só
uma preferência: no `carregar()` só vale se ainda constar da lista que a BD
devolveu (podem ter deixado de a partilhar comigo). Todos os pedidos de
conteúdo levam `garrafeira_id=eq.GA_ID` — a RLS já filtrava sozinha, mas
sem o filtro quem tem duas garrafeiras recebia-as misturadas no mesmo ecrã.

`carregar()` são **duas voltas ao servidor** e não uma: primeiro quem sou eu
e que garrafeiras posso ver, e só depois o que está dentro da que ficou
aberta — o filtro dos vinhos precisa de um id que só a primeira volta
conhece. `carregarGarrafeira()` é a segunda metade sozinha, e é só ela que
corre ao trocar de garrafeira (as castas e a lista de garrafeiras não
mudaram).

**Emprestar é SÓ deixar ver.** Uma linha em `partilhas` e mais nada: quem a
recebe vê e procura, nunca acrescenta, move, consome nem apaga. Não há
`pode_editar` nas partilhas de propósito — duas pessoas a dar saída às
mesmas garrafas é um estado partilhado que ninguém pediu, e a coluna
acrescenta-se um dia mais facilmente do que se desfaz a confusão. Na app
isso é o `isReadOnly` de sempre (`body.readonly`), que passou a ter **duas**
causas: ou não sou editor, ou o que está aberto é de outra pessoa
(`podeEditar()`: na minha garrafeira basta `souEditor()`; na de outra pessoa
só o admin com `'edicao'`). Quem recusa a sério é a RLS — uma partilha nunca
faz `pode_mexer()` dar verdadeiro.

**O admin da app não vê as garrafeiras dos outros — a não ser que o dono o
convide.** É a coluna `garrafeiras.admin_acesso`: `'nenhuma'` (o defeito, nem
a vê), `'leitura'`, `'edicao'`. `is_admin()` sozinho não abre nada — nem em
`e_dono`, nem em `pode_ver`, nem em `pode_mexer`; o que abre é o que o dono
escolheu em Definições › Garrafeiras › **Permissões ao admin**. Assim o
admin pode ajudar quem lho pedir, e mais ninguém.

**A exceção é o batch do admin, e só para os links do Vivino** (26/09/2026):
o painel da WineCatalog, no PC do admin e com a service role, compara o
`vivino_url` de cada vinho de TODAS as garrafeiras com o do catálogo e troca
os errados (sem `/w/<nº>`, ou a abrir outro vinho) ou vazios pelo link
confirmado do catálogo — `garrafeira.links_vivino_rever`, em
`db/migracao-links-vivino.sql`. Um link para uma colheita do mesmo vinho
fica como a pessoa o pôs. O admin vê de quem é cada vinho: "não há segredos
numa correção que melhora a informação" (o dono das apps). Cada troca fica
no `sync_log` (origem `winecatalog-batch`). Não é uma porta nesta app: é uma
função que só a `service_role` executa — e, desde 27/09/2026, o admin do
CATÁLOGO na app WineCatalog (Alertas › "As garrafeiras × o catálogo"), por um
invólucro de lá (`winecatalog.garrafeiras_links_rever`) que confirma o
`sou_admin()`; o GRANT daqui continua só da `service_role`, e o portão aceita
as duas. O `quem` do `sync_log` é o email do admin quando vem da app. A
decisão é do dono das apps: "o que é só comparação e análise de dados, podemos
ter na app" — a mesma pessoa, a ver o mesmo que já via no PC.
**E o resto da ficha** (a 19, `garrafeira.fichas_catalogo_rever`, também na
app WineCatalog pela `winecatalog.garrafeiras_fichas_rever`): só da
MESMA colheita, o que está vazio aqui e o catálogo tem, e o que é diferente
quando o do catálogo é mais recente do que a última gravação do vinho pelo
dono. Nunca a cor (um vinho com cor diferente fica todo de fora), nunca a
imagem de quem tem fotografia sua (`imagem_path`). Escreve pela
`escrever_do_catalogo` — o UPDATE que era da `aplicar_do_catalogo` (o botão
"≠ catálogo"), agora partilhado pelas duas; a do batch não carimba
`atualizado_em`, porque não foi o dono a mexer. **Um campo novo em
`vinhos` que venha do catálogo entra na `ficha_catalogo` E na
`escrever_do_catalogo`**, senão atravessa num sentido e não no outro.

Mesmo com `'edicao'`, o admin mexe nas GARRAFAS e não na fechadura: renomear,
partilhar, passar e mudar o próprio `admin_acesso` continuam a ser só do
dono (as policies de `garrafeiras`/`partilhas` comparam o `dono` à mão, não
passam por `pode_mexer`). Sem isso ele subia-se de `'leitura'` a `'edicao'`
sozinho e a permissão deixava de ser de quem a dá.

A permissão é do **papel** e não da pessoa — é o que a coluna consegue
guardar. Por isso `definir_admin()` repõe todas a `'nenhuma'` ao passar a
app: quem a deu estava a pensar numa pessoa, e o admin seguinte não pode
acordar com a chave da garrafeira de toda a gente. Quem quiser voltar a
abri-la abre-a num clique; quem não der por isso fica protegido, que é o
lado certo para onde errar.

Três coisas a ter na cabeça ao mexer nisto:
- **um vinho novo leva `garrafeira_id:GA_ID` no POST**, e um local também.
  Uma **garrafa não**: o trigger `garrafas_guard` copia-lho do vinho e
  ignora o que vier do cliente (senão dava para pendurar uma garrafa minha
  no vinho de outra pessoa). O mesmo trigger recusa arrumar uma garrafa num
  local que é de outra garrafeira — a FK não apanha isso, aponta ao
  `locais.id` e não à garrafeira certa;
- **as castas são a exceção e ficam globais.** "Touriga Nacional" é o mesmo
  nome na garrafeira de toda a gente, e é a tabela única que faz a procura
  por casta funcionar. O que é privado é a LIGAÇÃO (`vinho_castas`), e essa
  anda pela garrafeira do vinho. Apagar uma casta passou a ser só do admin:
  uma casta apagada levava atrás (CASCADE) as ligações dos vinhos de outra
  pessoa, que via as castas desaparecerem sem ninguém lhes ter tocado;
- **as fotos dos rótulos** vivem em `v<id-do-vinho>/…` no bucket privado, e
  as policies do `storage.objects` chegam à garrafeira por aí
  (`foto_visivel`/`foto_minha`). Se um dia mudares o formato do caminho em
  `enviarFoto()`, muda `vinho_do_ficheiro()` no mesmo commit — senão as
  fotos deixam de abrir para toda a gente, em silêncio.

**Entrar não dá garrafeira; ser editor é que dá.** `pode_editar` mudou de
significado: era "pode mexer nas garrafas de casa", passou a ser "tem
garrafeira própria e mexe-lhe". Como já não é poder sobre os dados de
ninguém, aprovar um pedido de acesso passa a marcá-lo logo
(`admAprovar`) — era o segundo passo que toda a gente se esquecia de dar. A
garrafeira em si é criada sozinha à primeira entrada
(`garantir_garrafeira()`, idempotente), e não há ecrã nenhum de "cria
primeiro a tua garrafeira".

Uma garrafeira **acabada de nascer não fica aberta** se houver outra à vista
(`escolherGarrafeira(acabadaDeNascer)`): está forçosamente vazia, e abrir a
app num ecrã vazio quando há garrafas para mostrar lê-se como "perdi tudo".
Era o que ia acontecer ao Barrona na primeira entrada depois da migração —
as garrafas dele ainda na conta de quem montou a app, e a dele própria
criada sem nada lá dentro.

**Passar a APP ≠ passar uma GARRAFEIRA.** `definir_admin()` passa quem manda
em quem entra; `transferir_garrafeira()` passa as garrafas — e são coisas
diferentes que já não se fazem no mesmo sítio. Transferir a garrafeira
continua na UI, em Definições › Garrafeiras, e só o dono a pode fazer (nem
o admin), e só para quem já tenha `pode_editar`. Passar a app deixou de ter
botão (ver "O admin está na BASE DE DADOS" mais abaixo) — quem precisar
disso corre `select garrafeira.definir_admin('email@...')` no SQL Editor do
Supabase.

## Vinho ≠ garrafa (é a decisão que segura o resto)
Um **vinho** é a referência: nome, ano, produtor, castas, e tudo o que a IA
descobriu. Uma **garrafa** é a coisa física: está num lugar, custou um
dinheiro, e um dia bebe-se. Duas garrafas do mesmo vinho em prateleiras
diferentes são **duas** linhas em `garrafas` e **uma** em `vinhos`.

Consequências práticas, todas de propósito:
- a ficha da IA é gravada **uma vez** por vinho, não copiada por garrafa;
- **consumir não apaga**: muda `garrafas.estado` para `'consumida'` e
  carimba data/sítio/avaliação (de 1 a 5 com uma casa decimal, 4,2 — as
  estrelas dão o número redondo com um toque e a caixa ao lado a casa
  decimal; `avalLer`/`avalPintar`, migração 25). É esse histórico que responde ao "onde é
  que bebi aquela relíquia" — apagar a linha era deitar isso fora, e é a
  única parte destes dados que não se recupera. Os COMENTÁRIOS são a
  exceção que não vive na garrafa: um vinho muda ao longo de uma refeição
  ("ainda fechado" no início, "abriu bem" depois de arejar), por isso são
  vários (`garrafeira.consumo_notas`, uma linha por comentário, com hora) e
  não um campo só que a próxima edição apagava por cima;
- a lista principal só mostra vinhos com `stockDe(id) > 0`. Um vinho todo
  bebido continua na base de dados e no separador Consumidos, mas sai da
  garrafeira.

## A wishlist é um vinho sem garrafas (migração 15)
Os vinhos que não estão cá mas que se querem ter. **Não é uma tabela à
parte**: é uma linha normal de `vinhos`, sem garrafas, com
`vinhos.desejado = true` — a consequência direta do "vinho ≠ garrafa" logo
acima. Por isso a ficha, a procura da IA, a página do vinho e o Editar são
os de sempre, e **passar um desejo para a garrafeira** é desligar a marca e
acrescentar garrafas no MESMO passo (`abrirEditarVinho(id,'converter')`:
a ficha editável — o ano, sobretudo — mais a "Primeira garrafa" com o local
e o preço de compra). Uma tabela de desejos obrigava a copiar a ficha de um
lado para o outro, e duas cópias divergem no dia em que se edita uma.

- **Não aparece em Detalhe/Locais/Resumo sem ninguém o esconder**: esses só
  contam vinhos com `stockDe>0`. Onde a lista é de TODOS os vinhos (pôr um
  vinho num lugar vazio, substituir o vinho de uma garrafa) filtra-se à mão
  com `desejado(v)` — um desejo não tem lugar na prateleira.
- **Um vinho com garrafas não é um desejo**: o `guardarGarrafa` desliga a
  marca se uma garrafa chegar por outro caminho.
- **A exceção: "bebi, gostei, quero voltar a ter"** (`quererDeNovo`, o botão
  "⭐ Quero voltar a ter" num vinho já todo bebido). O vinho passa à wishlist
  com a MESMA ficha e as garrafas CONSUMIDAS continuam lá — a prova, a nota,
  os comentários. Antes a única saída era um "Novo vinho na wishlist", e
  ficavam duas fichas do mesmo vinho na mesma garrafeira (foi o Ponte
  Mouchão do Barrona, juntado à mão a 28/09/2026). Por isso **retirar um
  desejo só o apaga quando ele não tem garrafa NENHUMA** (`retirarDesejo`):
  com garrafas bebidas, perde só a marca — apagar levava-as atrás pelo
  CASCADE, e isto vale também para o `oferecerRetirarDesejos`. Na página, a
  faixa da wishlist diz "Já foi bebido e quer-se voltar a ter" (a data de
  criação do vinho não é a de entrada na wishlist), e o "Passar para a
  garrafeira" chama "Nova garrafa" ao que noutro desejo é a "Primeira".
- **Quem se esquecer de passar o desejo** e puser o vinho pelo "Novo vinho"
  (ou pela importação) é apanhado no fim da gravação
  (`oferecerRetirarDesejos`/`mesmoDesejo`): a app PROPÕE, par a par, e a
  pessoa confirma — a semelhança sugere, nunca decide (a lição dos
  Duplicados da WineCatalog). A regra é apertada de propósito (ver o
  comentário no app.js): o ano não conta, o produtor e a cor contam.
- **Alimenta o catálogo partilhado, mas com força 1** (migração 29,
  28/09/2026, o dono das apps: "wishlist não preenche o Catálogo? tem que
  preencher!"). Até aí a `catalogar_vinho` saltava-o — quem o escreveu não
  tem a garrafa na mão — e, somado ao "adiado" da `vinho-info` (ver "O
  catálogo partilhado" › a escrever), um desejo procurado com IA nunca lá
  chegava: a IA esperava pelo trigger e o trigger saltava o desejo. A razão
  continua certa, era a FORÇA que estava errada: o desejo escreve com a
  origem `garrafeira-desejo`, que vale 1 em todos os campos (nem o rótulo
  vale 3 sem a garrafa) — enche o que está vazio e perde para qualquer
  coisa a sério. Ao passar para a garrafeira, o UPDATE volta a disparar o
  trigger e a garrafeira passa-lhe por cima.
  **Um desejo nunca faz nascer uma segunda linha de um vinho que o catálogo
  já tem**: escreve na linha a que está ligado (ou na que a `achar` der, a
  mesma colheita primeiro, senão qualquer uma); com a colheita diferente —
  ou sem ela, quase metade da wishlist — só os factos do VINHO (nada da
  `winecatalog.da_colheita`: a nota e as avaliações da colheita, o preço, a
  janela). Só um vinho que o catálogo não conhece em colheita nenhuma faz
  nascer a linha. Um vinho com a garrafa na mão, esse, faz nascer a linha da
  sua colheita. A 1.ª corrida (25 desejos, quase todos já no catálogo pelas
  procuras com IA de antes do "adiado") encheu 23 campos vazios e não fez
  nascer linha nenhuma.
- **É visível numa garrafeira emprestada** (é aí que um amigo vai ver o que
  oferecer), e o **PDF** também (`exportarWishlistPDF`, a mesma folha do
  Exportar PDF). Mexer é só de quem pode editar. O PDF não leva as minhas
  notas: é para enviar.
- Enquanto a coluna não existir, `detetarDesejo()` liga `body.sem-desejo` e
  tudo o que é `.desejo-only` desaparece — separador e opção do FAB.
- **Sem ano não há janela de consumo** (migração 16) — e na wishlist o
  normal é não haver ano. `beber_de`/`beber_ate` são anos de UMA colheita;
  sem ela seriam os de uma qualquer. A app não os pede à IA nem os propõe
  (`IA_JANELA`/`iaCamposPara`), o formulário esconde o campo enquanto o ano
  estiver vazio (`janelaSincronizarForm`), o "A completar" não conta a
  falta, e a BD apaga-os em qualquer escrita sem ano (trigger
  `vinhos_sem_colheita`). A `vinho-info` e a `importar-vinhos` fazem o
  mesmo do lado delas; o catálogo tem a mesma regra
  (`winecatalog.da_colheita`, no `CLAUDE.md` da WineCatalog).

## O preço de um vinho: as lojas primeiro, a colheita antes da loja
Nos ecrãs, o `preco_medio` chama-se **preço de referência** (26/09/2026,
igual na WineCatalog); a coluna mantém o nome.
Um vinho tem o `preco_medio` da ficha (a IA ou quem o escreveu) e, quando o
catálogo partilhado os tem, os **preços das lojas** — Garrafeira Nacional,
Granvine, Vinha, Vivino — com link, colheita e data da recolha. Estes
**não se copiam para `vinhos`**: lê-os a `precos_lojas` (migração 17) ao
carregar, para `PRECOS_LOJA`. Uma cópia ficava velha no dia a seguir, e o
que uma loja pede hoje não é um dado da garrafeira.
**E relêem-se depois de gravar um vinho** novo (ou com o nome/produtor
mudados — são a chave com que se acha a linha do catálogo):
`recarregarPrecosLoja`. Sem isso o vinho acabado de pôr na wishlist ficava
só com o preço de referência, sem dizer que era o da Garrafeira Nacional,
até alguém recarregar a app. Pela mesma razão, o "Procurar informação" do
vinho novo diz que lojas o catálogo tem (não as copia — não há campo para
elas).

O preço que CONTA — no crachá do cartão, no valor da garrafeira, no filtro
por preço, no "A completar" e nos dois PDFs — é **um só**, e sai sempre de
`precoPrincipal(v)`/`precoVinho(v)`; nunca `v.preco_medio` à mão nesses
sítios. A ordem, decidida pelo dono da app:
1. uma loja **da minha colheita** (GN → Granvine → Vinha);
2. o Vivino da minha colheita (só se souber qual — `?year=` no link);
3. uma loja de **outra** colheita, pela mesma ordem;
4. o Vivino sem colheita conhecida;
5. o `preco_medio`.
Uma loja vende a colheita que tem AGORA, raramente a minha — por isso a
colheita pesa antes da loja. Num vinho sem ano qualquer colheita é a
minha. O cartão diz sempre de onde veio o preço quando não é o médio
("63 € · G. Nacional · 2016"; o Vivino sem colheita é "Vivino · média",
que é o que ele mostra sem ano — nunca "colheita ?"), e a página do vinho
lista **todas** as lojas (`precosLojaHTML`); a que conta leva à frente
do nome uma nota pequena, "(preço de referência)" — sem pastilha nem
parágrafo a explicar a regra, que ninguém precisa de ler.

**Um preço desalinhado não conta** (`duvidoso`, em `precosLojaDe`): abaixo
de metade ou acima do dobro da mediana dos OUTROS preços do vinho (as
outras lojas e o `preco_medio`). Quando o script das lojas falha é na
página, não na colheita — o Casa de Saima Garrafeira veio a 8,49 € do
Vivino com as lojas a 63 € e 69 €. Aparece riscado no detalhe e nunca é o
principal; sem outro preço com que comparar, conta.

Um preço que o admin **retirou** na WineCatalog (Editar › Fontes de preço,
`retirado:true` na entrada) não sai da `precos_lojas` — nem riscado: para
esta app, essa loja não o tem.

`ano`, `produtor` e `precos` também existem na ficha do catálogo e **não**
entram na comparação do "≠ catálogo" (`catCampos` filtra por `CAT_NOMES`):
os dois primeiros são a identidade do vinho, o terceiro vive aqui.

## A nota do Vivino: duas, e a da colheita só com 100 avaliações (migração 22)
Um vinho tem a nota da **colheita** (`vivino_nota`/`vivino_avaliacoes` — o
Vivino com `?year=`) e a de **todas as colheitas** (`vivino_nota_global`/
`vivino_avaliacoes_global`, a página sem ano). Um 4,5 com 40 avaliações de
2019 diz menos do que o 4,2 de 5000 do vinho todo. Quem enche a global é o
script do Vivino da WineCatalog, no catálogo; chega cá pela
`ficha_catalogo`/`escrever_do_catalogo` como os outros campos. Os valores que
já existiam não se mexeram (decisão do dono).

**A pesquisa com IA também pede as duas, desde 27/09/2026** (`vinho-info`:
`vivinoNotaGlobal`/`vivinoAvaliacoesGlobal`; e os prompts manuais, de um
vinho e do lote). Até aí não conhecia a global, e a regra do Vivino dizia ao
modelo que "a nota que lá aparece é uma média entre colheitas" — e pedia-a
na `vivinoNota`, que é a da COLHEITA. Agora: pedir a da colheita traz também
a de todas (`camposComGlobal`/`iaCamposComGlobal`); sem colheita só se pede a
de todas; depois de lidas (`vivinoDuas`/`iaVivinoDuas`), as duas iguais ficam
só como a de todas e uma colheita com mais avaliações do que o vinho todo
deita a de todas fora; no Serper cada resultado do Vivino diz de que
colheita são os números. O visto "Tem de ser exatamente a colheita" deixou de
ser sobre o Vivino e passou a ser sobre o resto da ficha (`regraColheita`).
A regra (`regraVivino` na função, `iaManualRegraVivino` no `app.js`) é a
MESMA da `catalogo-info` da WineCatalog — mexer numa é mexer nas outras.
A cache da `vinho-info` subiu para `v4` por causa disto.

**Os sites de referência** (a caixa da "Procurar informação", 27/09/2026)
iam como ` (site:a OR site:b)` colados à consulta GERAL do Serper — o que não
dava prioridade, RESTRINGIA (sem o vinho nesses sites, a consulta voltava
vazia), e um nome sem domínio partia a consulta toda. Agora a consulta geral
é livre; os domínios (sem o Vivino, que tem a sua) têm uma consulta SÓ deles,
à frente das outras (uma consulta Serper a mais quando há sites); os
resultados deles vêm marcados "★ FONTE DE CONFIANÇA" no que o Gemini lê (o
prompt do Serper não os levava de todo); e o resultado (`sites`,
`confianca`, e `consultas` no log) diz quantos vieram de cada um — é o que o
ecrã mostra (`pqSitesHTML`). Só o pacote completo tem Serper: no intermédio,
no grounding e na resposta colada vão só no texto do pedido, e o ecrã di-lo.

**As páginas dos sites, "só estes sites" e de onde veio cada campo**
(27/09/2026, o dono das apps: "encontrei o vinho num site, dou o link e
preenchem-se os atributos a partir daí"). A `vinho-info` ABRE as páginas: um
link colado na caixa, tal e qual (em qualquer pacote — abrir uma página não
custa nada), e, de cada domínio escrito sem página, a primeira página de
produto que a procura só nesse site devolver (isso é Serper, por isso só no
completo; no intermédio o ecrã diz para colar o link). Do HTML lê o JSON-LD
do produto, as etiquetas `og:` e o texto do `<main>`; as páginas vão à frente
na base de evidência, e o Gemini devolve `deOnde` (de que página ou resultado
tirou cada campo) → `origemCampos` no resultado → a opção da IA diz
"IA · garrafeiranacional.com" (`pqDeOndeHTML`) e, no vinho novo, o
`pqFimNovo` diz de onde veio cada campo que pôs no formulário. **Só estes
sites** (`soSites`; foi um visto, e desde 30/09/2026 é o caminho "Em sites
concretos" — ver "2. IA", mais abaixo): sem a consulta geral,
sem a do Vivino se ele não for um dos sites, sem o grounding, sem a cache e
sem o catálogo; um campo sem origem sai da ficha e do catálogo (`semFonte`), mas a app mostra-o na mesma (`semFonteValores`), sem o marcar onde já há valor — quem pede um campo que tem quer ver alternativas (30/09/2026, o dono). **Com sites, a cache e o
catálogo do servidor não respondem** (`semAtalhos`): quem os escreve quer que
se leiam agora, e o catálogo já respondeu na etapa 1 do ecrã. O Vivino não se
abre (recusa servidores); uma loja que recuse fica com o resumo do Google.
Um link do Vivino colado procura-se no Google pelo nome QUE ESTÁ NO LINK, sem
aspas, e só fica essa página (`vivinoPag`, 30/09/2026): com o nome da
garrafeira entre aspas, um "do" por "de" ou um "Reserva" a mais e o Google
não devolvia nada. Sem resultado, o erro é só "Não foi possível consultar a
página facultada."
Só http(s) e nomes públicos, redireções conferidas, 1,5 MB — aqui qualquer
editor com IA pode escrever um endereço. A leitura é a MESMA da
`catalogo-info` da WineCatalog (o `CLAUDE.md` de lá tem o resto) — mexer numa
é mexer na outra.
**Numa página comprida, a parte que é deste vinho** (28/09/2026): de cada
página só se lia o princípio (6 000 caracteres), e numa página com vários
vinhos ("moraisrocha.com/vinhos/#MR-As-Velhas-Red") o vinho ficava de fora —
a página abria e o Gemini respondia, com razão, que ele não estava lá. Agora
o `#…` do link fica (`ancoraDe`; nunca vai no pedido) e, numa página maior
do que o princípio, vai a MAIS a secção para onde ele aponta (até ao vinho
seguinte, quando os `id` o dizem) e os trechos mais abaixo onde o nome
aparece (`extraDaPagina`). Só acrescenta: o princípio vai igual e o extra tem
uma quota à parte na base de evidência (`EVIDENCIA_EXTRA_MAX`); no registo, a
página diz `secao`/`trechos`.
**Os documentos: um PDF ou uma fotografia** (04/10/2026, o dono das apps:
colou o link da ficha técnica em PDF do produtor — o Dandy de Cidrô da Real
Companhia Velha — e "a IA não consegue fazer nada"). A página abria (HTTP
200), mas a leitura só conhecia HTML e recusava-a, "não é uma página
(application/pdf)"; com o "só estes sites" não sobrava nada. Agora um PDF ou
uma imagem vai INTEIRO ao Gemini, em anexo (`inline_data`, que lê PDFs,
tabelas e rótulos sem biblioteca nenhuma deste lado), por dois caminhos:
- **por link**, no "Em sites concretos" (`abrirPagina`: até 8 MB);
- **enviado da app**, no terceiro caminho de "Como queres procurar?", **📄
  Num documento** (`pqDocsHTML`/`pqDocsEscolher`; até 3 ficheiros, o PDF até
  6 MB, a fotografia encolhida aqui a 1600 px) → `documentos` no pedido
  (`lerDocumentos`), e é sempre "só o que lá estiver" (`soSites`). Não pede
  Serper: está nos dois pacotes.
Na base de evidência o documento é um bloco [n] que diz que vai em anexo, e o
anexo leva a marca do MESMO [n] — é por ele que o `deOnde` diz de onde veio
cada campo ("↳ do documento que enviaste · ficha.pdf", "↳ de
realcompanhiavelha.com · PDF lido"). O tipo decide-o o que os BYTES dizem
(`tipoDoc`: PDF, JPEG, PNG, WebP), nunca o nome nem o cabeçalho. **Não se
guarda em lado nenhum**: nem no Storage, nem nas `analises`, nem no
`sync_log` (do documento só vão o nome, o tipo e o tamanho — o `iaLog` da
app também os tira); com documentos não se lê nem escreve a cache, nem se
pergunta "pesquisaste há pouco". Uma ficha técnica de outra colheita lê-se na
mesma, e o "aviso" di-lo. A `catalogo-info` da WineCatalog não tem isto, de
propósito (como o "Procurar links"): o Catálogo vai ser fundido na Garrafeira.

**Procurar links** (29/09/2026, o dono das apps: "dar um link ao Gemini e
dizer 'procura só neste link' é o que traz a informação mais fidedigna, e
não é cara"). No pacote completo, é um botão no ecrã de colar links do
caminho "Em sites concretos", **💡 Sugere-me sites** — só a pedido, nunca ao
entrar (o dono, 30/09/2026: cada lista gasta Serper). **Procurar
links** (`pqLinks`) faz UMA pesquisa Serper (`vinho-info` com `links:true`:
síncrona, sem Gemini, sem cache nem catálogo, `[nome, ano, produtor,
"vinho"]`) e mostra até 5 links (`pqLinksHTML`): o título abre a página
noutro separador, por baixo o site e o resumo, e marcas curtas (outra
colheita no título/endereço, como o site se tem portado). Páginas de procura,
categoria ou marcas não entram (`paginaDoResultado`), nem a página inicial.
**Nenhum vem marcado**; escolhem-se **até 2** (`LINKS_ESCOLHER`) — para
outros, pesquisa-se outra vez a seguir. "Pesquisar só nestes" segue pelo
`soSites` de sempre, com os links como páginas dadas: a 2.ª fase não gasta
Serper nenhum (a não ser que uma página recuse). **O Vivino não entra na
lista** (recusa servidores); se vier nos resultados, o link e as estrelas do
Google vão com a pesquisa (`vivinoGoogle`, um resultado a mais na base de
evidência, sem outra consulta). No registo é UMA pesquisa Serper
(`passo: "links"`, `modelo: "serper"`, `serper_consultas: 1`, também no
`ia_uso` — a AI-API-Control ainda os conta como chamadas). **A medição**
(`garrafeira.paginas_por_site`, migração 30) conta, por site, as páginas
abertas nos últimos 60 dias a partir do `detalhe.paginas` do `sync_log`: não
lida = recusou, veio vazia ou não respondeu a tempo (o efeito é o mesmo). Vê-se
ao lado de cada link e em Definições › Diagnóstico. Um site que recuse sempre
ainda só se AVISA; tirá-lo da lista fica para quando houver números. A
`catalogo-info` da WineCatalog não tem isto, de propósito: o Catálogo vai ser
fundido na Garrafeira.
**As lojas primeiro, e "Mais links"** (29/09/2026, o dono). A primeira lista
vem SÓ das lojas (`LINKS_LOJAS`: Garrafeira Nacional, Granvine, Vinha.pt,
Portugal Vineyards, Wine Radar), numa consulta só com os `site:` juntos por
OR (`num:10`, no máximo 2 links por site — `LINKS_POR_SITE` —, senão uma loja
enchia a lista). Portugal Vineyards e Wine Radar abrem-se do servidor (a
`paginas_por_site` disse-o); o anti-bots da Portugal Vineyards foi só no
script do PC. **➕ Mais links** (`pqLinks(true)`) vai à internet, página a
página (`fase: "web"`, `pagina` 1 a 5, `LINKS_PAGINAS`), com os links já
mostrados em `excluir` para não se repetirem; os marcados ficam marcados, e a
lista diz de onde veio cada grupo (`pqLinksGrupo`). Cada toque é UMA consulta
Serper; a resposta diz qual é a seguinte (`proximo`, `null` no fim). Se as
lojas não tiverem nada, a mesma chamada passa logo à página 1 da internet (e
o registo conta 2 consultas).

A nota que CONTA — no crachá do cartão e da grelha, na página do vinho, na
ordenação dentro dos grupos, no filtro por Vivino, no "A completar" e na PDF
da wishlist — é **uma só**, e sai sempre de `notaVivino(v)`/`notaVivinoNum(v)`;
nunca `v.vivino_nota` à mão nesses sítios (a mesma disciplina do
`precoPrincipal`):
1. a da colheita, se tiver **pelo menos 100 avaliações** (`VIVINO_MIN_AVAL`);
2. senão, a que tiver **mais avaliações** — quase sempre a global — e em
   empate a global. É o caso de nenhuma chegar às 100.
Sem contagem conta zero; havendo só uma, é essa. Nunca uma média das duas.
O crachá é só as **uvas do Vivino** (`VIVINO_UVAS`, desenhadas a partir do
logo — as dez bagas nas mesmas posições — e não uma imagem) e a nota: disse
"todas" quando era a global, e saiu a 01/10/2026 (o dono das apps:
"interessa-me a classificação Vivino; se vem da global ou da colheita,
vê-se no detalhe") — fica no `title`. Na página do vinho, havendo as duas,
vêm as duas, cada uma dita pelo nome. As uvas são `currentColor`: vermelho
do Vivino no crachá e na fita dos filtros, a cor do texto na capa da
página. A regra é a MESMA do `wcNotaVivino` da
WineCatalog (ver o `CLAUDE.md` de lá, "A nota do Vivino são duas") — mexer
numa é mexer na outra, no mesmo dia.

## Monocasta / várias castas é CALCULADO, não guardado
`castaLabel(v)` conta as linhas de `vinho_castas`: 1 → "Monocasta", 2+ →
"Várias castas". Uma coluna na base de dados ficava dessincronizada assim
que alguém editasse as castas; a contagem nunca fica.

As castas são uma **tabela** (não texto no vinho) porque o requisito é
procurar por casta. Com texto livre, "Alicante Bouschet" e "Alicante
Bousquet" (as duas grafias aparecem nos dados de origem) eram coisas
diferentes e a procura perdia metade dos vinhos. Quem grava é a função SQL
`definir_castas(vinho_id, nomes[])` — uma transação, com `ON CONFLICT` a
resolver duas pessoas a criar a mesma casta ao mesmo tempo.

**Uma grafia por casta** (migração 38, 01/10/2026, o dono das apps): o
filtro tinha "Aragonez"/"Aragonês"/"Aragonêz", "Castelao"/"Castelão",
"Sousão"/"Souzão", "Shiraz/Syrah"/"Syrah", "Tinta Cão"/"Tinto Cão" e uma
"Touriga Nacional e Merlot". A regra é a do catálogo
(`winecatalog.normalizar_castas`, `db/castas.sql` da WineCatalog), e a
`definir_castas`/`casta_id` passam por ela (`castas_normalizadas`): separa
por " e ", "&", "/", "+", ";" e vírgulas, compara sem acentos (a
`casta_chave`), troca a grafia pela de referência e tira o que não é casta
("Vinhas Velhas"). No catálogo é um trigger na ficha. **Não junta
sinónimos regionais** (Tinta Roriz/Aragonez/Tempranillo — o nome diz de
onde é o vinho). Uma grafia nova entra na `winecatalog.casta_referencias()`,
não se corrige à mão; e "T. Nacional"/"Tª Roriz"/"Cab. Sauvignon" passam a
Touriga Nacional/Tinta Roriz/Cabernet Sauvignon (`castas_por_extenso`,
03/10/2026). A app **relê** as castas depois de gravar
(`gravarCastas`), porque não tem cópia da regra.

## O vocabulário do "tipo"
São quatro eixos, e misturá-los num campo só dá cabo dos filtros:
- **`tipo`** (cor): Tinto · Branco · Rosé · Espumante · Licoroso · Frisante
- **`estilo`**: Maduro · Verde · Colheita Tardia · Palhete. **"Verde" não é
  uma cor** — é região/estilo, e um Vinho Verde pode ser branco, tinto ou
  rosé. Por isso não vive no mesmo campo que "Tinto".
- **`mencao`** (menção portuguesa de qualidade): Reserva · Grande Reserva ·
  Garrafeira · Colheita Selecionada · Vinhas Velhas · Superior
- **`classificacao`** (legal): DOC · Vinho Regional · Vinho

As listas estão em `app.js` (`TIPOS`/`ESTILOS`/`MENCOES`/`CLASSIF`) **e** em
`vinho-info.ts` — a Edge Function deita fora o que o modelo devolver fora
delas. Se acrescentares um valor, acrescenta nos dois sítios, senão a IA
propõe uma coisa que a app nunca mostra.

### Os nomes: nunca em CAPS LOCK (migração 20)
A importação por fotografias lê o rótulo como está impresso, e entraram a
"HERDADE DO SOBROSO RESERVA TINTO" e o produtor "CARTUXA". A regra do dono
das apps: Herdades, Montes, Quintas… com maiúscula; "do/da/de" sempre
pequenos. Quem a aplica é a BD — o trigger `vinhos_nomes`, ao nome e ao
produtor, em qualquer escrita (formulário, importação, wishlist, IA,
atualização massiva) — e a regra é a `winecatalog.nome_proprio`, a MESMA do
catálogo (ver o `CLAUDE.md` da WineCatalog, "Os nomes sem CAPS LOCK"): uma
sigla sozinha num nome normal ("CARM — …", "JCA", "DOC") fica como está.
**A app não tem cópia da regra em JS**, e por isso lê de volta o que a BD
gravou (`Prefer: return=representation` nos PATCH do `guardarVinho` e da
confirmação da IA): sem isso, quem escrevesse em maiúsculas via-as no ecrã
até recarregar.

## Três níveis de permissão, mais a garrafeira
```
is_allowed()   →  entra na app
is_editor()    →  escreve (admin + quem tiver allowed_users.pode_editar)
is_admin()     →  manda em quem tem acesso e em quem é editor
pode_ver(g)    →  vê a garrafeira g       (dono · foi-lhe emprestada · admin convidado)
pode_mexer(g)  →  escreve na garrafeira g (is_editor() E dono · admin com 'edicao')
```
O Goals só tem dois ("admin" e "leitura"); aqui há o meio-termo porque numa
garrafeira de casa faz sentido haver quem dê saída a uma garrafa sem por
isso mandar na lista de utilizadores.

`is_allowed()` já não chega para ver um vinho — diz que a pessoa entra na
app, não de quem são as garrafas. Quem decide isso são as duas últimas, e
são elas que estão nas policies de `locais`/`vinhos`/`garrafas`/
`vinho_castas`.

Na UI: `body.readonly` esconde `.ro-hide` (não pode editar),
`body.naoadmin` esconde `.admin-hide` e `body.naominha` esconde
`.minha-only` (só o dono da garrafeira aberta). `.minha-only` não é o mesmo
que `.ro-hide` e é por isso que existe: o cartão das Garrafeiras TEM de
continuar visível numa garrafeira emprestada — é lá que está o caminho de
volta à própria — e só o que lá dentro é do dono (partilhar, renomear,
passar, as permissões ao admin) é que desaparece. `naominha` é "não sou o
DONO" e não "não posso editar": o admin com `'edicao'` mexe nas garrafas e
continua a ver este cartão fechado. **Isto é só a UI** — quem manda é a RLS; esconder
um botão nunca foi proteção nenhuma.

## O admin está na BASE DE DADOS, não em código
`garrafeira.config.admin_email`, lido por `garrafeira.admin_email()`. A app
começa com um valor de arranque em `ADMIN_EMAIL` (app.js) e substitui-o pelo
da config no `carregar()`. Isto existe porque a app nasce para testes com um
dono e podia um dia passar para outro: a passagem é a função SQL
`definir_admin()`, corrida à mão no SQL Editor do Supabase — não um deploy,
mas também já não um botão em Definições. Era um botão (Definições ›
Utilizadores › Passar a app) e deixou de fazer sentido tê-lo à vista: é uma
operação rara e definitiva (quem a faz fica de fora de mandar em quem entra
até alguém lho devolver do outro lado), e um botão permanente na UI é um
convite a um toque a mais. Continua a existir para quem precisar mesmo
dela — só muda o sítio de onde se chama.

`definir_admin()` recusa passar a app a quem não esteja já em
`allowed_users` — era ficar sem admin nenhum e sem forma de voltar atrás.

Isto passa a APP, não as GARRAFAS: os vinhos do Barrona são de quem for o
`dono` da garrafeira dele, e mudam de mãos por `transferir_garrafeira()`
(Definições › Garrafeiras) — essa continua na UI, é a operação do dia a dia.

**Admin da app ≠ dono da conta Supabase.** `SUPABASE_DONO_EMAIL` (app.js) é
fixo e não muda com `definir_admin()` — ao contrário de `ADMIN_EMAIL`, que
passa para quem herdar a app. A password temporária (`admin_pass_temp`) e o
Diagnóstico mexem na CONTA Supabase, que é minha mesmo depois de passar a
app a outra pessoa; por isso ficam atrás de `.dono-hide`
(`body.naodono`/`souDono()`), não só de `.admin-hide` — o próximo admin vê
"Utilizadores" mas não estas duas.

## A procura da IA (`vinho-info`)
Botão em cada vinho e no formulário de vinho novo.

**O ecrã é uma conversa POR ETAPAS, sempre a mesma** (26/09/2026, revista a
27/09 com o dono; secção "PROCURAR INFORMAÇÃO, POR ETAPAS" no app.js, `pq*`).
Era um labirinto: ao admin uma escolha de três caminhos antes de saber o que
faltava, cada caminho com o seu ecrã de revisão e, no vinho novo, uma pilha
de botões que apareciam e desapareciam. Agora:
- **O vinho novo (e a wishlist) abre COMPACTO**: nome, ano, cor e o produtor
  (opcional — ajuda o catálogo, e o candidato escolhido preenche-o). Por
  baixo, dois botões: **Procurar informação** ou **Preencher à mão**. O resto
  do formulário (`#e-resto`) só aparece depois de uma delas
  (`formMostrarResto`).
- **1. Catálogo** — corre sozinho ao abrir (grátis, `sem_ia` incluído) e
  mostra SEMPRE os candidatos em lista (`winecatalog.colheitas`: todas as
  colheitas, a cor tirada dos dois lados, o produtor como um "contém"), com
  nome, ano, produtor, castas e região; o do ano escrito vem destacado.
  Escolhe-se um, ou "Nenhum destes". Sem ano escrito, a colheita do
  escolhido passa a ser a do vinho (no formulário, ou `PQ.anoEscolhido`
  num vinho gravado); com outra colheita, só vêm os factos estáveis
  (`CAT_DA_COLHEITA`). A ficha pede-se depois à `comparar` com o nome e o
  ano DA LINHA escolhida. **Um vinho gravado já ligado ao catálogo
  (`catalogo_id`) salta esta etapa** (29/09/2026, o dono): a linha já se
  sabe, e o que ela tem chega cá sozinho — vai direto à IA.
- **2. IA** — UMA procura. O pacote completo (`premium`) faz na Edge
  Function, de seguida, o Serper e depois o grounding pelo que ele não
  trouxe; o intermédio (`gratis`) faz só o grounding — o Serper gasta
  créditos que se pagam, o grounding responde quase sempre de memória e
  custa pouco (decisão do dono, 27/09/2026). A resposta de memória diz-se
  a todos.
  **Primeiro COMO, depois O QUÊ** (30/09/2026, o dono: o primeiro ecrã da
  WineCatalog, "num site ou perguntar à IA", mas com a lista dos links para
  escolher, que lá não havia). `pqTipoHTML` → `pqTipo`: **🔗 Em sites
  concretos** ("Colas o link de 1 ou 2 páginas que já tenhas copiado, ou a
  app sugere-te alguns sites") — SÓ neles (`soSites`, sempre); abre a caixa
  para colar os links — um por linha ou separados por vírgula
  (`pqColados`), e têm de ser PÁGINAS: só o site recusa-se (`pqEPagina`; o
  dono: "queremos links concretos" — procurar dentro de um site era uma
  pesquisa Serper) — e, no pacote completo, o botão **💡 Sugere-me sites**,
  que abre a lista das lojas do "Procurar links" (escolhem-se até 2). **A
  lista só se pede, nunca abre sozinha** (o dono, 30/09/2026: cada lista é
  uma pesquisa Serper, que se paga); fechada com "‹ Voltar" não se perde
  (`pqLinksVer`), e o que lá se marcou continua a ir. No intermédio é só a
  caixa (procurar dentro de um site precisa do Serper) — ou **📄 Num
  documento** (a ficha técnica em PDF ou fotografias do rótulo, enviadas
  daqui; ver "Os documentos", mais acima) — ou **✨ Perguntar à IA**, sem
  sites. Depois, os campos e "Mais opções" (as notas); o que se marcou nos
  campos sobrevive a juntar um ficheiro (`P.camposMarca`). Os sites
  "de referência" misturados com a pesquisa geral saíram do ecrã, como na
  WineCatalog: não se sabia de onde vinha o quê (a `vinho-info` continua a
  aceitá-los). O "‹ Voltar" (`pqTipoVoltar`) volta à escolha; um erro fica
  no passo 2 do mesmo caminho, com os links que foram na caixa.
- **O que se encontrou é o ecrã da WineCatalog** (29/09/2026, o dono das
  apps: "fica mais claro o que encontrou, onde encontrou, com links"):
  `pqLinhasHTML`, as classes `.rv-*` de lá com as cores daqui. Uma linha
  por campo — o nome, o de agora riscado → o encontrado — e por baixo DE
  ONDE veio (`pqFonteHTML`): a página que a IA diz ter lido (com link, e se
  foi lida ou só o resumo do Google), o link colado, a pesquisa Google do
  grounding, o Catálogo, ou "da IA (sem dizer de onde)" — nunca se inventa
  uma origem. Vêm marcados os campos VAZIOS; quando o Catálogo e a IA
  trazem valores diferentes são duas linhas e só uma fica marcada
  (`pqMarcar`). A frase do que a pesquisa fez, os avisos em caixa, e no fim
  as fontes, os sites e a linha em itálico (`pqRodapeHTML`) são as mesmas
  da `wcRevisaoCorpo`.
- **No vinho novo**, o catálogo vai direto para os campos VAZIOS do
  formulário (`pqPorNoForm` — escolher o vinho dele é a confirmação); o que
  a IA trouxer passa pela lista acima, comparado com o formulário de AGORA
  (`P.atual` relido antes de pesquisar), e só o marcado vai para o
  formulário (`pqPassarForm`, por cima do que lá estava se foi marcado à
  mão) e o vinho **grava-se logo** (`pqGravarNovo`, 30/09/2026, o dono:
  "prefiro que guarde logo e, se o user quiser, depois abre o vinho em
  edição" — como na WineCatalog): abre-se a página do vinho, onde está o
  Editar. A primeira garrafa fica com a omissão (uma, sem lugar — por
  arrumar). "✏️ Rever antes de gravar" abre o formulário inteiro, como era;
  se a gravação recusar (falta a cor, a rede), o formulário abre-se e diz
  porquê. Até 29/09/2026 a IA enchia os vazios sozinha e dizia numa linha
  de que site tinham vindo.
- **O Editar tem TODOS os campos da ficha** (30/09/2026): também o país, as
  avaliações do Vivino (colheita e todas), o resumo e as notas de prova —
  estes quatro viviam só no `_iaExtraNovo`, gravavam-se sem nunca se verem
  nem se poderem corrigir. Agora são campos do formulário (`PQ_FORM`,
  `CAT_FICHA_FORM`), e o `_iaExtraNovo` ficou só com o carimbo da procura.
- **Num vinho gravado** há valores a proteger: cada fonte acrescenta
  PROPOSTAS a essa lista (`PQ.hist[campo][fonte]`). Nada entra sem Guardar;
  num campo vazio vem marcado o catálogo, senão a IA (`PQ_FORCA`). Tudo por
  PATCH (a `aplicar_do_catalogo` voltava a procurar a linha pelo nome, que
  é o que pode não casar). "Preencher à mão" guarda o que já se escolheu e
  abre o Editar.
- **A resposta colada de outro assistente vive no Editar** (e no "Preencher
  à mão" do vinho novo): `formManualAbrir`, para toda a gente que edita — é
  grátis. Preenche só os campos VAZIOS do formulário aberto e diz quantos
  ficaram como estavam.
- O ano e a cor nunca se propõem (`pqChaves`). Fechar a meio não perde nada:
  `PQ` fica, e o mesmo botão retoma.
- **E por isso o resultado tem saída para trás**: **‹ Pesquisar de outra
  forma** (`pqOutraPesquisa`, 30/09/2026, o dono: "quis voltar atrás para
  fazer outro tipo de pesquisa, e fico encalhado na pesquisa anterior").
  Sem ele, o único caminho depois da IA era Guardar ou Fechar — e reabrir
  retomava o mesmo resultado. Deita fora o que a IA trouxe (as propostas, o
  que se marcou nelas, os campos que vieram iguais — `P.antesIA`) e volta a
  "Como queres procurar?"; o que o Catálogo propôs fica. A pesquisa a seguir
  não pergunta "pesquisaste há pouco" (`P.jaPesquisou`): a última é a que se
  acabou de deitar fora.
A **atualização massiva** continua com o ecrã dela (`iaMostrarResultado`/
`iaAplicar`, onde vivem ainda a segunda opinião e os rádios descritos mais
abaixo) — é outra pergunta, vinho a vinho em fila. **E procura como a
procura de um vinho** (02/10/2026, o dono: "só iria à memória da IA se as
duas linhas do site do Serper não trouxessem nada"). Até aí era UMA
chamada ao Gemini com os motores de ANTES de 27/09 — o `premium` só com o
grounding, que muitas vezes não pesquisa (um lote de 7 harmonizações
voltou todo de memória, sem fonte nenhuma). Agora (`produzirFichaLote`):
- **completo** (`premium`): primeiro o Serper, vinho a vinho — a pesquisa
  GERAL só quando se pediu algum campo que não é do Vivino, a do VIVINO só
  quando se pediu um campo do Vivino (`CAMPOS_VIVINO`); pedidos só campos
  do Vivino, só essa. Depois UMA chamada ao Gemini a ler a evidência de
  todos (`promptLote`, numerada DENTRO de cada vinho) e a dizer de onde
  tirou cada campo (`deOnde` → `origemCampos`, a mesma `origemDosCampos`
  do vinho só). Só pelo que a pesquisa não trouxe, UMA chamada com
  grounding para os vinhos todos. Num lote de 10: 10 a 20 consultas Serper
  e 1 a 2 chamadas ao Gemini;
- **intermédio** (`gratis`): só o grounding, numa chamada — o Serper paga-se
  (a decisão de 27/09 para o vinho só, que o lote fazia ao contrário).
A "pesquisa Google" só se diz quando o grounding pesquisou MESMO
(`pesquisou`); de memória, o campo fica sem origem. Cada vinho traz as suas
`fontes`, `origemCampos` (sempre, mesmo vazio, quando a IA respondeu),
`catalogoCampos` e `pesquisaWeb`. No ecrã (`iaFonteHTML`, as frases do
`pqFonteHTML`, ao de leve e sem caixas de aviso no topo — o dono: "chega
perfeitamente aquele parêntesis"): "↳ de garrafeiranacional.com · resumo
no Google" com o link, "↳ da pesquisa Google (a IA não diz a página)",
"↳ do Catálogo" ou "↳ da IA (sem dizer de onde)". Com uma `vinho-info`
antiga (sem `origemCampos`) a app adivinha pelo `pesquisaWeb` do lote.
Os dados mostraram (02/10/2026) de onde vem a harmonização com fonte nas
procuras de um vinho: de páginas ABERTAS (links colados) quase sempre, e
do resumo do Google raramente (2 em 29) — por isso o grounding fica atrás
da pesquisa, e não se abrem páginas no lote.

Quem procura é a Edge
Function `vinho-info.ts`, com DOIS MOTORES desacoplados — não dois níveis do
mesmo motor, dois caminhos diferentes até ao JSON:
- **DESDE 27/09/2026 OS MOTORES TROCARAM DE PAPEL** (ver acima): o
  `premium` é Serper primeiro e grounding pelo que falta, na mesma chamada
  (`fase` em `produzirFicha`); o `gratis` é só grounding; a "profunda" deixou
  de ser um caminho à parte. Os dois pontos seguintes contam como era antes.
- **`premium`** ("IA com pesquisa web (Grounding Search)" na UI) — Gemini com
  **grounding search** (`tools:[{google_search:{}}]`), a pesquisar e escrever
  a ficha na mesma chamada. Sem isso o modelo inventa notas do Vivino e preços
  de memória, que é exatamente o que não se quer numa base de dados. Por
  causa do tool, a API **recusa** `response_mime_type: json` — o JSON vem em
  texto e é extraído na função (`extrairJson`).
  **Mas o tool não OBRIGA a pesquisar** — o modelo decide, e nas 25
  procuras premium registadas até 24/09/2026 nunca pesquisou (tokens
  totais = entrada + saída, ~5 s): respondeu de memória. Para toda a gente
  fica assim; o resultado leva `pesquisaWeb` (também na cache), e ao admin
  (`garrafeira.is_admin()`, confirmado na função) a procura de memória
  mostra 🧠 e o botão **🔬 Pesquisa profunda** (`profunda:true`), que salta
  a cache e o catálogo e **corre como o modo `gratis`** (abaixo): a pesquisa
  é feita por nós (Serper, geral + uma consulta ao Vivino) e o Gemini só lê
  os resultados. Até 25/09/2026 a profunda era o grounding com um prompt a
  "exigir" a pesquisa — e respondeu de memória na mesma: não há parâmetro
  na API que obrigue o Gemini a pesquisar. Os prompts MANUAIS pedem sempre a pesquisa a
  sério (`IA_MANUAL_PESQUISA`). Mesmo critério nas quatro apps — ver o
  `CLAUDE.md` da WineCatalog, "De memória ou pesquisado".
- **`gratis`** ("IA sem pesquisa web" na UI) — pesquisa **externa** primeiro
  (Search API, secrets `SEARCH_API_KEY`/`SEARCH_API_URL`), os resultados vão
  no PROMPT como "base de evidência", e o Gemini só EXTRAI o JSON — nunca
  pesquisa por si. Nasceu para cortar a dependência da chave grátis do Gemini
  ter quota própria: essa chave chegou a responder 404/429 a todos os
  modelos, com ou sem pesquisa, e a procura morria ali para quem não fosse
  premium (ver o histórico em Definições › Diagnóstico). Com a pesquisa a
  vir de outro serviço, o Gemini só faz extração — mais barato e sem essa
  dependência.
- **Os DIREITOS continuam a ser três** (`sem_ia`/`gratis`/`premium`,
  `allowed_users.ia_plano`), mas passaram a decidir só que MOTOR cada um pode
  pedir, não uma quota de Gemini: **nenhum dos dois tem limite diário na
  `vinho-info`**. Só o admin muda o direito de cada um, em Definições ›
  Utilizadores; o admin é sempre `premium` na BD (`garrafeira.plano_ia()`).
  A função pergunta `plano_ia()` com o JWT de quem chamou e nunca aceita do
  browser um plano MAIOR do que esse: o cliente manda `plano` no corpo,
  `auth.plano === "premium" ? pedidoModo : "gratis"` — pedir MENOS do que se
  tem é sempre permitido, nunca mais. É o `importar-vinhos` (fotos) que
  continua com quota diária (`GEMINI_IMPORT_FREE_DAILY_LIMIT`, 3/dia): aí sim
  cada pedido é uma chamada cara por imagem, sem cache possível.
- **Dois modelos por chamada, do barato para o caro, só se precisar**
  (`MODELO_BARATO`=flash-lite, `MODELO_ESCALADO`=flash): tenta-se sempre o
  barato primeiro e só se escala se a resposta vier vazia ou pobre
  (`qualidadeMinima` — menos de dois campos críticos, ou sem Vivino). É isto,
  e não uma quota por utilizador, que segura o custo por procura na
  `vinho-info`.
- **O catálogo partilhado responde antes de tudo isto** (secção própria mais
  abaixo): o que já se sabe do vinho não se volta a perguntar, e à IA vai só
  o que falta.
- **Cache por vinho** (`garrafeira.catalogo_vinhos_cache`, TTL configurável
  por `VINHO_CACHE_TTL_HOURS`, 30 dias por omissão): a chave inclui o MOTOR,
  o nome, o ano, o produtor, a região e os campos pedidos — o mesmo vinho,
  pedido da mesma forma, não paga a chamada ao Gemini (nem, no `gratis`, a
  pesquisa externa) uma segunda vez dentro da janela.
- **Cada um procura com o motor do seu DIREITO** (`motorDoPlano()`): premium
  a quem o tem, "sem pesquisa web" aos outros. `iaPedir(pedido,vinhoId,motor)`
  manda o MOTOR no corpo do pedido e a função atende `premium` só a quem a BD
  disser que o é. As análises registam o direito em `analises.plano_ia`; o
  trigger volta a carimbá-lo pela função SQL, mesmo se alguém falar com o
  PostgREST à mão.
- **O admin pode simular os outros direitos, só no SEU browser**
  (`IA_TESTE`/`iaTesteMudar()`, o seletor na própria linha do admin em
  Definições › Utilizadores): não muda `allowed_users.ia_plano` nem
  `plano_ia()` na BD — o admin continua sempre `premium` aí — só o que
  `planoIA()` devolve no browser que fez a escolha. Serve para testar o que
  cada direito mostra (botões escondidos em `sem_ia`, "sem pesquisa web" em
  `gratis`) sem precisar de outra conta; guarda-se em `localStorage`
  (`gf_ia_teste`) e nunca se aplica a quem não é admin.
- **Na atualização massiva, quem é premium pode pedir uma SEGUNDA OPINIÃO ao outro motor**
  (`iaSegundaOpiniao()`, o botão "Tentar com a…"): a mesma pergunta feita ao
  motor que não é o do direito (ou o do `IA_TESTE`, ver acima), para se ver
  campo a campo em que é que diferem. Serve também de saída quando o motor do
  direito falha.
- **Com as duas leituras, a confirmação passa a ser uma ESCOLHA.** `IA_RES` é
  a primeira (motor `IA_MOTOR`, o do plano) e `IA_RES2` a segunda opinião
  (`IA_MOTOR2`); os rótulos saem daí e NÃO estão fixos no HTML — qual das duas
  é a paga depende de quem procura, e é ela que leva o dourado. Com uma
  leitura só, cada campo é uma caixa como sempre foi; com duas, os campos em
  que elas DISCORDAM viram botões de rádio — manter / uma / outra — porque com
  duas propostas em cima da mesa "marcado" já não dizia qual delas entrava.
  Num campo vazio vem marcada a leitura PREMIUM, seja ela a primeira ou a
  segunda. Onde as duas concordam fica
  a caixa e diz-se isso: pedir uma escolha onde não há escolha nenhuma era
  encher o ecrã de decisões falsas. O "manter" está sempre lá, mesmo num campo
  vazio — sem ele, duas propostas obrigavam a aceitar uma, que é o contrário
  de confirmar. Premium é dourado (a cor da distinção nesta app), e
  `iaTudoDe('r1'|'r2'|'atual')` põe a ficha inteira numa das leituras de uma
  vez, que é o que torna a comparação legível. No formulário de vinho novo não
  há este ecrã: lá a segunda opinião reescreve o que a primeira encheu
  (`_iaAuto`) e mais nada.
  **A importação por imagens ficou de fora** — as duas leituras devolvem
  conjuntos de vinhos diferentes e compará-las campo a campo obrigava a
  emparelhá-los por semelhança de nome, que erra.
- **Segundo plano** (`garrafeira.analises`): a função cria uma linha
  'pendente', responde já com o `id` e continua com `EdgeRuntime.waitUntil`;
  a app faz polling (`iaEsperar`). É preciso porque a pesquisa demora mais
  do que um pedido HTTP aguenta (o browser/iOS corta perto dos 60s) e, no
  telemóvel, bloquear o ecrã a meio matava a chamada.
- **Escolhe-se o que procurar antes de procurar** ("O que pedir", `pqCamposHTML`): a lista
  dos campos, com os VAZIOS já marcados. Vai no pedido como `campos`, e a
  função usa-a para (a) dizer ao modelo em que se concentrar e (b) cortar da
  resposta o que não foi pedido. Pedir os 22 campos de uma vez faz o modelo
  andar atrás de tudo e voltar com meia dúzia de coisas mornas.
- **Não se procura duas vezes o mesmo sem perguntar** (`iaUltimaProcura`,
  perguntado em `pqIA`, `IA_AVISO_DIAS=30`). Cada procura é uma chamada paga
  ao Gemini com pesquisa Google, e a ficha de um vinho não muda de semana
  para semana. Ao carregar em "Procurar" vê-se quando é que este vinho foi
  procurado pela última vez; se foi há menos de 30 dias, a janela passa a
  perguntar "…pela última vez em AAAA-MM-DD hh:mm. Pretendes fazer novamente
  a pesquisa?" antes de gastar. A data sai da mais recente de duas: a linha
  em `analises` (o registo exato de CADA procura, mas a RLS só deixa ver as
  minhas — o admin vê todas) e `vinhos.ai_atualizado_em` (só fica quando se
  aceitou alguma coisa, mas vê-se seja de quem for — é o que apanha a procura
  de OUTRO editor). Este segundo **só conta com `ai_modelo` a começar por
  `gemini`**: é o único valor que a app escreve ali. O resto do que está
  nessa coluna ("pesquisa web (Claude) + complemento (ChatGPT)", "…confirmação
  no rótulo (Barrona)") veio da importação à mão — ficha cheia, mas sem
  nenhuma chamada paga por trás. Sem essa condição o aviso disparava nos 85
  vinhos no primeiro dia, e um aviso que aparece sempre não se lê. Se a consulta falhar, não se avisa e procura-se na mesma:
  um soluço de rede não pode impedir alguém de procurar. No formulário de
  **vinho novo** não há aviso nenhum — ainda não há vinho para ter história.
- **No vinho novo (e na wishlist), primeiro o CATÁLOGO, a IA só se se
  pedir** (26/09/2026; hoje é a etapa 1 do `pqAbrirNovo`). "Procurar informação"
  pergunta à `winecatalog.comparar` (grátis, aberta a quem tem sessão),
  preenche os campos vazios com o que lá está e diz quantos vieram e o que
  falta; completar com a IA é um botão à parte, nunca automático. Antes ia
  direto à `vinho-info`, que já usava o catálogo mas escondia-o atrás de
  "preenchido pela IA" — e pagava a IA pelo resto sem ninguém ter pedido.
  **O ano é de quem escreve**: só vai ao catálogo se estiver no formulário,
  e nunca volta de lá nem da IA (`iaPreencherForm` já não toca no
  `e-ano`; a `vinho-info` não devolve ano sem ano no pedido). Sem ano, o
  catálogo responde com a colheita mais completa e, em empate, a mais
  recente; com ano e outra colheita, só os factos estáveis
  (`CAT_DA_COLHEITA`). Cor diferente da escolhida = outro vinho, não se
  copia nada. Um link do Vivino fora do formato (`vivinoLink`) não se copia
  e o ecrã DIZ que não copiou — calado, parecia esquecido. E o link do
  Vivino vai para o campo `e-vivino-url`, à vista: ia só para o
  `_iaExtraNovo`, o campo ficava em branco e, ao gravar, o que lá estivesse
  escrito à mão era tapado pelo da procura.
- **A COR diz-se ANTES de se procurar.** A cor faz parte da identidade do
  vinho no catálogo partilhado — um branco com a cor errada ia procurar (e
  gravar) com a chave do tinto. No formulário de **vinho novo** o seletor
  nasce vazio ("— escolhe a cor —") e o botão de procurar recusa sem ela,
  tal como já recusava sem o nome. Desde a fase 4 dos nomes (27/09/2026)
  gravar também exige a cor (ver "O nome, a cor e o produtor"), por isso num
  vinho gravado a procura usa a dele. Houve uma linha **Cor** a confirmá-la
  na etapa da IA (`pqCorHTML`/`iaCorGuard`, do tempo em que o `tipo` nascia
  'Tinto' por omissão); saiu a 30/09/2026 (o dono: "já não seleciona atrás,
  logo na pesquisa inicial?"). Muda-se no Editar.
- **O texto vem sempre em português** (30/09/2026, o dono: chegavam notas
  de prova em inglês e espanhol, copiadas das páginas das lojas). Uma regra
  de IDIOMA em todos os prompts — `regraIdioma` nos quatro da `vinho-info`,
  `IA_MANUAL_IDIOMA` nos dois manuais do `app.js`, uma linha na
  `importar-vinhos`: traduz, nunca copia; o nome, o produtor e as castas
  ficam como são; a região com o nome português. A cache subiu para `v5`
  para não servir respostas antigas noutra língua.
- **Nada é gravado sem confirmação.** O resultado abre campo a campo
  (`iaMostrarResultado`), com o que está agora ao lado do que a IA propõe.
  Vêm marcados **só os campos vazios**: substituir o que alguém escreveu à
  mão por uma leitura automática tem de ser um clique consciente.
- **Um valor que é um ENDEREÇO abre-se ali** (`escLink`): o "antes" e o
  "depois" de um `vivino_url`/`imagem_url` saem como hiperligação, nos três
  caminhos que passam pelo `iaMostrarResultado` (procura de um vinho,
  atualização massiva, procura manual) e também no painel do catálogo
  (`catCampoHTML`). Ninguém decide qual dos dois links do Vivino é o do vinho
  certo lendo a cadeia de caracteres — decide-se abrindo os dois, e sem o `<a>`
  a única saída era copiá-los à mão para outro separador. O texto do link é o
  endereço **inteiro**: é o fim dele (o id, o `?year=`) que distingue um do
  outro, e cortá-lo deixava dois `https://www.vivino.com/…` iguais lado a
  lado. O `<a>` dentro do `<label>` da caixa/rádio não é problema — a spec
  manda o `label` ficar quieto quando o clique cai em conteúdo interativo lá
  dentro.

## O catálogo partilhado com a WineSelection (não pagar duas vezes o mesmo)
Há uma segunda app de vinhos no mesmo projeto Supabase — a **WineSelection**
(fotografa a carta de um restaurante e sugere o vinho) — e as duas faziam a
mesma pergunta ao Gemini sobre os mesmos vinhos, cada uma por sua conta. O
schema **`catalogo`** é a memória comum: o que já se pesquisou (nas duas
apps) e o que alguém já confirmou por ter a garrafa em casa. Fonte de
verdade: **`db/catalogo.sql` no repo WineCatalog** — o catálogo mudou-se
para o schema `winecatalog` em setembro de 2026, e deste lado só ficou o
gancho (`db/catalogo-partilhado.sql`, migração 12, ver `db/README.md`).

**Não é a cache do `vinho-info`.** `garrafeira.catalogo_vinhos_cache` é uma
cache TÉCNICA de um pedido — mesma pergunta, mesmos campos, mesmo motor,
mesma resposta — e morre com o TTL. O `catalogo` é sobre o VINHO, atravessa
as duas apps, e não expira por inteiro: só os campos que envelhecem. As duas
coexistem e o `produzirFicha` consulta-as por essa ordem.

**A fronteira do que atravessa é a mesma que já existia entre "vinho" e
"garrafa".** Entra só facto sobre o VINHO: castas, região, tipo, teor,
estágio, nota do Vivino, preço médio, janela de consumo, notas de prova,
harmonização. Nunca `notas` (as minhas notas), nunca `imagem_path` (a
fotografia tirada em casa, que apanha a prateleira à volta), nunca o preço
de compra nem o lugar na prateleira — esses são da GARRAFA e da PESSOA, e
não saem daqui. Se acrescentares uma coluna a `vinhos`, a pergunta a fazer
é essa: **isto é sobre o vinho ou sobre quem o tem?** Só a primeira resposta
entra em `garrafeira.catalogar_vinho()`.

Isto NÃO abre garrafeira nenhuma. Ninguém passa a ver uma linha de
`vinhos`, `garrafas` ou `locais` de outra pessoa — a RLS é a mesma e o
"cada um vê a sua garrafeira" fica intacto. O que se partilha é o que se
sabe sobre um rótulo, que nunca foi de ninguém.

Como funciona, dos dois lados:

- **a ler** (`produzirFicha` em `vinho-info.ts`): depois da cache falhar,
  pergunta-se ao catálogo o que já se sabe, e calcula-se o que SOBRA
  (`emFalta`). Se não sobrar nada, **não há chamada nenhuma** — nem ao
  Gemini nem à pesquisa externa. Se sobrar, a IA é chamada **só por esses
  campos**: um pedido mais estreito é mais barato e melhor respondido, que
  é a mesma razão por que a app já deixa escolher os campos ("O que pedir");
- **a escrever**: o que a IA acabou de descobrir volta ao catálogo, e o
  trigger `vinhos_catalogo` leva para lá cada vinho que alguém guarda —
  **mas a IA só escreve com um nome confirmado** (27/09/2026): um vinho já
  gravado (`vinhoId`), ou a LINHA desta colheita e cor que o catálogo já
  tem (`exato` da `procurar` — 02/10/2026: um vinho parecido noutra
  colheita não chega, porque a `juntar` escreve na colheita pedida e fazia
  nascer a linha ela própria; foi a #383, "Piano Grande Reserva" sem ano
  nem produtor, criada pela procura do vinho que se estava a criar no
  Catálogo, e a `criar` recusou-o um minuto depois). No vinho novo sem essa
  linha, não escreve (`catalogo: "adiado"` no `sync_log`): o nome é o que a pessoa escreveu e ainda o pode corrigir —
  o formulário é a confirmação. Foi o "Cristo vinhas velhas": a IA respondeu
  pelo Quinta do Crasto, a pessoa gravou "Crasto Vinhas Velhas" na wishlist,
  e o catálogo ficou com uma linha com o nome errado e sem produtor, de um
  vinho que ninguém tinha (resolvida nos Duplicados da WineCatalog). A linha
  nasce quando o vinho é gravado, pelo trigger, com o nome final — na
  wishlist também, desde a migração 29 (com força 1; ver "A wishlist é um
  vinho sem garrafas"). **A exceção é um vinho de uma CARTA** (`daCarta`, as
  Sugestões, 03/10/2026): o nome é o que o restaurante imprimiu, e escreve-se
  logo — com a cor que a carta disse, e sem ler a cache (uma resposta de lá
  não voltava ao catálogo). As
  castas não vivem na linha do vinho, por isso o trigger não as vê mudar —
  o gancho que falta está no fim da `definir_castas`, em `functions.sql`;
- **nada disto pode deitar uma procura abaixo.** É uma poupança, não uma
  dependência: se o RPC falhar, segue-se para a IA como sempre. Daí os
  `try/catch` a engolir tudo, e o `EXCEPTION WHEN OTHERS` no trigger.

**Quem ganha quando duas leituras discordam** é a `winecatalog.forca()`, e não
é uma opinião sobre quem é mais inteligente — é sobre o que cada uma teve à
frente: quem tem a garrafa em casa e a pesquisa Google a sério da
`verificar-vinhos` valem 3; as pesquisas normais das duas apps valem 2; um
vinho escrito à pressa numa garrafeira, a que ninguém tocou, vale 1 (o
`tipo` nasce 'Tinto' por omissão nesta app, e sem essa distinção uma linha
de rascunho carimbava "Tinto" por cima de uma pesquisa que dizia Branco),
e um desejo da wishlist também (`garrafeira-desejo`, sem a garrafa na mão); e
a estimativa de memória da WineSelection vale **0** — não entra nunca.

**A força é da origem E DO CAMPO**, e a segunda metade é o que impede o
catálogo de tomar por facto tudo o que alguém escreveu à mão. Isto é uma
app onde CADA UM ESCREVE O QUE QUISER na sua garrafeira, e o trigger leva
isso para uma tabela que as duas apps leem: sem a distinção, um número
escrito à pressa vale o mesmo que uma pesquisa Google e tapa-a para toda a
gente. A linha é a do rótulo: quem tem a garrafa na mão sabe melhor do que
qualquer pesquisa as castas, a cor, o teor, a região, a menção — isso vale
3, e é a razão de a Garrafeira estar lá em cima. Ninguém sabe a nota do
Vivino nem o preço de mercado por ter a garrafa na mão: esses lêem-se num
site, e vindos de uma garrafeira valem **2** — chegam para encher um campo
vazio, perdem para a `verificar-vinhos` no dia em que ela existir. É a
mesma fronteira do `winecatalog.volatil`, vista pelo outro lado: o que
envelhece é também o que não se sabe por ter a garrafa à frente.

O estado real desta base, antes disto, era esse: **todos** os 3104 campos
do catálogo com origem `garrafeira` e força 3 — nota do Vivino e preço de
mercado incluídos. Nem um único campo tinha vindo de uma pesquisa, e não
podia: 3 tapa 2. O catálogo estava selado à volta do que estava escrito à
mão nas garrafeiras. A migração baixou a força GRAVADA nesses campos
voláteis (o `f` no `origens`) — sem isso a mudança na função não servia de
nada, que o que decide é o número que ficou escrito no dia em que o campo
entrou.

**A colheita é o que separa um facto de uma invenção.** As castas de um Papa
Figos são as mesmas em 2019 e em 2021; a nota do Vivino e o preço não são.
Por isso `winecatalog.procurar` distingue duas perguntas que parecem uma:
"quero o de 2019" com só o de 2021 no catálogo devolve os factos estáveis e
corta a nota; "quero o Papa Figos" e mais nada (que é como as cartas de
restaurante vêm) devolve tudo e diz de que colheita é. A primeira versão
tratava as duas igual e cortava a nota nas duas — um catálogo que nunca
respondia a uma carta.

**E a colheita certa não pode TAPAR o que a irmã sabe.** Achar a linha do
ano pedido e ficar por aí parece o mais óbvio, e era o que estava — mas a
linha do ano certo pode ser um espelho quase vazio (o vinho que alguém
acabou de escrever na sua garrafeira) enquanto a do ano ao lado tem
dezassete campos: o catálogo respondia "não sei" com a resposta a um metro
de distância, e a IA era paga na mesma. Foi o que aconteceu ao Grous Moon
Harvested. Agora o que a linha CERTA sabe manda sempre, e só o que lhe
FALTA se pede emprestado à irmã — e apenas os campos **estáveis**, nunca a
nota nem o preço (é a mesma regra do parágrafo de cima, e não pode ter duas
versões). O `procurar` devolve em `emprestados` quais foram, para se poder
ver de onde veio cada coisa.

**O parêntesis no produtor não entra na chave.** "Herdade dos Grous (Monte
do Trevo)" ou "Quinta do Vesúvio (Symington Family Estates)" é uma NOTA de
quem escreveu — a sociedade que detém, a marca do grupo — não outro
produtor. A deixá-la entrar, o mesmo vinho ficava em duas linhas, cada uma
a pagar a sua ida à IA. Tira-se só do PRODUTOR, nunca do NOME: um
"(Branco)" no nome é a cor, e a cor não sai da chave.

**A chave (o que faz dois vinhos serem o mesmo vinho) vive só no SQL**, e
cada linha tem DUAS: `chave` (nome + produtor, como uma garrafeira escreve)
e `chave_nome` (só o nome, como uma carta escreve). Sem as duas, "Barca
Velha" numa carta nunca encontrava o "Barca Velha" + "Casa Ferreirinha" de
uma garrafeira. A trave é que um nome que sozinho não distinga nada
("Reserva") não ganha `chave_nome` — senão o Reserva de um produtor
respondia pelo de outro. E não é contenção de tokens (a
`verificarCoerencia` da WineSelection faz isso, e ali está certo): contenção
juntava "Quinta do Crasto" com "Quinta do Crasto Reserva", que num aviso é
aceitável e num catálogo é a nota errada dada como certa.

Na UI, uma ficha que aparece do nada merece dizer de onde veio
(`iaOrigemHTML`, `.ia-cat`): verde e não dourado, que o dourado é a
distinção do vinho e isto é uma boa notícia sobre a PROCURA.

**A ligação ao catálogo guarda-se** (migração 28, 28/09/2026). Até aqui um
vinho não sabia qual era a sua linha: achava-a pelo NOME de cada vez, e por
isso um nome corrigido no catálogo partia a ligação em vez de chegar cá — a
gravação seguinte fazia nascer lá outra linha com o nome antigo. Agora:
- `vinhos.catalogo_id` é a linha do catálogo deste vinho. **A app nunca o
  escreve** (a guarda `vinhos_ligacao_guard` desfaz o que vier dela); quem o
  escreve é a `ligar_catalogo`, chamada pelo trigger `vinhos_catalogo` a
  cada gravação. Sem FK, de propósito: o catálogo é uma poupança. A wishlist
  também se liga, e desde a migração 29 também alimenta o catálogo (com
  força 1, e sem fazer nascer outra linha de um vinho que lá está);
- enquanto o dono não mexe na identidade (nome, produtor, ano, cor) e a
  colheita é a mesma, o trigger escreve NA linha ligada, com o nome e o
  produtor dela (`catalogar_e_ligar`). Mudada a identidade, procura-se pelo
  nome, como sempre — pode ser outro vinho;
- **o nome e o produtor que o admin muda no catálogo chegam cá sozinhos**
  (`receber_identidade`, chamada por um trigger do catálogo —
  `db/garrafeiras-identidade.sql` da WineCatalog, que tem o resto), em todas
  as garrafeiras, com uma linha no `sync_log` (origem `winecatalog`, acao
  `identidade_do_catalogo`). Chega tal e qual: o `vinhos_nomes` deixa-o
  passar sem o arrumar (marca `garrafeira.do_catalogo`), não volta ao
  catálogo e não carimba `atualizado_em`. Nunca o ano nem a cor; um produtor
  vazio no catálogo não apaga o de cá. O que a `juntar` muda sozinha (o
  produtor que enche um vazio) não chega cá — e o nome ela já não muda.
**Se mexeres no `vinhos_nomes` ou no `vinhos_catalogo`**, as duas marcas
(`garrafeira.do_catalogo`, `garrafeira.ligar`) têm de continuar lá à
cabeça: sem elas, o nome do catálogo era rearrumado à chegada ou a escrita
voltava ao catálogo.

## Importar por imagens (`importar-vinhos`)

A **"📷 Importar por imagens"** vive no **FAB**, ao lado do "Novo vinho" e da
"Atualização massiva" — as três formas de ACRESCENTAR vinhos no mesmo sítio.
Esteve em Definições › Dados e veio de lá: aquele cartão é o das cópias de
segurança, por onde os dados SAEM, e quem acabou de fotografar a prateleira
procura o "+". No Catálogo (aos curadores) o que se escolhe nasce no
catálogo, sem garrafas (ver "A atualização massiva e a importação no
Catálogo"). Aceita uma a três fotos de rótulos, listas ou prateleiras. `encolherImagem()` reduz cada uma no
browser; a função recebe os base64 apenas em memória, envia-os ao Gemini e
descarta-os no fim. Não há upload para Storage nem imagens dentro da tabela
`garrafeira.importacoes`: essa tabela guarda somente os metadados do pedido e
o resultado pendente, associado ao email do JWT e à garrafeira que o editor
pode alterar.

`importar-vinhos.ts` usa só `GEMINI_FREE_API_KEY`, nunca a chave premium, e
não usa pesquisa web. Os modelos tentados começam pelos PONTEIROS
(`gemini-flash-latest`/`gemini-flash-lite-latest`, que apontam sempre para o
que a Google tem em produção agora) e completam-se com o que um `ListModels`
feito com a PRÓPRIA chave grátis disser que ela tem — nomes de versão fixos
("gemini-2.5-flash") partiram-se assim que a Google os reformou; a mensagem
de erro do Gemini foi literal: "no longer available to new users". Se
mesmo assim nenhum modelo responder, a mensagem distingue 404 (a chave não
tem acesso a nenhum) de 429 (sem quota no Google) — mesma lógica do
`vinho-info.ts`. O plano
grátis tem o limite por utilizador `GEMINI_IMPORT_FREE_DAILY_LIMIT` (3 por
defeito); premium não tem esse limite. A função corre a leitura em segundo
plano com `EdgeRuntime.waitUntil`, e a app consulta `importacoes` até ficar
concluída ou com erro. O resultado é sempre uma proposta: a UI deixa escolher
cada vinho e editar nome, produtor, ano e quantidade; só `importarGuardar()`
cria o vinho, as castas e as garrafas.
- Quem pode chamar é qualquer **editor** — e a pergunta é feita à BD
  (RPC `is_editor()`) com o JWT de quem chamou, não comparando emails dentro
  da função. Assim a regra vive num sítio só e mudar de admin não obriga a
  redeploy.
- **Diagnóstico** (`garrafeira.sync_log`): a app grava `pedido` antes de
  chamar (apanha o "nem saiu do browser") e a função grava `ok`/`erro` com o
  modelo e o erro exato do Gemini. Do lado do browser vê-se sempre "502"; a
  causa está lá. Definições › Diagnóstico.

## O registo central de acessos ao Gemini (schema `ia_uso`)
Esta app não é a única a chamar o Gemini: são **seis** no mesmo projeto
Supabase, por nove Edge Functions, e cada uma tinha só o seu `sync_log` —
a pergunta *"quanto é que isto custa ao todo?"* não tinha onde ser
respondida. O schema **`ia_uso`** é uma linha por chamada (app, função,
modelo, tokens, custo estimado, duração, quem, erro).

**A secção canónica é a do `CLAUDE.md` da WineCatalog** — a fonte de
verdade do schema é o `db/ia_uso.sql` desse repo, não deste. Aqui fica só
o que é preciso saber para não partir nada:

- **Um 200 com o corpo VAZIO não é resposta, e não pode passar por
  sucesso.** O modelo gasta o orçamento a pensar e não escreve uma letra —
  HTTP 200, `candidatesTokenCount: 0`. A `importar-vinhos` devolvia uma lista de ZERO vinhos como se a leitura tivesse corrido bem; a `vinho-info` já dava erro, mas chamava-lhe "resposta ilegível", que é outra coisa (ali houve texto e não se entendeu). Agora o corpo lê-se DENTRO do
  ciclo dos modelos (um vazio passa ao seguinte) e, se nenhum escrever,
  fecha em **erro** com o `finishReason` à frente. A lição inteira, com o
  caso que a pagou, está no `CLAUDE.md` da WineCatalog ("O 200 vazio").
- **Daqui escrevem duas funções**: `vinho-info.ts` e `importar-vinhos.ts`,
  as duas com `app: "garrafeira"`. A `registarIaUso()` de cada uma é
  chamada no fim do `registar()` local — o mesmo `detalhe` que vai para o
  `garrafeira.sync_log`, só com tokens/modelo/custo também em colunas, e
  um `POST` para outro schema (`Content-Profile: ia_uso`).
- **Está duplicada nas duas de propósito**, como tudo neste projeto (cada
  Edge Function é auto-contida). Se mexeres nela aqui, a regra do costume
  aplica-se: vê as outras sete no mesmo dia.

- **Nunca deita abaixo o trabalho que estava a ser feito**: vive num
  `try/catch` que engole tudo — é registo, não é o trabalho.
- **E é essa mesma regra que o faz falhar em SILÊNCIO quando está mal
  configurado.** Já aconteceu: sem os GRANTs do `db/ia_uso.sql`, os INSERTs
  levavam 403 e a tabela ficava a zero linhas sem um erro em lado nenhum.
  Se `ia_uso.registos` estiver vazia, confere **(1)** se `ia_uso` está nos
  *Exposed schemas* do painel e **(2)** se o bloco de GRANTs correu — só
  depois desconfia do código.
- **Não há migração a correr deste lado** e nada aqui depende disto: se o
  schema `ia_uso` não existir, estas funções comportam-se exatamente como
  antes.

## Regras técnicas (não partir a app)
- `app.js` carrega como `<script src>` **normal, NÃO module** — há
  `onclick="…"` no HTML e no HTML gerado, as funções têm de ser **globais**.
- **PWA/cache: o número é dos TRÊS e sobe no mesmo commit** — o
  `CACHE_NAME` do `sw.js`, o `APP_BUILD` do `app.js` e o `data-build` do
  `<body>`. Se mexeres em `app.js`, `style.css` ou `index.html`, sobe-os.
  **E confere que SOBE, não que muda.** Um `app.js` escrito a partir de uma
  cópia velha traz o `APP_BUILD` velho atrás, e o `verificarBuild()` passa a
  discordar PARA SEMPRE: recarrega uma vez, continua a discordar, e a barra
  vermelha ("a app ficou a meio de uma atualização") fica lá em cima em
  todas as cargas, com os botões todos a funcionar. Já aconteceu — de 83
  para 82 — e o sinal é esse: o aviso a aparecer sempre, e não só logo a
  seguir a um deploy. Nesse caso desconfia do ficheiro inteiro, não só do
  número: o mesmo commit tinha revertido, calado, o trabalho do commit
  anterior.
  Os três ficheiros são network-first de propósito: com o JS em
  cache-first, um deploy dava ao browser o `index.html` novo com o `app.js`
  velho — botões novos a chamar funções que ainda não existiam, sem erro
  visível. Aconteceu no Goals.
  **Mas o network-first só manda no browser, e isso não chegou.** O CDN do
  GitHub Pages propaga os ficheiros um de cada vez, e há uma janela de
  segundos a seguir a um deploy em que a mesma carga apanha o HTML novo com
  o JS velho — a avaria volta, na mesma forma e igualmente calada
  ("carrego nos filtros e não acontece nada"). Daí o `verificarBuild()` no
  arranque do `app.js`: compara o `APP_BUILD` com o `data-build` do
  `<body>`, recarrega **uma** vez (a janela é de segundos, e uma recarga
  costuma bastar) e, se ainda discordarem, põe uma barra com um botão que
  desregista o service worker e recarrega. O `sessionStorage` (`gf_build`)
  é o que impede o ciclo infinito; a barra leva estilo INLINE de propósito,
  porque o `style.css` pode ser justamente o ficheiro velho e esta é a
  mensagem que não pode depender de mais nada para aparecer.
- **Supabase:** schema `garrafeira`, `Accept-Profile`/`Content-Profile` em
  **todos** os pedidos REST (`sbHeaders`) — é isso que aponta para o schema,
  nunca vai no URL. A chave no topo do `app.js` é a **`anon`** (pública, por
  design), protegida por RLS + login. **Não é bug nem risco — não a
  "corrijas" nem a escondas.**
- **Não há `salvar()`.** Cada mutação é o `POST`/`PATCH`/`DELETE` da própria
  linha, atualiza o `db` local e re-renderiza. Padrão para um campo novo:
  optimista no `db`, `try/catch` à volta do `sbReq`, desfaz se a rede falhar.
- **Uma tabela de conteúdo NOVA precisa de `garrafeira_id`** — coluna, FK,
  índice, e as duas policies por `pode_ver()`/`pode_mexer()`. Uma tabela que
  se esqueça disto é uma tabela que toda a gente lê: a RLS não adivinha de
  quem é a linha. A única exceção é uma tabela pendurada num vinho (como
  `vinho_castas`), que vai buscar a garrafeira ao vinho por
  `garrafeira_do_vinho()` em vez de repetir a coluna.
- **Os `id` são reais da BD** (`bigint GENERATED BY DEFAULT AS IDENTITY`,
  lidos de volta com `Prefer: return=representation`), nunca `Date.now()`.
- **Alterar o schema:** edita primeiro `db/*.sql` (fonte de verdade) e só
  depois corre no SQL Editor do Supabase — nunca ao contrário. Ver
  `db/README.md` para a ordem e os passos manuais (expor o schema
  `garrafeira` na API, redirect URLs).
- **Escapar HTML:** `esc()` para conteúdo; `escJs()` para o que vai dentro
  de `onclick="…('…')"` — há vinhos com plica no nome ("Clefs D'or") e sem
  isso partiam o atributo.
- **`body>header`, nunca `header` solto no CSS.** O cabeçalho da app é um
  `<header>`, mas os cartões do mapa também tiveram cabeçalhos: com o
  seletor solto herdavam o bordô, o `position:sticky` e o texto branco — o
  nome do local ficava branco sobre branco. `ajustarSticky()` procura pelo
  mesmo `body>header`.
- **`input[type=date]` precisa de `min-width:0` e `-webkit-appearance:none`.**
  No iOS o campo de data não encolhe sozinho e saía pela borda do modal
  fora. A regra está no `style.css` uma vez, para todos.
- **Modais são folhas no telemóvel** (`@media(max-width:560px)`): sobem de
  baixo e é a `.mbox` que faz scroll, não a página por trás.
- Faz **edições cirúrgicas** (diffs pequenos).

## Ícones
**O ícone é o G com o copo de vinho** (01/10/2026, o dono das apps; até aí
era a estante redonda do `icone.svg`, que saiu). A fonte é o
`icone-fonte.png` — o desenho que o dono mandou, recortado ao quadrado e
com o fundo transparente. Tudo o resto é **gerado** dele (Pillow, LANCZOS
com alfa pré-multiplicado), e para o mudar muda-se a fonte e volta-se a
gerar:
- `icone.png` — 256px, transparente: o `badge` das notificações;
- `icone-claro.png` — 256px, transparente, gerado do `icone-claro-fonte.png`
  (o G BRANCO com o copo, que o dono mandou a 01/10/2026): o cabeçalho
  (`.escudo`) e o ecrã de arranque (`.gl-splash-logo`), direto no bordô e no
  verde, só com uma sombra. Antes era o G bordô num azulejo de papel — no
  fundo escuro não se lia sem ele;
- `apple-touch-icon.png` — 180px, opaco (o G a 72% em branco): o iPhone, o
  favicon e o `icon` das notificações. O iOS guarda-o quando se põe a app
  no ecrã principal: quem já a tinha só vê o novo depois de a tirar e pôr;
- `icone-512.png` (o G a 72%) e `icone-maskable.png` (a 56%, dentro da zona
  segura do Android) — o `manifest.json`;
- `nota-g.png` — 48px, transparente, o G do crachá da nota da casa.

## Deploy
GitHub Pages a partir de `main`. Um push para `main` publica.
