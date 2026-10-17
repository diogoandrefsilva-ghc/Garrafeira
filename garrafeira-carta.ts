// garrafeira-carta — as Sugestões da Garrafeira (03/10/2026, migração 40)
//
// O dono das apps: "quero mudar aqui a mecânica da coisa … aquilo da
// pesquisa simples e pesquisa avançada é confuso!". Até aqui as Sugestões
// eram a página da WineSelection transposta, e a `sugerir-vinho` fazia tudo
// de uma vez — ler a carta, perguntar ao catálogo e recomendar —, com uma
// segunda função (`verificar-vinhos`) para a "pesquisa a sério" e outra
// ainda, a profunda, ao admin. Agora são passos, e a pessoa vê cada um:
//   1. LER (`acao: "ler"`): as fotos da carta → a lista dos vinhos. É uma
//      transcrição — sem pesquisa —, e a seguir uma chamada só de texto
//      ORDENA os que cabem no orçamento pelo interesse para o prato
//      (`ordenarCarta`, 03/10/2026, o dono: "a ordem dos vinhos que aparece
//      podia aparecer pela sugestão do Gemini"). É a ordem da lista, para se
//      saber por onde começar a procurar — nunca um facto, nunca a sugestão.
//      Fica em `garrafeira.cartas` (`vinhos`, `ordem`). E a seguir, sem
//      ninguém a pedir, a sugestão do passo 4 entre os vinhos que o Catálogo
//      já conhece (ver "A SUGESTÃO JÁ COM A LEITURA").
//   2. a APP mostra só os que cabem no orçamento (+5 €) e, de cada um que o
//      Catálogo conhece, a nota do Vivino e a ficha (`carta_ligar`).
//   3. a APP manda até 5 ao "Procurar informação" com IA de sempre
//      (`vinho-info`, com `daCarta`: o que encontrar fica logo no catálogo).
//   4. RECOMENDAR (`acao: "recomendar"`): uma chamada só de texto, sem
//      pesquisa, que ordena APENAS os vinhos de que o catálogo sabe alguma
//      coisa, dentro do orçamento. Devolve só a ordem e a frase de cada um —
//      a nota, o preço e o "preço justo" do cartão a app tira dos dados.
//
// As duas acções respondem já com o `id` e fazem o trabalho em segundo plano
// (`EdgeRuntime.waitUntil`): ler seis fotos passa facilmente do que um pedido
// HTTP aguenta num telemóvel que bloqueia o ecrã. A app sonda a linha.
//
// E há mais dois modos, sem carta (07/10/2026, o dono das apps: "sugestão
// de vinhos a partir da garrafeira pessoal — não pedir o preço; a partir dos
// vinhos em Catálogo — pedir o preço"): SUGERIR (`acao: "sugerir"`, `modo`
// "garrafeira" ou "catalogo"). A APP manda a lista dos vinhos com os factos
// que já tem à frente (os da garrafeira aberta, que a RLS já lhe deu; ou os
// do Catálogo, uma colheita por vinho, até ao orçamento) e o modelo ordena-os
// como no passo 4 — a mesma resposta, a mesma limpeza (`rankingDe`). É uma
// chamada só de texto e responde no próprio pedido: não há nada a ler nem a
// guardar, e por isso não nasce linha nenhuma em `garrafeira.cartas`.
//
// E um quarto, LIVRE (`acao: "livre"`, 13/10/2026, migração 54): só o prato,
// o preço e as observações, e o modelo sugere 5 vinhos de memória — que se
// ligam ao Catálogo, ou vão à `vinho-info` para nascer lá (só com fontes).
// Ver "AS SUGESTÕES LIVRES".
//
// E IDENTIFICAR (`acao: "identificar"`, 17/10/2026, migração 56): fotografias
// de uma prateleira ou prints de um site → os vinhos que lá estão, numa
// linha de `garrafeira.cartas` com `fonte: "prateleira"`; e
// `acao: "identificar_procurar"` manda os que o Catálogo não tem à
// confirmação da pergunta livre (só nascem lá com fontes). Ver "IDENTIFICAR
// VINHOS NUMA FOTOGRAFIA".
//
// Quem pode: quem tem IA na Garrafeira (`garrafeira.plano_ia()` 'gratis' ou
// 'premium', perguntado com o JWT de quem chamou) — o mesmo que vê o
// separador. A linha escreve-se com a service role, sempre com `quem=eq.` no
// filtro; quem a pediu lê-a pela policy (`cartas_minhas`).
//
// Secrets: GEMINI_API_KEY (a mesma da `vinho-info`); GEMINI_MODEL opcional.
// Deploy: supabase functions deploy garrafeira-carta

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GAPI = "https://generativelanguage.googleapis.com/v1beta";
const PROC_TIMEOUT_MS = 110_000;
const SYNC_TIMEOUT_MS = 10_000;
const MODELO_LEVE = Deno.env.get("GEMINI_CHEAP_MODEL") || "gemini-flash-lite-latest";

/* O ORÇAMENTO TEM UMA MARGEM DE 5 € (o dono): a carta diz 31 € e o
   orçamento é 30 — entra. Sem preço lido não entra: um vinho a copo não é
   uma garrafa. A MESMA regra do `wsCabe` no app.js. */
const MARGEM_ORCAMENTO = 5;
function cabe(preco: number | null, orcamento: number | null): boolean {
  if (orcamento == null) return true;
  return preco != null && preco <= orcamento + MARGEM_ORCAMENTO;
}

