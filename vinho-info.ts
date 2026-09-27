// =====================================================================
// Edge Function `vinho-info` — a ficha de um vinho, procurada na net.
//
// Irmã da `calendario-sporting` do Goals e da `fatura-restaurante` do
// SplitBill: mesmo projeto Supabase, mesma descoberta de modelo, mesmos
// fallbacks. As diferenças que interessam:
//   · pesquisa externa desacoplada (Search API) e Gemini só para extração JSON;
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
// Esta versão expõe DOIS modos de procura:
//   · com grounding search (Gemini com pesquisa web do próprio modelo);
//   · sem grounding search (pesquisa externa + extração JSON pelo modelo).
// A escolha vem do plano de IA, sem nunca confiar no que o browser pede.
//
// Secrets do projeto (partilhados por todas as functions):
//   GEMINI_API_KEY · SEARCH_API_KEY
//   SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY
// Deploy: supabase functions deploy vinho-info
// =====================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SEARCH_API_KEY = Deno.env.get("SEARCH_API_KEY") ?? "";
const SEARCH_API_URL = Deno.env.get("SEARCH_API_URL") || "https://google.serper.dev/search";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GAPI = "https://generativelanguage.googleapis.com/v1beta";
// PONTEIROS ("-latest"), não nomes fixos: apontam sempre para o que a
// Google tem em produção agora, o mesmo ajuste que já salvou o
// importar-vinhos.ts deste exato problema. "gemini-2.5-flash"/"-flash-lite"
// pararam de responder com 404 ("no longer available to new users") — os
// ponteiros são o que evita repetir este deploy de emergência a cada vez
// que a Google reforma o catálogo. Continuam os dois mais baratos da
// família Flash: trocar de família por causa disto seria resolver uma
// disponibilidade com mais custo, que não é a troca que se quer.
const MODELO_BARATO = Deno.env.get("GEMINI_CHEAP_MODEL") || "gemini-flash-lite-latest";
const MODELO_ESCALADO = Deno.env.get("GEMINI_FALLBACK_MODEL") || Deno.env.get("GEMINI_MODEL") || "gemini-flash-latest";
const CACHE_TTL_HORAS = Math.max(1, Math.min(24 * 90, Number(Deno.env.get("VINHO_CACHE_TTL_HOURS") ?? 24 * 30) || 24 * 30));
const CACHE_VERSAO = "v4"; // v4 (27/09/2026): as duas notas do Vivino (colheita e todas) · v3: o pacote completo passou a Serper + grounding
const SEARCH_RESULTADOS = 5;

const TIMEOUT_MS = 55_000;        // modo síncrono, preso ao browser
const PROC_TIMEOUT_MS = 110_000;  // segundo plano — já não depende do browser
const GEMINI_TIMEOUT_MS = 28_000;
// Um prompt de lote (vários vinhos, grounding) é bem maior do que o de um
// vinho só — mais teto por tentativa, sempre dentro do que sobra do
// PROC_TIMEOUT_MS (o `run()` já respeita o que resta, isto só sobe o TETO).
const GEMINI_TIMEOUT_MS_LOTE = 50_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
type Fonte = { titulo: string; url: string };
type PesquisaWeb = { texto: string; fontes: Fonte[]; status: string };
type CacheItem = { resultado: Record<string, unknown>; fontes: Fonte[]; modelo: string; modo: string; expira_em: string; id?: number };
type UsageMetadata = { promptTokenCount: number; candidatesTokenCount: number; thoughtsTokenCount: number; totalTokenCount: number };

function usageMetadata(raw: any): UsageMetadata | null {
  const toInt = (v: unknown) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  };
  const src = raw?.usageMetadata;
  if (!src || typeof src !== "object") return null;
  const out = {
    promptTokenCount: toInt(src.promptTokenCount),
    candidatesTokenCount: toInt(src.candidatesTokenCount),
    thoughtsTokenCount: toInt(src.thoughtsTokenCount),
    totalTokenCount: toInt(src.totalTokenCount),
  };
  return (out.promptTokenCount || out.candidatesTokenCount || out.totalTokenCount) ? out : null;
}
function somarUsage(total: UsageMetadata | null, add: UsageMetadata | null): UsageMetadata | null {
  if (!add) return total;
  if (!total) return { ...add };
  return {
    promptTokenCount: total.promptTokenCount + add.promptTokenCount,
    candidatesTokenCount: total.candidatesTokenCount + add.candidatesTokenCount,
    thoughtsTokenCount: total.thoughtsTokenCount + add.thoughtsTokenCount,
    totalTokenCount: total.totalTokenCount + add.totalTokenCount,
  };
}

function semAcentos(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function chaveCache(
  modo: "gratis" | "premium", nome: string, ano: number | null, produtor: string, regiao: string,
  tipo: string, notas: string, sites: string[],
  campos: string[] | null, colheitaEspecifica: boolean,
): string {
  const camposTag = campos?.length ? [...campos].sort().join(",") : "*";
  // `tipo`/`notas`/`sites` entram na chave pela mesma razão que `campos` e
  // `colheitaEspecifica` já entravam: mudam o TEXTO do prompt (ou a
  // pesquisa) — duas procuras com contexto diferente não podem partilhar
  // cache, mesmo que o resto seja igual.
  const sitesTag = sites.length
    ? [...sites].map((s) => s.toLowerCase()).sort().join(",") : "";
  return [
    CACHE_VERSAO,
    modo,
    semAcentos(nome.toLowerCase()).replace(/[^a-z0-9]+/g, " ").trim(),
    ano ?? "",
    semAcentos(produtor.toLowerCase()).replace(/[^a-z0-9]+/g, " ").trim(),
    semAcentos(regiao.toLowerCase()).replace(/[^a-z0-9]+/g, " ").trim(),
    semAcentos(tipo.toLowerCase()),
    semAcentos(notas.toLowerCase()).replace(/[^a-z0-9]+/g, " ").trim(),
    sitesTag,
    camposTag,
    // Entra na chave porque muda o TEXTO do prompt (a regra do Vivino) —
    // duas pesquisas iguais em tudo menos nisto não podem partilhar cache.
    colheitaEspecifica ? "colheita" : "geral",
  ].join("|");
}
function milisIso(ms: number) {
  return new Date(ms).toISOString();
}
async function cacheLer(chave: string, signal: AbortSignal): Promise<CacheItem | null> {
  try {
    const agora = encodeURIComponent(new Date().toISOString());
    const r = await fetch(
      `${SB_URL}/rest/v1/catalogo_vinhos_cache?select=id,resultado,fontes,modelo,modo,expira_em&chave=eq.${encodeURIComponent(chave)}&expira_em=gt.${agora}&limit=1`,
      { headers: { apikey: SB_SRV, Authorization: 'Bearer '+SB_SRV, "Content-Profile": "garrafeira" }, signal },
    );
    if (!r.ok) return null;
    const row = (await r.json())?.[0];
    if (!row?.resultado || typeof row.resultado !== "object") return null;
    return {
      id: row.id,
      resultado: row.resultado,
      fontes: Array.isArray(row.fontes) ? row.fontes.slice(0, 8) : [],
      modelo: String(row.modelo || ""),
      modo: String(row.modo || "cache"),
      expira_em: String(row.expira_em || ""),
    };
  } catch (_) { return null; }
}
async function cacheEscrever(
  chave: string, pedido: Record<string, unknown>, resultado: Record<string, unknown>,
  fontes: Fonte[], modelo: string, modo: string, signal: AbortSignal,
) {
  try {
    const now = Date.now();
    await fetch(`${SB_URL}/rest/v1/catalogo_vinhos_cache?on_conflict=chave`, {
      method: "POST",
      headers: {
        apikey: SB_SRV, Authorization: 'Bearer '+SB_SRV, "Content-Type": "application/json", "Content-Profile": "garrafeira",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify([{
        chave, pedido, resultado, fontes: fontes.slice(0, 8), modelo, modo,
        atualizado_em: milisIso(now), expira_em: milisIso(now + CACHE_TTL_HORAS * 3600 * 1000),
      }]),
      signal,
    });
  } catch (_) { /* não falha a resposta por causa da cache */ }
}
/* ── CATÁLOGO PARTILHADO (schema `winecatalog`) ──
   A memória comum das duas apps de vinhos. Antes de pagar uma pesquisa,
   pergunta-se aqui se alguém já a fez — nesta app ou na WineSelection — ou
   se alguém já tem esta garrafa em casa com a ficha preenchida.

   Duas coisas que não são detalhe:
   · a CHAVE (o que faz dois vinhos serem o mesmo vinho) vive só no SQL.
     Daqui vai o nome, o produtor e o ano em cru; quem decide é
     `winecatalog.procurar`. Repetir esse algoritmo aqui era garantir que um
     dia divergia do da outra app e o catálogo se partia em dois em
     silêncio;
   · nada disto pode deitar uma procura abaixo. O catálogo é uma poupança,
     não uma dependência: se o RPC falhar, segue-se para a IA como sempre
     se fez. Daí o try/catch a engolir tudo. */
const CATALOGO_IDADE_DIAS = Math.max(1, Math.round(CACHE_TTL_HORAS / 24));

type Conhecido = {
  nome: string; produtor: string; ano: number | null;
  ficha: Record<string, unknown>; fontes: Fonte[];
  exato: boolean; mesmoAno: boolean | null; atualizadoEm: string;
};

async function catalogoRpc(fn: string, corpo: Record<string, unknown>, signal: AbortSignal): Promise<any> {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SB_SRV, Authorization: "Bearer " + SB_SRV,
      "Content-Type": "application/json",
      "Content-Profile": "winecatalog", "Accept-Profile": "winecatalog",
    },
    body: JSON.stringify(corpo),
    signal,
  });
  if (!r.ok) throw new Error(`winecatalog ${fn} ${r.status}`);
  return await r.json();
}

async function catalogoProcurar(
  nome: string, produtor: string, ano: number | null, signal: AbortSignal, tipo = "",
): Promise<Conhecido | null> {
  try {
    // A cor é parte da identidade (fase 4 dos nomes): o branco nunca
    // responde pelo tinto. Sem ela, é o coringa do catálogo.
    const d = await catalogoRpc("procurar", {
      p_nome: nome, p_produtor: produtor || "", p_ano: ano,
      p_idade_dias: CATALOGO_IDADE_DIAS, p_cor: tipo || null,
    }, signal);
    if (!d || typeof d !== "object" || !d.ficha) return null;
    return {
      nome: String(d.nome || ""), produtor: String(d.produtor || ""),
      ano: typeof d.ano === "number" ? d.ano : null,
      ficha: (d.ficha && typeof d.ficha === "object") ? d.ficha : {},
      fontes: Array.isArray(d.fontes) ? d.fontes.slice(0, 8) : [],
      exato: d.exato === true,
      mesmoAno: d.mesmoAno === null || d.mesmoAno === undefined ? null : d.mesmoAno === true,
      atualizadoEm: String(d.atualizadoEm || ""),
    };
  } catch (_) { return null; }
}

async function catalogoJuntar(
  nome: string, produtor: string, ano: number | null,
  ficha: Record<string, unknown>, origem: string, fontes: Fonte[], signal: AbortSignal,
) {
  try {
    if (!Object.keys(ficha).length) return;
    await catalogoRpc("juntar", {
      p_nome: nome, p_produtor: produtor || "", p_ano: ano,
      p_ficha: ficha, p_origem: origem, p_fontes: fontes.slice(0, 8),
    }, signal);
  } catch (_) { /* o catálogo nunca falha uma gravação da app */ }
}

function extrairHost(url: string) {
  try { return new URL(url).hostname; } catch (_) { return ""; }
}
/* OS SITES DE CONFIANÇA (27/09/2026). Até aqui entravam como
   ` (site:a OR site:b)` colados à consulta GERAL — o que não dava
   prioridade nenhuma: RESTRINGIA a consulta a eles (se não tivessem o
   vinho, a consulta geral voltava vazia), e um nome escrito sem domínio
   ("Garrafeira Nacional") partia a consulta toda. E nada dizia, no fim, se
   algum resultado tinha vindo deles. Agora: a consulta geral é sempre
   livre; os domínios a sério (sem o Vivino, que tem a consulta própria)
   têm uma consulta SÓ deles, a mais; os resultados deles vão à frente,
   marcados, na base de evidência; e o resultado diz quantos vieram de cada
   um (`confianca`). Um nome sem domínio fica só no texto do prompt. A
   MESMA regra da `catalogo-info` (WineCatalog). */
function dominioDe(s: string): string {
  const d = s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : "";
}
function doSite(url: string, dominio: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === dominio || h.endsWith("." + dominio);
  } catch { return false; }
}
/* De que colheita são os números de um resultado do Vivino: sem `year=`
   no endereço são os de TODAS as colheitas; com o nosso ano, os da
   colheita; com outro ano, não servem. A regra do motor Serper do script. */
