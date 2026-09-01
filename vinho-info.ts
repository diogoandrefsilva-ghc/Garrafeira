// =====================================================================
// Edge Function `vinho-info` — a ficha de um vinho, procurada na net.
//
// Irmã da `calendario-sporting` do Goals e da `fatura-restaurante` do
// SplitBill: mesmo projeto Supabase, mesma descoberta de modelo, mesmos
// fallbacks. As diferenças que interessam:
//   · usa GROUNDING com pesquisa Google (`tools:[{google_search:{}}]`).
//     Sem isso o modelo inventa notas do Vivino e preços de memória — que é
//     precisamente o que não se quer a entrar numa base de dados;
//   · por causa da pesquisa, a API RECUSA `response_mime_type: json`, por
//     isso o JSON vem em texto e é extraído aqui (`extrairJson`);
//   · quem pode chamar é qualquer EDITOR da garrafeira (não só o admin):
//     numa garrafeira de casa quem arruma as garrafas é quem procura.
//     A verificação é do servidor (RPC `garrafeira.is_editor()`), não da UI.
//
// A procura corre em SEGUNDO PLANO por omissão (`assincrono: true`): cria
// uma linha em `garrafeira.analises`, responde já com o `id`, e continua com
// `EdgeRuntime.waitUntil`. O browser/iOS corta um pedido HTTP perto dos 60s
// e esta pesquisa passa disso à vontade — enquanto foi síncrona dava sempre
// "demorou demasiado", por mais tempo que se lhe desse: o tecto não era
// nosso. Sem `assincrono` mantém-se a resposta completa de uma vez.
//
// Secrets do projeto (partilhados por todas as functions):
//   GEMINI_API_KEY · SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY
// Deploy: supabase functions deploy vinho-info
// =====================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GAPI = "https://generativelanguage.googleapis.com/v1beta";

const TIMEOUT_MS = 55_000;        // modo síncrono, preso ao browser
const PROC_TIMEOUT_MS = 110_000;  // segundo plano — já não depende do browser
// Janela curta reservada ao fallback SEM pesquisa, que responde sempre
// depressa por não ter o tool. A tentativa COM pesquisa leva o resto.
const FALLBACK_TENTATIVA_TIMEOUT_MS = 9_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* ── Escolha do modelo ──
   Os nomes dos modelos Gemini mudam com o tempo. Em vez de fixar um,
   pergunta-se à API que modelos a chave tem e ordenam-se os "flash" do
   melhor para o pior; devolve-se a LISTA para se poder cair no seguinte
   quando o preferido falha (404 se foi reformado, 503 se está cheio). */
function comLimiteProprio(sinalPai: AbortSignal, ms: number) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  const propagar = () => c.abort();
  sinalPai.addEventListener("abort", propagar, { once: true });
  return {
    signal: c.signal,
    limpar: () => { clearTimeout(t); sinalPai.removeEventListener("abort", propagar); },
  };
}
let _models: string[] | null = null;
function rankFlash(names: string[]): string[] {
  const ok = [...new Set(names.filter((n) =>
    n.includes("flash") && !/(lite|8b|image|tts|live|audio|embed|exp|preview|thinking)/.test(n)
  ))];
  const score = (n: string): number => {
    if (n === "gemini-flash-latest") return 100;   // apontador sempre atualizado
    const m = n.match(/^gemini-(\d+(?:\.\d+)?)-flash$/);
    return m ? parseFloat(m[1]) : 0;
  };
  return ok.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}
