# Garrafeira — guia para o assistente

Gestão de uma garrafeira caseira: o que lá está, **onde** está (local,
prateleira, lugar), e o que já se bebeu. **Sem build, sem npm.** Site
estático (GitHub Pages), PWA. Dados e login em **Supabase** — o **mesmo
projeto** do Goals/FestasBV/SplitBill (`gjweqwfbnkgnibhajldc`), num schema à
parte e isolado: `garrafeira`.

## Estrutura
- `index.html` — só markup: os três ecrãs de autenticação (`page-login`,
  `page-nova-pass`, `page-sem-acesso`), o splash, os 5 separadores e os 5
  modais (que são preenchidos por JS, vazios no HTML).
- `app.js` — **toda a lógica** (~2000 linhas). Secções (`grep` pelo título,
  não leias o ficheiro todo):
  Sessão Supabase (`sbHeaders`/`sbFetch`/`sbReq`/`sbRpc`) · Permissões ·
  **DB** (`carregar`) · Índices e cálculos · Navegação · **Resumo** (ecrã
  inicial) · Pesquisa (ecrã inicial) · Filtros · **Detalhe** (lista
  organizada) · Mapa dos locais · Consumidos · **Modal do vinho** ·
  Modal editar/novo · Consumir garrafa · Modal da garrafa · **IA** ·
  Auth (Supabase) · Definições · Locais · **Utilizadores (admin)** ·
  **Migração dos dados antigos** · Exportar · Diagnóstico · Init.

## Os cinco separadores (o ecrã inicial não é a lista)
`Garrafeira` (resumo) · `Detalhe` · `Locais` · `Consumidos` · `Definições`.

O ecrã inicial (`Garrafeira`) é **resumo + procura**: quatro cards —
vinhos, monocasta, regiões, castas — e, por baixo, a procura com os filtros
todos (texto, local, tipo, região, casta, monocasta, ano, menção,
maturação). De propósito: a primeira versão copiou demasiado do Goals
(painel cheio de números **e** a lista toda logo à entrada) e ficou
carregada para o que é.

Os cards são os `.sc` de sempre, na grelha 2×2 — não mudes isso para uma
lista vertical, já se tentou e ficou pobre. Três deles abrem, ao tocar, uma
contagem casta a casta ou região a região (`renderResumo`, `scCard`,
`resumoPainel`, `contarPor`); tocar numa linha dessa contagem mostra os
vinhos (`resumoDrill`). O painel (`.sc-det`) abre **por baixo da grelha
toda**, com `grid-column:1/-1` — pô-lo logo a seguir ao card aberto partia a
grelha ao meio e deixava buracos.

O painel tem **barra própria** (`.rdet-bar`): ‹ voltar à esquerda, a migalha
do sítio onde se está no meio, ✕ à direita (`resumoFechar`). Antes o voltar
era um link solto no meio do conteúdo e não havia como fechar sem ir outra
vez ao card lá em cima. O card aberto fica preenchido e com o chevron
virado — é o que liga o painel ao sítio de onde saiu.

A lista só aparece quando há alguma coisa filtrada (`haFiltros()`): sem
isso o ecrã inicial voltava a ser a lista toda, que é o que se quis tirar
daqui. Um clique numa casta no modal do vinho (`filtrarPorCasta`) volta ao
ecrã inicial com esse filtro aplicado — é lá que os filtros vivem.

`Locais` (`renderMapa`) é cada local como uma estante: cabeçalho com a cor
do sítio e **duas contagens em serifa, com a palavra à frente** — "9 vinhos"
e "12 garrafas". São mesmo coisas diferentes (12 garrafas podem ser 9
vinhos), e um número solto ao canto não dizia de quê. Cada lugar é uma
célula com a garrafinha desenhada, o nome (até duas linhas) e o lugar em
destaque.

`Detalhe` (`renderDetalhe`) é a **lista completa sem filtro nenhum**, só
organizada por região ou por ano (`agruparVinhos`, `detAgrupar`). Não lhe
metas procura nem filtros: isso é a Garrafeira, e ter os dois sítios a
filtrar era ter duas verdades sobre o que está a ser mostrado.

`renderLista()` ficou como o despachante chamado depois de QUALQUER
mutação (guardar, apagar, consumir, mover): atualiza resumo + pesquisa +
detalhe de uma vez, sem tentar adivinhar qual separador está aberto — o
dataset é pequeno, refazer os três é mais simples e mais seguro.

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
2. a **identidade** — nome, ano, produtor/tipo/região, castas, menção, nota;
3. depois de um filete, o **rodapé do que é físico** — onde está a garrafa e
   se está no ponto de beber.
Um crachá novo entra numa destas zonas; não há uma quarta.

## A imagem de cada vinho
`garrafaSVG(v)` desenha a garrafa em SVG inline: o vidro toma a cor do
`tipo` (`VIDRO`), o rótulo leva o ano. Se o vinho tiver `imagem_url` (foto
do rótulo), essa vai por cima — e o `onerror` tira-a se o link estiver
morto, ficando a garrafa desenhada em vez de um quadrado vazio.

É desenhada e não uma pasta de imagens porque **não há build nem servidor
de imagens aqui**: assim não custa um pedido à rede, não falha offline e
não depende de um link de terceiros que um dia morre. A garrafa aparece
também no mapa dos locais (versão `mini`, sem rótulo) e na capa do modal.

