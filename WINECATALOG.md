# WineCatalog — o que é preciso saber antes de a construir

Documento de arranque para uma sessão nova. Escrito em setembro de 2026, a
partir do trabalho que pôs o catálogo partilhado de pé nas duas apps que já
existem. **Lê-o todo antes de escrever código** — quase tudo o que aqui está
foi pago com um erro.

Quando a app existir, este ficheiro passa a ser o `CLAUDE.md` do repo novo.

---

## 1. Porque é que esta app existe

Há duas apps de vinhos no mesmo projeto Supabase (`gjweqwfbnkgnibhajldc`):

- **Garrafeira** — gestão da garrafeira de casa (o que lá está, onde está, o
  que já se bebeu). Schema `garrafeira`.
- **WineSelection** — fotografa a carta de um restaurante e sugere o vinho.
  Schema `wineselection`.

As duas pagavam ao Gemini para perguntar o mesmo sobre os mesmos vinhos. Em
setembro de 2026 criou-se o schema **`catalogo`**: a memória comum. O que
uma app descobre, a outra aproveita.

O catálogo funciona. O que **não** tem é casa:

1. **Ninguém consegue ver o que lá está.** A tabela tem RLS ligada e **zero
   policies** — só as Edge Functions (service_role) lhe chegam. Não há um
   único ecrã em lado nenhum que mostre uma linha do catálogo.
2. **Os duplicados não se resolvem sozinhos.** Dois registos do mesmo vinho
   escritos de maneiras diferentes ficam em duas linhas, cada uma a pagar a
   sua ida à IA. Um deles resolveu-se por acaso (ver §7); os outros ficam.
3. **Um vinho que ninguém tem não cabe em lado nenhum.** A `vinho-info`
   precisa de um vinho numa garrafeira; a `verificar-vinhos` precisa de uma
   carta analisada. Um vinho que se quer conhecer por curiosidade — ou para
   enriquecer o catálogo antes de precisar dele — não tem por onde entrar.
4. **Não se sabe quanto está a poupar.** As funções já registam
   `custo_estimado_eur` no `sync_log` (e `0` quando o catálogo respondeu),
   mas ninguém soma isso em lado nenhum.

E há um problema de governo que uma app nova resolve de graça: o catálogo
**não é de nenhuma das duas apps**. Pôr o painel de administração dele dentro
da Garrafeira significava que quem herdasse a Garrafeira (o `ADMIN_EMAIL`
passa com `definir_admin()`) herdava poder sobre uma tabela que também serve
a WineSelection. Uma app própria tem o seu dono e as suas permissões.

---

## 2. O que JÁ existe — não voltes a construir

**Fonte de verdade do schema: `db/catalogo-partilhado.sql` no repo
Garrafeira** (migração 12). Não há cópia em lado nenhum, de propósito.
Quando mexeres no schema, mexes LÁ primeiro e só depois corres no Supabase.

### 2.1 A tabela

```sql
catalogo.vinhos (
  id, chave, chave_base, chave_nome, base_nome,
  nome, produtor, ano,
  ficha    jsonb,   -- os factos do vinho
  origens  jsonb,   -- proveniência CAMPO A CAMPO: {campo:{o,f,em}}
  fontes   jsonb,   -- [{titulo,url}], no máximo 8
  vezes, visto_em, criado_em, atualizado_em
)
-- UNIQUE (chave) · INDEX (chave_base)
-- RLS ligada, ZERO policies
```

Estado em 11 de setembro de 2026: **162 linhas, 149 vinhos distintos, 3106
campos, média de 19,2 campos por linha, nenhuma sem ano.**

### 2.2 As funções

| função | o que faz | SECURITY DEFINER | `authenticated` pode? |
|---|---|---|---|
| `tokens(texto)` | normaliza para tokens | não | sim |
| `chave_base(nome, produtor)` | a identidade sem ano | não | sim |
| `chave(nome, produtor, ano)` | `base\|ano` | não | sim |
| `base_nome(nome)` / `chave_nome(nome, ano)` | a identidade só pelo nome | não | sim |
| `achar(nome, produtor, ano, exigir_ano, excluir)` | acha a linha | não | sim (mas a RLS não devolve nada) |
| `forca(origem, campo)` | quem ganha quando discordam | não | sim |
| `volatil(campo)` | o campo envelhece? | não | sim |
| **`juntar(...)`** | **escreve** | **sim** | **não (REVOKE)** |
| **`procurar(...)`** | **lê** | **sim** | **não (REVOKE)** |
| **`procurar_lote(...)`** | **lê, em lote** | **sim** | **não (REVOKE)** |