function vivinoDeQue(url: string, ano: number | null): string {
  try {
    const u = new URL(url);
    if (!/(^|\.)vivino\.com$/i.test(u.hostname)) return "";
    const y = Number(u.searchParams.get("year"));
    if (!y) return "página do Vivino SEM ano escolhido: a nota e as avaliações são as de TODAS as colheitas (vivinoNotaGlobal/vivinoAvaliacoesGlobal)";
    if (ano !== null && y === ano) return `página do Vivino da colheita ${y}: a nota e as avaliações são as DESTA colheita (vivinoNota/vivinoAvaliacoes)`;
    return `página do Vivino da colheita ${y}, que NÃO é a nossa: não uses a nota nem as avaliações daqui`;
  } catch { return ""; }
}
async function obterResultadosPesquisa(query: string, signal: AbortSignal,
  ano: number | null = null, dominios: string[] = []): Promise<PesquisaWeb> {
  if (!SEARCH_API_KEY) throw new Error("a pesquisa externa não está configurada: falta SEARCH_API_KEY");
  const { signal: ss, limpar } = comLimiteProprio(signal, 12_000);
  try {
    const r = await fetch(SEARCH_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": SEARCH_API_KEY },
      body: JSON.stringify({ q: query, gl: "pt", hl: "pt", num: SEARCH_RESULTADOS }),
      signal: ss,
    });
    limpar();
    if (!r.ok) throw new Error(`pesquisa externa ${r.status}`);
    const d = await r.json();
    const rows = Array.isArray(d?.organic) ? d.organic : [];
    const fontes: Fonte[] = rows.slice(0, SEARCH_RESULTADOS).map((x: any) => ({
      titulo: String(x?.title || x?.link || "").slice(0, 120),
      url: String(x?.link || "").slice(0, 400),
    })).filter((x: Fonte) => /^https?:\/\//i.test(x.url));
    if (!fontes.length) throw new Error("pesquisa externa sem resultados");
    const texto = rows.slice(0, SEARCH_RESULTADOS).map((x: any, i: number) => {
      const title = String(x?.title || "").trim();
      const snip = String(x?.snippet || "").replace(/\s+/g, " ").trim();
      const link = String(x?.link || "").trim();
      const conf = dominios.some((d) => doSite(link, d)) ? " ★ FONTE DE CONFIANÇA" : "";
      const viv = vivinoDeQue(link, ano);
      return `[${i + 1}]${conf} ${title}\nURL: ${link}\n` + (viv ? `(${viv})\n` : "") + `Resumo: ${snip}` + (x?.rating != null ? `\nEstrelas no Google: ${x.rating}${x.ratingCount != null ? ` (${x.ratingCount} avaliações)` : ""}` : "");
    }).join("\n\n");
    const estado = `search-api:${extrairHost(SEARCH_API_URL) || "externa"}`;
    return { texto: texto.slice(0, 6000), fontes, status: estado };
  } catch (e) {
    limpar();
    throw e;
  }
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

/* Os campos que a app pode pedir à letra (`campos` no corpo do pedido),
   com o nome que têm no JSON da resposta. Serve para duas coisas: escrever
   no prompt o que é que interessa procurar, e cortar da resposta o que não
   foi pedido. Pedir os 22 de uma vez faz o modelo andar atrás de tudo e
   voltar com meia dúzia de coisas mornas — pedir três dá três boas. */
const CAMPOS: Record<string, string> = {
  produtor: "produtor", ano: "ano", tipo: "tipo", estilo: "estilo",
  regiao: "regiao", sub_regiao: "subRegiao", mencao: "mencao",
  classificacao: "classificacao", castas: "castas", teor: "teor",
  estagio_meses: "estagioMeses", estagio_texto: "estagioTexto",
  vivino_nota: "vivinoNota", vivino_avaliacoes: "vivinoAvaliacoes",
  // A nota de TODAS as colheitas (26/09/2026, migração vivino-global): até
  // 27/09/2026 a pesquisa não a conhecia, e a média que o Vivino mostra sem
  // ano ia parar à `vivino_nota`, que é a da COLHEITA (ver `regraVivino`).
  vivino_nota_global: "vivinoNotaGlobal", vivino_avaliacoes_global: "vivinoAvaliacoesGlobal",
  vivino_url: "vivinoUrl", imagem_url: "imagemUrl", preco_medio: "precoMedio",
  beber_de: "beberDe", beber_ate: "beberAte", notas_prova: "notasProva",
  harmonizacao: "harmonizacao", ai_resumo: "resumo",
};

/* Pedir a nota da colheita é pedir também a de todas: vêm da mesma página,
   e é quase sempre a única que o modelo vê. Sem colheita, a da colheita não
   existe — pede-se só a de todas. A MESMA regra da `catalogo-info`
   (WineCatalog) e do script do Vivino. */
const PAR_VIVINO: Record<string, string> = {
  vivino_nota: "vivino_nota_global", vivino_avaliacoes: "vivino_avaliacoes_global",
};
function camposComGlobal(campos: string[] | null, ano: number | null): string[] | null {
  if (!campos) return campos;
  const out = new Set<string>();
  for (const k of campos) {
    if (k in PAR_VIVINO) {
      out.add(PAR_VIVINO[k]);
      if (ano !== null) out.add(k);
    } else out.add(k);
  }
  return [...out];
}

/* ── A REGRA DO VIVINO: a página é do vinho, as notas são DUAS ──
   A página do Vivino é do VINHO, não da colheita: não muda de identidade
   com o ano. Exigir "produtor, ano e região a bater certo" para a aceitar
   tinha o modelo a encontrar a página certa e a recusá-la na mesma
   (Villa Platanus 2022: com a exigência do ano, nota/avaliações/link vinham
   sempre vazios; sem ela, vieram certos em três tentativas seguidas).

   Mas as NOTAS são duas desde 26/09/2026 (`migracao-vivino-global.sql`): a
   de todas as colheitas (a página sem ano) e a de UMA (`?year=`). Até
   27/09/2026 esta regra dizia ao modelo que "a nota que lá aparece é uma
   média entre colheitas" e pedia-a na `vivinoNota` — que é a da COLHEITA.
   O visto "tem de ser esta colheita" (`colheitaEspecifica`) deixou de ser
   sobre o Vivino (as duas notas já vêm separadas) e passou a ser sobre o
   resto da ficha (`regraColheita`).

   `ano` undefined é o LOTE, onde cada vinho traz (ou não) o seu ano na
   lista. A MESMA regra está na `catalogo-info` (WineCatalog) e no `app.js`
   (`iaManualRegraVivino`, para os prompts manuais) — mexer numa é mexer
   nas outras. */
const regraVivino = (ano: number | null | undefined) => `O Vivino tem DUAS notas, e não se misturam:
   · "vivinoNotaGlobal"/"vivinoAvaliacoesGlobal" — a de TODAS as colheitas: a
     que a página do vinho mostra sem ano escolhido (…/w/<nº>, sem "?year=").
${ano === undefined
  ? `   · "vivinoNota"/"vivinoAvaliacoes" — SÓ a da colheita indicada na lista (a
     página com "?year=<ano>", ou a dessa colheita na lista de colheitas); um
     vinho SEM ano na lista não as tem, fica só com a de todas. Se só vires a de
     todas as colheitas, deixa estas duas vazias — nunca copies a de todas para aqui.`
  : ano
  ? `   · "vivinoNota"/"vivinoAvaliacoes" — SÓ a da colheita ${ano}: a da página com
     "?year=${ano}", ou a dessa colheita na lista de colheitas. Se só vires a de
     todas as colheitas, deixa estas duas vazias — nunca copies a de todas para aqui.`
  : `   · "vivinoNota"/"vivinoAvaliacoes" ficam de fora: este vinho não tem colheita, e
     a única nota que serve é a de todas as colheitas.`}
   A nota é o número entre 1.0 e 5.0 ao lado das estrelas; as avaliações vêm logo
   a seguir, entre parêntesis — não uses números de outra zona da página. Uma
   colheita nunca tem mais avaliações do que o vinho todo.
   "vivinoUrl" é a página do VINHO (…/<nome>/w/<nº>), a mesma para todas as
   colheitas: o ano não faz parte da identidade dela — basta o nome (já
   desambiguado na regra anterior) e o produtor baterem certo. Mantém o link se
   tiveres a certeza da página, mesmo sem nota.`;
/* "Tem de ser exatamente a colheita X" (o visto no ecrã). */
const regraColheita = (ano: number) => `O que responderes tem de ser da colheita ${ano}: teor, estágio, preço, notas de
   prova e janela de uma colheita diferente ficam fora do JSON.`;
/* Villa Platanus voltou a mostrar isto nos testes: o mesmo produtor tinha
   "Reserva" e "Terroir Blend" — o modelo tem de saber que "escolher a
   cuvée errada" é um erro tão real como "não encontrar nada". */
const regraCuvee = `Se o produtor tiver mais do que um vinho com este nome
   (variantes de gama: Reserva, Grande Reserva, Colheita, Terroir, etc.) e
   não se souber qual, prefere a versão SEM qualificador extra; se essa não
   existir, escolhe a que tiver mais avaliações no Vivino (a principal da
   gama, normalmente tem mais do que uma edição especial) e diz no "aviso"
   que outras versões encontraste e qual escolheste.`;

const prompt = (
  nome: string, ano: number | null, produtor: string, regiao: string, tipo: string, notas: string, hoje: string,
  campos: string[] | null, textosPesquisa: string, colheitaEspecifica: boolean, sites: string[] = [], soSites = false,
) => `
És um enólogo a preencher a ficha de um vinho para a garrafeira de uma casa particular.

VINHO A IDENTIFICAR:
  Nome: ${nome}
${ano ? `  Ano (colheita): ${ano}\n` : ""}${produtor ? `  Produtor indicado: ${produtor}\n` : ""}${regiao ? `  Região indicada: ${regiao}\n` : ""}${tipo ? `  Cor: ${tipo}\n` : ""}${notas ? `  Notas de quem procura: ${notas}\n` : ""}
Hoje é ${hoje}.
${campos && campos.length ? `
SÓ INTERESSAM ESTES CAMPOS: ${campos.map((k) => CAMPOS[k]).join(", ")}.
Concentra a pesquisa NELES. Os outros campos do JSON deixa-os fora da
resposta — não vale a pena gastar procura com o que já está preenchido do
lado de cá.
` : ""}
${soSites ? `
SÓ ESTES SITES: quem procura quer APENAS o que dizem ${sites.join(", ")} — a base de
evidência abaixo é só deles. Não completes com o que sabes nem com mais nada: o que
estas páginas e resultados não disserem fica fora do JSON.
` : sites.length ? `
FONTES DE CONFIANÇA: dá prioridade a informação vinda de ${sites.join(", ")}. Só uses outra fonte se estas não tiverem a resposta. Na base de evidência, as páginas destes sites vêm primeiro, e os resultados deles vêm marcados com ★ FONTE DE CONFIANÇA.
` : ""}
BASE DE EVIDÊNCIA (páginas abertas e trechos de pesquisa web já recolhidos):
${textosPesquisa}

REGRAS, e são a sério:
1. RESPONDE APENAS COM BASE NA BASE DE EVIDÊNCIA acima. Não procures na net.
2. NÃO INVENTES. Um campo que não consigas confirmar fica FORA do JSON (ou a
   null). Uma ficha com metade dos campos certos vale mais do que uma cheia
   com metade inventada — quem lê isto vai decidir o que abre ao jantar.
3. ${regraCuvee}
4. ${regraVivino(ano)}
5. Se houver DÚVIDA entre dois vinhos com nome parecido, escolhe o que bate
   certo com o ano e a região dados, e diz a hesitação no campo "aviso".
6. O preço é o de UMA garrafa de 0,75 L, em EUROS, em Portugal.
7. As castas vão SEPARADAS, uma a uma, com o nome português corrente
   ("Touriga Nacional", "Alicante Bouschet", "Aragonez"). Nunca "blend",
   "lote" nem "várias castas" — isso é contado do lado da app.
8. ${ano ? `"beberDe"/"beberAte" são ANOS (ex.: 2026 e 2034), a janela em que ESTA
   colheita está no ponto. Para um vinho para beber já, "beberAte" é daqui a 2-3 anos.` : `Este vinho não tem ano: sem colheita NÃO há janela de consumo — deixa
   "beberDe"/"beberAte" de fora.`}
9. "imagemUrl" é o link DIRECTO de uma fotografia da garrafa ou do rótulo
   (termina em .jpg/.jpeg/.png/.webp), de uma página que tenhas mesmo visto —
   site do produtor ou de uma loja. Não é o link da página, é o da imagem. Se
   não tiveres a certeza, deixa vazio: uma imagem errada é pior do que nenhuma,
   porque quem olha para a ficha fica a pensar que é aquele o vinho.
${colheitaEspecifica && ano ? `10. ${regraColheita(ano)}
` : ""}${colheitaEspecifica && ano ? 11 : 10}. Uma PÁGINA ABERTA de OUTRO vinho (outro nome, outra gama, outra cor) não
   serve: ignora-a. O preço de uma página é o do produto DELA (o de "DADOS DO
   PRODUTO", se houver), nunca o de produtos relacionados ou sugeridos, nem o de
   uma caixa ou de uma garrafa grande. A avaliação dos clientes de uma loja NÃO é
   a nota do Vivino.
${colheitaEspecifica && ano ? 12 : 11}. "deOnde" diz, para CADA campo que preencheres, o número [n] da página ou do
   resultado de onde o tiraste — ex.: "castas": 1, "precoMedio": 3.${soSites ? " Um campo sem número em \"deOnde\" é deitado fora." : ""}

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
${ano ? `  "vivinoNota": 4.2,
  "vivinoAvaliacoes": 312,
` : ""}  "vivinoNotaGlobal": 4.1,
  "vivinoAvaliacoesGlobal": 5234,
  "vivinoUrl": "",
  "imagemUrl": "",
  "precoMedio": 18.5,
${ano ? `  "beberDe": 2026,
  "beberAte": 2034,
` : ""}  "notasProva": "duas ou três frases sobre aroma, boca e final",
  "harmonizacao": "com que pratos",
  "resumo": "duas ou três frases sobre o vinho e o produtor",
  "deOnde": {"castas": 1, "teor": 1, "precoMedio": 2},
  "aviso": "vazio, ou o que ficou por confirmar"
}

Se não conseguires identificar o vinho de todo, responde
{"encontrado": false, "aviso": "porquê"}.`;

const promptComGrounding = (
  nome: string, ano: number | null, produtor: string, regiao: string, tipo: string, notas: string, sites: string[],
  hoje: string, campos: string[] | null, colheitaEspecifica: boolean,
) => `
És um enólogo a preencher a ficha de um vinho para a garrafeira de uma casa particular.
Usa pesquisa web (grounding search) para confirmar os dados.

VINHO A IDENTIFICAR:
  Nome: ${nome}
${ano ? `  Ano (colheita): ${ano}\n` : ""}${produtor ? `  Produtor indicado: ${produtor}\n` : ""}${regiao ? `  Região indicada: ${regiao}\n` : ""}${tipo ? `  Cor: ${tipo}\n` : ""}${notas ? `  Notas de quem procura: ${notas}\n` : ""}
Hoje é ${hoje}.
${campos && campos.length ? `
SÓ INTERESSAM ESTES CAMPOS: ${campos.map((k) => CAMPOS[k]).join(", ")}.
Concentra a pesquisa NELES e deixa os outros fora da resposta.
` : ""}
${sites.length ? `
FONTES DE CONFIANÇA: dá prioridade a informação vinda de ${sites.join(", ")}. Só uses outra fonte se estas não tiverem a resposta.
` : ""}
REGRAS:
1. NÃO INVENTES. Campo sem confirmação fica fora do JSON (ou null).
2. ${regraCuvee}
3. ${regraVivino(ano)}
4. "imagemUrl" tem de ser link DIRETO de imagem (.jpg/.jpeg/.png/.webp/.avif), não link de página.
5. Se houver dúvida de homónimo, prioriza ano + produtor + região e explica no "aviso".
6. Castas separadas por nome (nunca "blend"/"lote"/"várias castas").
7. ${ano ? `"beberDe"/"beberAte" são anos (a janela DESTA colheita).` : `Este vinho não tem ano: sem colheita NÃO há janela de consumo — deixa "beberDe"/"beberAte" de fora.`}
${colheitaEspecifica && ano ? `8. ${regraColheita(ano)}
` : ""}
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
${ano ? `  "vivinoNota": 4.2,
  "vivinoAvaliacoes": 312,
` : ""}  "vivinoNotaGlobal": 4.1,
  "vivinoAvaliacoesGlobal": 5234,
  "vivinoUrl": "",
  "imagemUrl": "",
  "precoMedio": 18.5,
${ano ? `  "beberDe": 2026,
  "beberAte": 2034,
` : ""}  "notasProva": "duas ou três frases sobre aroma, boca e final",
  "harmonizacao": "com que pratos",
  "resumo": "duas ou três frases sobre o vinho e o produtor",
  "aviso": "vazio, ou o que ficou por confirmar"
}

Se não conseguires identificar o vinho de todo, responde
{"encontrado": false, "aviso": "porquê"}.`;

/* ── LOTE: vários vinhos, UMA chamada ──
   A app já tinha a pesquisa manual em lote (colar a resposta de um
   assistente à parte, um prompt só para até 10 vinhos) — a automática, tal
   como nasceu, continuava a fazer uma chamada por vinho: pedir 5 vinhos
   pagava 5 pesquisas, quando a manual já mostrava que dava para pedir tudo
   de uma vez. Isto é a MESMA ideia, com o Gemini a pesquisar por nós numa
   única chamada com grounding, em vez de N.

   A resposta usa o mesmo formato `resultados: [{id, encontrado, ...}]` que
   a pesquisa manual em lote já produz no browser (`loteManualPrompt`) — não
   é coincidência: é o que deixa o cliente tratar as duas fontes (Gemini
   automático, ou colado à mão) pelo MESMO caminho depois de recebidas. */
const LOTE_MAX_VINHOS = 10;

type VinhoLote = { id: number; nome: string; ano: number | null; produtor: string; regiao: string; tipo: string };

// Os mesmos exemplos do template de um vinho só (linhas do JSON acima),
// só que por campo em vez de fixos num objeto — para poder listar só os
// pedidos, tal como o prompt de um vinho só já corta o que não foi pedido.
const CAMPO_EXEMPLO: Record<string, string> = {
  produtor: '""', ano: "null",
  tipo: `"um de: ${TIPOS.join(" | ")}"`,
  estilo: `"vazio, ou um de: ${ESTILOS.filter(Boolean).join(" | ")}"`,
  regiao: '"região vitivinícola"', sub_regiao: '""',
  mencao: `"vazio, ou um de: ${MENCOES.filter(Boolean).join(" | ")}"`,
  classificacao: `"vazio, ou um de: ${CLASSIF.filter(Boolean).join(" | ")}"`,
  castas: '["Touriga Nacional", "Touriga Franca"]',
  teor: "14.5", estagio_meses: "18", estagio_texto: '"18 meses em barrica de carvalho francês"',
  vivino_nota: "4.2", vivino_avaliacoes: "312",
  vivino_nota_global: "4.1", vivino_avaliacoes_global: "5234", vivino_url: '""', imagem_url: '""',
  preco_medio: "18.5", beber_de: "2026", beber_ate: "2034",
  notas_prova: '"duas ou três frases sobre aroma, boca e final"',
  harmonizacao: '"com que pratos"', ai_resumo: '"duas ou três frases sobre o vinho e o produtor"',
};

const promptLoteComGrounding = (vinhos: VinhoLote[], campos: string[], hoje: string) => `
És um enólogo a preencher a ficha de vários vinhos para a garrafeira de uma casa particular.
Usa pesquisa web (grounding search) para confirmar os dados — vinho a vinho, mas todos na mesma resposta.

Hoje é ${hoje}.
CAMPOS A PEDIR (só estes, para todos os vinhos): ${campos.map((k) => CAMPOS[k]).join(", ")}.

VINHOS A IDENTIFICAR:
${vinhos.map((v) =>
  `- id: ${v.id} | nome: ${v.nome}${v.produtor ? ` | produtor: ${v.produtor}` : ""}${v.ano ? ` | ano: ${v.ano}` : ""}${v.regiao ? ` | região: ${v.regiao}` : ""}${v.tipo ? ` | cor: ${v.tipo}` : ""}`
).join("\n")}

REGRAS, e são a sério:
1. NÃO INVENTES. Um campo que não confirmes por pesquisa fica FORA do objeto desse vinho (ou null).
2. ${regraCuvee}
3. ${regraVivino(undefined)}
4. "imagemUrl" tem de ser link DIRETO de imagem (.jpg/.jpeg/.png/.webp/.avif), nunca o link da página.
5. Se houver dúvida de homónimo, prioriza produtor + ano + região e explica no "aviso".
6. Castas separadas por nome (nunca "blend"/"lote"/"várias castas").
7. "beberDe"/"beberAte" são anos, a janela da colheita indicada. Um vinho SEM ano na lista não tem janela de consumo: deixa "beberDe"/"beberAte" de fora do objeto dele.
8. O "id" de cada resultado tem de ser EXATAMENTE o "id" da lista acima — é assim que se sabe a que vinho corresponde cada objeto, nunca pela posição na lista.
9. Se não conseguires identificar um vinho de todo, o objeto dele fica só {"id": <id>, "encontrado": false, "aviso": "porquê"} — sem inventar os outros campos.

Responde SÓ com este JSON, sem texto à volta e sem blocos de código, com exatamente ${vinhos.length} objeto${vinhos.length > 1 ? "s" : ""} em "resultados" (um por vinho, pela mesma ordem):
{
  "resultados": [
    {
      "id": ${vinhos[0]?.id ?? 0},
      "encontrado": true,
      ${campos.map((k) => `"${CAMPOS[k]}": ${CAMPO_EXEMPLO[k] ?? "null"}`).join(",\n      ")},
      "aviso": "vazio, ou o que ficou por confirmar"
    }
  ]
}`;

// Espelho do `prompt` (sem grounding) de um vinho só, para o modo `gratis`:
// aqui a pesquisa externa corre à mesma UMA VEZ POR VINHO (cada um precisa da
// sua própria pesquisa Google), mas o Gemini só é chamado UMA VEZ no fim,
// para ler as evidências de todos e extrair o JSON de todos — é aí que está
// a poupança desta função, mesmo neste motor.
const promptLote = (vinhos: (VinhoLote & { evidencia: string })[], campos: string[], hoje: string) => `
Ajuda a preencher a ficha de vários vinhos para a garrafeira de uma casa particular, um enólogo a ler o que
já se pesquisou sobre cada um.

Hoje é ${hoje}.
CAMPOS A PEDIR (só estes, para todos os vinhos): ${campos.map((k) => CAMPOS[k]).join(", ")}.

${vinhos.map((v) => `VINHO id ${v.id} — ${v.nome}${v.produtor ? ` (${v.produtor})` : ""}${v.ano ? `, ${v.ano}` : ""}:
BASE DE EVIDÊNCIA:
${v.evidencia || "(sem resultados de pesquisa para este vinho)"}
`).join("\n")}

REGRAS, e são a sério:
1. RESPONDE APENAS COM BASE NA BASE DE EVIDÊNCIA de cada vinho. Não procures na net.
2. NÃO INVENTES. Um campo que não consigas confirmar fica FORA do objeto desse vinho (ou null).
3. ${regraCuvee}
4. ${regraVivino(undefined)}
5. Castas separadas por nome (nunca "blend"/"lote"/"várias castas").
6. "beberDe"/"beberAte" são anos, a janela da colheita indicada. Um vinho SEM ano não tem janela de consumo: deixa "beberDe"/"beberAte" de fora do objeto dele.
7. O "id" de cada resultado tem de ser EXATAMENTE o "id" indicado acima — é assim que se sabe a que vinho corresponde cada objeto, nunca pela posição na lista.
8. Se a evidência de um vinho não chegar para o identificar, o objeto dele fica só {"id": <id>, "encontrado": false, "aviso": "porquê"}.

Responde SÓ com este JSON, sem texto à volta e sem blocos de código, com exatamente ${vinhos.length} objeto${vinhos.length > 1 ? "s" : ""} em "resultados" (um por vinho):
{
  "resultados": [
    {
      "id": ${vinhos[0]?.id ?? 0},
      "encontrado": true,
      ${campos.map((k) => `"${CAMPOS[k]}": ${CAMPO_EXEMPLO[k] ?? "null"}`).join(",\n      ")},
      "aviso": "vazio, ou o que ficou por confirmar"
    }
  ]
}`;

/* Aspas tipográficas (“ ” ‘ ’) não são JSON válido, e um chat-UI troca-as
   por conta própria ao mostrar texto normal (não costuma acontecer dentro
   de blocos de código) — apanhado com uma resposta colada à mão que tinha
   TODAS as aspas assim e o JSON.parse recusava logo na primeira chave.
   Trocar aqui por retas resolve os dois casos (automático e colado) de
   uma vez, sem arriscar strings verdadeiras: uma aspa tipográfica dentro
   de uma frase vira reta na mesma, mas fica dentro da MESMA string — só
   muda um caracter, nunca a estrutura. */
function normalizarAspas(s: string): string {
  return s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

/* Mesmo pedindo JSON, alguns modelos devolvem texto com blocos ``` e frases
   à volta. Aqui apanha-se o primeiro objeto JSON equilibrado do texto. */
function extrairJson(txt: string): any | null {
  const s = normalizarAspas(String(txt || "").trim());
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
/* ── O link do Vivino: só o formato que o Vivino usa ──
   A página de um vinho no Vivino é SEMPRE `/<nome>/w/<nº>` — o número é o
   do vinho e não muda. Um modelo que responda de memória (o normal — ver o
   CLAUDE.md da WineCatalog, "De memória ou pesquisado") escreve links com
   ar de verdadeiros que nunca existiram: `/Wines/<nome>`,
   `/Wineries/<x>/Wines/<y>`, `/pt-pt/<nome>` sem número. Até 25/09/2026 só
   se exigia o domínio, e esses entravam e partiam ao abrir. `/wines/<nº>`
   também sai: é o número de UMA colheita, não o do vinho. Devolve-se o
   link limpo (sem país, língua, ?year=, ?srsltid) — a MESMA regra do
   `urlLimpo` do `batch/vivino-verificar.mjs` (WineCatalog). */
function vivinoLink(u: unknown): string {
  try {
    const url = new URL(String(u ?? "").trim());
    if (!/(^|\.)vivino\.com$/i.test(url.hostname)) return "";
    const m = url.pathname.match(/\/([a-z0-9-]+)\/w\/(\d+)/i);
    return m ? `https://www.vivino.com/${m[1].toLowerCase()}/w/${m[2]}` : "";
  } catch { return ""; }
}
/* O link do Vivino que quem procura colou nos sites de confiança é FACTO
   (abriu-o), e ganha ao que veio da IA, da cache ou do catálogo. */
function comVivinoDado(res: Res, vivinoDado: string, campos: string[] | null): Res {
  if (res.ok && vivinoDado && (!campos || campos.includes("vivino_url"))) {
    res.corpo.vivino_url = vivinoDado;
    // E diz-se de onde veio: do link que se colou.
    const oc = (res.corpo.origemCampos && typeof res.corpo.origemCampos === "object") ? res.corpo.origemCampos as Record<string, unknown> : null;
    if (oc) oc.vivino_url = { url: vivinoDado, site: "vivino.com", titulo: "o link que colaste", dada: true };
  }
  return res;
}

function normalizar(raw: any, anoPedido: number | null, campos: string[] | null = null): Record<string, unknown> | null {
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
    // Sem ano no pedido, não há ano na resposta: a colheita é de quem tem a
    // garrafa (ou a quer), e um ano achado pela IA era inventar-lha — e ia
    // parar ao catálogo pelo `juntar` (o Sidónio de Sousa, 25/09/2026).
    ano: anoPedido === null ? null : (anoValido(raw.ano) ?? anoPedido),
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
    vivino_nota_global: numero(raw.vivinoNotaGlobal, 1, 5, 2),
    vivino_avaliacoes_global: (() => { const n = numero(raw.vivinoAvaliacoesGlobal, 0, 10_000_000, 0); return n === null ? null : Math.round(n); })(),
    // Só `/<nome>/w/<nº>` (ver `vivinoLink`). Não chega para apanhar um
    // link de um vinho HOMÓNIMO — isso é a regra 2, no prompt — mas apanha
    // os inventados.
    vivino_url: vivinoLink(raw.vivinoUrl),
    // Aqui a validação é mais apertada do que no `vivino_url`: exige-se a
    // extensão da imagem. O modelo tende a devolver o link da PÁGINA do
    // produto em vez do da fotografia, e isso dava um <img> partido na ficha
    // — pior do que não ter foto nenhuma.
    imagem_url: /^https?:\/\/\S+\.(jpe?g|png|webp|avif)(\?\S*)?$/i.test(String(raw.imagemUrl ?? "").trim())
      ? texto(raw.imagemUrl, 400) : "",
    preco_medio: numero(raw.precoMedio, 0.5, 100_000, 2),
    beber_de: beberDe,
    beber_ate: beberAte,
    notas_prova: texto(raw.notasProva, 600),
    harmonizacao: texto(raw.harmonizacao, 300),
    ai_resumo: texto(raw.resumo, 900),
    aviso: texto(raw.aviso, 300),
  };
  // Sem colheita não há janela de consumo: os anos dela seriam os de uma
  // colheita qualquer (a BD também a recusa, trigger `vinhos_sem_colheita`).
  if (out.ano == null) { out.beber_de = null; out.beber_ate = null; }
  // Campos vazios/null saem do objeto: a app decide o que fazer com o que
  // vem, e um `null` explícito ali era indistinguível de "a IA diz que é
  // nulo" — o que apagava dados bons ao aceitar tudo.
  Object.keys(out).forEach((k) => {
    const v = out[k];
    if (v === null || v === "" || (Array.isArray(v) && !v.length)) delete out[k];
  });
  vivinoDuas(out, (out.ano as number | undefined) ?? null);
  /* Pediram só alguns campos: o resto sai daqui, mesmo que o modelo o tenha
     mandado à mesma. Sem isto, o ecrã de confirmação da app voltava a
     encher-se de campos que ninguém pediu — e um deles, aceite por
     distração, escrevia por cima do que estava certo. O `aviso` fica sempre:
     é onde o modelo diz o que não conseguiu confirmar. */
  if (campos && campos.length) {
    Object.keys(out).forEach((k) => { if (k !== "aviso" && !campos.includes(k)) delete out[k]; });
  }
  return Object.keys(out).length ? out : null;
}

/* AS DUAS NOTAS DO VIVINO, arrumadas depois de lidas (27/09/2026) — a
   mesma função da `catalogo-info` (WineCatalog):
   · sem colheita, a nota "da colheita" é a de todas — passa para lá (se lá
     não houver outra) e sai;
   · a mesma nota com as mesmas avaliações nas duas é o modelo a copiar a
     média de todas as colheitas para a da colheita — fica só a de todas;
   · uma colheita com MAIS avaliações do que o vinho todo não existe: a de
     todas fica de fora (a regra do `lerGlobal` do script do Vivino). */
function vivinoDuas(out: Record<string, unknown>, ano: number | null): void {
  const tem = (k: string) => out[k] !== undefined;
  if (ano === null) {
    if (tem("vivino_nota") && !tem("vivino_nota_global")) {
      out.vivino_nota_global = out.vivino_nota;
      if (tem("vivino_avaliacoes") && !tem("vivino_avaliacoes_global")) out.vivino_avaliacoes_global = out.vivino_avaliacoes;
    }
    delete out.vivino_nota; delete out.vivino_avaliacoes;
    return;
  }
  if (tem("vivino_nota") && tem("vivino_nota_global") &&
      out.vivino_nota === out.vivino_nota_global &&
      (out.vivino_avaliacoes ?? null) === (out.vivino_avaliacoes_global ?? null)) {
    delete out.vivino_nota; delete out.vivino_avaliacoes;
    return;
  }
  if (tem("vivino_avaliacoes") && tem("vivino_avaliacoes_global") &&
      Number(out.vivino_avaliacoes) > Number(out.vivino_avaliacoes_global)) {
    delete out.vivino_nota_global; delete out.vivino_avaliacoes_global;
  }
}

/* Uma consulta ao Serper, em linhas (a `obterResultadosPesquisa` devolve
   já o texto, e o lote continua a usá-la): é o que deixa numerar tudo de
   seguida para o `deOnde`, e escolher a página de cada site. */
type Resultado = { url: string; titulo: string; snippet: string; rating: unknown; ratingCount: unknown };
async function serperConsulta(q: string, signal: AbortSignal): Promise<Resultado[]> {
  if (!SEARCH_API_KEY) throw new Error("a pesquisa externa não está configurada: falta SEARCH_API_KEY");
  const { signal: ss, limpar } = comLimiteProprio(signal, 12_000);
  try {
    const r = await fetch(SEARCH_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": SEARCH_API_KEY },
      body: JSON.stringify({ q, gl: "pt", hl: "pt", num: SEARCH_RESULTADOS }),
      signal: ss,
    });
    if (!r.ok) throw new Error(`pesquisa externa ${r.status}`);
    const d = await r.json();
    return (Array.isArray(d?.organic) ? d.organic : []).slice(0, SEARCH_RESULTADOS)
      .map((x: any) => ({
        url: String(x?.link || "").trim(), titulo: String(x?.title || "").trim(),
        snippet: String(x?.snippet || "").replace(/\s+/g, " ").trim(),
        rating: x?.rating, ratingCount: x?.ratingCount,
      }))
      .filter((x: Resultado) => /^https?:\/\//i.test(x.url));
  } finally {
    limpar();
  }
}

/* ── AS PÁGINAS DOS SITES (27/09/2026, o dono das apps) ──
   "Encontrei o vinho num site, dou o link e preenchem-se os atributos a
   partir daí." Até aqui um link de uma loja colado nos sites de confiança
   era reduzido ao domínio, e de um site só se lia o resumo que o Google
   mostra em cada resultado (duas linhas — quase nunca as castas, o teor ou
   o estágio). Agora a página ABRE-SE: a que se colou, tal e qual, e — de
   cada domínio escrito sem página — a primeira que a procura só nesse
   site devolver. Do HTML tira-se o que a loja declara do produto para os
   motores de busca (o JSON-LD: nome, marca, preço, imagem, descrição), as
   etiquetas `og:`, e o texto da zona principal sem menus nem rodapé. Lê-o
   o Gemini, com a regra de sempre (o que lá não estiver fica fora do JSON)
   e mais uma: dizer, campo a campo, de que página ou resultado o tirou
   (`deOnde`) — é o que a revisão mostra ao lado de cada valor.
   `soSites` ("Usar só a informação destes sites"): sem a consulta geral,
   sem a do Vivino (a não ser que o Vivino seja um dos sites) e sem o
   grounding. O que as páginas não disserem fica vazio, e um campo que a IA
   não diga de onde veio sai.
   O que NÃO se faz: abrir o Vivino daqui. A proteção dele recusa
   servidores (403 na 1.ª corrida no GitHub Actions) e isso não se contorna
   — ver o CLAUDE.md, "Links do Vivino"; do Vivino fica o que o Google
   mostra. Uma loja que recuse (403, desafio anti-bots) também não se
   contorna: fica o resumo do Google, se houver, e o ecrã diz que recusou.
   Um endereço escrito por alguém é aberto por um servidor: só http(s),
   só nomes públicos (nada de IPs, portas nem "localhost"), redireções
   conferidas uma a uma, 1,5 MB no máximo. A MESMA leitura está na
   `catalogo-info` da WineCatalog — mexer numa é mexer na outra. Aqui, quem
   pode escrever um endereço é qualquer editor com IA, e é por isso que as
   travas acima não são enfeite. */
const PAGINA_TIMEOUT_MS = 10_000;
const PAGINA_MAX_BYTES = 1_500_000;
const PAGINA_MAX_TEXTO = 6_000;
const EVIDENCIA_PAGINAS_MAX = 20_000;
const UA_PAGINA = "Mozilla/5.0 (compatible; Garrafeira/1.0)";
const RECUSA = /just a moment|attention required|access denied|captcha|verify you are human|unusual traffic|verifica[çc][ãa]o de seguran[çc]a/i;

function hostPublico(u: URL): boolean {
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.port || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(h) && !/(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(h);
}
const siteDe = (url: string): string => {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
};
/* O endereço de uma PÁGINA (com caminho) — só o domínio não é uma página. */
function paginaDe(s: string): string {
  let t = String(s ?? "").trim();
  if (!/^https?:\/\//i.test(t)) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S/i.test(t)) return "";
    t = "https://" + t;
  }
  try {
    const u = new URL(t);
    if (!hostPublico(u) || u.pathname.replace(/\/+$/, "") === "") return "";
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|srsltid$|gclid$|fbclid$)/i.test(k)) u.searchParams.delete(k);
    }
    return u.toString();
  } catch { return ""; }
}
/* O resultado de uma procura num site que tem ar de ser a página de UM
   produto (não a procura, uma categoria ou a página inicial). */