async function descobrirFlash(signal: AbortSignal): Promise<string[]> {
  if (_models) return _models;
  try {
    const names: string[] = [];
    let page = "";
    for (let i = 0; i < 3; i++) {
      // 8s por página: se o ListModels ficar preso cai-se depressa no
      // fallback, em vez de gastar aqui o orçamento todo.
      const { signal: sp, limpar } = comLimiteProprio(signal, 8_000);
      let r: Response;
      try { r = await fetch(`${GAPI}/models?pageSize=200${page ? `&pageToken=${page}` : ""}&key=${GEMINI_KEY}`, { signal: sp }); }
      catch (_) { limpar(); break; }
      limpar();
      if (!r.ok) break;
      const d = await r.json();
      (d.models ?? []).forEach((m: any) => {
        if ((m.supportedGenerationMethods ?? []).includes("generateContent")) {
          names.push(String(m.name).replace(/^models\//, ""));
        }
      });
      page = d.nextPageToken ?? "";
      if (!page) break;
    }
    const ranked = rankFlash(names);
    if (ranked.length) _models = ranked;
  } catch (_) { /* fica o fallback */ }
  return _models ?? [];
}
const ESTAVEIS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"];
async function candidatosModelo(signal: AbortSignal): Promise<string[]> {
  const pinned = Deno.env.get("GEMINI_MODEL");
  const vistos = new Set<string>();
  const lista = [...(pinned ? [pinned] : []), ...ESTAVEIS, ...(await descobrirFlash(signal))]
    .filter((m) => (vistos.has(m) ? false : vistos.add(m)));
  return lista.length ? lista : ["gemini-flash-latest"];
}

/* ── Vocabulário fechado ──
   O que o modelo devolver fora destas listas é deitado fora na
   normalização. Sem isto, cada procura inventava a sua própria maneira de
   dizer a mesma coisa ("tinto", "Vinho Tinto", "red") e os filtros da app,
   que são construídos a partir dos valores gravados, enchiam-se de
   sinónimos da mesma coisa. */
const TIPOS = ["Tinto", "Branco", "Rosé", "Espumante", "Licoroso", "Frisante"];
const ESTILOS = ["", "Maduro", "Verde", "Colheita Tardia", "Palhete"];
const MENCOES = ["", "Reserva", "Grande Reserva", "Garrafeira", "Colheita Selecionada",
  "Vinhas Velhas", "Superior", "Grande Escolha"];
const CLASSIF = ["", "DOC", "Vinho Regional", "Vinho"];

const prompt = (nome: string, ano: number | null, produtor: string, regiao: string, hoje: string) => `
És um enólogo a preencher a ficha de um vinho para a garrafeira de uma casa particular.

VINHO A IDENTIFICAR:
  Nome: ${nome}
${ano ? `  Ano (colheita): ${ano}\n` : ""}${produtor ? `  Produtor indicado: ${produtor}\n` : ""}${regiao ? `  Região indicada: ${regiao}\n` : ""}
Hoje é ${hoje}.

PROCURA na internet e responde com o que ENCONTRARES. Fontes boas: o site do
produtor, Vivino, Wine.com.pt, Garrafeira Nacional, Adegga, revistas de vinho
portuguesas.

REGRAS, e são a sério:
1. NÃO INVENTES. Um campo que não consigas confirmar fica FORA do JSON (ou a
   null). Uma ficha com metade dos campos certos vale mais do que uma cheia
   com metade inventada — quem lê isto vai decidir o que abre ao jantar.
2. A nota do Vivino e o preço têm de vir de uma página que tenhas mesmo
   visto. Se não a viste, não os ponhas.
3. Se houver DÚVIDA entre dois vinhos com nome parecido, escolhe o que bate
   certo com o ano e a região dados, e diz a hesitação no campo "aviso".
4. O preço é o de UMA garrafa de 0,75 L, em EUROS, em Portugal.
5. As castas vão SEPARADAS, uma a uma, com o nome português corrente
   ("Touriga Nacional", "Alicante Bouschet", "Aragonez"). Nunca "blend",
   "lote" nem "várias castas" — isso é contado do lado da app.
6. "beberDe"/"beberAte" são ANOS (ex.: 2026 e 2034), a janela em que o vinho
   está no ponto. Para um vinho para beber já, "beberAte" é daqui a 2-3 anos.

Responde SÓ com este JSON, sem texto à volta e sem blocos de código:
{
  "encontrado": true,
  "produtor": "",
  "ano": ${ano ?? "null"},
  "tipo": "um de: ${TIPOS.join(" | ")}",
  "estilo": "vazio, ou um de: Maduro | Verde | Colheita Tardia | Palhete",
  "regiao": "região vitivinícola (Douro, Alentejo, Bairrada, Dão, Tejo, Península de Setúbal, Vinho Verde, …)",
  "subRegiao": "",
  "mencao": "vazio, ou um de: ${MENCOES.filter(Boolean).join(" | ")}",
  "classificacao": "vazio, ou um de: DOC | Vinho Regional | Vinho",
  "castas": ["Touriga Nacional", "Touriga Franca"],
  "teor": 14.5,
  "estagioMeses": 18,
  "estagioTexto": "18 meses em barrica de carvalho francês",
  "vivinoNota": 4.1,
  "vivinoAvaliacoes": 1234,
  "vivinoUrl": "",
  "precoMedio": 18.5,
  "beberDe": 2026,
  "beberAte": 2034,
  "notasProva": "duas ou três frases sobre aroma, boca e final",
  "harmonizacao": "com que pratos",
  "resumo": "duas ou três frases sobre o vinho e o produtor",
  "aviso": "vazio, ou o que ficou por confirmar"
}

Se não conseguires identificar o vinho de todo, responde
{"encontrado": false, "aviso": "porquê"}.`;

/* Com o tool de pesquisa ligado a API recusa response_mime_type=json, por
   isso a resposta vem em texto: pode trazer blocos ``` e frases à volta.
   Aqui apanha-se o primeiro objeto JSON equilibrado do texto. */
function extrairJson(txt: string): any | null {
  const s = String(txt || "").trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { /* segue */ }
  const limpo = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(limpo); } catch (_) { /* segue */ }
  const ini = limpo.indexOf("{");
  if (ini < 0) return null;
  let nivel = 0, emString = false, escape = false;
  for (let i = ini; i < limpo.length; i++) {
    const c = limpo[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { emString = !emString; continue; }
    if (emString) continue;
    if (c === "{") nivel++;
    else if (c === "}" && --nivel === 0) {
      try { return JSON.parse(limpo.slice(ini, i + 1)); } catch (_) { return null; }
    }
  }
  return null;
}

/* Limpeza do que o modelo devolveu. Tudo o que não passa aqui é deitado
   fora em silêncio — um campo meio lido vale menos do que a confiança de
   quem vai olhar para a ficha. */
const texto = (v: unknown, max: number) =>
  String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
function numero(v: unknown, min: number, max: number, casas = 2): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  if (!isFinite(n) || n < min || n > max) return null;
  return Number(n.toFixed(casas));
}
function anoValido(v: unknown): number | null {
  const n = numero(v, 1900, 2100, 0);
  return n === null ? null : Math.round(n);
}
function daLista(v: unknown, lista: string[]): string {
  const t = texto(v, 40);
  const achado = lista.find((x) => x && x.toLowerCase() === t.toLowerCase());
  return achado ?? "";
}
function normalizar(raw: any, anoPedido: number | null): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.encontrado === false) return null;

  const castas = Array.isArray(raw.castas)
    ? [...new Set(
        raw.castas
          .map((c: unknown) => texto(c, 50))
          // "blend"/"lote"/"várias castas" não são castas — são a CONTAGEM
          // delas, e essa é calculada na app. Deixá-las entrar criava uma
          // casta fantasma que aparecia no filtro ao lado das verdadeiras.
          .filter((c: string) => c && !/^(blend|lote|v[áa]rias|diversas|field blend|castas?)$/i.test(c))
          .map((c: string) => c.replace(/\s*\(\d+%?\)\s*$/, "").trim()),
      )].slice(0, 12)
    : [];

  const beberDe = anoValido(raw.beberDe);
  let beberAte = anoValido(raw.beberAte);
  // Uma janela ao contrário não é informação, é ruído: fica sem fim.
  if (beberDe !== null && beberAte !== null && beberAte < beberDe) beberAte = null;

  const out: Record<string, unknown> = {
    produtor: texto(raw.produtor, 90),
    ano: anoValido(raw.ano) ?? anoPedido,
    tipo: daLista(raw.tipo, TIPOS),
    estilo: daLista(raw.estilo, ESTILOS),
    regiao: texto(raw.regiao, 60),
    sub_regiao: texto(raw.subRegiao, 60),
    mencao: daLista(raw.mencao, MENCOES),
    classificacao: daLista(raw.classificacao, CLASSIF),
    castas,
    teor: numero(raw.teor, 4, 25, 1),
    estagio_meses: (() => { const n = numero(raw.estagioMeses, 0, 400, 0); return n === null ? null : Math.round(n); })(),
    estagio_texto: texto(raw.estagioTexto, 160),
    vivino_nota: numero(raw.vivinoNota, 1, 5, 2),
    vivino_avaliacoes: (() => { const n = numero(raw.vivinoAvaliacoes, 0, 10_000_000, 0); return n === null ? null : Math.round(n); })(),
    vivino_url: /^https?:\/\//i.test(String(raw.vivinoUrl ?? "")) ? texto(raw.vivinoUrl, 300) : "",
    preco_medio: numero(raw.precoMedio, 0.5, 100_000, 2),
    beber_de: beberDe,
    beber_ate: beberAte,
    notas_prova: texto(raw.notasProva, 600),
    harmonizacao: texto(raw.harmonizacao, 300),
    ai_resumo: texto(raw.resumo, 900),
    aviso: texto(raw.aviso, 300),
  };
  // Campos vazios/null saem do objeto: a app decide o que fazer com o que
  // vem, e um `null` explícito ali era indistinguível de "a IA diz que é
  // nulo" — o que apagava dados bons ao aceitar tudo.
  Object.keys(out).forEach((k) => {
    const v = out[k];
    if (v === null || v === "" || (Array.isArray(v) && !v.length)) delete out[k];
  });
  return Object.keys(out).length ? out : null;
}