O `REVOKE` das três últimas é deliberado e **não se desfaz**: o schema
`catalogo` está EXPOSTO na API do Supabase, e uma função `SECURITY DEFINER`
nasce com `EXECUTE` para `PUBLIC`. Sem o `REVOKE`, qualquer pessoa com login
numa das apps podia chamar `juntar` do browser e carimbar o que lhe
apetecesse com a força de quem tem a garrafa na mão.

### 2.3 Quem lê e quem escreve hoje

| Edge Function | repo | lê o catálogo | escreve |
|---|---|---|---|
| `vinho-info` | Garrafeira | sim, antes da IA | sim, `vinho-info-premium\|gratis` |
| `sugerir-vinho` | WineSelection | sim, `procurar_lote` | sim, `ws-sugestao` |
| `verificar-vinhos` | WineSelection | sim (só os COMPLETOS) | sim, `ws-verificacao` |
| trigger `vinhos_catalogo` | Garrafeira (BD) | — | sim, `garrafeira`/`garrafeira-bruto` |
| `definir_castas()` | Garrafeira (BD) | — | sim (as castas não passam pelo trigger) |

---

## 3. As invariantes — não se rediscutem

Cada uma custou um erro. A app nova herda-as todas.

**1. O catálogo é sobre o VINHO, nunca sobre quem o tem.**
Entra: castas, região, tipo, teor, estágio, nota do Vivino, preço de
mercado, janela de consumo, notas de prova, harmonização.
NUNCA entra: as `notas` pessoais, o `imagem_path` (a fotografia tirada em
casa, que apanha a prateleira à volta), o `preco_compra`, o lugar na
prateleira, o `garrafeira_id`, o `criado_por`.
Ao acrescentar uma coluna, a pergunta é sempre: **isto é sobre o vinho ou
sobre quem o tem?**

**2. Isto não abre garrafeira nenhuma.** Ninguém passa a ver uma linha de
`vinhos`, `garrafas` ou `locais` de outra pessoa. O "cada um vê a sua
garrafeira" fica intacto. O que se partilha é o que se sabe sobre um
rótulo, que nunca foi de ninguém.

**3. A `pontuacaoAprox` da WineSelection NUNCA entra.** É uma estimativa de
memória do modelo, sem pesquisa. A `forca()` devolve 0 para ela. Toda a
WineSelection está construída à volta de não disfarçar uma estimativa de
verificação; deixá-la entrar aqui era espalhá-la pelas duas apps com ar de
facto pesquisado.

**4. O "barato/justo/caro" também não entra**, por outra razão: não é do
vinho, é de uma CARTA. O mesmo Papa Figos é barato a 22 € e caro a 45 €, e
nem o vinho mudou. O que atravessa é o `preco_medio`; a comparação com a
carta refaz-se sempre em código.

**5. A força é da ORIGEM e do CAMPO.**

```
3  garrafeira        (o que se lê no RÓTULO: castas, cor, teor, região)
3  ws-verificacao    (pesquisa Google a sério, pedida à mão)
2  garrafeira        (nota do Vivino, preço — quem tem a garrafa na mão
                      não sabe isto melhor; copiou de algum lado)
2  vinho-info-premium / vinho-info-gratis / ws-sugestao
1  garrafeira-bruto  (vinho escrito à pressa, a que ninguém tocou)
0  tudo o resto      — não entra
```

A segunda linha do `garrafeira` é a que impede o catálogo de tomar por
facto tudo o que alguém escreveu à mão. **As duas apps deixam cada um
escrever o que quiser nos campos do seu vinho**, e o trigger leva isso para
uma tabela que as duas leem. Sem a distinção por campo, os 3106 campos do
catálogo ficavam todos a 3 — e ficaram, durante umas semanas: *nenhum*
campo tinha entrado por uma pesquisa, e nenhum podia, porque 3 tapa 2.