// As cores da Garrafeira (`TIPOS` no app.js). "Verde" não é cor: um Vinho
// Verde é branco, tinto ou rosé — e a cor é a chave do catálogo.
const TIPOS = ["Tinto", "Branco", "Rosé", "Espumante", "Licoroso", "Frisante"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* ── O modelo: só PONTEIROS ("-latest"), mais o que a chave disser que tem
   (a lição da `vinho-info`: os nomes de versão fixos são reformados). ── */
let _models: string[] | null = null;
async function descobrirFlash(signal: AbortSignal): Promise<string[]> {
  if (_models) return _models;
  try {
    const r = await fetch(`${GAPI}/models?pageSize=200&key=${GEMINI_KEY}`, { signal });
    if (r.ok) {
      const d = await r.json();
      const nomes: string[] = (d.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((m: any) => String(m.name).replace(/^models\//, ""))
        .filter((n: string) => n.includes("flash") && !/(lite|8b|image|tts|live|audio|embed|exp|preview|thinking)/.test(n));
      const nota = (n: string) => n === "gemini-flash-latest" ? 100 : parseFloat((n.match(/^gemini-(\d+(?:\.\d+)?)-flash$/) ?? [])[1] ?? "0");
      const ord = [...new Set(nomes)].sort((a, b) => nota(b) - nota(a) || a.localeCompare(b));
      if (ord.length) _models = ord;
    }
  } catch (_) { /* fica a lista fixa */ }
  return _models ?? [];
}
async function candidatosModelo(signal: AbortSignal): Promise<string[]> {
  const fixo = Deno.env.get("GEMINI_MODEL");
  const vistos = new Set<string>();
  return [...(fixo ? [fixo] : []), "gemini-flash-latest", "gemini-flash-lite-latest", ...(await descobrirFlash(signal))]
    .filter((m) => (vistos.has(m) ? false : (vistos.add(m), true)));
}

/* ── O que isto gastou (os tokens vêm da API: são facto) ── */
type Usage = { promptTokenCount: number; candidatesTokenCount: number; thoughtsTokenCount: number; totalTokenCount: number };
function usageDe(raw: any): Usage | null {
  const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? Math.round(x) : 0; };
  const u = raw?.usageMetadata;
  if (!u || typeof u !== "object") return null;
  const out = { promptTokenCount: n(u.promptTokenCount), candidatesTokenCount: n(u.candidatesTokenCount), thoughtsTokenCount: n(u.thoughtsTokenCount), totalTokenCount: n(u.totalTokenCount) };
  return out.totalTokenCount || out.promptTokenCount ? out : null;
}
function somar(a: Usage | null, b: Usage | null): Usage | null {
  if (!b) return a;
  if (!a) return { ...b };
  return {
    promptTokenCount: a.promptTokenCount + b.promptTokenCount,
    candidatesTokenCount: a.candidatesTokenCount + b.candidatesTokenCount,
    thoughtsTokenCount: a.thoughtsTokenCount + b.thoughtsTokenCount,
    totalTokenCount: a.totalTokenCount + b.totalTokenCount,
  };
}
// Uma estimativa GROSSEIRA, para dar ordem de grandeza (como na `sugerir-vinho`).
const CUSTO_LEITURA_EUR = 0.003;
const CUSTO_RECOMENDACAO_EUR = 0.002;
const CUSTO_ORDEM_EUR = 0.001;

/* ── Uma chamada ao Gemini, de modelo em modelo ──
   JSON direto (não há pesquisa, por isso não há o conflito com o
   `google_search`). Um 400 com o `thinkingConfig` repete-se sem ele; um 200
   VAZIO não é resposta — passa ao modelo seguinte (ver o CLAUDE.md da
   WineCatalog, "O 200 vazio"). */
async function gerar(tentativas: [string, number | null][], parts: unknown[], signal: AbortSignal) {
  let usage: Usage | null = null, chamadas = 0, erro = "", status = 0;
  const vistos = new Set<string>();
  for (const [m, pensar] of tentativas) {
    if (!m || vistos.has(m) || signal.aborted) continue;
    vistos.add(m);
    for (const p of pensar == null ? [null] : [pensar, null]) {
      const generationConfig: Record<string, unknown> = { temperature: 0, response_mime_type: "application/json" };
      if (p != null) generationConfig.thinkingConfig = { thinkingBudget: p };
      const r = await fetch(`${GAPI}/models/${m}:generateContent?key=${GEMINI_KEY}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal,
        body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
      });
      if (r.status === 400 && p != null) continue;
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        let msg = ""; try { msg = JSON.parse(t)?.error?.message ?? ""; } catch (_) { /**/ }
        status = r.status; erro = `gemini ${r.status} (${m})${msg ? ": " + msg.slice(0, 200) : ""}`;
        if (r.status === 404) _models = null;
        break;
      }
      const d = await r.json();
      chamadas++;
      usage = somar(usage, usageDe(d));
      const cand = d?.candidates?.[0];
      const texto = (cand?.content?.parts ?? []).map((x: any) => x?.text ?? "").join("").trim();
      if (texto) return { texto, modelo: m, usage, chamadas, erro: "", status: 200 };
      status = 200; erro = `o modelo não devolveu resposta (${cand?.finishReason || "vazia"}, ${m})`;
      break;
    }
  }
  return { texto: "", modelo: "", usage, chamadas, erro: erro || "sem resposta do modelo", status };
}

function extrairJson(txt: string): any {
  const s = String(txt || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(s); } catch (_) { /* segue */ }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { /**/ } }
  return null;
}

/* ── Limpeza ── */
function s(v: unknown, max = 120): string { return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max); }
function numOuNull(v: unknown, min = 0, max = 100000): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return isFinite(n) && n >= min && n <= max ? Math.round(n * 100) / 100 : null;
}
function anoOuNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isInteger(n) && n >= 1900 && n <= new Date().getFullYear() + 2 ? n : null;
}
// A colheita, quando a carta a escreve no nome ("Papa Figos 2020").
function anoDoNome(nome: string): number | null {
  const m = String(nome || "").match(/\b(19|20)\d{2}\b/);
  return m ? anoOuNull(m[0]) : null;
}

/* ── PASSO 1: LER A CARTA ──
   Só transcrever. O produtor e o ano pedem-se à parte porque é com eles que
   o catálogo acerta; a COR pede-se com as palavras da Garrafeira, porque é
   parte da chave do catálogo — um branco com a cor errada liga-se ao tinto. */
const promptLeitura = (n: number) => `${n > 1
  ? `Aqui estão ${n} fotografias que, juntas, mostram a carta de vinhos de um restaurante em Portugal (o menu não coube numa só foto — trata-as como páginas da MESMA carta).`
  : "Aqui está a fotografia de uma carta de vinhos de um restaurante em Portugal."}
Transcreve TODOS os vinhos legíveis (até 80). Se o mesmo vinho aparecer em
mais que uma foto, conta-o uma única vez. Não avalies nem recomendes nada —
só transcreve o que está impresso.

Devolve APENAS um objeto JSON com esta forma exata:
{"vinhosCarta": [{"nome": string, "produtor": string|null, "ano": number|null,
  "tipo": "Tinto"|"Branco"|"Rosé"|"Espumante"|"Licoroso"|"Frisante"|null,
  "regiao": string|null, "preco": number|null}],
 "aviso": string|null}

Regras:
- "nome": o nome do vinho como está escrito na carta (sem o preço).
- "produtor": só se a carta o escrever (na mesma linha, ou num título de
  secção por produtor); null se não aparecer. Nunca o deduzas de memória.
- "ano": a colheita, só se estiver impressa; null caso contrário.
- "tipo": a COR. Muitas cartas dizem-na pelo título da secção ("Tintos",
  "Brancos", "Espumantes"). Um Vinho Verde não é uma cor: diz se é branco,
  tinto ou rosé (na dúvida, Branco). Porto, Moscatel e Madeira são Licoroso.
  null só se nada o deixar perceber.
- "regiao": só se a carta a indicar (na linha ou no título da secção).
- "preco": o preço da GARRAFA em euros; se só houver copo, null.
- "aviso": preenche só se as fotos estiverem ilegíveis ou sem vinhos —
  caso contrário null.
- Nunca inventes: na dúvida, null.`;

function normVinhoCarta(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as any;
  const nome = s(o.nome, 100);
  if (!nome) return null;
  return {
    nome,
    produtor: o.produtor ? s(o.produtor, 80) : null,
    ano: anoOuNull(o.ano) ?? anoDoNome(nome),
    tipo: TIPOS.includes(o.tipo) ? o.tipo : null,
    regiao: o.regiao ? s(o.regiao, 60) : null,
    preco: numOuNull(o.preco, 0, 5000),
  };
}

/* ── PASSO 4: RECOMENDAR, só com o que o catálogo sabe ──
   O modelo ORDENA, por ÍNDICE da carta, os vinhos que o catálogo conhece e
   que cabem no orçamento, e marca os 2 ou 3 que recomenda. Um índice que
   não esteja na lista dada é deitado fora aqui: um vinho de que não se sabe
   nada nunca é recomendado, nem por engano. Um vinho SEM nota não passa à
   frente de um COM nota dentro dos recomendados (dito no prompt e garantido
   em código — foi o erro da primeira carta a sério, 24/09/2026). */
const MAX_RANKING = 10;

/* A nota do Vivino que CONTA — a regra do `notaVivino` do app.js: a da
   colheita com pelo menos 100 avaliações, senão a que tiver mais. */
function notaVivino(f: any): { nota: number; de: "colheita" | "global" } | null {
  const c = numOuNull(f?.vivino_nota, 0, 5), g = numOuNull(f?.vivino_nota_global, 0, 5);
  const ac = Number(f?.vivino_avaliacoes) || 0, ag = Number(f?.vivino_avaliacoes_global) || 0;
  if (c == null && g == null) return null;
  if (g == null) return { nota: c!, de: "colheita" };
  if (c == null) return { nota: g, de: "global" };
  if (ac >= 100) return { nota: c, de: "colheita" };
  return ac > ag ? { nota: c, de: "colheita" } : { nota: g, de: "global" };
}
function sabeAlgo(f: any): boolean {
  return !!f && (notaVivino(f) != null || numOuNull(f.preco_medio) != null ||
    (Array.isArray(f.castas) && f.castas.length > 0) || !!f.harmonizacao || !!f.notas_prova);
}

/* A resposta do modelo → as sugestões, pela ordem. Só índices da lista que
   lhe foi dada (`validos`), sem repetir, até `MAX_RANKING`; os 2 ou 3
   recomendados à frente, e dentro deles os que têm nota primeiro. A MESMA
   limpeza para a carta e para os modos sem carta. */
function rankingDe(j: any, validos: Set<number>, comNota: Set<number>) {
  const ranking: { i: number; razao: string }[] = [];
  for (const x of Array.isArray(j?.ranking) ? j.ranking : []) {
    const i = Number(x?.i);
    if (!validos.has(i) || ranking.some((r) => r.i === i)) continue;
    ranking.push({ i, razao: s(x?.razao, 400) });
    if (ranking.length >= MAX_RANKING) break;
  }
  const recs: number[] = [];
  for (const x of Array.isArray(j?.recomendados) ? j.recomendados : []) {
    const i = Number(x);
    if (ranking.some((r) => r.i === i) && !recs.includes(i)) recs.push(i);
    if (recs.length >= 3) break;
  }
  if (!recs.length && ranking.length) recs.push(ranking[0].i);
  // A trave em código: dentro dos recomendados, os que têm nota primeiro.
  recs.sort((a, b) => Number(comNota.has(b)) - Number(comNota.has(a)));
  const ordem = [...recs, ...ranking.map((r) => r.i).filter((i) => !recs.includes(i))];
  return ordem.map((i) => ({ i, razao: ranking.find((r) => r.i === i)?.razao ?? "", recomendado: recs.includes(i) }));
}

function promptRecomendacao(linhas: string[], prato: string, orcamento: number | null) {
  return `És um escanção num restaurante em Portugal. Estes são os vinhos desta
carta${orcamento ? ` que cabem no orçamento (${orcamento} € por garrafa, com uma folga de ${MARGEM_ORCAMENTO} €)` : ""}
de que se SABE alguma coisa, com os factos que se sabem de cada um:

${linhas.join("\n")}

${prato ? `O prato a acompanhar é: "${prato}".` : "Não foi indicado nenhum prato — escolhe vinhos versáteis e bem avaliados."}

Devolve APENAS um objeto JSON com esta forma exata:
{"ranking": [{"i": number, "razao": string}], "recomendados": [number]}

Regras:
- "ranking": os vinhos da lista (até ${MAX_RANKING}), do melhor para o pior para
  este prato, pelo número entre [ ].
- Critérios, por esta ordem:
  1. harmonização com o prato (corpo, acidez, taninos, castas, o que o
     vinho diz harmonizar) — um vinho que não combina fica sempre atrás;
  2. entre os que combinam, a NOTA do Vivino: um vinho com nota alta fica à
     frente de um com nota baixa, e um vinho "SEM NOTA" NUNCA fica à frente
     de um que combine e tenha nota de 3.8 ou mais;
  3. o preço na carta face ao preço de referência (2 a 3 vezes é o normal
     num restaurante);
  4. em igualdade, dá prioridade aos PORTUGUESES.
- "recomendados": os 2 ou 3 primeiros do ranking que recomendarias mesmo a
  quem está à mesa (só 1 se só um combinar; [] se nenhum combinar). Numa
  carta, o normal é poucos combinarem MESMO bem com um prato concreto: não
  recomendes um só para chegar a três.
- "razao": uma a duas frases concretas, em português, sobre porque está
  nessa posição para este prato, apoiadas nos factos dados — com honestidade:
  o que joga a favor e, se houver, o que joga contra; um bom vinho que é
  melhor para outro prato di-lo ("é mais para assados"). Não elogies por
  elogiar. Não cites notas nem preços que não estejam na lista, e não
  inventes castas nem características.
Responde só com o JSON.`;
}

/* ── A ORDEM DA LISTA (no fim da leitura) ──
   O dono: "a ordem dos vinhos que aparece podia aparecer pela sugestão do
   Gemini". Era o que a `sugerir-vinho` fazia com o `pesquisar` (até 4
   desconhecidos que valia a pena pesquisar); aqui ordena-se a lista TODA
   dos que cabem no orçamento, para quem vai escolher até 5 para procurar
   saber por onde começar. Aqui a memória do modelo pode entrar — a
   reputação de um produtor, uma região que casa com o prato — porque é só a
   ORDEM: nada do que o modelo sabe aparece como facto, e a sugestão final
   continua a ser só com o que o Catálogo sabe. Se falhar, a lista fica pela
   ordem da carta, que é como sempre foi. */
const LINHA_FACTOS = 140;
function linhaDaCarta(v: any, i: number, l: any): string {
  const f = l?.ficha ?? null;
  const nv = f ? notaVivino(f) : null;
  const factos = f && sabeAlgo(f) ? [
    nv ? `Vivino ${nv.nota}/5` : "",
    numOuNull(f.preco_medio) != null ? `preço de referência ~${numOuNull(f.preco_medio)}€` : "",
    Array.isArray(f.castas) && f.castas.length ? `castas: ${f.castas.slice(0, 4).join(", ")}` : "",
    f.harmonizacao ? `harmoniza com: ${s(f.harmonizacao, LINHA_FACTOS)}` : "",
  ].filter(Boolean).join(" | ") : "";
  return [
    `[${i}] ${v.nome}`,
    (v.produtor || l?.produtor) ? `produtor: ${v.produtor || l.produtor}` : "",
    v.ano ? `colheita: ${v.ano}` : "",
    (v.tipo || f?.tipo) ? `cor: ${v.tipo || f.tipo}` : "",
    (v.regiao || f?.regiao) ? `região: ${v.regiao || f.regiao}` : "",
    v.preco != null ? `preço na carta: ${v.preco}€` : "",
    factos ? `catálogo: ${factos}` : "sem dados no catálogo",
  ].filter(Boolean).join(" | ");
}
function promptOrdem(linhas: string[], prato: string, orcamento: number | null) {
  return `És um escanção num restaurante em Portugal. Estes são os vinhos desta
carta${orcamento ? ` que cabem no orçamento (${orcamento} € por garrafa, com uma folga de ${MARGEM_ORCAMENTO} €)` : ""}:

${linhas.join("\n")}

${prato ? `O prato a acompanhar é: "${prato}".` : "Não foi indicado nenhum prato — pensa em vinhos versáteis e bem feitos."}

Quem está à mesa vai escolher alguns destes para pesquisar a fundo antes de
decidir. Ordena-os TODOS, do que mais vale a pena pesquisar para o que menos:
os primeiros são os candidatos mais prometedores para este prato, a este preço.

Devolve APENAS um objeto JSON com esta forma exata:
{"ordem": [number]}
com os números entre [ ], todos, sem repetir.

Critérios, por esta ordem:
1. a harmonização provável com o prato (cor, corpo, castas, região, estilo);
2. a reputação do vinho e do produtor, e a nota do Vivino quando é dada;
3. a relação preço/qualidade (o preço na carta face ao de referência,
   quando é dado — 2 a 3 vezes é o normal num restaurante);
4. em igualdade, os PORTUGUESES primeiro.
Podes usar o que sabes destes vinhos, produtores e regiões: é só para
ordenar a lista, não aparece a ninguém como facto.
Responde só com o JSON.`;
}
// A linha do catálogo de cada vinho da carta, com a ficha (a mesma pergunta
// que a app faz, `carta_ligar`). Lança se o catálogo não responder.
async function ligarComFicha(vinhos: any[], signal: AbortSignal): Promise<any[]> {
  const r = await sb("rpc/carta_ligar", { method: "POST", signal,
    body: JSON.stringify({ p_pedidos: vinhos.map((v) => ({ nome: v.nome, produtor: v.produtor || "", ano: v.ano ?? null, tipo: v.tipo || null })), p_ficha: true }) });
  if (!r.ok) throw new Error("não consegui perguntar ao catálogo (" + r.status + ")");
  const d = await r.json();
  return Array.isArray(d) ? d : [];
}
async function ordenarCarta(vinhos: any[], ligados: any[], prato: string, orcamento: number | null, modelos: string[], parent: AbortSignal) {
  const cand = vinhos.map((v, i) => i).filter((i) => cabe(vinhos[i].preco ?? null, orcamento));
  const out = { ordem: null as number[] | null, usage: null as Usage | null, modelo: "", chamadas: 0, erro: "" };
  if (cand.length < 2) { out.ordem = cand; return out; }
  // Um tecto próprio: uma ordem lenta não pode levar a leitura atrás.
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  parent.addEventListener("abort", onAbort);
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const linhas = cand.map((i) => linhaDaCarta(vinhos[i], i, ligados[i]));
    const g = await gerar([[modelos[0], 512], [MODELO_LEVE, 0]], [{ text: promptOrdem(linhas, prato, orcamento) }], ctrl.signal);
    out.usage = g.usage; out.modelo = g.modelo; out.chamadas = g.chamadas;
    const j = g.texto ? extrairJson(g.texto) : null;
    if (!j || !Array.isArray(j.ordem)) { out.erro = g.erro || "ilegível"; return out; }
    const ok = new Set(cand), vistos = new Set<number>(), ordem: number[] = [];
    for (const x of j.ordem) {
      const i = Number(x);
      if (ok.has(i) && !vistos.has(i)) { vistos.add(i); ordem.push(i); }
    }
    // os que o modelo deixou de fora vão no fim, pela ordem da carta
    for (const i of cand) if (!vistos.has(i)) ordem.push(i);
    out.ordem = ordem;
    return out;
  } catch (e) {
    out.erro = String((e as Error).message || e).slice(0, 200);
    return out;
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", onAbort);
  }
}

/* ── OS MODOS SEM CARTA: a garrafeira e o Catálogo (07/10/2026) ──
   A app manda os vinhos com os factos que tem (`normFactos` limpa-os — vêm
   do browser), e o modelo ordena-os como no passo 4. Na GARRAFEIRA não há
   preço (são garrafas que já se têm), mas há o MOMENTO de cada uma — a
   janela de consumo: um vinho no ponto, sobretudo a fechar a janela, vem
   antes de um ainda cedo. No CATÁLOGO há o preço de referência (o das lojas,
   o `precoPrincipal` da app) e a relação preço/qualidade.
   OS VINHOS ESCOLHIDOS À MÃO (`escolhidos: true`, 17/10/2026, o dono: "marcar
   manualmente até 5 vinhos … para que a IA sugerisse qual dos 5 melhor
   acompanha com o prato"): a pessoa já escolheu a lista e está indecisa
   entre eles. O modelo ordena-os TODOS, recomenda só o melhor (dois se
   estiverem mesmo empatados) e, se nenhum combinar, diz-o (`nenhum`, com o
   `aviso`) em vez de recomendar um à força — o `rankingDe` punha o
   primeiro como recomendado. Uma app antiga não manda a marca e fica como
   era. */
const MAX_LISTA = 20;
const MAX_ESCOLHIDOS = 5;   // o `WS_ESC_MAX` da app
const MODOS_LISTA = ["garrafeira", "catalogo"];
const LISTA_TIMEOUT_MS = 55_000;
const CUSTO_LISTA_EUR = 0.003;
function anoJanela(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isInteger(n) && n >= 1900 && n <= 2100 ? n : null;
}
function normFactos(raw: unknown): Record<string, any> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as any;
  const nome = s(o.nome, 100);
  if (!nome) return null;
  const nv = o.vivino && typeof o.vivino === "object" ? numOuNull(o.vivino.nota, 0, 5) : null;
  const j = o.janela && typeof o.janela === "object" ? o.janela : null;
  return {
    nome,
    produtor: s(o.produtor, 80),
    ano: anoOuNull(o.ano),
    tipo: TIPOS.includes(o.tipo) ? o.tipo : "",
    regiao: s(o.regiao, 60),
    castas: Array.isArray(o.castas) ? o.castas.map((c: unknown) => s(c, 40)).filter(Boolean).slice(0, 6) : [],
    estilo: s(o.estilo, 40),
    mencao: s(o.mencao, 40),
    vivino: nv != null ? { nota: nv, de: o.vivino.de === "global" ? "global" : "colheita" } : null,
    preco: numOuNull(o.preco, 0, 5000),
    harmonizacao: s(o.harmonizacao, 200),
    prova: s(o.prova, 160),
    janela: j ? {
      de: anoJanela(j.de), ate: anoJanela(j.ate),
      fase: ["cedo", "ponto", "passou"].includes(j.fase) ? j.fase : "",
      terco: ["a abrir", "a meio", "a fechar"].includes(j.terco) ? j.terco : "",
    } : null,
  };
}
function linhaDaLista(f: any, i: number, modo: string): string {
  const jan = modo === "garrafeira" ? f.janela : null;
  const janTxt = jan && (jan.de || jan.ate)
    ? `janela de consumo: ${jan.de ?? "?"}–${jan.ate ?? "?"}` +
      (jan.fase === "ponto" ? `, no ponto${jan.terco ? ` (${jan.terco})` : ""}` : jan.fase === "cedo" ? ", ainda cedo" : jan.fase === "passou" ? ", já passou" : "")
    : "";
  return [
    `[${i}] ${f.nome}`,
    f.produtor ? `produtor: ${f.produtor}` : "",
    f.ano ? `colheita: ${f.ano}` : "",
    f.tipo ? `cor: ${f.tipo}` : "",
    f.regiao ? `região: ${f.regiao}` : "",
    f.mencao ? `menção: ${f.mencao}` : "",
    f.estilo ? `estilo: ${f.estilo}` : "",
    f.castas.length ? `castas: ${f.castas.join(", ")}` : "",
    f.vivino ? `Vivino ${f.vivino.nota}/5${f.vivino.de === "global" ? " (todas as colheitas)" : ""}` : "SEM NOTA",
    modo === "catalogo" && f.preco != null ? `preço de referência ~${f.preco}€` : "",
    janTxt,
    f.harmonizacao ? `harmoniza com: ${f.harmonizacao}` : "",
    f.prova ? `prova: ${f.prova}` : "",
  ].filter(Boolean).join(" | ");
}
function promptLista(modo: string, linhas: string[], prato: string, orcamento: number | null, escolhidos = false) {
  const casa = modo === "garrafeira";
  const n = linhas.length, um = n === 1;
  const regraNota = `a NOTA do Vivino: um vinho com nota alta fica à frente de um com nota
     baixa, e um vinho "SEM NOTA" NUNCA fica à frente de um que combine e
     tenha nota de 3.8 ou mais`;
  const intro = escolhidos
    ? (um
      ? `Esta pessoa quer saber se este vinho${casa ? ", que tem em casa," : ", de um catálogo,"} serve para o prato`
      : `Esta pessoa está indecisa entre estes ${n} vinhos${casa ? ", que tem em casa" : ", que escolheu de um catálogo para comprar"}`)
    : casa
      ? "Estes são os vinhos que esta pessoa tem em casa, na sua garrafeira"
      : `Estes são vinhos de um catálogo, para comprar${orcamento ? ` (até ${orcamento} € por garrafa pelo preço de referência das lojas, com uma folga de ${MARGEM_ORCAMENTO} €)` : ""}`;
  return `És um escanção em Portugal. ${intro},
com os factos que se sabem de ${um ? "ele" : "cada um"}:

${linhas.join("\n")}

${prato ? `O prato a acompanhar é: "${prato}".` : casa
    ? "Não foi indicado nenhum prato — escolhe vinhos para abrir agora: no ponto, versáteis e bem avaliados."
    : "Não foi indicado nenhum prato — escolhe vinhos versáteis e bem avaliados."}

Devolve APENAS um objeto JSON com esta forma exata:
{"ranking": [{"i": number, "razao": string}], "recomendados": [number]${escolhidos ? `, "aviso": string` : ""}}

Regras:
${escolhidos
    ? `- "ranking": ${um ? "o vinho da lista" : `TODOS os ${n} vinhos da lista, do que melhor acompanha este prato
  para o que pior acompanha`}, pelo número entre [ ].`
    : `- "ranking": até ${MAX_RANKING} vinhos da lista, do melhor para o pior para este
  prato, pelo número entre [ ].`}
- Critérios, por esta ordem:
  1. harmonização com o prato (cor, corpo, acidez, taninos, castas, o que o
     vinho diz harmonizar) — um vinho que não combina fica sempre atrás;
${casa
    ? `  2. o momento do vinho: um vinho no ponto vem à frente de um "ainda cedo",
     e entre os que estão no ponto, os que estão "a fechar" a janela primeiro
     (são os que se devem beber antes); um que "já passou" só se combinar
     muito bem;
  3. ${regraNota};`
    : `  2. ${regraNota};
  3. a relação preço/qualidade (a nota face ao preço de referência);`}
  4. em igualdade, dá prioridade aos PORTUGUESES.
${escolhidos
    ? `- "recomendados": ${um ? "[o número do vinho] se combinar bem com o prato" : `o que melhor acompanha o prato — só esse (dois só se
  estiverem mesmo empatados)`}; [] se ${um ? "não combinar" : "nenhum combinar bem"}. Não
  recomendes ${um ? "o vinho" : "um"} só para dar uma resposta: a pessoa prefere saber.
- "aviso": só se ${um ? "não combinar" : "nenhum combinar bem"}, uma frase honesta a dizê-lo e o
  que procurar em vez disso (cor, casta, estilo); senão "".`
    : `- "recomendados": os 2 ou 3 primeiros do ranking que recomendarias mesmo
  (só 1 se só um combinar; [] se nenhum combinar) — não recomendes um só
  para chegar a três.`}
- "razao": uma a duas frases concretas, em português, sobre porque está
  nessa posição para este prato, apoiadas nos factos dados — com honestidade:
  o que joga a favor e, se houver, o que joga contra; um bom vinho que é
  melhor para outro prato di-lo ("é mais para assados"). Não elogies por
  elogiar. Não cites notas nem preços que não estejam na lista, e não
  inventes castas nem características${escolhidos ? "; de um vinho de que se saiba pouco, di-lo em vez de adivinhar" : ""}.
Responde só com o JSON.`;
}
async function sugerirLista(body: any, quem: string): Promise<{ status: number; corpo: Record<string, unknown> }> {
  const t0 = Date.now();
  const modo = String(body.modo);
  const prato = s(body.prato, 200);
  const escolhidos = body.escolhidos === true;
  const orc = modo === "catalogo" && !escolhidos ? numOuNull(body.orcamento, 1, 10000) : null;
  const factos = (body.vinhos as unknown[]).slice(0, escolhidos ? MAX_ESCOLHIDOS : MAX_LISTA).map(normFactos);
  const linhas: string[] = [];
  const validos = new Set<number>(), comNota = new Set<number>();
  factos.forEach((f, i) => {
    if (!f) return;
    validos.add(i);
    if (f.vivino) comNota.add(i);
    linhas.push(linhaDaLista(f, i, modo));
  });
  if (!linhas.length) {
    await registar("ok", { passo: "sugerir", modo, candidatos: 0, ms: Date.now() - t0 }, quem);
    return { status: 200, corpo: { estado: "vazio", sugestoes: [] } };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LISTA_TIMEOUT_MS);
  try {
    const modelos = await candidatosModelo(ctrl.signal);
    const g = await gerar([[modelos[0], 1024], [MODELO_LEVE, 0]], [{ text: promptLista(modo, linhas, prato, orc, escolhidos) }], ctrl.signal);
    const j = g.texto ? extrairJson(g.texto) : null;
    if (!j || typeof j !== "object") {
      await registar("erro", { passo: "sugerir", modo, escolhidos, erro: g.erro || "ilegível", modelo: g.modelo || null, candidatos: linhas.length,
        ms: Date.now() - t0, ...(g.usage ? { usageMetadata: g.usage } : {}) }, quem);
      return { status: 502, corpo: { error: g.status === 429 || g.status === 503
        ? "o serviço está com muita procura agora — espera um minuto e tenta outra vez"
        : "não consegui fazer a sugestão agora — tenta outra vez" } };
    }
    const sugestoes = rankingDe(j, validos, comNota);
    // Escolhidos à mão: "nenhum combina" é uma resposta, e não se lhe põe
    // por cima um recomendado à força (o `rankingDe` põe o primeiro).
    const nenhum = escolhidos && sugestoes.length > 0 && Array.isArray(j.recomendados) && j.recomendados.length === 0;
    if (nenhum) sugestoes.forEach((x) => { x.recomendado = false; });
    const aviso = nenhum ? s(j.aviso, 300) : "";
    await registar("ok", {
      passo: "sugerir", modo, escolhidos, modelo: g.modelo, candidatos: linhas.length, sugestoes: sugestoes.length,
      ...(escolhidos ? { nenhum } : {}), prato, orcamento: orc, chamadas_gemini: g.chamadas,
      ...(g.usage ? { usageMetadata: g.usage } : {}), custo_estimado_eur: CUSTO_LISTA_EUR, ms: Date.now() - t0,
    }, quem);
    return { status: 200, corpo: { estado: sugestoes.length ? "ok" : "nenhum-combina", sugestoes, modelo: g.modelo,
      ...(escolhidos ? { nenhum, aviso } : {}) } };
  } catch (e) {
    const err = e as Error, timeout = err.name === "AbortError";
    await registar("erro", { passo: "sugerir", modo, erro: String(err.message).slice(0, 300), ms: Date.now() - t0 }, quem);
    return { status: timeout ? 504 : 500, corpo: { error: timeout ? "a sugestão demorou demasiado — tenta outra vez" : (err.message || "erro inesperado") } };
  } finally { clearTimeout(timer); }
}

/* ── AS SUGESTÕES LIVRES (13/10/2026, migração 54) ──
   O dono das apps: "sugestões sem ter por base uma carta, uma garrafeira ou
   um catálogo. O utilizador simplesmente colocava o prato, o preço (mínimo
   e máximo), um campo de observações … e pedíamos à IA 5 vinhos". Aqui a
   memória do modelo ESCOLHE os vinhos (não há outra coisa por onde
   escolher), mas nada do que ele diz entra no Catálogo como facto:
   · cada vinho liga-se ao Catálogo pela procura da carta (`carta_achar`,
     dentro da `garrafeira.livre_registar`) — o que lá está mostra-se com os
     dados de lá;
   · o que não está vai à `vinho-info` (com o `livreId`), que só o faz nascer
     no Catálogo com produtor, castas, preço, imagem e Vivino COM FONTE; o
     resto fica para o Backoffice (`livre_vinhos`, estado `por_carregar`);
   · MEMÓRIA (o dono: "dois pedidos praticamente iguais na mesma semana
     deviam levar a mesma resposta"): a chave é o prato pelos conceitos da
     app (`chavePrato`, a mesma tabela da procura do prato sem IA), o preço
     e as palavras das observações; dentro de `LIVRE_MEMORIA_DIAS` responde
     a linha de `livre_pedidos`, sem modelo nenhum. A app mostra-a com o que
     o Catálogo sabe HOJE. E "pedir outra vez" obriga a mais detalhe nas
     observações — é a própria chave que muda (a app confere-o).
   As observações não se guardam por extenso: só as palavras da chave. */
const LIVRE_N = 5;
const LIVRE_MEMORIA_DIAS = 7;
const LIVRE_TIMEOUT_MS = 55_000;
const CUSTO_LIVRE_EUR = 0.003;
const LIVRE_STOP = new Set(("a o as os ao aos de do da dos das com sem e em no na nos nas um uma uns umas para por " +
  "pela pelo que se mais muito pouco bem tipo vinho vinhos quero queria gostava algo coisa prefiro preferencia " +
  "preferencialmente talvez").split(" "));
// As palavras das observações, sem acentos nem ordem, e sem as que não dizem nada.
function obsChave(t: string): string {
  const ws = String(t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !LIVRE_STOP.has(w));
  return [...new Set(ws)].sort().join(" ").slice(0, 300);
}
function precoChave(v: number | null): string { return v == null ? "" : String(Math.round(v)); }

function promptLivre(prato: string, min: number | null, max: number | null, obs: string) {
  const preco = min != null && max != null ? `entre ${min} € e ${max} €`
    : max != null ? `até ${max} €` : min != null ? `a partir de ${min} €` : "sem limite de preço";
  return `És um escanção em Portugal. Sugere exatamente ${LIVRE_N} vinhos para acompanhar:
"${prato}".

Preço por garrafa (preço de loja, não de restaurante): ${preco}.
${obs ? `Observações de quem pergunta (segue-as): "${obs}".` : "Sem observações."}

Devolve APENAS um objeto JSON com esta forma exata:
{"vinhos": [{"nome": string, "produtor": string, "ano": number|null,
  "tipo": "Tinto"|"Branco"|"Rosé"|"Espumante"|"Licoroso"|"Frisante",
  "regiao": string, "castas": [string], "preco": number, "razao": string}]}

Regras:
- Só vinhos REAIS, que existem e se compram em lojas em Portugal. Se não
  tens a certeza de que um vinho existe com esse nome, não o sugiras.
- Dá prioridade a vinhos PORTUGUESES, a não ser que as observações peçam
  outra coisa. Varia: no máximo um vinho de cada produtor.
- Pela ordem: o primeiro é o que mais recomendas para este prato.
- "nome": o nome do vinho como está no rótulo, sem a colheita e sem a cor
  (ex.: "Quinta do Crasto Reserva Vinhas Velhas", "Esporão Reserva").
- "produtor": o nome do produtor.
- "ano": null — a não ser que uma colheita concreta seja a razão da
  sugestão.
- "tipo": a cor, com estas palavras. Um Vinho Verde diz-se pela cor.
- "preco": o preço aproximado de uma garrafa numa loja, em euros, dentro do
  intervalo pedido.
- Se o prato ou as observações falarem de mais do que um prato (o prato
  "sushi" e, nas observações, "que também não seja má escolha para uma
  massada de peixe"), o primeiro é o que serve bem TODOS, e a razão diz
  como se porta com cada um.
- "razao": uma a duas frases concretas, em português, sobre porque combina
  com o prato (corpo, acidez, taninos, castas, estilo) — e, se houver um
  senão, di-lo. Não elogies por elogiar.
Responde só com o JSON.`;
}
function normLivre(raw: unknown): Record<string, any> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as any;
  const nome = s(o.nome, 120).replace(/\b(19|20)\d{2}\b/g, "").replace(/\s+/g, " ").trim();
  if (!nome || !TIPOS.includes(o.tipo)) return null;
  return {
    nome, produtor: s(o.produtor, 90), ano: anoOuNull(o.ano), tipo: o.tipo, regiao: s(o.regiao, 60),
    sugerido: {
      castas: Array.isArray(o.castas) ? o.castas.map((c: unknown) => s(c, 40)).filter(Boolean).slice(0, 6) : [],
      preco: numOuNull(o.preco, 1, 5000), regiao: s(o.regiao, 60),
    },
    razao: s(o.razao, 400),
  };
}
// A `vinho-info` publicada já confirma sugestões livres? (ver lá o `livreSonda`)
async function vinhoInfoSabe(auth: string): Promise<"sim" | "nao" | "sem-acesso"> {
  try {
    const r = await fetch(`${SB_URL}/functions/v1/vinho-info`, {
      method: "POST", headers: { Authorization: auth, apikey: SB_SRV, "Content-Type": "application/json" },
      body: JSON.stringify({ livreSonda: true }), signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 403) return "sem-acesso";
    if (!r.ok) return "nao";
    const d = await r.json().catch(() => null);
    return d?.livre === 1 ? "sim" : "nao";
  } catch (_) { return "nao"; }
}
async function livrePatch(ids: number[], patch: Record<string, unknown>) {
  if (!ids.length) return;
  try {
    await sb(`livre_vinhos?id=in.(${ids.join(",")})`, { method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ ...patch, atualizado_em: new Date().toISOString() }) });
  } catch (_) { /**/ }
}
/* As confirmações, em segundo plano: uma procura da `vinho-info` por vinho,
   em nome de quem perguntou (o JWT dele). A `vinho-info` responde já com o
   `id` da análise e fecha a linha de `livre_vinhos` quando acabar — aqui só
   se arranca. Sem a versão nova publicada, as linhas voltam a `pendente`
   (confirmam-se no próximo pedido que as sugira). */
async function livreVerificar(vinhos: any[], auth: string, quem: string) {
  if (!vinhos.length) return;
  const sabe = await vinhoInfoSabe(auth);
  if (sabe !== "sim") {
    await livrePatch(vinhos.map((v) => v.id), sabe === "sem-acesso"
      ? { estado: "por_carregar", falta: ["ninguém o procurou: quem perguntou não tem acesso à procura com IA"] }
      : { estado: "pendente" });
    await registar("ok", { passo: "livre_verificar", vinhos: vinhos.length, vinho_info: sabe }, quem);
    return;
  }
  const arrancou: number[] = [], falhou: number[] = [];
  await Promise.all(vinhos.map(async (v) => {
    try {
      const r = await fetch(`${SB_URL}/functions/v1/vinho-info`, {
        method: "POST", headers: { Authorization: auth, apikey: SB_SRV, "Content-Type": "application/json" },
        body: JSON.stringify({ livreId: v.id, nome: v.nome, assincrono: true }), signal: AbortSignal.timeout(20_000),
      });
      (r.ok ? arrancou : falhou).push(v.id);
    } catch (_) { falhou.push(v.id); }
  }));
  await livrePatch(falhou, { estado: "pendente" });
  await registar("ok", { passo: "livre_verificar", vinhos: vinhos.length, arrancou: arrancou.length, falhou: falhou.length }, quem);
}
async function livrePedido(body: any, quem: string, auth: string): Promise<{ status: number; corpo: Record<string, unknown> }> {
  const t0 = Date.now();
  const prato = s(body.prato, 200);
  if (!prato) return { status: 400, corpo: { error: "diz o prato" } };
  let min = numOuNull(body.precoMin, 0, 10000), max = numOuNull(body.precoMax, 1, 10000);
  if (min === 0) min = null;
  if (min != null && max != null && min > max) [min, max] = [max, min];
  const obs = s(body.observacoes, 400);
  // O prato pela chave dos conceitos que a app calculou (a tabela vive lá);
  // sem ela, as palavras do prato.
  const cp = typeof body.chavePrato === "string" && /^[a-z0-9_ +/|:.-]{1,300}$/.test(body.chavePrato) ? body.chavePrato : obsChave(prato);
  const oc = obsChave(obs);
  const chave = `${cp}#${precoChave(min)}-${precoChave(max)}#${oc}`;

  // A MEMÓRIA: o mesmo pedido há menos de uma semana.
  const desde = new Date(Date.now() - LIVRE_MEMORIA_DIAS * 86400_000).toISOString();
  try {
    const r = await sb(`livre_pedidos?chave=eq.${encodeURIComponent(chave)}&criado_em=gte.${encodeURIComponent(desde)}&order=criado_em.desc&limit=1&select=id,criado_em,sugestoes,vezes`);
    const p = r.ok ? (await r.json())?.[0] : null;
    if (p) {
      await sb(`livre_pedidos?id=eq.${p.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ vezes: (p.vezes || 1) + 1, ultimo_em: new Date().toISOString() }) });
      const ids = (Array.isArray(p.sugestoes) ? p.sugestoes : []).map((x: any) => Number(x?.v)).filter((n: number) => Number.isInteger(n));
      // Os que ficaram por confirmar (a `vinho-info` ainda não sabia) vão agora.
      let aVerificar: any[] = [];
      if (ids.length) {
        const rv = await sb(`livre_vinhos?id=in.(${ids.join(",")})&estado=eq.pendente&select=id,nome`, {
          method: "PATCH", headers: { Prefer: "return=representation" },
          body: JSON.stringify({ estado: "a_verificar", atualizado_em: new Date().toISOString() }) });
        aVerificar = rv.ok ? await rv.json() : [];
      }
      if (aVerificar.length) EdgeRuntime.waitUntil(livreVerificar(aVerificar, auth, quem));
      await registar("ok", { passo: "livre", memoria: true, pedido: p.id, verificar: aVerificar.length, ms: Date.now() - t0 }, quem);
      return { status: 200, corpo: { id: p.id, memoria: true, criado_em: p.criado_em } };
    }
  } catch (_) { /* sem memória, pergunta-se */ }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIVRE_TIMEOUT_MS);
  try {
    const modelos = await candidatosModelo(ctrl.signal);
    const g = await gerar([[modelos[0], 1024], [MODELO_LEVE, 0]], [{ text: promptLivre(prato, min, max, obs) }], ctrl.signal);
    const j = g.texto ? extrairJson(g.texto) : null;
    const vinhos = (Array.isArray(j?.vinhos) ? j.vinhos : []).map(normLivre).filter(Boolean).slice(0, LIVRE_N) as Record<string, any>[];
    if (!vinhos.length) {
      await registar("erro", { passo: "livre", erro: g.erro || "sem vinhos", modelo: g.modelo || null, ms: Date.now() - t0,
        ...(g.usage ? { usageMetadata: g.usage } : {}) }, quem);
      return { status: 502, corpo: { error: g.status === 429 || g.status === 503
        ? "o serviço está com muita procura agora — espera um minuto e tenta outra vez"
        : "não consegui fazer a sugestão agora — tenta outra vez" } };
    }
    // Cada vinho, uma linha (e a ligação ao Catálogo).
    const rr = await sb("rpc/livre_registar", { method: "POST", signal: ctrl.signal,
      body: JSON.stringify({ p_vinhos: vinhos, p_prato: prato }) });
    if (!rr.ok) throw new Error("não consegui guardar a sugestão (" + rr.status + ")");
    const linhas: any[] = await rr.json();
    const sugestoes = vinhos.map((v, k) => linhas[k] ? { v: linhas[k].id, razao: v.razao, recomendado: k === 0 } : null).filter(Boolean);
    const rp = await sb("livre_pedidos", { method: "POST", headers: { Prefer: "return=representation" }, signal: ctrl.signal,
      body: JSON.stringify({ chave, prato, preco_min: min, preco_max: max, obs_chave: oc, quem, sugestoes, modelo: g.modelo }) });
    const id = rp.ok ? (await rp.json())?.[0]?.id : null;
    if (typeof id !== "number") throw new Error("não consegui guardar a sugestão (" + rp.status + ")");
    const aVerificar = linhas.filter((l) => l && l.verificar);
    if (aVerificar.length) EdgeRuntime.waitUntil(livreVerificar(aVerificar, auth, quem));
    await registar("ok", {
      passo: "livre", modelo: g.modelo, prato, preco_min: min, preco_max: max, observacoes: !!obs,
      vinhos: vinhos.length, no_catalogo: linhas.filter((l) => l && l.catalogo_id).length, verificar: aVerificar.length,
      chamadas_gemini: g.chamadas, ...(g.usage ? { usageMetadata: g.usage } : {}), custo_estimado_eur: CUSTO_LIVRE_EUR,
      ms: Date.now() - t0,
    }, quem);
    return { status: 200, corpo: { id, memoria: false } };
  } catch (e) {
    const err = e as Error, timeout = err.name === "AbortError";
    await registar("erro", { passo: "livre", erro: String(err.message).slice(0, 300), ms: Date.now() - t0 }, quem);
    return { status: timeout ? 504 : 500, corpo: { error: timeout ? "a sugestão demorou demasiado — tenta outra vez" : (err.message || "erro inesperado") } };
  } finally { clearTimeout(timer); }
}

/* ── IDENTIFICAR VINHOS NUMA FOTOGRAFIA (17/10/2026, migração 56) ──
   O dono das apps: "estou no supermercado ou num site e tiro fotografia ou
   print a apanhar vários vinhos, e a app dizia quais conhecia … e quais não
   conhecia (com opção de pesquisar detalhe adicional — para adicionar ao
   Catálogo)". É a leitura da carta com outra instrução — rótulos e
   etiquetas de prateleira, não as linhas de uma carta — e sem ordem nem
   sugestão (não há prato nem orçamento). Fica numa linha de
   `garrafeira.cartas` com `fonte: "prateleira"`; a ligação ao Catálogo
   faz-a a app (`carta_ligar`).
   Procurar um que o Catálogo não tem (`acao: "identificar_procurar"`) é a
   confirmação da pergunta livre, tal e qual: uma linha em
   `garrafeira.livre_vinhos` (`livre_registar`, com `foto: true`) e a
   `vinho-info` com o `livreId`, que só o faz nascer no Catálogo com os
   campos principais COM FONTE (o dono: "só com fontes"); o resto vai ao
   Backoffice. Escolhe-os a pessoa, até `ID_PROC_MAX` de cada vez e
   `ID_PROC_TOTAL` por fotografia — cada um é uma procura com o pacote
   completo. Só a quem edita: a `vinho-info` só atende editores, e sem eles
   a linha ficava "por carregar" com uma falta que não é do vinho. */
const ID_MAX_FOTOS = 4;
const ID_MAX_VINHOS = 40;
const ID_PROC_MAX = 5;
const ID_PROC_TOTAL = 10;
const promptPrateleira = (n: number) => `${n > 1
  ? `Aqui estão ${n} fotografias (ou prints de um site) com vinhos — prateleiras de uma loja ou de um supermercado, uma montra, ou a página de uma loja online. Trata-as em conjunto.`
  : "Aqui está uma fotografia (ou um print de um site) com vinhos — a prateleira de uma loja ou de um supermercado, uma montra, ou a página de uma loja online."}
Identifica CADA vinho diferente que se consegue ler (até ${ID_MAX_VINHOS}). Várias
garrafas iguais são um vinho só; o mesmo vinho em duas fotos também. Não
avalies nem recomendes nada — só lê o que lá está.

Devolve APENAS um objeto JSON com esta forma exata:
{"vinhos": [{"nome": string, "produtor": string|null, "ano": number|null,
  "tipo": "Tinto"|"Branco"|"Rosé"|"Espumante"|"Licoroso"|"Frisante"|null,
  "regiao": string|null, "preco": number|null}],
 "naoLidas": number, "aviso": string|null}

Regras:
- Lê o RÓTULO da garrafa e, quando houver, a ETIQUETA da prateleira que lhe
  corresponde (ou o texto do produto, num site): a etiqueta costuma trazer o
  nome por extenso, a colheita e o preço. Junta as duas no mesmo vinho.
- "nome": o nome do vinho como está no rótulo ou na etiqueta, sem o preço,
  sem a capacidade ("75cl") e sem palavras de promoção.
- "produtor": só se estiver escrito (no rótulo, na etiqueta, no site); null
  se não aparecer. Nunca o deduzas de memória.
- "ano": a colheita, só se estiver escrita; null caso contrário.
- "tipo": a COR — pelo que está escrito ("Tinto", "Branco", "Rosé"…) ou,
  sem isso, pela cor do vinho que se vê através do vidro. Um Vinho Verde não
  é uma cor: diz se é branco, tinto ou rosé (na dúvida, Branco). Porto,
  Moscatel e Madeira são Licoroso. null só se nada o deixar perceber.
- "regiao": só se estiver escrita (Douro, Alentejo, Dão, Vinho Verde…).
- "preco": o preço de UMA garrafa em euros, da etiqueta ou do site (com
  desconto, se houver os dois); null se não se vir.
- Uma garrafa cujo rótulo não se consegue ler NÃO entra: conta-a em
  "naoLidas" (quantos vinhos diferentes ficaram por ler). Nunca adivinhes um
  vinho pela forma da garrafa ou pelas cores do rótulo.
- "aviso": preenche só se as fotos estiverem desfocadas ou sem vinhos —
  caso contrário null.
- Nunca inventes: na dúvida, null.`;

/* A leitura de uma fotografia de vinhos: o Identificar e a pergunta livre
   com uma foto passam os dois por aqui. Devolve os vinhos (cada um uma vez
   só — nome, colheita e cor) e o aviso, ou o erro já dito para a app. */
async function lerVinhosDaFoto(partsImg: unknown[], nFotos: number, modelos: string[], signal: AbortSignal) {
  // Ler não precisa de pensar (o "200 vazio" da carta).
  const g = await gerar(modelos.map((m) => [m, 0] as [string, number]), [...partsImg, { text: promptPrateleira(nFotos) }], signal);
  const base = { modelo: g.modelo, usage: g.usage, chamadas: g.chamadas };
  if (!g.texto) {
    return { ...base, vinhos: [] as any[], aviso: null as string | null, naoLidas: 0, falhou: g.erro || "sem resposta do modelo",
      erro: g.status === 429 || g.status === 503 ? "o serviço está com muita procura agora — espera um minuto e tenta outra vez" : g.erro };
  }
  const j = extrairJson(g.texto);
  if (!j) {
    return { ...base, vinhos: [] as any[], aviso: null as string | null, naoLidas: 0, falhou: "json: " + g.texto.slice(0, 300),
      erro: "não percebi a resposta do modelo — tenta uma foto mais nítida" };
  }
  const vistos = new Set<string>();
  const vinhos = (Array.isArray(j.vinhos) ? j.vinhos : []).map(normVinhoCarta).filter((v: any) => {
    if (!v) return false;
    const k = `${String(v.nome).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim()}|${v.ano ?? ""}|${v.tipo ?? ""}`;
    return vistos.has(k) ? false : (vistos.add(k), true);
  }).slice(0, ID_MAX_VINHOS) as any[];
  const naoLidas = Math.max(0, Math.min(200, Math.round(Number(j.naoLidas) || 0)));
  const aviso = [j.aviso ? s(j.aviso, 200) : "",
    naoLidas ? `${naoLidas === 1 ? "Um vinho ficou" : naoLidas + " vinhos ficaram"} por ler — aproxima-te dos rótulos ou das etiquetas e tira outra foto.` : ""]
    .filter(Boolean).join(" ") || null;
  return { ...base, vinhos, aviso, naoLidas, falhou: "",
    erro: vinhos.length ? "" : (aviso || "não consegui ler vinhos nesta fotografia — aproxima-te dos rótulos ou das etiquetas") };
}

async function lerPrateleira(id: number, quem: string, partsImg: unknown[], nFotos: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROC_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const modelos = await candidatosModelo(ctrl.signal);
    const l = await lerVinhosDaFoto(partsImg, nFotos, modelos, ctrl.signal);
    if (l.falhou) {
      await registar("erro", { passo: "identificar", erro: l.falhou, modelo: l.modelo || null, ms: Date.now() - t0,
        ...(l.usage ? { usageMetadata: l.usage } : {}) }, quem);
      await atualizarCarta(id, quem, { estado: "erro", erro: l.erro });
      return;
    }
    await registar("ok", {
      passo: "identificar", modelo: l.modelo, fotos: nFotos, vinhos: l.vinhos.length, nao_lidas: l.naoLidas,
      chamadas_gemini: l.chamadas, ...(l.usage ? { usageMetadata: l.usage } : {}),
      custo_estimado_eur: CUSTO_LEITURA_EUR, ms: Date.now() - t0,
    }, quem);
    await atualizarCarta(id, quem, l.vinhos.length
      ? { estado: "lida", vinhos: l.vinhos, aviso: l.aviso }
      : { estado: "erro", erro: l.erro });
  } catch (e) {
    const err = e as Error, timeout = err.name === "AbortError";
    await registar("erro", { passo: "identificar", erro: timeout ? "timeout" : String(err.message).slice(0, 300), ms: Date.now() - t0 }, quem);
    await atualizarCarta(id, quem, { estado: "erro",
      erro: timeout ? "o modelo demorou demasiado a ler a fotografia — tenta outra vez, ou uma foto mais nítida" : (err.message || "erro inesperado") });
  } finally { clearTimeout(timer); }
}

async function identificarProcurar(body: any, quem: string, auth: string): Promise<{ status: number; corpo: Record<string, unknown> }> {
  const id = Number(body?.id);
  if (!Number.isInteger(id)) return { status: 400, corpo: { error: "falta a identificação" } };
  // A `vinho-info` só atende editores (ver acima).
  try {
    const re = await sb("rpc/is_editor", { method: "POST", body: "{}" }, "garrafeira", auth);
    if (!re.ok || (await re.json()) !== true) return { status: 403, corpo: { error: "procurar informação é só para quem edita a sua garrafeira" } };
  } catch (_) { return { status: 502, corpo: { error: "não consegui confirmar o teu acesso — tenta outra vez" } }; }
  const r = await sb(`cartas?id=eq.${id}&quem=eq.${encodeURIComponent(quem)}&fonte=eq.prateleira&select=id,estado,vinhos,livre`);
  const row = r.ok ? (await r.json())?.[0] : null;
  if (!row) return { status: 404, corpo: { error: "não encontrei esta identificação" } };
  if (row.estado !== "lida") return { status: 409, corpo: { error: "a fotografia ainda não foi lida" } };
  const vinhos: any[] = Array.isArray(row.vinhos) ? row.vinhos.slice() : [];
  const livre: Record<string, number> = { ...(row.livre && typeof row.livre === "object" ? row.livre : {}) };
  // A cor de um vinho lido sem ela, escolhida na app: é a chave do Catálogo.
  let mudou = false;
  if (body.cores && typeof body.cores === "object") {
    for (const [k, v] of Object.entries(body.cores)) {
      const i = Number(k);
      if (Number.isInteger(i) && vinhos[i] && !vinhos[i].tipo && TIPOS.includes(v as string)) { vinhos[i] = { ...vinhos[i], tipo: v }; mudou = true; }
    }
  }
  const resta = ID_PROC_TOTAL - Object.keys(livre).length;
  const indices: number[] = (Array.isArray(body.indices) ? body.indices : []).map((x: unknown) => Number(x));
  const pedidos = [...new Set(indices)]
    .filter((i) => Number.isInteger(i) && vinhos[i] && vinhos[i].tipo && !(String(i) in livre));
  if (resta <= 0) return { status: 409, corpo: { error: `já procuraste ${ID_PROC_TOTAL} vinhos desta fotografia` } };
  const lote = pedidos.slice(0, Math.min(ID_PROC_MAX, resta));
  if (!lote.length) return { status: 400, corpo: { error: "escolhe os vinhos a procurar (com a cor)" } };
  const rr = await sb("rpc/livre_registar", { method: "POST",
    body: JSON.stringify({ p_prato: "", p_vinhos: lote.map((i) => {
      const v = vinhos[i];
      return { nome: v.nome, produtor: v.produtor || "", ano: v.ano ?? null, tipo: v.tipo, regiao: v.regiao || "", foto: true,
        sugerido: { foto: { nome: v.nome, ...(v.preco != null ? { preco: v.preco } : {}) } } };
    }) }) });
  if (!rr.ok) {
    await registar("erro", { passo: "identificar_procurar", erro: "livre_registar " + rr.status, carta: id }, quem);
    return { status: 502, corpo: { error: "não consegui guardar o pedido — tenta outra vez" } };
  }
  const linhas: any[] = await rr.json();
  // Um nome de que não sai chave nenhuma fica com 0: não se volta a tentar.
  lote.forEach((i, k) => { livre[String(i)] = linhas[k] && typeof linhas[k].id === "number" ? linhas[k].id : 0; });
  await atualizarCarta(id, quem, { livre, ...(mudou ? { vinhos } : {}) });
  const aVerificar = linhas.filter((l) => l && l.verificar);
  if (aVerificar.length) EdgeRuntime.waitUntil(livreVerificar(aVerificar, auth, quem));
  await registar("ok", { passo: "identificar_procurar", carta: id, vinhos: lote.length, verificar: aVerificar.length,
    no_catalogo: linhas.filter((l) => l && l.catalogo_id).length }, quem);
  return { status: 200, corpo: { livre, ...(mudou ? { vinhos } : {}) } };
}

/* ── A PERGUNTA LIVRE COM UMA FOTOGRAFIA (17/10/2026, migração 56) ──
   O dono das apps: "na parte da perguntar à IA, era muito giro que eu
   pudesse enviar uma fotografia de vinhos (que tirei tipo no supermercado)
   e perguntar à IA, para o que vou almoçar ou jantar, qual é o vinho mais
   recomendado". A IA escolhe ENTRE os vinhos da foto — lidos como no
   Identificar (`lerVinhosDaFoto`) e ligados ao Catálogo, cuja ficha vai no
   pedido (a nota do Vivino, as castas, a harmonização); dos que o Catálogo
   não conhece pode usar o que sabe, como na pergunta livre de sempre, e a
   app di-lo. A resposta guarda-se como uma pergunta livre (`livre_pedidos`,
   os recomendados em `livre_vinhos`, com `foto: true`), e a app mostra-a
   com o mesmo desenho; os recomendados que o Catálogo não tem vão à
   confirmação (só nascem lá com fontes). Ler a foto leva tempo: o pedido
   nasce `pendente`, o trabalho segue em segundo plano e a app sonda a
   `livre_ler`. Sem memória — cada fotografia é outra pergunta (a chave é
   `foto#…`, que nunca se repete). */
const LIVRE_FOTO_N = 3;
/* O VEREDICTO HONESTO (17/10/2026, o dono das apps, depois de experimentar
   com sushi: "a sensação que fico é que a resposta do Gemini foi sempre para
   me satisfazer … faltou uma resposta mais honesta: 'este vinho é muito bom,
   mas mais apropriado para bacalhau ou assados'"). O pedido era "os 3
   melhores" e "porque combina": com 4 vinhos na foto, 3 saíam elogiados. Agora
   cada vinho leva um veredicto — "bem", "serve" ou "mal" — e uma nota com o
   que joga a favor E contra; só se recomenda o que combina bem (sem nenhum,
   no máximo um "serve", dito como o menos mau). */
const VEREDICTOS = ["bem", "serve", "mal"];
const COR_TIPO: Record<string, string> = { tinto: "Tinto", branco: "Branco", rose: "Rosé", espumante: "Espumante", frisante: "Frisante", licoroso: "Licoroso" };
// As fotografias de um pedido → as partes para o Gemini, ou o erro.
function partesImagens(imagens: unknown, max: number): { parts: unknown[]; erro: string } {
  if (!Array.isArray(imagens) || imagens.length === 0 || imagens.length > max) return { parts: [], erro: `envia entre 1 e ${max} fotografias` };
  let total = 0;
  const parts: unknown[] = [];
  for (const img of imagens as any[]) {
    const data = img && typeof img.data === "string" ? img.data : null;
    if (!data || data.length > 6_000_000) return { parts: [], erro: "uma das fotos está em falta ou é demasiado grande" };
    total += data.length;
    if (total > 20_000_000) return { parts: [], erro: "fotos demasiado grandes no total — tenta menos fotos" };
    parts.push({ inline_data: { mime_type: /^image\/[a-z+.-]+$/i.test(String(img.mime)) ? img.mime : "image/jpeg", data } });
  }
  return { parts, erro: "" };
}
// Um vinho da foto, para o modelo: o que se leu e, se o Catálogo o conhece, a ficha.
function linhaDaFoto(i: number, v: any, l: any): string {
  const f = l && l.id != null ? l.ficha : null;
  const nv = f ? notaVivino(f) : null;
  return [
    `[${i}] ${v.nome}`,
    (v.produtor || l?.produtor) ? `produtor: ${v.produtor || l.produtor}` : "",
    v.ano ? `colheita: ${v.ano}` : "",
    (v.tipo || f?.tipo) ? `cor: ${v.tipo || f.tipo}` : "",
    (v.regiao || f?.regiao) ? `região: ${v.regiao || f.regiao}` : "",
    v.preco != null ? `preço na foto: ${v.preco}€` : "",
    !f || !sabeAlgo(f) ? "(o Catálogo não o conhece)"
      : [nv ? `Vivino ${nv.nota}/5${nv.de === "global" ? " (todas as colheitas)" : ""}` : "SEM NOTA",
         numOuNull(f.preco_medio) != null ? `preço de referência ~${numOuNull(f.preco_medio)}€` : "",
         Array.isArray(f.castas) && f.castas.length ? `castas: ${f.castas.slice(0, 6).join(", ")}` : "",
         f.estilo ? `estilo: ${s(f.estilo, 40)}` : "",
         f.harmonizacao ? `harmoniza com: ${s(f.harmonizacao, 240)}` : "",
         f.notas_prova ? `prova: ${s(f.notas_prova, 200)}` : ""].filter(Boolean).join(" | "),
  ].filter(Boolean).join(" | ");
}
function promptLivreFoto(prato: string, min: number | null, max: number | null, obs: string, linhas: string[]) {
  const preco = min != null && max != null ? `entre ${min} € e ${max} €`
    : max != null ? `até ${max} €` : min != null ? `a partir de ${min} €` : "sem limite de preço";
  return `És um escanção em Portugal. Numa loja, alguém fotografou estes vinhos e quer saber qual levar para acompanhar:
"${prato}".

Preço por garrafa: ${preco}.
${obs ? `Observações de quem pergunta (segue-as): "${obs}".` : "Sem observações."}

Os vinhos da fotografia — o índice, o que se leu e, quando o Catálogo o conhece, os factos de lá:
${linhas.join("\n")}

Diz, de CADA vinho da lista, se serve para este prato — com honestidade,
como um escanção que não tem nada para vender. Numa prateleira, o normal é
só 1 ou 2 combinarem mesmo bem com um prato concreto, e às vezes nenhum: um
bom vinho pode não ser o vinho para ESTE prato.

Devolve APENAS um objeto JSON com esta forma exata:
{"vinhos": [{"i": number, "combina": "bem"|"serve"|"mal",
  "tipo": "Tinto"|"Branco"|"Rosé"|"Espumante"|"Licoroso"|"Frisante"|null, "nota": string}],
 "recomendados": [number], "aviso": string|null}

Regras:
- "vinhos": todos os vinhos da lista, pelo número entre [ ], cada um com:
  · "combina": "bem" (escolhê-lo-ias para este prato), "serve" (não estraga
    a refeição, mas não é a escolha certa) ou "mal" (não é vinho para isto);
  · "nota": uma a duas frases concretas, em português, com o que joga A
    FAVOR e o que joga CONTRA para este prato (corpo, acidez, taninos,
    madeira, doçura, castas). Se é um bom vinho mas para outra coisa, diz
    para quê ("muito bom, mas com esta madeira é mais para bacalhau ou
    assados"). Não elogies por elogiar.
- "recomendados": até ${LIVRE_FOTO_N} números, pela ordem — o primeiro é o que
  levarias —, SÓ de vinhos "bem". Sem nenhum "bem", no máximo UM "serve",
  e a nota dele diz que é o menos mau. [] se nenhum servir.
- Dos vinhos com factos do Catálogo, usa esses factos — a nota do Vivino
  pesa entre os que combinam.
- Dos que o Catálogo não conhece, podes usar o que sabes do vinho, do
  produtor e da região. Um que não reconheces julga-se pelo que se lê (cor,
  região, castas, menção) e a nota di-lo — e não o recomendes às cegas.
- Respeita o preço pedido quando o preço na foto se vê.
- Se o prato ou as observações falarem de mais do que um prato (o prato
  "sushi" e, nas observações, "que também não seja má escolha para uma
  massada de peixe"), o veredicto é para TODOS: "bem" só se servir bem os
  dois, e a nota diz como se porta com cada um.
- "tipo": a cor do vinho, quando a souberes.
- "aviso": se nenhum combinar bem, uma frase honesta a dizê-lo e o que
  procurar em vez disso (ex.: "para sushi, procura um Alvarinho ou um
  espumante bruto"); senão null.
Responde só com o JSON.`;
}
async function livreFotoPedido(body: any, quem: string, auth: string): Promise<{ status: number; corpo: Record<string, unknown> }> {
  const prato = s(body.prato, 200);
  if (!prato) return { status: 400, corpo: { error: "diz o prato" } };
  const im = partesImagens(body.imagens, ID_MAX_FOTOS);
  if (im.erro) return { status: 400, corpo: { error: im.erro } };
  let min = numOuNull(body.precoMin, 0, 10000), max = numOuNull(body.precoMax, 1, 10000);
  if (min === 0) min = null;
  if (min != null && max != null && min > max) [min, max] = [max, min];
  const obs = s(body.observacoes, 400);
  const n = (body.imagens as unknown[]).length;
  const r = await sb("livre_pedidos", { method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ chave: `foto#${crypto.randomUUID()}`, prato, preco_min: min, preco_max: max, obs_chave: obsChave(obs),
      quem, sugestoes: [], estado: "pendente", foto: { fotos: n } }) });
  const id = r.ok ? (await r.json())?.[0]?.id : null;
  if (typeof id !== "number") {
    await registar("erro", { passo: "livre_foto", erro: "criar " + r.status }, quem);
    return { status: 502, corpo: { error: r.status === 400 ? "falta a migração 56 no Supabase (db/migracao-identificar.sql)" : "não consegui começar — tenta outra vez" } };
  }
  EdgeRuntime.waitUntil(livreFoto(id, im.parts, n, prato, min, max, obs, quem, auth));
  return { status: 202, corpo: { id, pendente: true } };
}
async function livreFoto(id: number, partsImg: unknown[], nFotos: number, prato: string, min: number | null, max: number | null,
  obs: string, quem: string, auth: string) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROC_TIMEOUT_MS);
  const t0 = Date.now();
  const fechar = async (patch: Record<string, unknown>) => {
    try {
      await sb(`livre_pedidos?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ ...patch, ultimo_em: new Date().toISOString() }) });
    } catch (_) { /**/ }
  };
  let usage: Usage | null = null, chamadas = 0, modelo = "";
  let aVerificar: any[] = [];
  try {
    const modelos = await candidatosModelo(ctrl.signal);
    const l = await lerVinhosDaFoto(partsImg, nFotos, modelos, ctrl.signal);
    usage = l.usage; chamadas = l.chamadas; modelo = l.modelo;
    if (!l.vinhos.length) {
      await registar("erro", { passo: "livre_foto", erro: l.falhou || "sem vinhos", modelo: modelo || null, ms: Date.now() - t0,
        ...(usage ? { usageMetadata: usage } : {}) }, quem);
      await fechar({ estado: "erro", erro: l.erro });
      return;
    }
    // A linha do Catálogo de cada um, com a ficha (com um tecto próprio).
    let ligados: any[] = [];
    const cl = new AbortController(), onAbort = () => cl.abort();
    ctrl.signal.addEventListener("abort", onAbort);
    const tl = setTimeout(() => cl.abort(), 20_000);
    try { ligados = await ligarComFicha(l.vinhos, cl.signal); } catch (_) { /* segue sem */ }
    finally { clearTimeout(tl); ctrl.signal.removeEventListener("abort", onAbort); }
    const foto = { fotos: nFotos, aviso: l.aviso, vinhos: l.vinhos.map((v: any, i: number) => ({ ...v, cat: ligados[i]?.id ?? null })) };
    // Fora do preço pedido (com a margem do orçamento) não vai ao modelo.
    const cabeP = (p: number | null) => p == null || ((max == null || p <= max + MARGEM_ORCAMENTO) && (min == null || p >= min - MARGEM_ORCAMENTO));
    const cand = l.vinhos.map((_: any, i: number) => i).filter((i: number) => cabeP(l.vinhos[i].preco ?? null));
    if (!cand.length) {
      await registar("ok", { passo: "livre_foto", modelo, fotos: nFotos, vinhos: l.vinhos.length, candidatos: 0, chamadas_gemini: chamadas,
        ...(usage ? { usageMetadata: usage } : {}), custo_estimado_eur: CUSTO_LEITURA_EUR, ms: Date.now() - t0 }, quem);
      await fechar({ estado: "pronto", modelo, foto: { ...foto, semSugestao: "nenhum dos vinhos da foto está dentro do preço pedido" } });
      return;
    }
    const g = await gerar([[modelos[0], 1024], [MODELO_LEVE, 0]],
      [{ text: promptLivreFoto(prato, min, max, obs, cand.map((i: number) => linhaDaFoto(i, l.vinhos[i], ligados[i]))) }], ctrl.signal);
    usage = somar(usage, g.usage); chamadas += g.chamadas;
    const j = g.texto ? extrairJson(g.texto) : null;
    if (!j) {
      await registar("erro", { passo: "livre_foto", erro: g.erro || "json", modelo: g.modelo || modelo || null, ms: Date.now() - t0,
        ...(usage ? { usageMetadata: usage } : {}) }, quem);
      await fechar({ estado: "erro", foto, erro: g.status === 429 || g.status === 503
        ? "o serviço está com muita procura agora — espera um minuto e tenta outra vez" : "não consegui escolher agora — tenta outra vez" });
      return;
    }
    // O veredicto de cada vinho (ver "O VEREDICTO HONESTO", acima) e os
    // recomendados — só "bem", e sem nenhum "bem" no máximo UM "serve". A
    // regra vai no pedido e confere-se aqui: um "mal" nunca é sugestão.
    const validos = new Set<number>(cand);
    const ver = new Map<number, { combina: string; nota: string; tipo: string | null }>();
    for (const x of Array.isArray(j.vinhos) ? j.vinhos : []) {
      const i = Number(x?.i);
      if (!validos.has(i) || ver.has(i) || !VEREDICTOS.includes(x?.combina)) continue;
      ver.set(i, { combina: x.combina, nota: s(x?.nota, 400), tipo: TIPOS.includes(x?.tipo) ? x.tipo : null });
    }
    // Uma resposta sem veredicto nenhum não quer dizer "nenhum combina": é uma
    // resposta fora do formato.
    if (!ver.size) {
      await registar("erro", { passo: "livre_foto", erro: "sem veredictos", modelo: g.modelo || null, amostra: g.texto.slice(0, 400),
        ms: Date.now() - t0, ...(usage ? { usageMetadata: usage } : {}) }, quem);
      await fechar({ estado: "erro", foto, erro: "não consegui escolher agora — tenta outra vez" });
      return;
    }
    const pedidos = (Array.isArray(j.recomendados) ? j.recomendados : []).map((x: unknown) => Number(x))
      .filter((i: number, k: number, a: number[]) => ver.has(i) && a.indexOf(i) === k);
    let recs = pedidos.filter((i: number) => ver.get(i)!.combina === "bem").slice(0, LIVRE_FOTO_N);
    if (!recs.length) recs = pedidos.filter((i: number) => ver.get(i)!.combina === "serve").slice(0, 1);
    const sug = recs.map((i: number) => ({ i, razao: ver.get(i)!.nota, tipo: ver.get(i)!.tipo, combina: ver.get(i)!.combina }));
    // Na lista dos vinhos da foto, o veredicto de cada um.
    foto.vinhos = foto.vinhos.map((v: any, i: number) => ver.has(i) ? { ...v, combina: ver.get(i)!.combina, nota: ver.get(i)!.nota }
      : validos.has(i) ? v : { ...v, foraPreco: true });
    // Os recomendados, como na pergunta livre: uma linha cada um (ligada ao
    // Catálogo pelo nome de lá, quando o tem), e a cor que se souber.
    const pv = sug.map((x) => {
      const v = l.vinhos[x.i], lg = ligados[x.i]?.id != null ? ligados[x.i] : null;
      return { nome: lg?.nome || v.nome, produtor: lg?.produtor || v.produtor || "", ano: v.ano ?? null,
        tipo: v.tipo || lg?.ficha?.tipo || COR_TIPO[lg?.cor] || x.tipo, regiao: v.regiao || "", foto: true,
        sugerido: { foto: { nome: v.nome, ...(v.preco != null ? { preco: v.preco } : {}) } } };
    });
    let regs: any[] = [];
    if (pv.length) {
      const rr = await sb("rpc/livre_registar", { method: "POST", signal: ctrl.signal, body: JSON.stringify({ p_vinhos: pv, p_prato: prato }) });
      if (!rr.ok) throw new Error("não consegui guardar a sugestão (" + rr.status + ")");
      regs = await rr.json();
    }
    const sugestoes = sug.map((x, k) => regs[k] ? { v: regs[k].id, razao: x.razao, recomendado: k === 0, i: x.i, combina: x.combina } : null).filter(Boolean);
    aVerificar = regs.filter((r) => r && r.verificar);
    await fechar({ estado: "pronto", sugestoes, modelo: g.modelo,
      foto: { ...foto, ...(j.aviso ? { avisoIA: s(j.aviso, 300) } : {}),
        ...(sugestoes.length ? {} : { semSugestao: j.aviso ? s(j.aviso, 300) : "nenhum dos vinhos da foto combina com este prato" }) } });
    await registar("ok", {
      passo: "livre_foto", modelo: g.modelo, modelo_leitura: modelo, prato, preco_min: min, preco_max: max, observacoes: !!obs,
      fotos: nFotos, vinhos: l.vinhos.length, candidatos: cand.length, sugeridos: sugestoes.length,
      veredictos: { bem: [...ver.values()].filter((x) => x.combina === "bem").length,
        serve: [...ver.values()].filter((x) => x.combina === "serve").length, mal: [...ver.values()].filter((x) => x.combina === "mal").length },
      no_catalogo: regs.filter((r) => r && r.catalogo_id).length, verificar: aVerificar.length,
      chamadas_gemini: chamadas, ...(usage ? { usageMetadata: usage } : {}),
      custo_estimado_eur: CUSTO_LEITURA_EUR + CUSTO_LIVRE_EUR, ms: Date.now() - t0,
    }, quem);
  } catch (e) {
    const err = e as Error, timeout = err.name === "AbortError";
    aVerificar = [];
    await registar("erro", { passo: "livre_foto", erro: timeout ? "timeout" : String(err.message).slice(0, 300), ms: Date.now() - t0 }, quem);
    await fechar({ estado: "erro", erro: timeout ? "demorou demasiado a ler a fotografia — tenta outra vez, ou uma foto mais nítida" : (err.message || "erro inesperado") });
  } finally { clearTimeout(timer); }
  // Fora do prazo da leitura: as confirmações só arrancam (ver `livreVerificar`).
  if (aVerificar.length) await livreVerificar(aVerificar, auth, quem);
}

/* ── A base de dados ── */
async function sb(path: string, init: RequestInit = {}, perfil = "garrafeira", auth = "Bearer " + SB_SRV) {
  return await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_SRV, Authorization: auth, "Content-Type": "application/json",
      "Accept-Profile": perfil, "Content-Profile": perfil,
      ...(init.headers as Record<string, string> ?? {}),
    },
  });
}
async function atualizarCarta(id: number, quem: string, patch: Record<string, unknown>) {
  try {
    const r = await sb(`cartas?id=eq.${id}&quem=eq.${encodeURIComponent(quem)}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ ...patch, atualizado_em: new Date().toISOString() }),
    });
    if (!r.ok) console.log("CARTA atualizar falhou:", r.status, (await r.text().catch(() => "")).slice(0, 200));
  } catch (e) { console.log("CARTA atualizar erro:", String((e as Error).message).slice(0, 200)); }
}

/* Quem pode: a BD diz o plano de IA de quem chamou, com o JWT dele. */
async function autorizar(auth: string, signal: AbortSignal): Promise<{ ok: boolean; email: string; plano: string }> {
  if (!auth) return { ok: false, email: "", plano: "sem_ia" };
  const u = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_SRV, Authorization: auth }, signal });
  if (!u.ok) return { ok: false, email: "", plano: "sem_ia" };
  const email = String((await u.json()).email ?? "").toLowerCase();
  if (!email) return { ok: false, email: "", plano: "sem_ia" };
  try {
    const r = await sb("rpc/plano_ia", { method: "POST", body: "{}", signal }, "garrafeira", auth);
    const plano = r.ok ? String(await r.json()) : "sem_ia";
    return { ok: plano === "gratis" || plano === "premium", email, plano };
  } catch (_) { return { ok: false, email, plano: "sem_ia" }; }
}

/* ── Registo: `garrafeira.sync_log` e o espelho em `ia_uso.registos` (o
   registo central dos acessos ao Gemini — ver o CLAUDE.md). Nunca deita o
   trabalho abaixo. Duplicado de propósito (cada Edge Function é auto-contida). */
async function registar(estado: string, detalhe: Record<string, unknown>, quem: string | null) {
  try {
    await sb("sync_log", { method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ origem: "function", acao: "garrafeira-carta", estado, quem, detalhe }) });
  } catch (_) { /**/ }
  if (!detalhe.modelo && estado !== "erro") return;   // sem chamada ao Gemini, nada a contar
  try {
    const u = (detalhe.usageMetadata ?? null) as Usage | null;
    await sb("registos", { method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        app: "garrafeira", funcao: "garrafeira-carta",
        // A funcionalidade (o painel de custos conta o custo médio de cada uma):
        // ler a carta, sugerir da carta, ou sugerir da garrafeira/do Catálogo.
        // Recusado antes de se saber o que era → `entrada`.
        funcionalidade: detalhe.passo === "sugerir" ? `sugerir-${String(detalhe.modo ?? "garrafeira")}`
          : detalhe.passo === "livre" ? "sugerir-livre"
          : detalhe.passo === "livre_foto" ? "sugerir-livre-foto"
          : String(detalhe.passo ?? "").startsWith("identificar") ? "identificar"
          : detalhe.passo === "recomendar" ? "recomendar"
          : (detalhe.passo === "autorizacao" || detalhe.passo === "excecao_inicial") ? "entrada"
          : "ler",
        estado: estado === "erro" ? "erro" : "ok",
        modelo: (detalhe.modelo as string | undefined) ?? null, pesquisa_web: false,
        tokens_entrada: u?.promptTokenCount ?? null, tokens_saida: u?.candidatesTokenCount ?? null,
        tokens_pensamento: u?.thoughtsTokenCount ?? null, tokens_total: u?.totalTokenCount ?? null,
        custo_estimado_eur: (detalhe.custo_estimado_eur as number | undefined) ?? null,
        duracao_ms: (detalhe.ms as number | undefined) ?? null, quem,
        erro: estado === "erro" ? String(detalhe.erro ?? detalhe.passo ?? "").slice(0, 500) || null : null,
        detalhe,
      }) }, "ia_uso");
  } catch (_) { /**/ }
}