/* ── Registo (garrafeira.sync_log) ──
   Do lado do browser vê-se sempre a mesma coisa ("HTTP 502"); a causa está
   nesta linha. Nunca deita a resposta abaixo. */
async function registar(estado: string, detalhe: Record<string, unknown>, quem: string | null) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/sync_log`, {
      method: "POST",
      headers: {
        apikey: SB_SRV, Authorization: `Bearer ${SB_SRV}`,
        "Content-Type": "application/json", "Content-Profile": "garrafeira",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ origem: "function", acao: "vinho-info", estado, quem, detalhe }),
    });
    if (!r.ok) console.log("VINHO sync_log falhou:", r.status, (await r.text().catch(() => "")).slice(0, 200));
  } catch (e) { console.log("VINHO sync_log erro:", String((e as Error).message).slice(0, 200)); }
}

/* Cria a linha 'pendente' com o PRÓPRIO JWT de quem carregou — assim a RLS
   corre normalmente e não é preciso confiar em nada que o cliente mande.
   Devolve null se a tabela ainda não existir; nesse caso cai-se no modo
   síncrono em vez de rebentar. */
async function criarAnalise(auth: string, pedido: unknown, vinhoId: number | null, quem: string, signal: AbortSignal) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/analises`, {
      method: "POST",
      headers: {
        apikey: SB_SRV, Authorization: auth, "Content-Type": "application/json",
        "Content-Profile": "garrafeira", Prefer: "return=representation",
      },
      signal,
      body: JSON.stringify({ quem, pedido, vinho_id: vinhoId }),
    });
    if (!r.ok) { console.log("VINHO criar analise:", r.status, (await r.text().catch(() => "")).slice(0, 300)); return null; }
    const id = (await r.json())?.[0]?.id;
    return typeof id === "number" ? id : null;
  } catch (e) { console.log("VINHO criar analise excecao:", String((e as Error).message).slice(0, 200)); return null; }
}
/* Fecha a linha — SERVICE ROLE, porque isto corre em segundo plano, depois
   de o pedido original (e o seu JWT) já ter respondido. O `quem=eq.` no
   WHERE garante que só se mexe na linha do próprio dono, mesmo com uma
   chave que tem acesso a tudo. */