function paginaDoResultado(rows: Resultado[], dominio: string): Resultado | null {
  return rows.find((x) => {
    if (!doSite(x.url, dominio)) return false;
    try {
      const u = new URL(x.url);
      return u.pathname.replace(/\/+$/, "") !== "" &&
        !/catalogsearch|\/search\b|\/pesquisa\b|\/categor|\/tag\/|\/marcas?\/?$|\/brands?\/?$/i.test(u.pathname) &&
        !u.searchParams.has("s") && !u.searchParams.has("q");
    } catch { return false; }
  }) ?? null;
}

const ENT: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", euro: "€", ordm: "º", ordf: "ª",
  deg: "°", middot: "·", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", reg: "®", copy: "©", trade: "™", times: "×",
};
const ACENTO: Record<string, string> = { acute: "\u0301", grave: "\u0300", circ: "\u0302", tilde: "\u0303", uml: "\u0308", cedil: "\u0327" };
function entidades(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    if (e in ENT) return ENT[e];
    const a = e.match(/^([a-z])(acute|grave|circ|tilde|uml|cedil)$/i);
    return a ? (a[1] + ACENTO[a[2].toLowerCase()]).normalize("NFC") : m;
  });
}
const semTags = (s: string) => entidades(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
function metaDe(html: string, nome: string): string {
  const tag = html.match(new RegExp(`<meta[^>]+(?:property|name|itemprop)\\s*=\\s*["']${nome}["'][^>]*>`, "i"))?.[0];
  if (!tag) return "";
  const m = tag.match(/content\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  return m ? texto(entidades(m[1] ?? m[2] ?? ""), 400) : "";
}
/* O que a loja declara do produto (JSON-LD `Product`, dentro ou fora de um
   `@graph`). A classificação que lá vier é a dos CLIENTES DA LOJA, nunca a
   do Vivino — e diz-se isso ao modelo. */
function produtoDaPagina(html: string): string {
  const ld: any[] = [];
  const junta = (x: any) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(junta); return; }
    ld.push(x);
    if (Array.isArray(x["@graph"])) x["@graph"].forEach(junta);
  };
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { junta(JSON.parse(m[1].trim())); } catch { /* um JSON-LD partido não deita a página abaixo */ }
  }
  const p = ld.find((x) => /Product|Wine/i.test(String(x?.["@type"] ?? "")));
  if (!p) return "";
  const um = (v: any) => (Array.isArray(v) ? v[0] : v);
  const t = (v: unknown, n: number) => texto(semTags(String(v ?? "")), n);
  const linhas: string[] = [];
  if (p.name) linhas.push(`nome: ${t(p.name, 200)}`);
  const marca = um(p.brand ?? p.manufacturer);
  const marcaN = typeof marca === "string" ? marca : marca?.name;
  if (marcaN) linhas.push(`marca/produtor: ${t(marcaN, 120)}`);
  const of = um(p.offers);
  if (of && typeof of === "object") {
    const ps = um(of.priceSpecification);
    const preco = of.price ?? of.lowPrice ?? ps?.price;
    if (preco != null && preco !== "") linhas.push(`preço: ${t(preco, 20)} ${t(of.priceCurrency ?? ps?.priceCurrency ?? "", 5)}`.trim());
  }
  const img = um(p.image);
  const imgU = typeof img === "string" ? img : img?.url ?? img?.contentUrl;
  if (imgU) linhas.push(`imagem: ${t(imgU, 400)}`);
  const ar = p.aggregateRating;
  if (ar?.ratingValue != null) {
    linhas.push(`avaliação dos clientes DESTA loja (não é o Vivino): ${t(ar.ratingValue, 10)}${(ar.ratingCount ?? ar.reviewCount) != null ? ` (${t(ar.ratingCount ?? ar.reviewCount, 12)})` : ""}`);
  }
  for (const ap of (Array.isArray(p.additionalProperty) ? p.additionalProperty : []).slice(0, 20)) {
    if (ap?.name && ap?.value != null) linhas.push(`${t(ap.name, 60)}: ${t(ap.value, 200)}`);
  }
  if (p.description) linhas.push(`descrição: ${t(p.description, 1500)}`);
  return linhas.join("\n");
}
/* O texto da zona principal (o `<main>`, se houver), sem menus, rodapé,
   scripts nem botões. As tabelas ficam "rótulo | valor" numa linha — é
   onde as lojas escrevem as castas, a região, o teor e o estágio. */
