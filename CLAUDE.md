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
- `db/` — `schema.sql` → `functions.sql` → `policies.sql` → `seed.sql`
  (+ `README.md` com os passos manuais no painel do Supabase). Fonte de
  verdade do schema. `migracao-garrafeiras.sql` é a migração 07 (uma
  garrafeira por pessoa); `migracao-ia-planos.sql` é a 08 (planos de IA por
  utilizador) e, numa base existente, é seguida por `functions.sql`.
  `catalogo-partilhado.sql` é a 12 e era a única que criava um schema que **não
  é desta app**: o `catalogo`, partilhado com a WineSelection (ver secção
  própria). Também é seguida por `functions.sql`.
  `migracao-blindagem.sql` é a 13: fecha o que o linter do Supabase apanhou
  (as tabelas de backup de setembro estavam com RLS DESLIGADA num schema
  exposto — qualquer pessoa com a chave `anon` lia os vinhos de toda a gente
  sem login). Traz escrito o que NÃO se revoga e porquê; lê-o antes de
  "arrumar" mais algum aviso do linter.
- Não mexer à mão: `apple-touch-icon.png` (é gerado — ver "Ícones").

## Os cinco separadores (o ecrã inicial não é a lista)
`Garrafeira` (resumo) · `Detalhe` · `Locais` · `Consumidos` · `Definições`.

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
(`preco_compra`) quando se sabe, e o `preco_medio` do vinho quando não se
sabe; garrafas sem nenhum dos dois não entram na conta (inventar um preço
era pôr no cartão um número que ninguém podia conferir). Abre por
**intervalo de preço** (`FAIXAS_PRECO`/`faixaIndice`: até 15€, 15€–30€,
30€–50€, acima de 50€) — é a pergunta que se faz a seguir a "quanto vale
isto": está sobretudo em garrafas baratas ou caras? O painel também mostra
o **valor médio por garrafa** (só ali, não no card fechado — o card fechado
já tem o total).

**A completar** são os vinhos a quem falta alguma coisa que a app usa —
imagem, castas, preço médio ou classificação (`FALTAS`/`faltasDe`).

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
HTML (depois da organização/ordenação — texto que se lê antes de agrupar) e
sobe para `#s-locais` (antes do `#mapa`) quando se entra lá; ao voltar a
Detalhe, desce outra vez. Por ser o mesmo `<input>`, o texto e os filtros
ligados não se perdem ao trocar de separador.

Colapsada ocupa **uma linha só**: a caixa de texto e, à direita, o botão
"Filtros" que abre o resto (chips, pastilhas) por baixo — antes eram duas
linhas sempre visíveis (a barra de procura e, por baixo, a barra do botão).
`renderFiltrados()` é o despachante desta procura: atualiza os chips/
pastilhas e volta a desenhar **Detalhe e Locais os dois**, sem tentar
adivinhar qual dos dois está aberto (o mesmo raciocínio do `renderLista()`,
ver abaixo). O texto da caixa vem em letra pequena de propósito — é uma
linha de trabalho, não conteúdo para se ler devagar.

Os filtros são texto livre, local, tipo, região, casta, produtor, nº de
castas, ano, menção, **preço** e **grau alcoólico** (`FAIXAS_PRECO`/
`FAIXAS_TEOR`, o mesmo desenho por intervalo do card do Valor), maturação e
Vivino (`F`/`F_META`/`opcoesFiltro`). Cada um é um chip desenhado por nós
com o `<select>` **nativo por cima, invisível** (`opacity:0;inset:0`): o
desenho é nosso, o seletor continua a ser o do telemóvel — um dropdown
feito à mão em JS era mais código e pior no iOS. O que está ligado aparece
em pastilhas com ✕ próprio (`.factivos`), escondidas quando o painel está
aberto para não dizer a mesma coisa duas vezes.

A **maturação** não filtra por "No ponto" — filtra pelo **terço da janela**:
*No ponto · a abrir*, *· a meio*, *· a fechar*, mais *Ainda cedo* e *Já
passou* (`listasFiltro`, valores `ponto:abrir`/`ponto:meio`/`ponto:fechar`).
"No ponto" sozinho está em quase todos os vinhos e devolvia a lista quase
inteira; a pergunta que sobra é em que parte da janela se está, e *a fechar*
é a lista do que se deve beber primeiro. As palavras são as mesmas que a
ficha do vinho escreve (`FASES`) — quem filtra por uma tem de a reconhecer
quando abre o vinho.

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

Com a procura ligada, só se anda pelos locais com garrafas que passam nela
(a contagem passa a "4 encontradas · de 35") e os lugares ocupados por
garrafas que NÃO passam ficam **apagados** (`.msdot.fora`) — o que fica a
cor é a resposta a "onde estão as minhas garrafas de Syrah".

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

