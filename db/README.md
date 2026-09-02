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

E as funções: `definir_castas` junta as grafias repetidas e apaga as castas
que saíram da lista; `consumir_garrafa` recusa consumir a mesma garrafa duas
vezes (a data e a nota do primeiro consumo aguentam); `repor_garrafa` limpa
o carimbo; `definir_admin` recusa quem não é admin **e** recusa passar a app
a um email que não esteja em `allowed_users`; o `criado_por` dos vinhos é
carimbado pelo trigger, não pelo cliente.

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
| `allowed_users` | quem entra. `pode_editar` marca quem também mexe nas garrafas |
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

## As três fronteiras

```
is_allowed()  →  vê tudo (vinhos, garrafas, locais, histórico)
is_editor()   →  escreve nisso  (admin + quem tiver pode_editar)
is_admin()    →  manda em quem tem acesso e em quem é editor
```

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