**6. A colheita separa um facto de uma invenção.** As castas de um Papa
Figos são as mesmas em 2019 e em 2021; a nota do Vivino e o preço não são.
Campos voláteis (`volatil()`) nunca atravessam colheitas. Campos estáveis
atravessam.

**7. Nada disto pode deitar uma procura abaixo.** É uma poupança, não uma
dependência. Se o RPC falhar, segue-se para a IA como sempre. Daí os
`try/catch` a engolir tudo nas Edge Functions e o `EXCEPTION WHEN OTHERS`
no trigger.

**8. A chave vive só no SQL.** Esteve repetida em TypeScript nas três Edge
Functions com um aviso a dizer para as manter iguais — e um aviso desses é
uma dívida à espera: no dia em que uma divergisse, o catálogo partia-se em
dois em silêncio e a única coisa que se notava era a conta a não descer.
**Uma cópia só não pode divergir.** A app nova não faz exceção.

**9. Uma nota pesquisada e um palpite não podem parecer a mesma coisa** na
UI. Já é assim na WineSelection (dourado + colheita para o catálogo,
cinzento + `~` para a estimativa).

**10. Um log limpo numa app que não corre não é saúde, é desuso.** A
WineSelection ficou semanas com duas avarias que a Garrafeira já tinha
corrigido, e ninguém deu por nada porque ela não corria. A WineCatalog vai
correr ainda menos vezes do que a WineSelection — tem isto na cabeça ao
decidir o que ela faz sozinha.

---

## 4. O que a app faz — os ecrãs

Quatro, e nenhum deles é "a lista toda do catálogo" como ecrã inicial.

### 4.1 Resumo (ecrã inicial) — *quanto é que isto está a poupar*

É a pergunta que deu origem ao catálogo e hoje não se vê em lado nenhum.

- respostas servidas pelo catálogo vs. idas à IA, por app e no total;
- `custo_estimado_eur` acumulado, e quanto dele é `0` (servido pelo
  catálogo). **Os tokens são facto** (vêm da API do Gemini); **o euro é uma
  estimativa grosseira** e tem de se dizer isso no ecrã — não é um preço
  publicado, e a pesquisa Google é faturada à parte por pedido;
- tamanho do catálogo: linhas, vinhos distintos, campos, média por linha;
- quantos campos vieram de cada origem (é onde se vê se as pesquisas a
  sério já estão a entrar, ou se está tudo a ser escrito à mão).

Os dados estão em `garrafeira.sync_log` e `wineselection.sync_log` — duas
tabelas em schemas diferentes. **Isso é um problema a resolver no desenho**:
ou a app lê as duas (e precisa de acesso a ambas), ou cria-se uma vista
`catalogo.consumo` que as une. Prefere-se a vista: mantém a app a falar só
com o `catalogo` e não a espreitar para dentro das outras duas.

### 4.2 Catálogo — *ver e procurar o que já se sabe*

A lista, com procura por nome/produtor/região/casta. Cada vinho abre numa
ficha que mostra, **campo a campo, de onde veio** (`origens`: a origem, a
força, a data) e as `fontes`.

Isto é o primeiro ecrã que alguma vez mostrou uma linha do catálogo. É
também o que torna as outras funcionalidades possíveis de confirmar.

### 4.3 Duplicados — *a fusão manual*

A lista de candidatos, com os campos lado a lado e dois botões: **são o
mesmo** / **não são**.

Três coisas que não são negociáveis:

- **nunca automática.** Uma varredura por semelhança de tokens (mesmo ano,
  ≥2 tokens comuns, ≥60% de sobreposição) devolveu 29 pares numa base de
  162 linhas. Lá dentro havia duplicados a sério (*dona-ermelinda-freitas-
  garrafeira* / *ermelinda-freitas-garrafeira*) **e** falsos positivos
  perigosos: *nacional-touriga-vallado* com *esporao-nacional-touriga* —
  produtores diferentes a partilhar o nome de uma casta. **A semelhança
  serve para SUGERIR, nunca para DECIDIR.**
- **o "não são" tem de ficar GRAVADO** (uma tabela `catalogo.distintos`).
  Senão a lista volta a propor o mesmo par todas as semanas, e uma lista
  que insiste em erros deixa de se ler — é o caminho para alguém carregar
  em "são o mesmo" sem olhar e juntar um Vallado a um Esporão.
