# Garrafeira 🍷

App/PWA para gerir uma garrafeira caseira: o que lá está, **onde** está, e o
que já se bebeu.

- **Sem build.** HTML + CSS + um `app.js`. Publica-se em GitHub Pages.
- **Dados e login no Supabase** (schema `garrafeira`, isolado das outras
  apps do mesmo projeto).
- **Uma garrafeira por pessoa.** Mesma app, mesmas tabelas — mas cada um só
  vê as suas garrafas. Podes **emprestar** a tua a um amigo: ele vê e
  procura, nunca mexe.
- **Instalável** no telemóvel (PWA).
- Cada vinho tem a sua **garrafa desenhada** (SVG, cor pelo tipo, ano no
  rótulo), a foto que a procura encontrou, ou **uma fotografia tua** — toca
  na imagem da ficha para a ver em grande e trocar.

## O que faz

| | |
|---|---|
| **Garrafeira** | resumo + procura: barra de texto sempre à vista e os filtros (local, tipo, região, **casta**, monocasta/várias castas, ano, menção, maturação) atrás do botão *Filtros* |
| **Detalhe** | a lista toda, organizada por região ou por ano |
| **Locais** | o mapa: cada local → cada prateleira → cada lugar |
| **Consumidos** | o histórico — quando, onde e o que se achou de cada garrafa bebida |
| **Definições** | conta, **garrafeiras** (trocar de garrafeira, partilhar, passar a outra pessoa), locais, utilizadores (admin), migração dos dados antigos, exportação e diagnóstico |

Em cada vinho há um botão **Procurar informação**: uma Edge Function
pergunta a um modelo *com pesquisa Google ligada* e traz castas, região,
tipo, nota do Vivino, preço médio, estágio, janela de consumo, notas de
prova, harmonização e, quando encontra uma fotografia fiável, a imagem do
rótulo. **Nada é gravado sem confirmação campo a campo** — as leituras
automáticas entram como proposta, não como facto.

## Pôr a andar

1. **Base de dados:** correr no SQL Editor do Supabase, por esta ordem —
   `db/schema.sql` → `db/functions.sql` → `db/policies.sql` → `db/seed.sql`.
   Numa base que já esteja a andar, correr antes
   `db/migracao-garrafeiras.sql` → `db/functions.sql` → `db/policies.sql`
   (é a migração que dá uma garrafeira a cada pessoa — ver `db/README.md`).
2. **Expor o schema:** Settings › API › *Exposed schemas* → juntar
   `garrafeira`. Sem isto todos os pedidos dão 404.
3. **Redirect URLs:** Authentication › URL Configuration → juntar o endereço
   do GitHub Pages desta app.
4. **Edge Function:** `supabase functions deploy vinho-info`
   (os secrets `GEMINI_API_KEY`/`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`
   já existem no projeto — são por projeto, não por função).
5. **GitHub Pages:** Settings › Pages → branch `main`.
6. Entrar na app e, em **Definições › Dados**, carregar em *Migrar* para
   trazer os 85 vinhos que vieram do Excel e do bloco de notas.

Os detalhes todos — e o porquê de cada decisão — estão em
[`db/README.md`](db/README.md) e no [`CLAUDE.md`](CLAUDE.md).