async function fecharAnalise(id: number, quem: string, patch: Record<string, unknown>) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/analises?id=eq.${id}&quem=eq.${encodeURIComponent(quem)}`, {
      method: "PATCH",
      headers: {
        apikey: SB_SRV, Authorization: `Bearer ${SB_SRV}`, "Content-Type": "application/json",
        "Content-Profile": "garrafeira", Prefer: "return=minimal",
      },
      body: JSON.stringify(patch),
    });
    if (!r.ok) console.log("VINHO fechar analise falhou:", r.status);
  } catch (e) { console.log("VINHO fechar analise erro:", String((e as Error).message).slice(0, 200)); }
}

/* Quem pode chamar: qualquer EDITOR da garrafeira. A pergunta é feita à BD
   (RPC `garrafeira.is_editor()`) COM O JWT DE QUEM CHAMOU, e não comparando
   emails aqui — assim a regra vive num sítio só (db/functions.sql) e mudar
   de admin não obriga a redeploy da função. */
async function ehEditor(auth: string, signal: AbortSignal): Promise<{ ok: boolean; email: string | null }> {
  if (!auth) return { ok: false, email: null };
  const u = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_SRV, Authorization: auth }, signal });
  if (!u.ok) { console.log("VINHO /user erro:", u.status); return { ok: false, email: null }; }
  const email = String((await u.json()).email ?? "").toLowerCase();
  if (!email) return { ok: false, email: null };
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/is_editor`, {
      method: "POST",
      headers: {
        apikey: SB_SRV, Authorization: auth, "Content-Type": "application/json",
        "Content-Profile": "garrafeira",
      },
      signal, body: "{}",
    });
    if (!r.ok) { console.log("VINHO is_editor:", r.status, (await r.text().catch(() => "")).slice(0, 200)); return { ok: false, email }; }
    return { ok: (await r.json()) === true, email };
  } catch (e) { console.log("VINHO is_editor excecao:", String((e as Error).message).slice(0, 200)); return { ok: false, email }; }
}