- **fundir é reversível.** Com texto livre à entrada, isso é requisito e
  não conforto. Preferir um **alias** (`catalogo.alias(chave_de →
  chave_para)`) a uma fusão destrutiva: o `achar` resolve por ele, o
  `juntar` escreve na linha-alvo, a linha perdedora fica intacta, e
  desfazer é apagar uma linha.

**Nunca fundir colheitas diferentes.** Destruía a regra que faz a nota e o
preço valerem alguma coisa.

Depois das correções de setembro a lista caiu de 29 para **10 pares
suspeitos, 2 deles mesmo parecidos**. Uma app inteira para dois pares seria
excesso — é o §4.4 e o §4.1 que justificam o projeto.

### 4.4 Enriquecer — *um vinho que ninguém tem*

Escreve-se nome + produtor + ano + cor, escolhem-se os campos, e pesquisa-se.
É a `vinho-info` sem garrafeira por trás.

**Regra dura: a WineCatalog NÃO ganha uma terceira cópia da escolha de
modelo do Gemini.** Foram precisas duas avarias silenciosas para se
perceber o custo de duas cópias (os 404 dos nomes de modelo fixos em
1 de setembro, os 400 do `thinkingBudget:0` com `google_search` em 10 de
setembro — a Garrafeira corrigiu as duas e a WineSelection ficou semanas
com elas intactas). Três cópias seria pedi-lo.

Duas saídas, por ordem de preferência:

1. **reutilizar a `vinho-info`**, tornando o `vinhoId` opcional. Ela já faz
   exatamente isto: recebe nome/produtor/ano/campos, pergunta ao catálogo,
   chama a IA só pelo que falta, e escreve de volta. O que a prende à
   Garrafeira é a linha em `garrafeira.analises` e a autorização por
   `is_editor()`;
2. uma função nova que **importe** a escolha de modelo de um sítio só.

A convenção das Edge Functions deste projeto é serem auto-contidas, e a
duplicação entre elas é intencional — mas essa convenção nasceu antes de
haver três. Se escolheres a 2, escreve no `CLAUDE.md` das três apps que
agora há um sítio só.

---

## 5. O que é preciso construir na base de dados

### 5.1 Um caminho de leitura para a UI

Hoje `catalogo.vinhos` tem RLS com **zero policies**: nem o `authenticated`
lê uma linha. A app precisa de ler. Duas opções:

- **policies de SELECT** para quem estiver autorizado na WineCatalog. Mais
  simples, mas abre a tabela a qualquer pessoa com login em QUALQUER app do
  projeto que aponte para o schema `catalogo` — e o schema está exposto;
- **funções `SECURITY DEFINER` novas** (`catalogo.listar`, `catalogo.ver`,
  `catalogo.candidatos`), com `REVOKE ... FROM PUBLIC, anon, authenticated`
  e `GRANT` só a quem deve, tal como as três que já existem.

**Recomendo a segunda**, pela mesma razão que levou ao `REVOKE` das outras:
um schema exposto mais uma função `SECURITY DEFINER` é um caminho direto
para dentro se ninguém se lembrar do `REVOKE`. Cada função nova nasce com
`EXECUTE` para `PUBLIC` — verifica sempre com:

```sql
select has_function_privilege('authenticated', p.oid, 'EXECUTE')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'catalogo';
```

### 5.2 As tabelas novas

```sql
catalogo.alias     (chave_de, chave_para, quem, quando)
catalogo.distintos (chave_a, chave_b, quem, quando)   -- o "não são" gravado
```

Ambas com RLS, ambas alcançadas só por funções.

### 5.3 Quem manda

O catálogo não é de nenhuma das duas apps, por isso **não herda o admin de
nenhuma**. Um `catalogo.config.admin_email` próprio, com o mesmo desenho do
`garrafeira.config.admin_email` (na BD, não em código — ver o `CLAUDE.md`
da Garrafeira).

Nota que na Garrafeira há duas figuras diferentes e aqui também vai haver:
o **admin da app** (passa com a app) e o **dono da conta Supabase**
(`SUPABASE_DONO_EMAIL`, fixo, não passa). Coisas que mexem na CONTA ficam
atrás da segunda.

---

## 6. A mudança da chave que ficou decidida e não está feita

**Decisão tomada:** tirar a cor do NOME e passá-la a um lugar próprio da
chave, vindo da coluna `tipo`.