function textoDaPagina(html: string): string {
  let h = html;
  const main = h.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main && main[1].length > 500) h = main[1];
  else {
    const b = h.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
    h = (b ? b[1] : h).replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, " ");
  }
  h = h.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|nav|footer|aside|select|button)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/t[hd]>/gi, " | ")
    .replace(/<\/dt>/gi, ": ")
    .replace(/<\/(p|div|li|h[1-6]|section|article|tr|ul|ol|table|dd|dl|figcaption|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const linhas: string[] = [];
  for (const bruta of entidades(h).split("\n")) {
    const l = bruta.replace(/[ \t\u00a0]+/g, " ").replace(/^[\s|]+|[\s|]+$/g, "");
    if (!l || l === linhas[linhas.length - 1]) continue;
    linhas.push(l);
  }
  return linhas.join("\n").slice(0, PAGINA_MAX_TEXTO);
}
async function lerAte(r: Response, max: number): Promise<Uint8Array> {
  const rd = r.body?.getReader();
  if (!rd) return new Uint8Array();
  const partes: Uint8Array[] = [];
  let n = 0;
  while (n < max) {
    const { done, value } = await rd.read();
    if (done || !value) break;
    partes.push(value);
    n += value.length;
  }
  if (n >= max) await rd.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(n, max));
  let o = 0;
  for (const p of partes) {
    const c = p.subarray(0, out.length - o);
    out.set(c, o);
    o += c.length;
    if (o >= out.length) break;
  }
  return out;
}
type Pagina = {
  url: string; site: string; dada: boolean;
  estado: "lida" | "recusada" | "vazia" | "erro";
  http?: number; titulo?: string; motivo?: string; texto?: string;
};
async function abrirPagina(url0: string, dada: boolean, signal: AbortSignal): Promise<Pagina> {
  let url = url0;
  const base = (): Pagina => ({ url, site: siteDe(url) || siteDe(url0), dada, estado: "erro" });
  try {
    const sinal = AbortSignal.any([signal, AbortSignal.timeout(PAGINA_TIMEOUT_MS)]);
    let r: Response | null = null;
    for (let i = 0; i < 5; i++) {
      const u = new URL(url);
      if (!hostPublico(u)) return { ...base(), motivo: "endereço não permitido" };
      r = await fetch(u, {
        redirect: "manual", signal: sinal,
        headers: { "User-Agent": UA_PAGINA, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.5" },
      });
      const loc = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
      if (!loc) break;
      await r.body?.cancel().catch(() => {});
      url = new URL(loc, url).toString();
      r = null;
    }
    if (!r) return { ...base(), motivo: "redireções a mais" };
    const tipo = r.headers.get("content-type") ?? "";
    if (r.status === 403 || r.status === 429 || r.status === 503) {
      await r.body?.cancel().catch(() => {});
      return { ...base(), estado: "recusada", http: r.status, motivo: `HTTP ${r.status}` };
    }
    if (!r.ok) {
      await r.body?.cancel().catch(() => {});
      return { ...base(), http: r.status, motivo: `HTTP ${r.status}` };
    }
    if (tipo && !/html|xml/i.test(tipo)) {
      await r.body?.cancel().catch(() => {});
      return { ...base(), http: r.status, motivo: `não é uma página (${tipo.split(";")[0]})` };
    }
    const bytes = await lerAte(r, PAGINA_MAX_BYTES);
    // O charset do cabeçalho, senão o do <meta>, senão UTF-8.
    const ascii = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
    const cs = (tipo.match(/charset=["']?([\w-]+)/i) ?? ascii.match(/<meta[^>]+charset=["']?([\w-]+)/i) ?? [])[1] ?? "utf-8";
    let html: string;
    try { html = new TextDecoder(cs).decode(bytes); } catch { html = new TextDecoder().decode(bytes); }
    const titulo = texto(semTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? [])[1] ?? ""), 160);
    const corpo = textoDaPagina(html);
    const recusa = `${titulo} ${corpo.slice(0, 500)}`.match(RECUSA);
    if (recusa) return { ...base(), estado: "recusada", http: r.status, titulo, motivo: `a página diz "${recusa[0]}"` };
    const produto = produtoDaPagina(html);
    const meta = [["título", "og:title"], ["imagem", "og:image"], ["preço", "product:price:amount"],
      ["moeda", "product:price:currency"], ["preço", "price"], ["descrição", "og:description"]]
      .map(([rot, n]) => [rot, metaDe(html, n)]).filter(([, v]) => v).map(([rot, v]) => `${rot}: ${v}`);
    const partes = [
      titulo ? `Título da página: ${titulo}` : "",
      produto ? `DADOS DO PRODUTO (o que a página declara aos motores de busca):\n${produto}` : "",
      meta.length ? `ETIQUETAS DA PÁGINA:\n${meta.join("\n")}` : "",
      corpo ? `TEXTO DA PÁGINA:\n${corpo}` : "",
    ].filter(Boolean);
    if (!produto && corpo.length < 200) {
      return { ...base(), estado: "vazia", http: r.status, titulo, motivo: "a página quase não tem texto (é montada em JavaScript?)" };
    }
    return { ...base(), estado: "lida", http: r.status, titulo, texto: partes.join("\n\n") };
  } catch (e) {
    if (signal.aborted) throw e;
    const err = e as Error;
    return { ...base(), motivo: err.name === "TimeoutError" ? "não respondeu a tempo" : String(err.message).slice(0, 120) };
  }
}
/* O que o ecrã e o registo dizem de cada página (sem o texto). */
type PaginaRes = { site: string; url?: string; dada?: boolean; estado: string; http?: number; titulo?: string; motivo?: string };
const paginaRes = (p: Pagina): PaginaRes => ({
  site: p.site, url: p.url, dada: p.dada, estado: p.estado,
  ...(p.http ? { http: p.http } : {}), ...(p.titulo ? { titulo: p.titulo } : {}), ...(p.motivo ? { motivo: p.motivo } : {}),
});

/* A base de evidência: as páginas abertas primeiro, depois os resultados
   da pesquisa (os dos sites de confiança à frente) — tudo numerado de
   seguida, que é o número que o modelo devolve em `deOnde`. */
type Origem = { url: string; site: string; titulo: string; pagina?: boolean; dada?: boolean; google?: boolean };
function montarEvidencia(paginas: Pagina[], resultados: Resultado[], ano: number | null, dominios: string[]) {
  const lista: Origem[] = [];
  const blocos: string[] = [];
  let resto = EVIDENCIA_PAGINAS_MAX;
  for (const p of paginas) {
    if (p.estado !== "lida" || !p.texto || resto <= 0) continue;
    lista.push({ url: p.url, site: p.site, titulo: p.titulo || p.site, pagina: true, ...(p.dada ? { dada: true } : {}) });
    const b = `[${lista.length}] PÁGINA ABERTA de ${p.site}${p.dada
      ? " (indicada por quem pesquisa como sendo a deste vinho)"
      : ` (a primeira que a procura só em ${p.site} devolveu — confirma que é deste vinho)`}\nURL: ${p.url}\n${p.texto}`;
    blocos.push(b.slice(0, resto));
    resto -= b.length;
  }
  const vistos = new Set(lista.map((x) => x.url));
  // Um resultado sem resumo nem estrelas (a página de procura da loja, por
  // exemplo) não diz nada — fica de fora.
  const rs = resultados.filter((x) => (x.snippet || x.rating != null) && !vistos.has(x.url) && (vistos.add(x.url), true));
  const deConfianca = (x: Resultado) => dominios.find((d) => doSite(x.url, d)) ?? "";
  // Os dos sites de confiança à frente — é a eles que a regra manda ir primeiro.
  rs.sort((a, b) => Number(!deConfianca(a)) - Number(!deConfianca(b)));
  const textoRs: string[] = [];
  for (const x of rs) {
    lista.push({ url: x.url, site: siteDe(x.url), titulo: x.titulo || siteDe(x.url) });
    const viv = vivinoDeQue(x.url, ano);
    textoRs.push(`[${lista.length}] RESULTADO DA PESQUISA${deConfianca(x) ? " ★ FONTE DE CONFIANÇA" : ""} ${x.titulo}\nURL: ${x.url}\n` +
      (viv ? `(${viv})\n` : "") + `Resumo: ${x.snippet}` +
      (x.rating != null ? `\nEstrelas no Google: ${x.rating}${x.ratingCount != null ? ` (${x.ratingCount} avaliações)` : ""}` : ""));
  }
  const confianca: Record<string, number> = Object.fromEntries(dominios.map((d) => [d, lista.filter((o) => doSite(o.url, d)).length]));
  const texto_ = [...blocos, textoRs.join("\n\n").slice(0, 9000)].filter(Boolean).join("\n\n");
  return {
    texto: texto_,
    lista,
    fontes: lista.slice(0, 8).map((o) => ({ titulo: o.titulo.slice(0, 120), url: o.url.slice(0, 400) })),
    confianca,
  };
}
/* `deOnde` → de que página/resultado veio cada campo (as chaves da ficha).
   O modelo devolve o número; aceita-se também o endereço. */
const CAMPO_DO_JSON: Record<string, string> = Object.fromEntries(Object.entries(CAMPOS).map(([k, j]) => [j, k]));
function origemDosCampos(deOnde: unknown, lista: Origem[], ficha: Record<string, unknown>, ano: number | null): Record<string, Origem> {
  const out: Record<string, Origem> = {};
  if (!deOnde || typeof deOnde !== "object" || Array.isArray(deOnde)) return out;
  for (const [kj, bruto] of Object.entries(deOnde as Record<string, unknown>)) {
    const k = CAMPO_DO_JSON[kj] ?? (kj in CAMPOS ? kj : "");
    if (!k) continue;
    const n = Array.isArray(bruto) ? bruto[0] : bruto;
    const s = String(n ?? "").trim();
    const o = /^https?:\/\//i.test(s)
      ? lista.find((x) => x.url === s || s.startsWith(x.url))
      : lista[parseInt(s.replace(/\D+/g, " ").trim().split(" ")[0], 10) - 1];
    if (o) out[k] = o;
  }
  // Sem colheita, a nota "da colheita" passou a ser a de todas (`vivinoDuas`).
  if (ano === null) {
    if (out.vivino_nota && !out.vivino_nota_global) out.vivino_nota_global = out.vivino_nota;
    if (out.vivino_avaliacoes && !out.vivino_avaliacoes_global) out.vivino_avaliacoes_global = out.vivino_avaliacoes;
  }
  for (const k of Object.keys(out)) if (k !== "produtor" && !(k in ficha)) delete out[k];
  return out;
}
/* Numa frase, o que se passou com uma página (para o erro do "só estes sites"). */
function paginaEmFrase(p: PaginaRes): string {
  if (p.estado === "nao_encontrada") return `${p.site}: o vinho não apareceu na procura deste site`;
  if (p.estado === "sem_pesquisa") return `${p.site}: sem a pesquisa externa não há como procurar dentro do site — cola o link da página`;
  if (p.estado === "recusada") return `${p.site}: a página recusou a leitura (${p.motivo || "bloqueio"})`;
  if (p.estado === "vazia") return `${p.site}: ${p.motivo || "a página não tem texto"}`;
  if (p.estado === "erro") return p.url ? `${p.site}: não abriu (${p.motivo || "erro"})` : `${p.site}: ${p.motivo || "erro"}`;
  return `${p.site}: lida`;
}

/* O que é que o catálogo consegue responder, dos campos que se pediram.
   `ano` fica SEMPRE de fora: o catálogo sabe a colheita que alguém pôs lá,
   e essa não tem de ser a da garrafa que está à minha frente — preencher
   um ano por adivinhação era estragar a identidade do vinho de quem
   procura. `produtor` entra, que esse não muda de colheita para colheita. */
function catalogoResponde(c: Conhecido, pedidos: string[]): Record<string, unknown> {
  // O vocabulário fechado vale para TUDO o que entra, e o catálogo é
  // escrito também pela outra app — que tem os seus próprios rótulos
  // ("Verde" lá é um tipo, aqui é um estilo; "Doce" e "Outro" aqui não
  // existem). Sem esta passagem, um valor de lá entrava nos filtros desta
  // app como se fosse nosso e enchia-os de sinónimos da mesma coisa. A
  // WineSelection já só escreve os quatro que são comuns — isto é a rede,
  // e uma rede num sítio por onde entram dados de fora paga-se sozinha.
  const LISTAS: Record<string, string[]> = {
    tipo: TIPOS, estilo: ESTILOS, mencao: MENCOES, classificacao: CLASSIF,
  };
  const out: Record<string, unknown> = {};
  for (const k of pedidos) {
    if (k === "ano") continue;
    if (k === "produtor") { if (c.produtor) out.produtor = c.produtor; continue; }
    let v = (c.ficha as any)[k];
    if (LISTAS[k]) v = daLista(v, LISTAS[k]);
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
}

/* ── Registo (garrafeira.sync_log) ──
   Do lado do browser vê-se sempre a mesma coisa ("HTTP 502"); a causa está
   nesta linha. Nunca deita a resposta abaixo. */
async function registar(estado: string, detalhe: Record<string, unknown>, quem: string | null) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/sync_log`, {
      method: "POST",
      headers: {
        apikey: SB_SRV, Authorization: 'Bearer '+SB_SRV,
        "Content-Type": "application/json", "Content-Profile": "garrafeira",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ origem: "function", acao: "vinho-info", estado, quem, detalhe }),
    });
    if (!r.ok) console.log("VINHO sync_log falhou:", r.status, (await r.text().catch(() => "")).slice(0, 200));
  } catch (e) { console.log("VINHO sync_log erro:", String((e as Error).message).slice(0, 200)); }
  await registarIaUso("vinho-info", estado, detalhe, quem);
}

/* Espelho em `ia_uso.registos` — schema à parte, no MESMO projeto Supabase,
   partilhado pelas cinco apps que chamam o Gemini (ver CLAUDE.md "O registo
   central de acessos ao Gemini"). O MESMO `detalhe` de cima, com
   tokens/modelo/custo também promovidos a colunas, para uma tabela que soma
   o gasto ao todo em vez de app a app. Nunca deita a chamada principal
   abaixo por isto falhar — mesma regra do `registar()` local, só que este
   POST vai para outro schema (`Content-Profile: ia_uso`). */
async function registarIaUso(funcao: string, estado: string, detalhe: Record<string, unknown>, quem: string | null): Promise<void> {
  try {
    const usage = (detalhe.usageMetadata ?? null) as
      | { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number }
      | null;
    const pesquisa = detalhe.pesquisa as unknown;
    await fetch(`${SB_URL}/rest/v1/registos`, {
      method: "POST",
      headers: {
        apikey: SB_SRV, Authorization: "Bearer " + SB_SRV,
        "Content-Type": "application/json", "Content-Profile": "ia_uso",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        app: "garrafeira", funcao,
        estado: estado === "pedido" || estado === "erro" ? estado : "ok",
        modelo: (detalhe.modelo as string | undefined) ?? null,
        pesquisa_web: typeof pesquisa === "boolean" ? pesquisa : (typeof pesquisa === "string" ? pesquisa.length > 0 : null),
        tokens_entrada: usage?.promptTokenCount ?? null,
        tokens_saida: usage?.candidatesTokenCount ?? null,
        tokens_pensamento: usage?.thoughtsTokenCount ?? null,
        tokens_total: usage?.totalTokenCount ?? null,
        custo_estimado_eur: (detalhe.custo_estimado_eur as number | undefined) ?? null,
        duracao_ms: (detalhe.ms as number | undefined) ?? null,
        quem,
        erro: estado === "erro"
          ? (String((detalhe.erro as string | undefined) ?? (detalhe.passo as string | undefined) ?? "").slice(0, 500) || null)
          : null,
        detalhe,
      }),
    });
  } catch (_e) {
    // nunca deita a chamada principal abaixo
  }
}

/* Cria a linha 'pendente' com o PRÓPRIO JWT de quem carregou — assim a RLS
   corre normalmente e não é preciso confiar em nada que o cliente mande.
   Devolve null se a tabela ainda não existir; nesse caso cai-se no modo
   síncrono em vez de rebentar. */
async function criarAnalise(auth: string, pedido: unknown, vinhoId: number | null, quem: string,
                            signal: AbortSignal) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/analises`, {
      method: "POST",
      headers: {
        apikey: SB_SRV, Authorization: auth, "Content-Type": "application/json",
        "Content-Profile": "garrafeira", Prefer: "return=representation",
      },
      signal,
      // `plano_ia` não vai daqui de propósito: o trigger `analises_guard_ins`
      // carimba-o com o DIREITO de quem chamou (é isso que a quota conta), e
      // o motor que acabou por correr fica no `resultado`.
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
        apikey: SB_SRV, Authorization: 'Bearer '+SB_SRV, "Content-Type": "application/json",
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
async function ehEditor(auth: string, signal: AbortSignal): Promise<{ ok: boolean; email: string | null; plano: string }> {
  if (!auth) return { ok: false, email: null, plano: "sem_ia" };
  const u = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_SRV, Authorization: auth }, signal });
  if (!u.ok) { console.log("VINHO /user erro:", u.status); return { ok: false, email: null, plano: "sem_ia" }; }
  const email = String((await u.json()).email ?? "").toLowerCase();
  if (!email) return { ok: false, email: null, plano: "sem_ia" };
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/is_editor`, {
      method: "POST",
      headers: {
        apikey: SB_SRV, Authorization: auth, "Content-Type": "application/json",
        "Content-Profile": "garrafeira",
      },
      signal, body: "{}",
    });
    if (!r.ok) { console.log("VINHO is_editor:", r.status, (await r.text().catch(() => "")).slice(0, 200)); return { ok: false, email, plano: "sem_ia" }; }
    const editor = (await r.json()) === true;
    if (!editor) return { ok: false, email, plano: "sem_ia" };
    const p = await fetch(`${SB_URL}/rest/v1/rpc/plano_ia`, {
      method: "POST",
      headers: { apikey: SB_SRV, Authorization: auth, "Content-Type": "application/json", "Content-Profile": "garrafeira" },
      signal, body: "{}",
    });
    if (!p.ok) { console.log("VINHO plano_ia:", p.status, (await p.text().catch(() => "")).slice(0, 200)); return { ok: false, email, plano: "sem_ia" }; }
    const plano = String(await p.json());
    return { ok: true, email, plano };
  } catch (e) { console.log("VINHO is_editor excecao:", String((e as Error).message).slice(0, 200)); return { ok: false, email, plano: "sem_ia" }; }
}

/* O admin da Garrafeira — quem decide é a base (`garrafeira.is_admin()`),
   com o JWT da pessoa. Só é perguntado quando alguém pede a profunda. */
async function souAdmin(auth: string, signal: AbortSignal): Promise<boolean> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/is_admin`, {
      method: "POST",
      headers: { apikey: SB_SRV, Authorization: auth, "Content-Type": "application/json", "Content-Profile": "garrafeira" },
      signal, body: "{}",
    });
    return r.ok && (await r.json()) === true;
  } catch (_) { return false; }
}

