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
//      Fica em `garrafeira.cartas` (`vinhos`, `ordem`).
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
  quem está à mesa (só 1 se só um combinar; [] se nenhum combinar).
- "razao": uma a duas frases concretas, em português, sobre porque está
  nessa posição para este prato, apoiadas nos factos dados. Não cites notas
  nem preços que não estejam na lista, e não inventes castas nem
  características.
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
async function ordenarCarta(vinhos: any[], prato: string, orcamento: number | null, modelos: string[], parent: AbortSignal) {
  const cand = vinhos.map((v, i) => i).filter((i) => cabe(vinhos[i].preco ?? null, orcamento));
  const out = { ordem: null as number[] | null, usage: null as Usage | null, modelo: "", chamadas: 0, erro: "" };
  if (cand.length < 2) { out.ordem = cand; return out; }
  // Um tecto próprio: uma ordem lenta não pode levar a leitura atrás.
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  parent.addEventListener("abort", onAbort);
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    let ligados: any[] = [];
    try { ligados = await ligarComFicha(vinhos, ctrl.signal); } catch (_) { /* ordena-se só com a carta */ }
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

/* ── Ler (em segundo plano) ── */
async function lerCarta(id: number, quem: string, partsImg: unknown[], nFotos: number, prato: string, orcamento: number | null) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROC_TIMEOUT_MS);
  const t0 = Date.now();
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
    // A ordem da lista (ver "A ORDEM DA LISTA"): nunca deita a leitura abaixo.
    const o = vinhos.length && !ctrl.signal.aborted
      ? await ordenarCarta(vinhos, prato, orcamento, modelos, ctrl.signal)
      : { ordem: null, usage: null, modelo: "", chamadas: 0, erro: "" };
    const pediuOrdem = o.chamadas > 0 || !!o.erro;
    await registar("ok", {
      passo: "ler", modelo: g.modelo, fotos: nFotos, vinhos_carta: vinhos.length,
      ordem: o.ordem && pediuOrdem ? "ia" : o.erro ? "falhou" : "carta",
      ...(o.erro ? { ordem_erro: o.erro } : {}), ...(o.modelo ? { modelo_ordem: o.modelo } : {}),
      chamadas_gemini: g.chamadas + o.chamadas,
      ...(somar(g.usage, o.usage) ? { usageMetadata: somar(g.usage, o.usage) } : {}),
      custo_estimado_eur: CUSTO_LEITURA_EUR + (o.chamadas ? CUSTO_ORDEM_EUR : 0), ms: Date.now() - t0,
    }, quem);
    await atualizarCarta(id, quem, vinhos.length
      ? { estado: "lida", vinhos, aviso, ordem: o.ordem && pediuOrdem ? o.ordem : null }
      : { estado: "erro", erro: aviso || "não consegui ler vinhos nesta carta — tenta uma foto mais nítida" });
  } catch (e) {
    const err = e as Error, timeout = err.name === "AbortError";
    await registar("erro", { passo: timeout ? "timeout" : "excecao", erro: String(err.message).slice(0, 300), ms: Date.now() - t0 }, quem);
    await atualizarCarta(id, quem, { estado: "erro",
      erro: timeout ? "o modelo demorou demasiado a ler a carta — tenta outra vez, ou uma foto mais nítida" : (err.message || "erro inesperado") });
  } finally { clearTimeout(timer); }
}