Hoje "tinto"/"branco"/"rose" ficam dentro da chave, e o custo está assumido
no `CLAUDE.md` da Garrafeira: um vinho gravado como nome "Papa Figos" +
tipo Branco **não encontra** o "Papa Figos Branco" lido numa carta. São
chaves diferentes.

Do que foi proposto, três quartos já estão feitos: "de/do/da" já saem
(lista de vazias em `catalogo.tokens`), o ano dentro do nome já sai
(`\m(19|20)[0-9]{2}\M`), e o ano já está no fim da chave (`base|ano`). **O
que falta é só a cor.**

Medido neste catálogo: **162 chaves → 161**. Junta um par (*Cartuxa Reserva
Tinto* / *Herdade da Cartuxa Reserva*, os dois Tinto 2017). Ganho pequeno
hoje; o valor está nas cartas de restaurante.

### As três regras que a tornam segura

**1. Na Garrafeira, a cor passa a ser obrigatória antes de qualquer
pesquisa.** *(decidido — falta implementar)* Hoje o `tipo` nasce `'Tinto'`
por omissão, e com a cor dentro da identidade um branco escrito à pressa
ficava com a chave do tinto. É o desastre do Papa Figos a entrar pela porta
do lado. Obrigar a escolher antes de procurar resolve-o na origem.
Enquanto não estiver feito, usa o `v_curado` do `catalogar_vinho` como
proxy: num vinho não curado, a cor entra como DESCONHECIDA.