`vinhos.imagem_url` já está aplicada no Supabase deste projeto — a
`vinho-info` (Edge Function) também tenta trazê-la na procura da IA (link
DIRETO da fotografia, não o da página; ver `vinho-info.ts`). Mesmo assim a
app **deteta** se a coluna existe (`detetarImagem()`) e, se um dia faltar
numa base nova antes do `db/schema.sql` correr, esconde o campo e não o
manda nas gravações — sem isso um PATCH rebentava **todas** as gravações
com 400.

## A procura (o ecrã inicial)
A barra de procura está sempre à vista; os **filtros vivem atrás do botão
"Filtros"**, que traz o número dos que estão ligados. Com nove caixas
abertas de uma vez, o ecrã inicial era uma parede cinzenta.

Cada filtro é um chip desenhado por nós com o `<select>` **nativo por cima,
invisível** (`opacity:0;inset:0`). O desenho é nosso, o seletor continua a
ser o do telemóvel — um dropdown feito à mão em JS era mais código e pior no
iOS. O que está ligado aparece em pastilhas com ✕ próprio (`.factivos`),
escondidas quando o painel está aberto para não dizer a mesma coisa duas
vezes.

Sem procura nenhuma, em vez do vazio ficam três atalhos (`sugestoesHTML`)
que carregam nos filtros que já existem — "no ponto de beber", "já
passaram", "monocasta" — e só aparecem se tiverem alguma coisa.
- `style.css` — todo o CSS. Ver **"A linguagem visual"** mais abaixo antes
  de lhe mexer: as cores e os tipos de letra são um sistema, não gosto.
- `sw.js` — service worker (cache PWA).
- `vinho-info.ts` — a Edge Function que procura a ficha do vinho na net
  (deploy à parte: `supabase functions deploy vinho-info`).
- `dados-iniciais.js` — o Excel e o bloco de notas de onde isto partiu, já
  lidos e limpos. Só a migração lhe toca.
- `db/` — `schema.sql` → `functions.sql` → `policies.sql` → `seed.sql`
  (+ `README.md` com os passos manuais no painel do Supabase). Fonte de
  verdade do schema.
- Não mexer à mão: `apple-touch-icon.png` (é gerado — ver "Ícones").

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

## Três níveis de permissão (não dois)
```
is_allowed()  →  vê tudo
is_editor()   →  escreve (admin + quem tiver allowed_users.pode_editar)
is_admin()    →  manda em quem tem acesso e em quem é editor
```
O Goals só tem dois ("admin" e "leitura"); aqui há o meio-termo porque numa
garrafeira de casa faz sentido haver quem dê saída a uma garrafa sem por
isso mandar na lista de utilizadores.

Na UI: `body.readonly` esconde `.ro-hide` (não pode editar) e
`body.naoadmin` esconde `.admin-hide`. **Isto é só a UI** — quem manda é a
RLS; esconder um botão nunca foi proteção nenhuma.

## O admin está na BASE DE DADOS, não em código
`garrafeira.config.admin_email`, lido por `garrafeira.admin_email()`. A app
começa com um valor de arranque em `ADMIN_EMAIL` (app.js) e substitui-o pelo
da config no `carregar()`. Isto existe porque a app nasce para testes com um
dono e passa depois para outro (o Barrona): a passagem é **Definições ›
Utilizadores › Passar a app** (`definir_admin()`), não um deploy.

`definir_admin()` recusa passar a app a quem não esteja já em
`allowed_users` — era ficar sem admin nenhum e sem forma de voltar atrás
pela interface.

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

## A migração dos dados antigos
`dados-iniciais.js` (gerado a partir do Excel da sala e do bloco de notas
dos níveis) + o botão em Definições › Dados. **Trava-se sozinha se já houver
vinhos** — garrafas a dobrar num mapa de garrafeira são piores do que
garrafas nenhumas. O cabeçalho do `dados-iniciais.js` diz o que foi limpo ao
ler as fontes e porquê.

## Regras técnicas (não partir a app)
- `app.js` carrega como `<script src>` **normal, NÃO module** — há
  `onclick="…"` no HTML e no HTML gerado, as funções têm de ser **globais**.
- **PWA/cache:** se mexeres em `app.js`, `style.css`, `index.html` ou
  `dados-iniciais.js`, **sobe o `CACHE_NAME` no `sw.js`**. Os quatro são
  network-first de propósito: com o JS em cache-first, um deploy dava ao
  browser o `index.html` novo com o `app.js` velho — botões novos a chamar
  funções que ainda não existiam, sem erro visível. Aconteceu no Goals.
- **Supabase:** schema `garrafeira`, `Accept-Profile`/`Content-Profile` em
  **todos** os pedidos REST (`sbHeaders`) — é isso que aponta para o schema,
  nunca vai no URL. A chave no topo do `app.js` é a **`anon`** (pública, por
  design), protegida por RLS + login. **Não é bug nem risco — não a
  "corrijas" nem a escondas.**
- **Não há `salvar()`.** Cada mutação é o `POST`/`PATCH`/`DELETE` da própria
  linha, atualiza o `db` local e re-renderiza. Padrão para um campo novo:
  optimista no `db`, `try/catch` à volta do `sbReq`, desfaz se a rede falhar.
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