/* ── Recomendar (em segundo plano) ── */
async function recomendarCarta(row: any, quem: string) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  const t0 = Date.now();
  const id = row.id as number;
  try {
    const vinhos: any[] = Array.isArray(row.vinhos) ? row.vinhos : [];
    const orc = row.orcamento != null ? Number(row.orcamento) : null;
    // A linha do catálogo de cada um — a mesma pergunta que a app faz, mas
    // com a ficha (o que o modelo vai ler).
    const ligados = await ligarComFicha(vinhos, ctrl.signal);

    const linhas: string[] = [];
    const conhecidos = new Set<number>();
    const comNota = new Set<number>();
    vinhos.forEach((v, i) => {
      const l = ligados[i];
      if (!cabe(v.preco ?? null, orc) || !l || !sabeAlgo(l.ficha)) return;
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

    if (!linhas.length) {
      await registar("ok", { passo: "recomendar", conhecidos: 0, ms: Date.now() - t0 }, quem);
      await atualizarCarta(id, quem, { rec_estado: "concluido",
        recomendacao: { estado: "sem-conhecidos", sugestoes: [], geradoEm: new Date().toISOString() } });
      return;
    }

    const modelos = await candidatosModelo(ctrl.signal);
    // Ordenar por harmonização E nota é raciocínio a sério: o modelo que lê
    // a carta, com um tecto POSITIVO de pensamento; o lite é a rede.
    const g = await gerar([[modelos[0], 1024], [MODELO_LEVE, 0]], [{ text: promptRecomendacao(linhas, s(row.prato, 200), orc) }], ctrl.signal);
    const j = g.texto ? extrairJson(g.texto) : null;
    if (!j || typeof j !== "object") {
      await registar("erro", { passo: "recomendar", erro: g.erro || "ilegível", modelo: g.modelo || null, ms: Date.now() - t0, ...(g.usage ? { usageMetadata: g.usage } : {}) }, quem);
      await atualizarCarta(id, quem, { rec_estado: "erro", rec_erro: "não consegui fazer a recomendação agora — tenta outra vez" });
      return;
    }

    const ranking: { i: number; razao: string }[] = [];
    for (const x of Array.isArray(j.ranking) ? j.ranking : []) {
      const i = Number(x?.i);
      if (!conhecidos.has(i) || ranking.some((r) => r.i === i)) continue;
      ranking.push({ i, razao: s(x?.razao, 400) });
      if (ranking.length >= MAX_RANKING) break;
    }
    const recs: number[] = [];
    for (const x of Array.isArray(j.recomendados) ? j.recomendados : []) {
      const i = Number(x);
      if (ranking.some((r) => r.i === i) && !recs.includes(i)) recs.push(i);
      if (recs.length >= 3) break;
    }
    if (!recs.length && ranking.length) recs.push(ranking[0].i);
    // A trave em código: dentro dos recomendados, os que têm nota primeiro.
    recs.sort((a, b) => Number(comNota.has(b)) - Number(comNota.has(a)));
    const ordem = [...recs, ...ranking.map((r) => r.i).filter((i) => !recs.includes(i))];
    const sugestoes = ordem.map((i) => ({ i, razao: ranking.find((r) => r.i === i)?.razao ?? "", recomendado: recs.includes(i) }));

    await registar("ok", {
      passo: "recomendar", modelo: g.modelo, conhecidos: conhecidos.size, sugestoes: sugestoes.length,
      prato: s(row.prato, 200), orcamento: orc, chamadas_gemini: g.chamadas,
      ...(g.usage ? { usageMetadata: g.usage } : {}), custo_estimado_eur: CUSTO_RECOMENDACAO_EUR, ms: Date.now() - t0,
    }, quem);
    await atualizarCarta(id, quem, { rec_estado: "concluido", rec_erro: null,
      recomendacao: { estado: sugestoes.length ? "ok" : "nenhum-combina", sugestoes, modelo: g.modelo, geradoEm: new Date().toISOString() } });
  } catch (e) {
    const err = e as Error, timeout = err.name === "AbortError";
    await registar("erro", { passo: "recomendar", erro: String(err.message).slice(0, 300), ms: Date.now() - t0 }, quem);
    await atualizarCarta(id, quem, { rec_estado: "erro",
      rec_erro: timeout ? "a recomendação demorou demasiado — tenta outra vez" : (err.message || "erro inesperado") });
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

    return json({ error: "acção desconhecida" }, 400);
  } catch (e) {
    const err = e as Error;
    await registar("erro", { passo: "excecao_inicial", erro: String(err.message).slice(0, 300) }, quem);
    return json({ error: err.message || "erro inesperado" }, 500);
  } finally { clearTimeout(timer); }
});