**2. Cor desconhecida casa com qualquer uma; duas cores conhecidas e
diferentes nunca casam.** Não é invenção — é literalmente a regra que a
`verificarCoerencia` da WineSelection já usa e documenta ("o Papa Figos
branco não é o tinto"). E é **obrigatória**, não opcional: uma carta de
restaurante muitas vezes não traz cor nenhuma, e sem o coringa a mudança
partia as consultas das cartas. *(Já cometi exatamente este erro com a
regra da colheita: cortava a nota sempre que a colheita não batia certo,
incluindo quando ninguém tinha pedido colheita nenhuma — ou seja, em todas
as cartas.)*

**3. Com a cor desconhecida e as duas versões no catálogo, mostram-se as
DUAS.** *(decidido)* Se a carta diz "Papa Figos" e o catálogo tem o branco
e o tinto, a resposta certa não é escolher uma — é apresentar as duas e
deixar quem está à mesa reconhecer a sua. Escolher sozinho é dar a nota
errada como certa.

### Como se aplica

**Cuidado: aplicar isto é, em si, uma fusão em massa.** Mudar o
`chave_base` obriga a recalcular as 162 linhas, e desta vez as colisões são
o objetivo, não um acidente. Não se faz como se fez a do parêntesis do
produtor (onde se confirmou ZERO colisões antes de aplicar). Faz-se com a
lista de pares à frente e um "sim" por par — ou seja, **depois** do ecrã do
§4.3 existir.

---

## 7. Coisas que já aconteceram e que é bom conhecer

- **O Grous Moon Harvested.** Três linhas para o que pareciam ser o mesmo
  vinho. Afinal: duas colheitas legítimas (2022 e 2023, que têm de ficar
  separadas) mais uma **duplicação verdadeira** — o Barrona tinha escrito
  "Moon Harve**st**" e outra pessoa "Moon Harve**sted**". Uma letra. A
  correção foi mudar o nome na garrafeira do Barrona; o trigger recatalogou
  e o `juntar` fundiu sozinho na linha certa (16 → 18 campos, o preço de
  29,99 € a entrar). **Não foi preciso ferramenta de fusão nenhuma** — o
  que faltava era um selector no momento de gravar, a perguntar "já existe
  este, é o mesmo?".
- **O parêntesis do produtor.** "Herdade dos Grous (Monte do Trevo)" é uma
  NOTA de quem escreveu (a sociedade que detém, a marca do grupo), não
  outro produtor. Deixá-la entrar na chave punha o mesmo vinho em duas
  linhas. Corrigido em 10 de setembro; sozinho, baixou os pares suspeitos
  de 29 para 10. Tira-se só do PRODUTOR, nunca do NOME.
- **A colheita irmã a ser tapada.** O `procurar` achava a linha do ano
  pedido e ficava por aí — mesmo quando essa linha era um espelho quase
  vazio e a do ano ao lado tinha dezassete campos. Agora o que a linha
  certa sabe manda sempre, e só o que FALTA se pede emprestado à irmã, e só
  nos campos estáveis. O `procurar` devolve `emprestados` a dizer quais.
- **A ordem de expandir abreviaturas.** "Qta. do Vallado" dava
  `{quinta,vallado}` e "Quinta do Vallado" dava `{vallado}`: a expansão
  estava a correr DEPOIS do filtro de palavras vazias. Primeiro mapeia-se,
  depois filtra-se.
- **`RETURNS TABLE` com nomes iguais aos das colunas** dá ambiguidade em
  plpgsql. Por isso o `procurar` devolve `jsonb`.
- **`STABLE` numa função que faz `UPDATE`** (o `visto_em`) não é `STABLE`.

---

## 8. Regras técnicas herdadas das duas apps

- **Sem build, sem npm.** Site estático em GitHub Pages, PWA. `app.js`
  carrega como `<script src>` **normal, NÃO module** — há `onclick="…"` no
  HTML, as funções têm de ser globais.
- **Se mexeres em `app.js`, `style.css` ou `index.html`, SOBE o
  `CACHE_NAME` no `sw.js`.** Os três são network-first de propósito: sem
  isto, um deploy dá ao browser o `index.html` novo com o `app.js` velho —
  botões novos a chamar funções que ainda não existem, sem erro visível.
  Já aconteceu.
- **Supabase:** `Accept-Profile`/`Content-Profile` em **todos** os pedidos
  REST (`sbHeaders`) — é isso que aponta para o schema, nunca vai no URL.
- **A chave `anon` no topo do `app.js` é pública por design**, protegida por
  RLS + login. **Não é bug nem risco — não a "corrijas" nem a escondas.**
- **Alterar o schema:** edita primeiro `db/*.sql` (fonte de verdade) e só
  depois corre no Supabase — nunca ao contrário.
- **Escapar HTML:** `esc()` para conteúdo, `escJs()` para o que vai dentro
  de `onclick="…('…')"` — há vinhos com plica no nome ("Clefs D'or").
- **Login:** o mesmo padrão do Goals/FestasBV/Garrafeira/WineSelection —
  `allowed_users`, `access_requests`, ecrã "sem acesso" com "Solicitar
  acesso", e `admin_pass_temp` (RPC `SECURITY DEFINER`) porque o projeto
  não tem SMTP próprio e o "esqueci-me da password" fica com o template
  genérico.
- **Linguagem visual:** as duas apps usam bordô (a app) e dourado
  (distinção). Se a WineCatalog seguir a mesma paleta, o verde já está
  tomado como "boa notícia sobre a procura" (`.ia-cat`).
- Edições **cirúrgicas** (diffs pequenos).

---

## 9. Por onde começar

1. **Repo, auth e deploy** — o esqueleto do costume, sem nada do catálogo.
   Confirma-se que se entra e que o admin aprova quem entra.
2. **Leitura do catálogo** (§5.1 + §4.2) — as funções `SECURITY DEFINER`
   novas com o `REVOKE`, e o ecrã que mostra as linhas com a proveniência
   campo a campo. É o primeiro ecrã que alguma vez mostrou isto; serve de
   base para confirmar tudo o resto.
3. **Resumo/poupança** (§4.1) — inclui decidir a vista `catalogo.consumo`.
4. **Duplicados** (§4.3) — com a `catalogo.distintos` e o alias reversível
   desde o primeiro dia.
5. **A mudança da cor na chave** (§6) — só depois do 4 existir, porque é
   uma fusão em massa e precisa do ecrã de revisão. E só depois de a
   Garrafeira passar a obrigar a escolher a cor.
6. **Enriquecer** (§4.4) — e aqui decide-se a questão da terceira cópia do
   Gemini antes de escrever uma linha.

Uma coisa que fica por decidir e vale a pena decidir cedo: **o selector no
momento de gravar um vinho** ("já existe *X 2023* — é o mesmo?") vive na
Garrafeira, não aqui. É o que previne duplicados em vez de os remediar, e o
caso do Grous mostra que é a peça que faltava. Vale mais do que o ecrã do
§4.3 — mas é trabalho no outro repo.