/* ── A SUGESTÃO JÁ COM A LEITURA (11/10/2026) ──
   O dono das apps: "é como se fosse aquele nosso amigo a quem pedimos
   opinião e ele diz 'olha, dos que conheço da carta, recomendaria este'".
   Acabada a leitura, a carta fica 'lida' (a app mostra logo a lista) com a
   sugestão 'pendente', e o mesmo trabalho em segundo plano segue para a
   recomendação de sempre (`recomendarCarta`), só entre os vinhos de que o
   Catálogo já sabe alguma coisa — basta UM. Sem nenhum, não se chama o
   modelo e fica como era. A app já espera por uma sugestão 'pendente' ao
   abrir a carta. Diz-se sempre quantos se conhecem de quantos (`conhecidos`,
   `possiveis` na `recomendacao`). Leitura e sugestão cabem no tempo que a
   plataforma dá a um trabalho em segundo plano (`PRAZO_TOTAL_MS`); se a
   leitura o gastou quase todo, não há sugestão já — pede-se no fim da
   lista, como antes. */
const PRAZO_TOTAL_MS = 140_000;
const PRAZO_SUGESTAO_MIN_MS = 20_000;

/* ── Ler (em segundo plano) ── */
async function lerCarta(id: number, quem: string, partsImg: unknown[], nFotos: number, prato: string, orcamento: number | null) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROC_TIMEOUT_MS);
  const t0 = Date.now();
  let sugerirJa: { vinhos: any[]; ligados: any[] } | null = null;
  try {
    const modelos = await candidatosModelo(ctrl.signal);
    // Transcrever não precisa de pensar — e pensar é o que gastava o
    // orçamento todo e devolvia o "200 vazio".
    const g = await gerar(modelos.map((m) => [m, 0] as [string, number]), [...partsImg, { text: promptLeitura(nFotos) }], ctrl.signal);
    if (!g.texto) {
      await registar("erro", { passo: "ler", erro: g.erro, ms: Date.now() - t0, ...(g.usage ? { usageMetadata: g.usage } : {}) }, quem);
      await atualizarCarta(id, quem, { estado: "erro",
        erro: g.status === 429 || g.status === 503 ? "o serviço está com muita procura agora — espera um minuto e tenta outra vez" : g.erro });
      return;
    }
    const j = extrairJson(g.texto);
    if (!j) {
      await registar("erro", { passo: "json", modelo: g.modelo, amostra: g.texto.slice(0, 600), ms: Date.now() - t0 }, quem);
      await atualizarCarta(id, quem, { estado: "erro", erro: "não percebi a resposta do modelo — tenta uma foto mais nítida" });
      return;
    }
    const vinhos = (Array.isArray(j.vinhosCarta) ? j.vinhosCarta : []).map(normVinhoCarta).filter(Boolean).slice(0, 80);
    const aviso = j.aviso ? s(j.aviso, 200) : null;
    // A linha do Catálogo de cada vinho, com a ficha: para a ordem e para a
    // sugestão. Se o Catálogo não responder, ordena-se só com a carta.
    // Com um tecto próprio: um catálogo lento não pode levar a leitura atrás.
    let ligados: any[] = [];
    if (vinhos.length && !ctrl.signal.aborted) {
      const cl = new AbortController(), onAbort = () => cl.abort();
      ctrl.signal.addEventListener("abort", onAbort);
      const tl = setTimeout(() => cl.abort(), 20_000);
      try { ligados = await ligarComFicha(vinhos, cl.signal); } catch (_) { /* segue sem */ }
      finally { clearTimeout(tl); ctrl.signal.removeEventListener("abort", onAbort); }
    }
    // A ordem da lista (ver "A ORDEM DA LISTA"): nunca deita a leitura abaixo.
    const o = vinhos.length && !ctrl.signal.aborted
      ? await ordenarCarta(vinhos, ligados, prato, orcamento, modelos, ctrl.signal)
      : { ordem: null, usage: null, modelo: "", chamadas: 0, erro: "" };
    const pediuOrdem = o.chamadas > 0 || !!o.erro;
    // A sugestão já (ver "A SUGESTÃO JÁ COM A LEITURA"): há algum conhecido, e tempo.
    const conhecidos = vinhos.length ? conhecidosDaCarta(vinhos, ligados, orcamento).conhecidos.size : 0;
    if (conhecidos > 0 && PRAZO_TOTAL_MS - (Date.now() - t0) >= PRAZO_SUGESTAO_MIN_MS) sugerirJa = { vinhos, ligados };
    await registar("ok", {
      passo: "ler", modelo: g.modelo, fotos: nFotos, vinhos_carta: vinhos.length,
      conhecidos, sugestao_ja: !!sugerirJa,
      ordem: o.ordem && pediuOrdem ? "ia" : o.erro ? "falhou" : "carta",
      ...(o.erro ? { ordem_erro: o.erro } : {}), ...(o.modelo ? { modelo_ordem: o.modelo } : {}),
      chamadas_gemini: g.chamadas + o.chamadas,
      ...(somar(g.usage, o.usage) ? { usageMetadata: somar(g.usage, o.usage) } : {}),
      custo_estimado_eur: CUSTO_LEITURA_EUR + (o.chamadas ? CUSTO_ORDEM_EUR : 0), ms: Date.now() - t0,
    }, quem);
    await atualizarCarta(id, quem, vinhos.length
      ? { estado: "lida", vinhos, aviso, ordem: o.ordem && pediuOrdem ? o.ordem : null,
          ...(sugerirJa ? { rec_estado: "pendente", rec_erro: null } : {}) }
      : { estado: "erro", erro: aviso || "não consegui ler vinhos nesta carta — tenta uma foto mais nítida" });
  } catch (e) {
    const err = e as Error, timeout = err.name === "AbortError";
    sugerirJa = null;
    await registar("erro", { passo: timeout ? "timeout" : "excecao", erro: String(err.message).slice(0, 300), ms: Date.now() - t0 }, quem);
    await atualizarCarta(id, quem, { estado: "erro",
      erro: timeout ? "o modelo demorou demasiado a ler a carta — tenta outra vez, ou uma foto mais nítida" : (err.message || "erro inesperado") });
  } finally { clearTimeout(timer); }
  // Fora do prazo da leitura: a sugestão tem o seu, o que sobra do total.
  if (sugerirJa) {
    await recomendarCarta({ id, prato, orcamento, vinhos: sugerirJa.vinhos }, quem,
      { ligados: sugerirJa.ligados, auto: true, prazoMs: Math.max(5_000, Math.min(60_000, PRAZO_TOTAL_MS - (Date.now() - t0))) });
  }
}