## A linguagem visual (o "charme")
Duas famílias e uma regra de cor. **Fraunces** (serifa) para o que se lê
devagar — nomes de vinhos, anos, números, títulos; **Inter** para a
interface. A cor é informação, não decoração: **bordô** = a app, **dourado**
= distinção (menção portuguesa e nota do Vivino), e o resto vive em tons de
papel. O fundo tem uma textura de pontos em CSS puro (nada de imagens).

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
  carimba data/sítio/nota. É esse histórico que responde ao "onde é que bebi
  aquela relíquia" — apagar a linha era deitar isso fora, e é a única parte
  destes dados que não se recupera;
- a lista principal só mostra vinhos com `stockDe(id) > 0`. Um vinho todo
  bebido continua na base de dados e no separador Consumidos, mas sai da
  garrafeira.

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
Botão em cada vinho e no formulário de vinho novo. Quem procura é a Edge
Function `vinho-info.ts`, com DOIS MOTORES desacoplados — não dois níveis do
mesmo motor, dois caminhos diferentes até ao JSON:
- **`premium`** ("IA com pesquisa web (Grounding Search)" na UI) — Gemini com
  **grounding search** (`tools:[{google_search:{}}]`), a pesquisar e escrever
  a ficha na mesma chamada. Sem isso o modelo inventa notas do Vivino e preços
  de memória, que é exatamente o que não se quer numa base de dados. Por
  causa do tool, a API **recusa** `response_mime_type: json` — o JSON vem em
  texto e é extraído na função (`extrairJson`).
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
- **Quem é premium pode pedir uma SEGUNDA OPINIÃO ao outro motor**
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
- **Escolhe-se o que procurar antes de procurar** (`iaEscolher`): a lista
  dos campos, com os VAZIOS já marcados. Vai no pedido como `campos`, e a
  função usa-a para (a) dizer ao modelo em que se concentrar e (b) cortar da
  resposta o que não foi pedido. Pedir os 22 campos de uma vez faz o modelo
  andar atrás de tudo e voltar com meia dúzia de coisas mornas.
- **Não se procura duas vezes o mesmo sem perguntar** (`iaUltimaProcura`,
  `iaConfirmarRepetir`, `IA_AVISO_DIAS=30`). Cada procura é uma chamada paga
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
- **A COR diz-se ANTES de se procurar** (`iaCorGuard`). O `tipo` nasce
  'Tinto' por omissão e a cor faz parte da identidade do vinho no catálogo
  partilhado — um branco que ninguém corrigiu ia procurar (e gravar) com a
  chave do tinto. A BD não consegue distinguir um 'Tinto' escolhido de um
  'Tinto' por defeito, por isso a resposta é PERGUNTAR, uma vez, onde se
  carrega em Procurar: no seletor de campos (`iaEscolher`) há uma linha
  **Cor** no topo, já com a do vinho, e mudá-la ali grava-a no vinho; no
  formulário de **vinho novo** o seletor nasce vazio ("— escolhe a cor —") e
  o botão de procurar recusa sem ela, tal como já recusava sem o nome.
  Gravar continua a aceitar o defeito — o que passou a ser obrigatório é
  procurar, não guardar.
- **Nada é gravado sem confirmação.** O resultado abre campo a campo
  (`iaMostrarResultado`), com o que está agora ao lado do que a IA propõe.
  Vêm marcados **só os campos vazios**: substituir o que alguém escreveu à
  mão por uma leitura automática tem de ser um clique consciente.

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
  é a mesma razão por que a app já deixa escolher os campos (`iaEscolher`);
- **a escrever**: o que a IA acabou de descobrir volta ao catálogo, e o
  trigger `vinhos_catalogo` leva para lá cada vinho que alguém guarda. As
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
de rascunho carimbava "Tinto" por cima de uma pesquisa que dizia Branco); e
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

## Importar por imagens (`importar-vinhos`)

O botão **Definições → Dados → Importar por imagens** aceita uma a três fotos
de rótulos, listas ou prateleiras. `encolherImagem()` reduz cada uma no
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

## Regras técnicas (não partir a app)
- `app.js` carrega como `<script src>` **normal, NÃO module** — há
  `onclick="…"` no HTML e no HTML gerado, as funções têm de ser **globais**.
- **PWA/cache:** se mexeres em `app.js`, `style.css` ou `index.html`,
  **sobe o `CACHE_NAME` no `sw.js`**. Os três são network-first de
  propósito: com o JS em cache-first, um deploy dava ao browser o
  `index.html` novo com o `app.js` velho — botões novos a chamar funções que
  ainda não existiam, sem erro visível. Aconteceu no Goals.
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
`icone.svg` é a fonte. O `apple-touch-icon.png` (iOS não aceita SVG) é
**gerado** — o script que o desenha está no histórico do commit inicial;
para o mudar, muda o SVG e volta a rasterizar com o mesmo desenho.

## Deploy
GitHub Pages a partir de `main`. Um push para `main` publica.