/* ── O TRABALHO A SÉRIO ──
   Toda a conversa com o Gemini num sítio só, para poder correr nos DOIS
   modos: à espera, ou em segundo plano. Nunca escreve na resposta HTTP —
   devolve o corpo final ou o erro já com o status certo. */
type Res = { ok: true; corpo: Record<string, unknown> } | { ok: false; status: number; erro: string };

async function produzirFicha(
  nome: string, ano: number | null, produtor: string, regiao: string,
  quem: string | null, signal: AbortSignal, budgetMs: number,
): Promise<Res> {
  const inicio = Date.now();
  const restante = () => budgetMs - (Date.now() - inicio) - 2_000;
  const searchMs = Math.max(15_000, budgetMs - 14_000);
  const texto0 = prompt(nome, ano, produtor, regiao, new Date().toISOString().slice(0, 10));

  /* Cada variante é a mesma pergunta pedida de outra maneira. A ordem
     depende do ORÇAMENTO: em segundo plano há tempo para o modelo pensar e
     é isso que dá uma leitura boa; no modo síncrono (55s presos ao browser)
     o pensamento não cabe, e aí mais vale uma resposta pobre do que
     nenhuma. Os modelos recentes trazem o "pensamento" LIGADO por omissão e
     com o tool de pesquisa isso é um custo de latência grande. */
  type V = { search: boolean; semThinking: boolean; label: string };
  const pensarCabe = budgetMs >= 90_000;
  const VARIANTES: V[] = pensarCabe
    ? [{ search: true, semThinking: false, label: "pesquisa" },
       { search: true, semThinking: true, label: "pesquisa+sem-pensar" },
       { search: false, semThinking: false, label: "sem-pesquisa" }]
    : [{ search: true, semThinking: true, label: "pesquisa+sem-pensar" },
       { search: true, semThinking: false, label: "pesquisa" },
       { search: false, semThinking: false, label: "sem-pesquisa" }];

  const chamar = (model: string, v: V, sinal: AbortSignal) => {
    const generationConfig: Record<string, unknown> = v.search
      ? { temperature: 0 }
      : { temperature: 0, response_mime_type: "application/json" };
    if (v.semThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    const corpo: Record<string, unknown> = {
      contents: [{ role: "user", parts: [{ text: texto0 }] }], generationConfig,
    };
    if (v.search) corpo.tools = [{ google_search: {} }];
    return fetch(`${GAPI}/models/${model}:generateContent?key=${GEMINI_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: sinal, body: JSON.stringify(corpo),
    });
  };
  const tentar = async (model: string, v: V): Promise<Response | null> => {
    const ms = Math.min(v.search ? searchMs : FALLBACK_TENTATIVA_TIMEOUT_MS, restante());
    if (ms < 2_000) return null;
    const { signal: sinal, limpar } = comLimiteProprio(signal, ms);
    try {
      const r = await chamar(model, v, sinal);
      limpar();
      console.log("VINHO tentativa:", model, v.label, "->", r.status);
      return r;
    } catch (e) {
      limpar();
      if (signal.aborted) throw e;
      console.log("VINHO tentativa presa:", model, v.label);
      return null;
    }
  };
  const transitorio = (s: number) => s === 429 || s === 500 || s === 503;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const candidatos = await candidatosModelo(signal);
  if (signal.aborted) throw new DOMException("timeout", "AbortError");
  let model = candidatos[0] ?? "gemini-flash-latest";
  let comPesquisa = true;
  let g: Response | null = null;

  for (let ci = 0; ci < candidatos.length && !signal.aborted; ci++) {
    model = candidatos[ci];
    // Assim que uma variante responde, fica-se por ela. Não há retry da
    // MESMA variante: uma tentativa que fica presa não fica presa "um
    // bocadinho menos" à segunda, e esse tempo rende mais na seguinte.
    for (const v of VARIANTES) {
      if (signal.aborted || restante() < 2_000) break;
      comPesquisa = v.search;
      g = await tentar(model, v);
      if (!g) continue;
      if (g.status === 400) { console.log("VINHO 400:", (await g.clone().text()).slice(0, 300)); g = null; continue; }
      if (g.status === 404) { _models = null; g = null; break; }          // saiu do catálogo
      if (transitorio(g.status)) { await sleep(700); g = null; break; }   // cheio: outro modelo
      break;
    }
    if (g && g.ok) break;
    if (g && !transitorio(g.status) && g.status !== 404) break;
  }

  if (!g) {
    await registar("erro", { passo: "sem-resposta", nome, modelos: candidatos.length, orcamento_ms: budgetMs }, quem);
    return { ok: false, status: 504, erro: "o modelo não respondeu a tempo — tenta outra vez daqui a pouco" };
  }
  if (!g.ok) {
    const status = g.status, detail = await g.text();
    let msg = ""; try { msg = JSON.parse(detail)?.error?.message ?? ""; } catch (_) { /**/ }
    await registar("erro", { passo: "gemini", status, modelo: model, pesquisa: comPesquisa, erro: (msg || detail).slice(0, 800) }, quem);
    if (transitorio(status)) return { ok: false, status: 503, erro: "o serviço está com muita procura agora — espera um minuto e tenta outra vez" };
    return { ok: false, status: 502, erro: `gemini ${status} (${model})${msg ? ": " + msg.slice(0, 200) : ""}` };
  }

  const gd = await g.json();
  const cand = gd?.candidates?.[0];
  const bruto = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();
  const parsed = extrairJson(bruto);
  if (!parsed) {
    await registar("erro", { passo: "json", modelo: model, pesquisa: comPesquisa, amostra: bruto.slice(0, 800) }, quem);
    return { ok: false, status: 502, erro: "resposta ilegível do modelo" };
  }
  const ficha = normalizar(parsed, ano);
  if (!ficha) {
    await registar("erro", { passo: "vazio", modelo: model, pesquisa: comPesquisa, nome, amostra: bruto.slice(0, 500) }, quem);
    // Sem pesquisa o modelo só conhece o que aprendeu no treino, e um vinho
    // de uma quinta pequena é exatamente o que ele não sabe — devolve vazio
    // em vez de inventar, que é o que se lhe pede. Não é "este vinho não
    // existe": são coisas diferentes e merecem mensagens diferentes.
    return {
      ok: false, status: comPesquisa ? 404 : 503,
      erro: comPesquisa
        ? `não encontrei informação fiável sobre "${nome}". Confere o nome (o do rótulo, com o produtor) e tenta outra vez.`
        : "só consegui responder sem pesquisa na net, e sem ela não conheço este vinho — tenta outra vez daqui a uns minutos",
    };
  }

  // As fontes que o grounding usou — a app mostra-as para se poder conferir.
  const fontes: { titulo: string; url: string }[] = [];
  (cand?.groundingMetadata?.groundingChunks ?? []).forEach((c: any) => {
    const w = c?.web;
    if (w?.uri && !fontes.some((f) => f.url === w.uri)) {
      fontes.push({ titulo: String(w.title ?? w.uri).slice(0, 80), url: String(w.uri) });
    }
  });
  await registar("ok", {
    nome, ano, modelo: model, pesquisa: comPesquisa,
    campos: Object.keys(ficha).length, fontes: fontes.map((f) => f.url).slice(0, 8),
  }, quem);

  return {
    ok: true,
    corpo: { ...ficha, fontes: fontes.slice(0, 8), pesquisa: comPesquisa, modelo: model, geradoEm: new Date().toISOString() },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  const authHeader = req.headers.get("Authorization") ?? "";
  // Criado à entrada e passado a TODOS os fetch (auth, ListModels, Gemini):
  // um único fetch sem este signal chega para deixar a função pendurada sem
  // nunca responder ao browser.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let quem: string | null = null;

  try {
    const auth = await ehEditor(authHeader, ctrl.signal);
    quem = auth.email;
    if (!auth.ok) {
      await registar("erro", { passo: "autorizacao" }, quem);
      return json({ error: "não autorizado — só quem pode editar a garrafeira é que procura" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const nome = String(body?.nome ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (nome.length < 3) {
      await registar("erro", { passo: "nome", recebido: String(body?.nome ?? "").slice(0, 60) }, quem);
      return json({ error: "falta o nome do vinho" }, 400);
    }
    const ano = anoValido(body?.ano);
    const produtor = texto(body?.produtor, 90);
    const regiao = texto(body?.regiao, 60);
    const vinhoId = typeof body?.vinhoId === "number" ? body.vinhoId : null;

    /* ── MODO ASSÍNCRONO ──
       Responde já com o `id` e faz o trabalho depois, com muito mais tempo
       do que um pedido HTTP aguenta. Se a tabela `analises` ainda não
       existir, `criarAnalise` devolve null e cai-se no modo síncrono em vez
       de rebentar. */
    if (body?.assincrono === true) {
      const analiseId = await criarAnalise(authHeader, { nome, ano, produtor, regiao }, vinhoId, quem!, ctrl.signal);
      if (analiseId != null) {
        const dono = quem!;
        // NÃO faz await: o trabalho pesado sobrevive ao pedido original.
        EdgeRuntime.waitUntil((async () => {
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), PROC_TIMEOUT_MS);
          try {
            const res = await produzirFicha(nome, ano, produtor, regiao, dono, c.signal, PROC_TIMEOUT_MS);
            await fecharAnalise(analiseId, dono, res.ok
              ? { estado: "concluido", resultado: res.corpo }
              : { estado: "erro", erro: res.erro });
          } catch (e) {
            const err = e as Error, timeout = err.name === "AbortError";
            await registar("erro", { passo: timeout ? "timeout" : "excecao", erro: String(err.message).slice(0, 500) }, dono);
            await fecharAnalise(analiseId, dono, {
              estado: "erro",
              erro: timeout ? "a procura demorou demasiado — tenta outra vez daqui a pouco" : (err.message || "erro inesperado"),
            });
          } finally { clearTimeout(t); }
        })());
        return json({ id: analiseId, estado: "pendente" }, 202);
      }
      console.log("VINHO sem tabela de análises — cai para o modo síncrono");
    }

    const res = await produzirFicha(nome, ano, produtor, regiao, quem, ctrl.signal, TIMEOUT_MS);
    return res.ok ? json(res.corpo) : json({ error: res.erro }, res.status);
  } catch (e) {
    const err = e as Error, timeout = err.name === "AbortError";
    await registar("erro", { passo: timeout ? "timeout" : "excecao", erro: String(err.message).slice(0, 500) }, quem);
    if (timeout) return json({ error: "a procura demorou demasiado — tenta outra vez daqui a pouco" }, 504);
    return json({ error: err.message }, 500);
  } finally { clearTimeout(timer); }
});
