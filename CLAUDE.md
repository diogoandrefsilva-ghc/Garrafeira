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
  modais (que são preenchidos por JS, vazios no HTML).
- `app.js` — **toda a lógica** (~2000 linhas). Secções (`grep` pelo título,
  não leias o ficheiro todo):
  Sessão Supabase (`sbHeaders`/`sbFetch`/`sbReq`/`sbRpc`) ·
  **A garrafeira aberta** (`GA_ID`) · Permissões ·
  **DB** (`carregar` + `carregarGarrafeira`) · Índices e cálculos ·
  Navegação · **Resumo** (ecrã
  inicial) · Pesquisa (Detalhe + Locais) · Filtros · **Detalhe** (lista
  organizada) · Mapa dos locais · Consumidos · **Página do vinho** ·
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
  garrafeira por pessoa) para a base que já existe — a única deste repo
  ainda **por aplicar** no Supabase.
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

`Locais` (`renderMapa`) é cada local como uma estante: cabeçalho com a cor
do sítio e **duas contagens em serifa, com a palavra à frente** — "9 vinhos"
e "12 garrafas". São mesmo coisas diferentes (12 garrafas podem ser 9
vinhos), e um número solto ao canto não dizia de quê. Cada lugar é uma
célula com a garrafinha desenhada, o nome (até duas linhas) e o lugar em
destaque. Com a procura ligada, só aparecem os locais e lugares com garrafas
que passam nela — é a resposta a "onde estão as minhas garrafas de Syrah".

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

**Passar a APP ≠ passar uma GARRAFEIRA.** `definir_admin()` passa quem manda
em quem entra; `transferir_garrafeira()` passa as garrafas. A entrega ao
Barrona precisa dos dois cliques, em Definições. Transferir só o dono o pode
fazer (nem o admin), e só para quem já tenha `pode_editar`.

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
dono e passa depois para outro (o Barrona): a passagem é **Definições ›
Utilizadores › Passar a app** (`definir_admin()`), não um deploy.

`definir_admin()` recusa passar a app a quem não esteja já em
`allowed_users` — era ficar sem admin nenhum e sem forma de voltar atrás
pela interface.

Isto passa a APP, não as GARRAFAS: os vinhos do Barrona são de quem for o
`dono` da garrafeira dele, e mudam de mãos por `transferir_garrafeira()`
(Definições › Garrafeiras). A entrega ao Barrona é dois cliques, não um.

**Admin da app ≠ dono da conta Supabase.** `SUPABASE_DONO_EMAIL` (app.js) é
fixo e não muda com `definir_admin()` — ao contrário de `ADMIN_EMAIL`, que
passa para quem herdar a app. A password temporária (`admin_pass_temp`) e o
Diagnóstico mexem na CONTA Supabase, que é minha mesmo depois de passar a
app a outra pessoa; por isso ficam atrás de `.dono-hide`
(`body.naodono`/`souDono()`), não só de `.admin-hide` — o próximo admin vê
"Utilizadores" mas não estas duas.

## A procura da IA (`vinho-info`)
Botão em cada vinho e no formulário de vinho novo. Quem procura é a Edge
Function `vinho-info.ts` — irmã da `calendario-sporting` do Goals: mesma
descoberta de modelo, mesma escada de variantes, mesmos fallbacks.
- **Grounding com pesquisa Google** (`tools:[{google_search:{}}]`). Sem isso
  o modelo inventa notas do Vivino e preços de memória, que é exatamente o
  que não se quer numa base de dados. Por causa do tool, a API **recusa**
  `response_mime_type: json` — o JSON vem em texto e é extraído na função
  (`extrairJson`).
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
- **Nada é gravado sem confirmação.** O resultado abre campo a campo
  (`iaMostrarResultado`), com o que está agora ao lado do que a IA propõe.
  Vêm marcados **só os campos vazios**: substituir o que alguém escreveu à
  mão por uma leitura automática tem de ser um clique consciente.
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