/* ── O TRABALHO A SÉRIO ──
   Toda a conversa com o Gemini num sítio só, para poder correr nos DOIS
   modos: à espera, ou em segundo plano. Nunca escreve na resposta HTTP —
   devolve o corpo final ou o erro já com o status certo. */
type Res = { ok: true; corpo: Record<string, unknown> } | { ok: false; status: number; erro: string };

/* HOUVE PESQUISA OU NÃO. Ligar o `google_search` não obriga o modelo a
   pesquisar — ele decide, e nas 25 procuras premium registadas até
   24/09/2026 nunca o fez (total de tokens = entrada + saída, ~5 s): as
   respostas vinham do que o modelo aprendeu no treino. Para toda a gente
   isto fica como está; o resultado passa a dizê-lo (`pesquisaWeb`) e ao
   admin a app oferece a "pesquisa profunda" (`profunda:true`).

   PESQUISA PROFUNDA = SERPER (25/09/2026). Não há parâmetro nenhum na API
   do Gemini que o OBRIGUE a pesquisar, e mudar o prompt só mexe nas
   probabilidades: com o prompt a pedir "primeiro pesquisa, depois o JSON",
   a primeira profunda a sério (Quinta dos Sentidos, 24/09/2026) respondeu
   de memória na mesma, no lite e no flash. A profunda passou a ser o
   "modo grátis" que já existia: a pesquisa é NOSSA (Serper — geral + uma
   ao Vivino), o Gemini só lê os resultados, sem `google_search`. Salta a
   cache e o catálogo. Mesmo critério da `catalogo-info` (WineCatalog), da
   `verificar-vinhos` (WineSelection) e da `prendas-vinho` — ver o
   CLAUDE.md da WineCatalog, "De memória ou pesquisado". */
function fezPesquisa(body: any): boolean {
  const gm = body?.candidates?.[0]?.groundingMetadata;
  return (Array.isArray(gm?.webSearchQueries) && gm.webSearchQueries.length > 0) ||
    (Array.isArray(gm?.groundingChunks) && gm.groundingChunks.length > 0) ||
    Number(body?.usageMetadata?.toolUsePromptTokenCount ?? 0) > 0;
}

// Um campo que a IA não trouxe: nulo, texto vazio ou lista vazia.
function vazioCampo(x: unknown): boolean {
  return x == null || x === "" || (Array.isArray(x) && !x.length);
}
function fontesGrounding(body: any): Fonte[] {
  const chunks = body?.candidates?.[0]?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(chunks)) return [];
  const out: Fonte[] = [];
  for (const ch of chunks) {
    const url = String(ch?.web?.uri || "").trim();
    const titulo = String(ch?.web?.title || url || "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({ titulo: titulo.slice(0, 120), url: url.slice(0, 400) });
    if (out.length >= 8) break;
  }
  return out;
}

