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
2. **`functions.sql`** — `admin_email`, `is_admin`, `is_allowed`,
   `is_editor`, `definir_admin`, `admin_pass_temp`, `consumir_garrafa`,
   `repor_garrafa`, `casta_id`, `definir_castas` e os triggers de guarda.
3. **`policies.sql`** — as RLS policies (dependem das funções acima).
   É aqui que vive o isolamento: `locais`, `vinhos`, `garrafas` e
   `vinho_castas` andam por `pode_ver()`/`pode_mexer()`, não por
   `is_allowed()`/`is_editor()` sozinhos.
4. **`seed.sql`** — põe o admin na lista de acesso. Sem isto a app abre na
   mesma (o admin tem acesso por ser admin), mas ele não aparece na lista de
   utilizadores e a passagem da app a outra pessoa fica bloqueada —
   `definir_admin()` exige que o novo dono já esteja na lista.

Todos são idempotentes: podem ser corridos outra vez sem estragar nada.

## Passos manuais no painel do Supabase

Estes não se fazem por SQL:

1. **Expor o schema na API.** Settings › API › *Exposed schemas*: juntar
   `garrafeira` à lista (`public`, `goals`, `splitbill`, …). **Sem isto,
   todos os pedidos da app dão 404** e parece que as tabelas não existem.
2. **Redirect URLs.** Authentication › URL Configuration › *Redirect URLs*:
   juntar o endereço do GitHub Pages desta app (ex.:
   `https://diogoandrefsilva-ghc.github.io/Garrafeira/`) e, se usares,
   `http://localhost:*`. É para onde volta o login com Google e o link de
   recuperação de password.
3. **Secrets da Edge Function.** Já existem no projeto e são partilhados por
   todas as functions (são por PROJETO, não por function):
   `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Não é
   preciso criar nada de novo.
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
| `sync_log` | rasto de cada procura, para quando o browser só diz "502" |

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