/* ── Os vinhos da carta que se CONHECEM: os que cabem no orçamento e de que
   o Catálogo sabe alguma coisa, com os factos que o modelo vai ler. É a
   mesma conta para a sugestão pedida e para a que sai com a leitura, e é de
   onde vêm os dois números que a app mostra ("conheço X dos Y"). ── */
function conhecidosDaCarta(vinhos: any[], ligados: any[], orc: number | null) {
  const linhas: string[] = [];
  const conhecidos = new Set<number>();
  const comNota = new Set<number>();
  let possiveis = 0;
  vinhos.forEach((v, i) => {
    if (!cabe(v.preco ?? null, orc)) return;
    possiveis++;
    const l = ligados[i];
    if (!l || !sabeAlgo(l.ficha)) return;
    const f = l.ficha;
    const nv = notaVivino(f);
    if (nv) comNota.add(i);
    conhecidos.add(i);
    const outraColheita = v.ano && l.ano && v.ano !== l.ano ? ` (os factos são da colheita ${l.ano})` : "";
    linhas.push([
      `[${i}] ${v.nome}`,
      (v.produtor || l.produtor) ? `produtor: ${v.produtor || l.produtor}` : "",
      v.ano ? `colheita: ${v.ano}${outraColheita}` : (l.ano ? `colheita no catálogo: ${l.ano}` : ""),
      (v.tipo || f.tipo) ? `cor: ${v.tipo || f.tipo}` : "",
      (v.regiao || f.regiao) ? `região: ${v.regiao || f.regiao}` : "",
      v.preco != null ? `preço na carta: ${v.preco}€` : "preço na carta: ?",
      nv ? `Vivino ${nv.nota}/5${nv.de === "global" ? " (todas as colheitas)" : ""}` : "SEM NOTA",
      numOuNull(f.preco_medio) != null ? `preço de referência ~${numOuNull(f.preco_medio)}€` : "",
      Array.isArray(f.castas) && f.castas.length ? `castas: ${f.castas.slice(0, 6).join(", ")}` : "",
      f.estilo ? `estilo: ${s(f.estilo, 40)}` : "",
      f.harmonizacao ? `harmoniza com: ${s(f.harmonizacao, 240)}` : "",
      f.notas_prova ? `prova: ${s(f.notas_prova, 240)}` : "",
    ].filter(Boolean).join(" | "));
  });
  return { linhas, conhecidos, comNota, possiveis };
}