async function chamarGemini(
  modelo: string, textoPrompt: string, signal: AbortSignal, maxTokens = 2048, semThinking = true, comGrounding = false,
) {
  // A pesquisa (grounding) precisa de "pensar" para decidir o quê e quando
  // pesquisar: pedir thinkingBudget:0 ao mesmo tempo que se liga o tool
  // google_search passou a ser recusado (400 "Request contains an invalid
  // argument") pelos modelos que ficaram por trás dos ponteiros "-latest".
  // Por isso só se tenta desligar o thinking fora do modo com pesquisa.
  const pedir = (comThinking: boolean) => {
    const generationConfig: Record<string, unknown> = {
      temperature: 0,
      maxOutputTokens: maxTokens,
    };
    if (!comGrounding) generationConfig.response_mime_type = "application/json";
    if (comThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    return fetch(`${GAPI}/models/${modelo}:generateContent?key=${GEMINI_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: textoPrompt }] }],
        generationConfig,
        ...(comGrounding ? { tools: [{ google_search: {} }] } : {}),
      }),
    });
  };
  const tentarThinking = semThinking && !comGrounding;
  let r = await pedir(tentarThinking);
  let txt = await r.text();
  // Rede de segurança: se MESMO ASSIM vier 400 com o thinking pedido,
  // repete sem ele antes de desistir — mais barato do que ficar preso a
  // adivinhar qual é a próxima restrição que a Google vai impor.
  if (!r.ok && r.status === 400 && tentarThinking) {
    r = await pedir(false);
    txt = await r.text();
  }
  if (!r.ok) {
    let msg = "";
    try { msg = JSON.parse(txt)?.error?.message ?? ""; } catch (_) { /**/ }
    return { ok: false as const, status: r.status, erro: msg || txt.slice(0, 800) };
  }
  let body: any = null;
  try { body = JSON.parse(txt); } catch (_) { /**/ }
  const usage = usageMetadata(body);
  const cand = body?.candidates?.[0];
  const motivo = String(cand?.finishReason ?? "");
  const bruto = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();
  // Um 200 com o corpo VAZIO não é o mesmo que uma resposta que não se
  // entendeu: ali houve texto, aqui o modelo gastou o orçamento a pensar e
  // não escreveu nada. O `finishReason` é o que diz qual dos dois foi —
  // ver o CLAUDE.md da WineCatalog, "O 200 vazio". (A escada já trata do
  // resto: uma falha TÉCNICA destas escala para o modelo seguinte.)
  if (!bruto) return { ok: false as const, status: 502, erro: `o modelo não devolveu resposta (${motivo || "vazia"})`, usage };
  const parsed = extrairJson(bruto);
  if (!parsed) return { ok: false as const, status: 502, erro: `resposta ilegível do modelo (${motivo || "sem finishReason"})`, usage };
  return { ok: true as const, parsed, fontes: comGrounding ? fontesGrounding(body) : [], usage,
    pesquisou: comGrounding ? fezPesquisa(body) : null };
}

async function produzirFicha(
  modoIA: "gratis" | "premium",
  nome: string, ano: number | null, produtor: string, regiao: string,
  quem: string | null, signal: AbortSignal, budgetMs: number,
  campos: string[] | null = null, colheitaEspecifica: boolean = false,
  tipo: string = "", notas: string = "", sites: string[] = [], profunda: boolean = false,
  vinhoGravado: boolean = false,
  // As páginas coladas nos sites (ver "AS PÁGINAS DOS SITES") e o visto
  // "Usar só a informação destes sites".
  paginasDadas: string[] = [], soSites: boolean = false,
): Promise<Res> {
  if (!GEMINI_KEY) return { ok: false, status: 503, erro: "a IA com pesquisa web ainda não está configurada (falta GEMINI_API_KEY)" };
  const inicio = Date.now();
  // A nota da colheita traz a de todas; sem colheita, só a de todas.
  campos = camposComGlobal(campos, ano);
  const chave = chaveCache(modoIA, nome, ano, produtor, regiao, tipo, notas, sites, campos, colheitaEspecifica);
  // A profunda existe para refazer o que veio de memória: nem a cache nem o
  // catálogo (onde essa resposta de memória foi parar) respondem por ela.
  // COM SITES também não (27/09/2026): quem os escreve quer que se LEIAM
  // agora — e o catálogo já respondeu na etapa 1 do ecrã, à parte.
  const semAtalhos = profunda || sites.length > 0;
  const cache = semAtalhos ? null : await cacheLer(chave, signal);
  if (cache?.resultado) {
    await registar("ok", {
      nome, ano, modo: "cache", modelo: cache.modelo, ms: Date.now() - inicio,
      campos: Object.keys(cache.resultado).length,
    }, quem);
    return {
      ok: true,
      corpo: { ...cache.resultado, fontes: cache.fontes.slice(0, 8), pesquisa: true, plano: modoIA, modelo: cache.modelo, geradoEm: new Date().toISOString() },
    };
  }

  /* ── O catálogo partilhado, antes de gastar ──
     Duas perguntas, por esta ordem: o que é que já se sabe deste vinho, e
     o que é que SOBRA por saber. Se não sobrar nada, não há chamada
     nenhuma — nem ao Gemini, nem à pesquisa externa. Se sobrar alguma
     coisa, vai à IA só ESSA: um pedido mais estreito é também um pedido
     mais barato e melhor respondido (é a mesma razão por que a app já
     deixa escolher os campos, ver `iaEscolher`). */
  // Sem colheita, a janela de consumo nem se pede — nem ao catálogo (que
  // responderia com a de uma colheita qualquer) nem à IA.
  // Nem o ano, que sem ano no pedido não se procura (ver `normalizar`).
  const pedidos = (campos && campos.length ? campos : Object.keys(CAMPOS))
    .filter((k) => ano !== null || (k !== "beber_de" && k !== "beber_ate" && k !== "ano" && !(k in PAR_VIVINO)));
  const conhecido = semAtalhos ? null : await catalogoProcurar(nome, produtor, ano, signal, tipo);
  const doCatalogo = conhecido ? catalogoResponde(conhecido, pedidos) : {};
  const emFalta = pedidos.filter((k) => !(k in doCatalogo));

  if (Object.keys(doCatalogo).length && !emFalta.length) {
    await registar("ok", {
      nome, ano, modo: "catalogo", ms: Date.now() - inicio,
      campos: Object.keys(doCatalogo).length,
      catalogo_exato: conhecido?.exato, catalogo_em: conhecido?.atualizadoEm,
    }, quem);
    return {
      ok: true,
      corpo: {
        ...doCatalogo,
        fontes: conhecido?.fontes ?? [],
        pesquisa: true, plano: modoIA, modelo: "", modo: "catalogo",
        // A app mostra isto a quem procurou: uma ficha que apareceu do
        // nada, sem espera nem custo, merece dizer de onde veio.
        origem: "catalogo",
        catalogoEm: conhecido?.atualizadoEm ?? "",
        catalogoAno: conhecido?.ano ?? null,
        catalogoMesmoAno: conhecido?.mesmoAno ?? null,
        custoEstimadoEur: 0,
        geradoEm: new Date().toISOString(),
      },
    };
  }

  /* Daqui para baixo, a IA é chamada só pelo que FALTA — mas só se o
     catálogo tiver dado alguma coisa. Se não deu nada, o pedido segue tal e
     qual veio: com `campos: null` (procurar tudo) o prompt NÃO leva a lista
     de campos, e passar-lhe agora os 22 nomes era mudar-lhe o texto sem
     necessidade nenhuma — e a lista dos 22 é exatamente o que faz o modelo
     "andar atrás de tudo e voltar com meia dúzia de coisas mornas". */
  const campos_ia = Object.keys(doCatalogo).length ? emFalta
    : (campos && ano === null ? campos.filter((k) => k !== "beber_de" && k !== "beber_ate") : campos);

  // Os `sites` de confiança: os que são domínios ganham uma procura só
  // deles no Serper (ver `dominioDe`), e a página que ela devolver abre-se,
  // como as coladas (ver "AS PÁGINAS DOS SITES"); no grounding só podem ir
  // como pedido no texto (o `google_search` não tem esse parâmetro na API).
  const dominios = [...new Set(sites.map(dominioDe).filter(Boolean))];
  const query = [nome, ano || "", produtor, regiao, notas, "vivino garrafeira nacional vinho portugal"]
    .filter(Boolean).join(" ");
  let confianca: Record<string, number> | null = null;
  let consultasFeitas: string[] = [];
  /* OS DOIS PACOTES (27/09/2026, o dono das apps):
     · COMPLETO (`premium`): primeiro a pesquisa NOSSA (Serper, geral + uma
       consulta ao Vivino, e o Gemini só a ler os resultados) e depois, SÓ
       para os campos que ela não trouxe, o grounding. Tudo de seguida, uma
       procura só aos olhos de quem procura. O Serper é o que garante que se
       pesquisou mesmo; o grounding tapa o que os resultados não tinham.
     · INTERMÉDIO (`gratis`): só o grounding. O Serper gasta créditos que um
       dia se pagam; o grounding, com o modelo a responder quase sempre de
       memória, custa pouco (ver "De memória ou pesquisado").
     A "profunda" deixou de ser um caminho à parte: é o pacote completo.
     AS PÁGINAS COLADAS leem-se nos dois (abrir uma página não custa nada);
     procurar DENTRO de um site é o Serper, e por isso só no completo.
     `soSites` ("Usar só a informação destes sites"): só as páginas e as
     procuras nos sites — nem a consulta geral, nem a do Vivino se ele não
     for um dos sites, nem o grounding. */
  const usarSerper = (modoIA === "premium" || profunda) && !!SEARCH_API_KEY;
  let pesquisa: PesquisaWeb = { texto: "", fontes: [], status: "grounding:google_search" };
  let serperConsultas = 0;
  const ehVivino = (d: string) => doSite(`https://${d}/`, "vivino.com");
  const dadas = paginasDadas.filter((u) => !doSite(u, "vivino.com"));
  const abrirDadas = Promise.all(dadas.map((u) => abrirPagina(u, true, signal)));
  const comPagina = dadas.map(siteDe);
  const procurarEm = dominios.filter((d) => !ehVivino(d) && !comPagina.some((sd) => doSite(`https://${sd}/`, d)));
  const resultados: Resultado[] = [];
  const achadas: string[] = [];
  let paginasRes: PaginaRes[] = [];
  if (usarSerper) {
    const qVivino = `"${nome.replace(/"/g, "")}" ${produtor} site:vivino.com`.replace(/\s+/g, " ");
    const quem_ = [nome, ano || "", produtor].filter(Boolean).join(" ");
    // As procuras nos sites vão À FRENTE, para caberem no corte do texto.
    const consultas: { q: string; dominio?: string }[] = procurarEm.map((d) => ({ q: `${quem_} site:${d}`, dominio: d }));
    if (!soSites) consultas.push({ q: query });
    if (!soSites || dominios.some(ehVivino)) consultas.push({ q: qVivino, dominio: "vivino.com" });
    const rs = await Promise.allSettled(consultas.map((c) => serperConsulta(c.q, signal)));
    if (signal.aborted) throw new DOMException("timeout", "AbortError");
    serperConsultas = consultas.length;
    consultasFeitas = consultas.map((c) => c.q);
    rs.forEach((r, i) => {
      const d = consultas[i].dominio;
      if (r.status !== "fulfilled") {
        if (d && d !== "vivino.com") paginasRes.push({ site: d, estado: "erro", motivo: "a procura neste site falhou" });
        return;
      }
      // Com o `soSites`, um resultado de fora dos sites não entra.
      const rows = soSites && d ? r.value.filter((x) => doSite(x.url, d)) : r.value;
      resultados.push(...rows);
      if (d && d !== "vivino.com") {
        const pr = paginaDoResultado(rows, d);
        if (pr) achadas.push(pr.url);
        else paginasRes.push({ site: d, estado: "nao_encontrada" });
      }
    });
    const falhou = rs.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (falhou && !resultados.length) {
      // Sem os resultados do Serper não se desiste: segue-se com o que houver
      // (as páginas coladas, e o grounding fora do "só estes sites").
      await registar("erro", { passo: "search-api", erro: String((falhou.reason as Error)?.message ?? falhou.reason).slice(0, 300) }, quem);
    }
  } else {
    // Sem o Serper não há como procurar dentro de um site.
    procurarEm.forEach((d) => paginasRes.push({ site: d, estado: "sem_pesquisa" }));
  }
  const [abertasDadas, abertasAchadas] = await Promise.all([abrirDadas, Promise.all(achadas.map((u) => abrirPagina(u, false, signal)))]);
  // Uma página colada que não se deixou ler (403, desafio anti-bots, 404):
  // fica o que o Google mostra desse site, se houver pesquisa.
  const semLeitura = [...new Set(abertasDadas.filter((p) => p.estado !== "lida").map((p) => p.site))]
    .filter((d) => d && !procurarEm.includes(d));
  if (usarSerper && semLeitura.length) {
    const qs = semLeitura.map((d) => `${[nome, ano || "", produtor].filter(Boolean).join(" ")} site:${d}`);
    const rs2 = await Promise.allSettled(qs.map((q) => serperConsulta(q, signal)));
    serperConsultas += qs.length;
    consultasFeitas = [...consultasFeitas, ...qs];
    rs2.forEach((r, i) => { if (r.status === "fulfilled") resultados.push(...r.value.filter((x) => doSite(x.url, semLeitura[i]))); });
  }
  const abertas = [...abertasDadas, ...abertasAchadas];
  paginasRes = [...abertas.map(paginaRes), ...paginasRes];
  const paginasLidas = abertas.filter((p) => p.estado === "lida").length;
  const ev = montarEvidencia(abertas, resultados, ano, dominios);
  if (ev.texto) {
    pesquisa = { texto: ev.texto, fontes: ev.fontes, status: serperConsultas ? `search-api:${extrairHost(SEARCH_API_URL) || "externa"}` : "paginas" };
  }
  // Sem pesquisa nem páginas, os sites foram só texto no pedido — e é isso
  // que o ecrã diz quando não há contagem.
  if (dominios.length && (serperConsultas || abertas.length)) confianca = ev.confianca;
  const temEvidencia = !!pesquisa.texto;
  if (soSites && !temEvidencia) {
    const porque = paginasRes.map(paginaEmFrase).join("; ") ||
      (usarSerper ? "nenhum dos sites é um domínio ou um link" : "sem a pesquisa do pacote completo, só se leem links de páginas — cola o link da página do vinho");
    await registar("erro", { passo: "so_sites_vazio", nome, sites, paginas: paginasRes,
      ...(serperConsultas ? { serper_consultas: serperConsultas, consultas: consultasFeitas } : {}) }, quem);
    return { ok: false, status: 404, erro: `não consegui ler nada dos sites escolhidos — ${porque}.` };
  }

  const tentativas: { modelo: string; modo: string; estado: number | string; usageMetadata?: UsageMetadata }[] = [];
  let usageTotal: UsageMetadata | null = null;
  const hoje = new Date().toISOString().slice(0, 10);
  // Uma fase = uma pergunta ao Gemini (o barato, e o maior só se o barato
  // falhar tecnicamente). `comSerper`: lê os resultados do Serper, sem tool;
  // senão, grounding.
  const fase = async (comSerper: boolean, camposFase: string[] | null) => {
    const texto = comSerper
      ? prompt(nome, ano, produtor, regiao, tipo, notas, hoje, camposFase, pesquisa.texto, colheitaEspecifica, sites, soSites)
      : promptComGrounding(nome, ano, produtor, regiao, tipo, notas, sites, hoje, camposFase, colheitaEspecifica);
    let fontesG: Fonte[] = [];
    const run = async (modelo: string, modo: string, maxTokens: number, semThinking: boolean) => {
      const ms = Math.max(8_000, Math.min(GEMINI_TIMEOUT_MS, budgetMs - (Date.now() - inicio) - 2_000));
      if (ms < 2_000) return null;
      const { signal: sp, limpar } = comLimiteProprio(signal, ms);
      try {
        const g = await chamarGemini(modelo, texto, sp, maxTokens, semThinking, !comSerper);
        limpar();
        usageTotal = somarUsage(usageTotal, g.usage ?? null);
        tentativas.push({ modelo, modo: (comSerper ? "serper-" : "grounding-") + modo, estado: g.ok ? 200 : g.status, ...(g.usage ? { usageMetadata: g.usage } : {}) });
        if (g.ok && g.fontes?.length) fontesG = g.fontes;
        return g;
      } catch (e) {
        limpar();
        if (signal.aborted) throw e;
        tentativas.push({ modelo, modo, estado: "presa" });
        return null;
      }
    };
    const primeira = await run(MODELO_BARATO, "barato", 1800, true);
    let modelo = MODELO_BARATO, modo = "barato";
    let parsed: any = primeira && primeira.ok ? primeira.parsed : null;
    let erro = primeira && !primeira.ok ? primeira.erro : "";
    let pesquisouF: boolean | null = primeira && primeira.ok ? primeira.pesquisou : null;
    // Só escala em falha TÉCNICA do barato — nunca por "poucos campos": um
    // modelo maior não inventa o que a pesquisa não encontrou.
    if ((!primeira || !primeira.ok) && MODELO_ESCALADO !== MODELO_BARATO) {
      const segunda = await run(MODELO_ESCALADO, "escalado", 2800, false);
      if (segunda && segunda.ok) {
        modelo = MODELO_ESCALADO; modo = "escalado";
        parsed = segunda.parsed; pesquisouF = segunda.pesquisou;
      } else if (segunda && !segunda.ok) erro = segunda.erro;
    }
    // Com o Serper a pesquisa foi nossa: houve pesquisa, garantida.
    if (comSerper && parsed) pesquisouF = true;
    return {
      ficha: parsed ? normalizar(parsed, ano, camposFase) : null,
      // De onde veio cada campo (só na leitura da base de evidência).
      deOnde: comSerper ? parsed?.deOnde : undefined,
      pesquisou: pesquisouF, erro, modelo, modo,
      fontes: comSerper ? pesquisa.fontes : (pesquisouF ? fontesG : []),
    };
  };

  // Com base de evidência (o Serper e/ou as páginas), o Gemini só a lê;
  // sem ela, grounding.
  const f1 = await fase(temEvidencia, campos_ia);
  let ficha = f1.ficha;
  let pesquisou = f1.pesquisou;
  let usadoModelo = f1.modelo, usadoModo = f1.modo, erroUltimo = f1.erro;
  let fontesIA: Fonte[] = f1.fontes;
  // Os campos que só o grounding trouxe — dizem-se como tal no ecrã.
  const doGround = new Set<string>();
  // O grounding só pelo que a base de evidência não trouxe, logo a seguir —
  // nunca com o "só estes sites": o que eles não disserem fica vazio.
  if (temEvidencia && !soSites) {
    const quis = (campos_ia && campos_ia.length ? campos_ia : pedidos);
    const faltam = quis.filter((k) => !(ficha && !vazioCampo((ficha as any)[k])) && !(k in doCatalogo));
    if (faltam.length && budgetMs - (Date.now() - inicio) > 15_000) {
      const f2 = await fase(false, faltam);
      if (f2.ficha) {
        for (const k of Object.keys(f2.ficha)) if (k !== "aviso" && k !== "ano" && vazioCampo((ficha as any)?.[k])) doGround.add(k);
        ficha = { ...f2.ficha, ...(ficha ?? {}) };
        fontesIA = [...fontesIA, ...f2.fontes];
        usadoModelo = f1.ficha ? `${f1.modelo} + ${f2.modelo}` : f2.modelo;
        if (!f1.ficha) pesquisou = f2.pesquisou;
      } else if (!ficha) erroUltimo = f2.erro || erroUltimo;
    }
  }

  if (!ficha && !Object.keys(doCatalogo).length) {
    await registar("erro", {
      passo: "vazio", nome, modo: usadoModo, modelo: usadoModelo,
      ...(paginasRes.length ? { paginas: paginasRes } : {}), ...(soSites ? { so_sites: true } : {}),
      tentativas, erro: erroUltimo.slice(0, 300), ms: Date.now() - inicio,
      ...(usageTotal ? { usageMetadata: usageTotal } : {}),
    }, quem);
    return { ok: false, status: 404, erro: `não encontrei informação fiável sobre "${nome}". Confere o nome do rótulo e tenta outra vez.` };
  }

  /* O que a IA acabou de descobrir vai para o catálogo — é isto que faz a
     próxima pessoa (nesta app ou na WineSelection) não pagar a mesma
     pergunta. Só o que veio da IA: o que já era do catálogo voltar para lá
     não acrescenta nada e só remexia as datas de quem lá pôs primeiro.

     MAS SÓ COM UM NOME CONFIRMADO (27/09/2026). No vinho novo o formulário
     é a confirmação: o nome que se procura é o que a pessoa escreveu, e ela
     ainda o pode corrigir antes de gravar. Alguém escreveu "Cristo vinhas
     velhas", a IA respondeu pelo Quinta do Crasto, a pessoa gravou "Crasto
     Vinhas Velhas" (na wishlist) — e o catálogo ficou com uma linha
     "Cristo vinhas velhas", sem produtor, que ninguém tinha, e que só os
     Duplicados da WineCatalog apanharam. Por isso, com o vinho por gravar
     (`vinhoId` nulo) e um nome que o catálogo ainda não conhece, NÃO se
     escreve: a linha nasce quando o vinho for gravado, pelo trigger
     `vinhos_catalogo`, com o nome final (e a ficha da IA que ficou no
     formulário). Um nome que o catálogo já conhece, ou um vinho já gravado,
     escreve-se como sempre. O que se perde: a ficha da IA de um desejo com
     um nome novo (a wishlist não vai ao catálogo — é a regra dela). */
  /* DE ONDE VEIO CADA CAMPO (27/09/2026): o número que o modelo deu em
     `deOnde` → a página ou o resultado; o que só o grounding trouxe diz-se
     como tal. Com o "só estes sites", um campo sem origem sai — não há como
     dizer que veio deles (o ano e o aviso não são campos da ficha). */
  const origemCampos: Record<string, Origem> = ficha ? origemDosCampos(f1.deOnde, ev.lista, ficha, ano) : {};
  for (const k of doGround) if (ficha && k in ficha && !origemCampos[k]) origemCampos[k] = { url: "", site: "", titulo: "pesquisa Google", google: true };
  const semFonte: string[] = [];
  if (soSites && ficha) {
    for (const k of Object.keys(ficha)) {
      if (k === "aviso" || k === "ano" || origemCampos[k]) continue;
      delete (ficha as Record<string, unknown>)[k];
      semFonte.push(k);
    }
  }

  let catalogoAdiado = false;
  if (ficha) {
    const nomeConfirmado = vinhoGravado || !!conhecido ||
      (semAtalhos && !!(await catalogoProcurar(nome, produtor, ano, signal, tipo)));
    const { aviso: _aviso, ...factos } = ficha as Record<string, unknown>;
    if (!Object.keys(factos).some((k) => k !== "ano")) {
      // Nada a levar (o "só estes sites" deixou tudo de fora).
    } else if (nomeConfirmado) {
      await catalogoJuntar(
        nome, produtor, ano, factos, `vinho-info-${modoIA}`,
        fontesIA, signal,
      );
    } else catalogoAdiado = true;
  }

  /* O catálogo por baixo, a IA por cima: a IA só foi chamada pelo que
     FALTAVA, por isso não há aqui um a tapar o outro — mas a ordem fica
     explícita, que é o que se quer ler daqui a um ano. */
  ficha = { ...doCatalogo, ...(ficha ?? {}) };

  // Com sites não se lê a cache (ver `semAtalhos`), por isso também não se
  // escreve: era uma linha que ninguém ia ler.
  if (!semAtalhos) await cacheEscrever(
    chave,
    { nome, ano, produtor, regiao, tipo, notas, sites, campos, query, fonte: pesquisa.status, modo_ia: modoIA },
    // `pesquisaWeb` vai com a cache para o botão da profunda não se perder
    // quando a mesma procura volta a sair daqui.
    { ...ficha, ...(pesquisou !== null ? { pesquisaWeb: pesquisou } : {}) },
    fontesIA,
    usadoModelo,
    usadoModo,
    signal,
  );
  const dur = Date.now() - inicio;
  const custoEstimado = (usadoModo === "barato" ? 0.001 : 0.0035) + serperConsultas * 0.001; // o Serper à parte, ~1 $ por 1000 consultas
  await registar("ok", {
    nome, ano, modo: usadoModo, modelo: usadoModelo,
    pesquisa: pesquisa.status, campos: Object.keys(ficha).length,
    // Quantos campos é que o catálogo poupou nesta procura: é por aqui que
    // se vê se isto está a valer a pena (Definições › Diagnóstico).
    catalogo_campos: Object.keys(doCatalogo).length,
    ia_campos: emFalta.length,
    // O vinho novo com um nome que o catálogo não conhece: vai quando for gravado.
    ...(catalogoAdiado ? { catalogo: "adiado" } : {}),
    ...(pesquisou !== null ? { pesquisaWeb: pesquisou } : {}), ...(profunda ? { profunda: true } : {}),
    ...(serperConsultas ? { serper_consultas: serperConsultas, consultas: consultasFeitas } : {}),
    // O que se fez com os sites de confiança: sem isto não havia maneira de
    // saber se tinham servido para alguma coisa.
    ...(sites.length ? { sites, ...(confianca ? { confianca } : {}) } : {}),
    ...(paginasRes.length ? { paginas: paginasRes, paginas_lidas: paginasLidas } : {}),
    ...(soSites ? { so_sites: true, ...(semFonte.length ? { sem_fonte: semFonte } : {}) } : {}),
    ms: dur, tentativas, custo_estimado_eur: custoEstimado,
    ...(usageTotal ? { usageMetadata: usageTotal } : {}),
  }, quem);
  return {
    ok: true,
    corpo: {
      ...ficha,
      fontes: [
        ...fontesIA,
        ...(Object.keys(doCatalogo).length ? (conhecido?.fontes ?? []) : []),
      ].filter((f, i, a) => a.findIndex((x) => x.url === f.url) === i).slice(0, 8),
      ...(Object.keys(doCatalogo).length
        ? { origem: "misto", catalogoCampos: Object.keys(doCatalogo), catalogoEm: conhecido?.atualizadoEm ?? "" }
        : {}),
      pesquisa: true,
      plano: modoIA,
      ...(pesquisou !== null ? { pesquisaWeb: pesquisou } : {}),
      ...(profunda ? { profunda: true } : {}),
      ...(sites.length ? {
        sites, confianca,
        ...(paginasRes.length ? { paginas: paginasRes } : {}),
        ...(soSites ? { soSites: true, ...(semFonte.length ? { semFonte } : {}) } : {}),
      } : {}),
      // De onde veio cada campo (a página, o resultado, ou o grounding) —
      // a app mostra-o ao lado de cada proposta.
      ...(Object.keys(origemCampos).length ? { origemCampos } : {}),
      modelo: usadoModelo,
      modo: usadoModo,
      custoEstimadoEur: custoEstimado,
      ...(usageTotal ? { usageMetadata: usageTotal } : {}),
      ...(tentativas.length ? { tentativas } : {}),
      geradoEm: new Date().toISOString(),
    },
  };
}

/* ── O TRABALHO A SÉRIO, EM LOTE ──
   Mesma lógica do `produzirFicha` de um vinho só — catálogo primeiro, IA só
   pelo que falta — aplicada a uma LISTA de vinhos, com no máximo UMA
   chamada ao Gemini no total (nunca uma por vinho). Se o catálogo já
   resolver todos os vinhos para os campos pedidos, nem essa chamada
   acontece. */
async function produzirFichaLote(
  modoIA: "gratis" | "premium", vinhos: VinhoLote[], campos: string[],
  quem: string | null, signal: AbortSignal, budgetMs: number,
): Promise<Res> {
  if (!GEMINI_KEY) return { ok: false, status: 503, erro: "a IA com pesquisa web ainda não está configurada (falta GEMINI_API_KEY)" };
  const inicio = Date.now();

  type Item = { v: VinhoLote; conhecido: Conhecido | null; doCatalogo: Record<string, unknown>; emFalta: string[] };
  const itens: Item[] = [];
  for (const v of vinhos) {
    // Sem colheita, a janela de consumo não se pede (ver `produzirFicha`).
    const pedidosV = (camposComGlobal(campos, v.ano) ?? campos)
      .filter((k) => v.ano !== null || (k !== "beber_de" && k !== "beber_ate" && !(k in PAR_VIVINO)));
    const conhecido = await catalogoProcurar(v.nome, v.produtor, v.ano, signal, v.tipo);
    const doCatalogo = conhecido ? catalogoResponde(conhecido, pedidosV) : {};
    const emFalta = pedidosV.filter((k) => !(k in doCatalogo));
    itens.push({ v, conhecido, doCatalogo, emFalta });
  }
  const precisamIA = itens.filter((it) => it.emFalta.length > 0);
  const catalogoVinhos = itens.length - precisamIA.length;

  // Todos os vinhos já vinham completos do catálogo: nem vale a pena ir ao Gemini.
  if (!precisamIA.length) {
    const resultados = itens.map((it) => ({
      id: it.v.id, encontrado: true, ...it.doCatalogo,
      origem: "catalogo", catalogoEm: it.conhecido?.atualizadoEm ?? "",
    }));
    await registar("ok", {
      nome: `lote de ${vinhos.length}`, modo: "catalogo-lote", ms: Date.now() - inicio,
      vinhos: vinhos.length, catalogo_vinhos: catalogoVinhos,
    }, quem);
    return {
      ok: true,
      corpo: { resultados, pesquisa: true, plano: modoIA, modelo: "", modo: "catalogo", custoEstimadoEur: 0, geradoEm: new Date().toISOString() },
    };
  }

  // A IA só é chamada pelos campos que ainda faltam a PELO MENOS UM vinho —
  // a mesma poupança do `campos_ia` de um vinho só, aplicada ao lote.
  const camposIA = [...new Set(precisamIA.flatMap((it) => it.emFalta))];
  const hoje = new Date().toISOString().slice(0, 10);

  const pesquisasPorVinho = new Map<number, PesquisaWeb>();
  if (modoIA === "gratis") {
    // Cada vinho precisa da SUA pesquisa (não há como pedir "isto tudo" a um
    // motor de busca) — mas o Gemini que lê essas pesquisas só é chamado
    // UMA vez, no fim, para todos. É aí que está a poupança neste motor.
    for (const it of precisamIA) {
      const query = [it.v.nome, it.v.ano || "", it.v.produtor, it.v.regiao, "vivino garrafeira nacional vinho portugal"]
        .filter(Boolean).join(" ");
      try {
        pesquisasPorVinho.set(it.v.id, await obterResultadosPesquisa(query, signal, it.v.ano));
      } catch (_) {
        // Um vinho sem resultados não deita o lote todo abaixo — fica sem
        // evidência, e o prompt já sabe responder "não encontrei" para ele.
        pesquisasPorVinho.set(it.v.id, { texto: "", fontes: [], status: "sem-resultados" });
      }
    }
  }

  const texto0 = modoIA === "premium"
    ? promptLoteComGrounding(precisamIA.map((it) => it.v), camposIA, hoje)
    : promptLote(precisamIA.map((it) => ({ ...it.v, evidencia: pesquisasPorVinho.get(it.v.id)?.texto || "" })), camposIA, hoje);

  const tentativas: { modelo: string; modo: string; estado: number | string; usageMetadata?: UsageMetadata }[] = [];
  let usageTotal: UsageMetadata | null = null;
  let fontesGround: Fonte[] = [];
  const run = async (modelo: string, modo: string, maxTokens: number, semThinking: boolean) => {
    const ms = Math.max(8_000, Math.min(GEMINI_TIMEOUT_MS_LOTE, budgetMs - (Date.now() - inicio) - 2_000));
    if (ms < 2_000) return null;
    const { signal: sp, limpar } = comLimiteProprio(signal, ms);
    try {
      const g = await chamarGemini(modelo, texto0, sp, maxTokens, semThinking, modoIA === "premium");
      limpar();
      usageTotal = somarUsage(usageTotal, g.usage ?? null);
      tentativas.push({ modelo, modo, estado: g.ok ? 200 : g.status, ...(g.usage ? { usageMetadata: g.usage } : {}) });
      if (g.ok && g.fontes?.length) fontesGround = g.fontes;
      return g;
    } catch (e) {
      limpar();
      if (signal.aborted) throw e;
      tentativas.push({ modelo, modo, estado: "presa" });
      return null;
    }
  };

  // Teto de tokens proporcional ao tamanho do lote — um prompt de vários
  // vinhos devolve um JSON bem maior do que o de um vinho só.
  const maxTokBarato = Math.min(8000, 700 + 450 * precisamIA.length);
  const maxTokEscalado = Math.min(8000, 1000 + 600 * precisamIA.length);

  const primeira = await run(MODELO_BARATO, "barato", maxTokBarato, true);
  let usadoModelo = MODELO_BARATO, usadoModo = "barato";
  let pesquisouLote: boolean | null = primeira && primeira.ok ? primeira.pesquisou : null;
  let parsed: any = primeira && primeira.ok ? primeira.parsed : null;
  let erroUltimo = primeira && !primeira.ok ? primeira.erro : "";

  // Mesma regra do vinho só: só escala em falha TÉCNICA, nunca por
  // "poucos campos" — um modelo maior não inventa o que não se encontrou, e
  // no premium escalar por qualidade pagava a pesquisa a dobrar sem ganho.
  const falhouTecnicamente = !primeira || !primeira.ok;
  if (falhouTecnicamente && MODELO_ESCALADO !== MODELO_BARATO) {
    const segunda = await run(MODELO_ESCALADO, "escalado", maxTokEscalado, false);
    if (segunda && segunda.ok) { usadoModelo = MODELO_ESCALADO; usadoModo = "escalado"; parsed = segunda.parsed; pesquisouLote = segunda.pesquisou; }
    else if (segunda && !segunda.ok) erroUltimo = segunda.erro;
  }

  const lista: any[] = parsed && Array.isArray(parsed.resultados) ? parsed.resultados : [];
  if (!lista.length && !catalogoVinhos) {
    await registar("erro", {
      passo: "vazio", nome: `lote de ${vinhos.length}`, modo: usadoModo, modelo: usadoModelo,
      tentativas, erro: erroUltimo.slice(0, 300), ms: Date.now() - inicio,
      ...(usageTotal ? { usageMetadata: usageTotal } : {}),
    }, quem);
    return { ok: false, status: 404, erro: "não consegui pesquisar nenhum destes vinhos — tenta outra vez daqui a pouco" };
  }

  const porId = new Map(lista.map((r) => [Number(r?.id), r]));
  const resultados: Record<string, unknown>[] = [];
  for (const it of itens) {
    if (!it.emFalta.length) {
      resultados.push({ id: it.v.id, encontrado: true, ...it.doCatalogo, origem: "catalogo", catalogoEm: it.conhecido?.atualizadoEm ?? "" });
      continue;
    }
    const raw = porId.get(it.v.id);
    const fichaIA = raw && raw.encontrado !== false ? normalizar(raw, it.v.ano, it.emFalta) : null;
    if (fichaIA) {
      const { aviso: _aviso, ...factos } = fichaIA as Record<string, unknown>;
      await catalogoJuntar(
        it.v.nome, it.v.produtor, it.v.ano, factos, `vinho-info-${modoIA}-lote`,
        (modoIA === "premium" ? fontesGround : (pesquisasPorVinho.get(it.v.id)?.fontes ?? [])), signal,
      );
    }
    const fichaFinal = { ...it.doCatalogo, ...(fichaIA ?? {}) };
    resultados.push({
      id: it.v.id,
      encontrado: !!(fichaIA || Object.keys(it.doCatalogo).length),
      ...fichaFinal,
      ...(Object.keys(it.doCatalogo).length ? { origem: fichaIA ? "misto" : "catalogo" } : {}),
      ...(raw && raw.aviso ? { aviso: texto(raw.aviso, 300) } : {}),
    });
  }

  const dur = Date.now() - inicio;
  const custoEstimado = usadoModo === "barato" ? 0.001 : 0.0035;
  await registar("ok", {
    nome: `lote de ${vinhos.length}`, modo: usadoModo, modelo: usadoModelo,
    vinhos: vinhos.length, catalogo_vinhos: catalogoVinhos, ia_vinhos: precisamIA.length,
    ia_campos: camposIA.length, ms: dur, tentativas, custo_estimado_eur: custoEstimado,
    ...(pesquisouLote !== null ? { pesquisaWeb: pesquisouLote } : {}),
    ...(usageTotal ? { usageMetadata: usageTotal } : {}),
  }, quem);

  return {
    ok: true,
    corpo: {
      resultados,
      fontes: (modoIA === "premium" ? fontesGround : []).slice(0, 8),
      pesquisa: true, plano: modoIA, modelo: usadoModelo, modo: usadoModo,
      ...(pesquisouLote !== null ? { pesquisaWeb: pesquisouLote } : {}),
      custoEstimadoEur: custoEstimado,
      ...(usageTotal ? { usageMetadata: usageTotal } : {}),
      ...(tentativas.length ? { tentativas } : {}),
      geradoEm: new Date().toISOString(),
    },
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
    if (auth.plano !== "gratis" && auth.plano !== "premium") {
      await registar("erro", { passo: "plano", plano: auth.plano }, quem);
      return json({ error: "não tens acesso à pesquisa por IA — pede ao admin para te atribuir um modo com IA" }, 403);
    }

    const body = await req.json().catch(() => ({}));

    /* ── LOTE: vários vinhos, uma chamada só ──
       Distingue-se do pedido de sempre por trazer `vinhos` (array) em vez de
       `nome` (um vinho só). Sempre assíncrono — o tempo de vários vinhos de
       uma vez não cabe num pedido HTTP normal — e sempre com `campos`
       explícitos: sem eles o prompt "concentra-te nisto" perde sentido, e
       pedir os 22 campos a vários vinhos ao mesmo tempo é exatamente o
       "andar atrás de tudo e voltar com meia dúzia de coisas mornas" que a
       escolha de campos existe para evitar. */
    if (Array.isArray(body?.vinhos)) {
      const vinhosIn = body.vinhos as unknown[];
      if (!vinhosIn.length || vinhosIn.length > LOTE_MAX_VINHOS) {
        await registar("erro", { passo: "lote-tamanho", recebido: vinhosIn.length }, quem);
        return json({ error: `o lote tem de ter entre 1 e ${LOTE_MAX_VINHOS} vinhos` }, 400);
      }
      const vinhos: VinhoLote[] = [];
      for (const rawV of vinhosIn) {
        const r = rawV as Record<string, unknown>;
        const id = typeof r?.id === "number" ? r.id : null;
        const vnome = String(r?.nome ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
        if (id == null || vnome.length < 3) {
          await registar("erro", { passo: "lote-vinho" }, quem);
          return json({ error: "cada vinho do lote precisa de id e nome" }, 400);
        }
        vinhos.push({
          id, nome: vnome,
          ano: anoValido(r?.ano),
          produtor: texto(r?.produtor, 90),
          regiao: texto(r?.regiao, 60),
          tipo: daLista(r?.tipo, TIPOS),
        });
      }
      const camposLote: string[] = Array.isArray(body?.campos)
        ? [...new Set<string>(body.campos.map((c: unknown) => String(c)).filter((c: string) => c in CAMPOS))]
        : [];
      if (!camposLote.length) {
        await registar("erro", { passo: "lote-campos" }, quem);
        return json({ error: "escolhe pelo menos um campo para o lote" }, 400);
      }
      const pedidoModoLote: "gratis" | "premium" = body?.plano === "premium" ? "premium" : "gratis";
      const modoIALote: "gratis" | "premium" = auth.plano === "premium" ? pedidoModoLote : "gratis";

      const analiseId = await criarAnalise(
        authHeader, { vinhos: vinhos.map((v) => v.id), campos: camposLote }, null, quem!, ctrl.signal,
      );
      if (analiseId != null) {
        const dono = quem!;
        EdgeRuntime.waitUntil((async () => {
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), PROC_TIMEOUT_MS);
          try {
            const res = await produzirFichaLote(modoIALote, vinhos, camposLote, dono, c.signal, PROC_TIMEOUT_MS);
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
      // Sem tabela de análises não há modo síncrono para onde cair — o tempo
      // de vários vinhos de uma vez não cabe num pedido HTTP normal.
      return json({ error: "a atualização massiva precisa da tabela `analises` (ver o README) — tenta um vinho de cada vez entretanto" }, 503);
    }

    const nome = String(body?.nome ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (nome.length < 3) {
      await registar("erro", { passo: "nome", recebido: String(body?.nome ?? "").slice(0, 60) }, quem);
      return json({ error: "falta o nome do vinho" }, 400);
    }
    const ano = anoValido(body?.ano);
    const produtor = texto(body?.produtor, 90);
    const regiao = texto(body?.regiao, 60);
    // `tipo`: confirmado pelo `iaCorGuard` antes de chegar aqui.
    const tipo = daLista(body?.tipo, TIPOS);
    /* `notas`/`sites`: contexto LIVRE escrito por quem procura (duas caixas
       de texto na app, não campos fechados) — ajuda a não confundir este
       vinho com um homónimo ("grande reserva", "edição limitada", …) e a
       dar prioridade a fontes em que a pessoa confia. Nunca são pedidos de
       volta à IA, só entram no prompt/pesquisa como contexto. */
    // Um domínio fica só o domínio (sem "www.", sem caminho — é o que a
    // contagem `confianca` usa); um nome sem domínio ("Garrafeira Nacional")
    // fica como foi escrito: vai para o prompt, nunca para um `site:`.
    const sites: string[] = Array.isArray(body?.sites)
      ? [...new Set<string>(body.sites.map((s: unknown) => dominioDe(texto(s, 300)) || texto(s, 60)).filter(Boolean))].slice(0, 5)
      : [];
    // Os sites viram só o domínio (acima) — mas um link do Vivino de UM vinho
    // colado ali é a resposta, não uma fonte: guarda-se inteiro, antes de o
    // corte o reduzir a "www.vivino.com", e ganha no fim (`comVivinoDado`).
    // Não vai para as `notas`: essas entram também na consulta da pesquisa
    // externa, e um URL lá dentro estragava-a.
    const vivinoDado = Array.isArray(body?.sites)
      ? (body.sites as unknown[]).map((s) => vivinoLink(texto(s, 300))).find(Boolean) ?? ""
      : "";
    // E um link de uma PÁGINA de outro site abre-se e lê-se (ver "AS PÁGINAS
    // DOS SITES"); o domínio dela fica nos `sites`, como antes.
    const paginasDadas: string[] = Array.isArray(body?.sites)
      ? [...new Set((body.sites as unknown[]).map((s) => paginaDe(texto(s, 400))).filter(Boolean))].slice(0, 5)
      : [];
    // "Usar só a informação destes sites" — sem sites não quer dizer nada.
    const soSites = body?.soSites === true && sites.length > 0;
    const notas = texto(body?.notas, 300);
    const vinhoId = typeof body?.vinhoId === "number" ? body.vinhoId : null;
    /* `campos`: a app diz o que quer que se procure. Só se aceitam nomes
       conhecidos — um nome inventado aqui era um campo a menos no prompt e,
       pior, um filtro que deitava fora a resposta toda lá no fim. Pedir
       todos é o mesmo que não pedir nenhum: procura-se tudo. */
    const campos: string[] | null = Array.isArray(body?.campos)
      ? [...new Set<string>(body.campos.map((c: unknown) => String(c)).filter((c: string) => c in CAMPOS))]
      : null;
    const camposPedidos = campos && campos.length && campos.length < Object.keys(CAMPOS).length ? campos : null;
    const pedidoModo: "gratis" | "premium" = body?.plano === "premium" ? "premium" : "gratis";
    const modoIA: "gratis" | "premium" = auth.plano === "premium" ? pedidoModo : "gratis";
    // Por omissão a pesquisa é sobre o vinho em geral (ver a regra do
    // Vivino em `regraVivino`) — só se torna estrita quando o ecrã de
    // escolha de campos manda isto explicitamente.
    const colheitaEspecifica = body?.colheitaEspecifica === true;
    // Pesquisa profunda: só o admin, e só no modo com grounding (é o único
    // em que o modelo pode escolher não pesquisar; o grátis já é Serper).
    let profunda = false;
    if (body?.profunda === true) {
      if (!(await souAdmin(authHeader, ctrl.signal))) {
        await registar("erro", { passo: "profunda_nao_admin" }, quem);
        return json({ error: "a pesquisa profunda é só para o admin" }, 403);
      }
      profunda = modoIA === "premium";
    }

    /* ── MODO ASSÍNCRONO ──
       Responde já com o `id` e faz o trabalho depois, com muito mais tempo
       do que um pedido HTTP aguenta. Se a tabela `analises` ainda não
       existir, `criarAnalise` devolve null e cai-se no modo síncrono em vez
       de rebentar. */
    if (body?.assincrono === true) {
      const analiseId = await criarAnalise(authHeader, { nome, ano, produtor, regiao, tipo, notas, sites, ...(soSites ? { soSites } : {}), campos: camposPedidos }, vinhoId, quem!, ctrl.signal);
      if (analiseId != null) {
        const dono = quem!;
        // NÃO faz await: o trabalho pesado sobrevive ao pedido original.
        EdgeRuntime.waitUntil((async () => {
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), PROC_TIMEOUT_MS);
          try {
          const res = comVivinoDado(await produzirFicha(modoIA, nome, ano, produtor, regiao, dono, c.signal, PROC_TIMEOUT_MS, camposPedidos, colheitaEspecifica, tipo, notas, sites, profunda, vinhoId !== null, paginasDadas, soSites), vivinoDado, camposPedidos);
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

    const res = comVivinoDado(await produzirFicha(modoIA, nome, ano, produtor, regiao, quem, ctrl.signal, TIMEOUT_MS, camposPedidos, colheitaEspecifica, tipo, notas, sites, profunda, vinhoId !== null, paginasDadas, soSites), vivinoDado, camposPedidos);
    return res.ok ? json(res.corpo) : json({ error: res.erro }, res.status);
  } catch (e) {
    const err = e as Error, timeout = err.name === "AbortError";
    await registar("erro", { passo: timeout ? "timeout" : "excecao", erro: String(err.message).slice(0, 500) }, quem);
    if (timeout) return json({ error: "a procura demorou demasiado — tenta outra vez daqui a pouco" }, 504);
    return json({ error: err.message }, 500);
  } finally { clearTimeout(timer); }
});