/* ── Recomendar (em segundo plano) ──
   Pedida (o botão "Sugerir"), ou logo a seguir à leitura (`auto`, ver "A
   SUGESTÃO JÁ COM A LEITURA"): nesse caso a leitura já trouxe a ligação ao
   Catálogo (`ligados`) e diz quanto tempo sobra (`prazoMs`). */
async function recomendarCarta(row: any, quem: string, op: { ligados?: any[]; auto?: boolean; prazoMs?: number } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), op.prazoMs ?? 60_000);
  const t0 = Date.now();
  const id = row.id as number;
  const auto = !!op.auto;
  try {
    const vinhos: any[] = Array.isArray(row.vinhos) ? row.vinhos : [];
    const orc = row.orcamento != null ? Number(row.orcamento) : null;
    // A linha do catálogo de cada um — a mesma pergunta que a app faz, mas
    // com a ficha (o que o modelo vai ler).
    const ligados = op.ligados ?? await ligarComFicha(vinhos, ctrl.signal);
    const { linhas, conhecidos, comNota, possiveis } = conhecidosDaCarta(vinhos, ligados, orc);

    if (!linhas.length) {
      await registar("ok", { passo: "recomendar", auto, conhecidos: 0, possiveis, ms: Date.now() - t0 }, quem);
      await atualizarCarta(id, quem, { rec_estado: "concluido",
        recomendacao: { estado: "sem-conhecidos", sugestoes: [], conhecidos: 0, possiveis, auto, geradoEm: new Date().toISOString() } });
      return;
    }

    const modelos = await candidatosModelo(ctrl.signal);
    // Ordenar por harmonização E nota é raciocínio a sério: o modelo que lê
    // a carta, com um tecto POSITIVO de pensamento; o lite é a rede.
    const g = await gerar([[modelos[0], 1024], [MODELO_LEVE, 0]], [{ text: promptRecomendacao(linhas, s(row.prato, 200), orc) }], ctrl.signal);
    const j = g.texto ? extrairJson(g.texto) : null;
    // A que sai com a leitura não foi pedida: se falhar, diz-se por onde a
    // pedir, e não "tenta outra vez".
    const deNovo = auto ? "pede-a no fim da lista" : "tenta outra vez";
    if (!j || typeof j !== "object") {
      await registar("erro", { passo: "recomendar", auto, erro: g.erro || "ilegível", modelo: g.modelo || null, ms: Date.now() - t0, ...(g.usage ? { usageMetadata: g.usage } : {}) }, quem);
      await atualizarCarta(id, quem, { rec_estado: "erro", rec_erro: `não consegui fazer a sugestão agora — ${deNovo}` });
      return;
    }

    const sugestoes = rankingDe(j, conhecidos, comNota);

    await registar("ok", {
      passo: "recomendar", auto, modelo: g.modelo, conhecidos: conhecidos.size, possiveis, sugestoes: sugestoes.length,
      prato: s(row.prato, 200), orcamento: orc, chamadas_gemini: g.chamadas,
      ...(g.usage ? { usageMetadata: g.usage } : {}), custo_estimado_eur: CUSTO_RECOMENDACAO_EUR, ms: Date.now() - t0,
    }, quem);
    await atualizarCarta(id, quem, { rec_estado: "concluido", rec_erro: null,
      recomendacao: { estado: sugestoes.length ? "ok" : "nenhum-combina", sugestoes, conhecidos: conhecidos.size, possiveis, auto,
        modelo: g.modelo, geradoEm: new Date().toISOString() } });
  } catch (e) {
    const err = e as Error, timeout = err.name === "AbortError";
    await registar("erro", { passo: "recomendar", auto, erro: String(err.message).slice(0, 300), ms: Date.now() - t0 }, quem);
    await atualizarCarta(id, quem, { rec_estado: "erro",
      rec_erro: timeout ? `a sugestão demorou demasiado — ${auto ? "pede-a no fim da lista" : "tenta outra vez"}` : (err.message || "erro inesperado") });
  } finally { clearTimeout(timer); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  const authHeader = req.headers.get("Authorization") ?? "";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SYNC_TIMEOUT_MS);
  let quem: string | null = null;
  try {
    const auth = await autorizar(authHeader, ctrl.signal);
    quem = auth.email || null;
    if (!auth.ok) {
      await registar("erro", { passo: "autorizacao", plano: auth.plano }, quem);
      return json({ error: "As sugestões usam IA, e a IA não está incluída no teu acesso." }, 403);
    }
    const body = await req.json().catch(() => ({} as any));

    if (body?.acao === "ler") {
      const imagens = body.imagens;
      if (!Array.isArray(imagens) || imagens.length === 0 || imagens.length > 6) {
        return json({ error: "envia entre 1 e 6 fotos da carta" }, 400);
      }
      let total = 0;
      const partsImg: unknown[] = [];
      for (const img of imagens) {
        const data = img && typeof img.data === "string" ? img.data : null;
        if (!data || data.length > 6_000_000) return json({ error: "uma das fotos está em falta ou é demasiado grande" }, 400);
        total += data.length;
        if (total > 20_000_000) return json({ error: "fotos demasiado grandes no total — tenta menos fotos" }, 400);
        partsImg.push({ inline_data: { mime_type: /^image\/[a-z+.-]+$/i.test(String(img.mime)) ? img.mime : "image/jpeg", data } });
      }
      const prato = s(body.prato, 200), orcamento = numOuNull(body.orcamento, 1, 10000);
      const r = await sb("cartas", { method: "POST", headers: { Prefer: "return=representation" }, signal: ctrl.signal,
        body: JSON.stringify({ quem, prato, orcamento, fotos: imagens.length }) });
      const id = r.ok ? (await r.json())?.[0]?.id : null;
      if (typeof id !== "number") {
        await registar("erro", { passo: "criar_carta", status: r.status }, quem);
        return json({ error: "não consegui começar a leitura — tenta outra vez" }, 502);
      }
      EdgeRuntime.waitUntil(lerCarta(id, quem!, partsImg, imagens.length, prato, orcamento));
      return json({ id, estado: "pendente" }, 202);
    }

    if (body?.acao === "recomendar") {
      const id = Number(body.id);
      if (!Number.isInteger(id)) return json({ error: "falta a carta" }, 400);
      const r = await sb(`cartas?id=eq.${id}&quem=eq.${encodeURIComponent(quem!)}&select=id,prato,orcamento,estado,vinhos,pesquisados`, { signal: ctrl.signal });
      const row = r.ok ? (await r.json())?.[0] : null;
      if (!row) return json({ error: "não encontrei esta carta" }, 404);
      if (row.estado !== "lida") return json({ error: "a carta ainda não foi lida" }, 409);
      // os vinhos que a app procurou com IA desde a última vez
      const pesq: Record<string, string> = { ...(row.pesquisados && typeof row.pesquisados === "object" ? row.pesquisados : {}) };
      if (body.pesquisados && typeof body.pesquisados === "object") {
        for (const [k, v] of Object.entries(body.pesquisados)) {
          if (/^\d{1,3}$/.test(k) && (v === "ok" || v === "falhou")) pesq[k] = v;
        }
      }
      await atualizarCarta(id, quem!, { rec_estado: "pendente", rec_erro: null, pesquisados: pesq });
      EdgeRuntime.waitUntil(recomendarCarta(row, quem!));
      return json({ id, estado: "pendente" }, 202);
    }

    if (body?.acao === "livre") {
      // Com fotografias, a IA escolhe entre os vinhos da foto (ver "A PERGUNTA
      // LIVRE COM UMA FOTOGRAFIA").
      const r = Array.isArray(body.imagens) && body.imagens.length
        ? await livreFotoPedido(body, quem!, authHeader)
        : await livrePedido(body, quem!, authHeader);
      return json(r.corpo, r.status);
    }

    // Identificar vinhos numa fotografia (ver "IDENTIFICAR VINHOS NUMA FOTOGRAFIA").
    if (body?.acao === "identificar") {
      const imagens = body.imagens;
      const im = partesImagens(imagens, ID_MAX_FOTOS);
      if (im.erro) return json({ error: im.erro }, 400);
      const partsImg = im.parts;
      const r = await sb("cartas", { method: "POST", headers: { Prefer: "return=representation" }, signal: ctrl.signal,
        body: JSON.stringify({ quem, fotos: imagens.length, fonte: "prateleira" }) });
      const id = r.ok ? (await r.json())?.[0]?.id : null;
      if (typeof id !== "number") {
        await registar("erro", { passo: "identificar", erro: "criar " + r.status }, quem);
        return json({ error: r.status === 400 ? "falta a migração 56 no Supabase (db/migracao-identificar.sql)" : "não consegui começar a leitura — tenta outra vez" }, 502);
      }
      EdgeRuntime.waitUntil(lerPrateleira(id, quem!, partsImg, imagens.length));
      return json({ id, estado: "pendente" }, 202);
    }

    if (body?.acao === "identificar_procurar") {
      const r = await identificarProcurar(body, quem!, authHeader);
      return json(r.corpo, r.status);
    }

    if (body?.acao === "sugerir") {
      if (!MODOS_LISTA.includes(body.modo)) return json({ error: "modo desconhecido" }, 400);
      if (!Array.isArray(body.vinhos)) return json({ error: "faltam os vinhos" }, 400);
      const r = await sugerirLista(body, quem!);
      return json(r.corpo, r.status);
    }

    return json({ error: "acção desconhecida" }, 400);
  } catch (e) {
    const err = e as Error;
    await registar("erro", { passo: "excecao_inicial", erro: String(err.message).slice(0, 300) }, quem);
    return json({ error: err.message || "erro inesperado" }, 500);
  } finally { clearTimeout(timer); }
});
