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
const CACHE_VERSAO = "v2";
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
  nome: string, produtor: string, ano: number | null, signal: AbortSignal,
): Promise<Conhecido | null> {
  try {
    const d = await catalogoRpc("procurar", {
      p_nome: nome, p_produtor: produtor || "", p_ano: ano,
      p_idade_dias: CATALOGO_IDADE_DIAS,
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
async function obterResultadosPesquisa(query: string, signal: AbortSignal): Promise<PesquisaWeb> {
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
      return `[${i + 1}] ${title}\nURL: ${link}\nResumo: ${snip}` + (x?.rating != null ? `\nEstrelas no Google: ${x.rating}${x.ratingCount != null ? ` (${x.ratingCount} avaliações)` : ""}` : "");
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
  vivino_url: "vivinoUrl", imagem_url: "imagemUrl", preco_medio: "precoMedio",
  beber_de: "beberDe", beber_ate: "beberAte", notas_prova: "notasProva",
  harmonizacao: "harmonizacao", ai_resumo: "resumo",
};

/* ── A REGRA DO VIVINO, e porque tem DUAS versões ──
   O Vivino é do VINHO, não da colheita: a página não muda de identidade
   com o ano, e a nota que mostra por omissão é uma média entre colheitas
   (a colheita é só um filtro dentro da própria página). Exigir "produtor,
   ano e região a bater certo" para aceitar essa página — o que esta regra
   fazia até aqui — tinha o modelo a encontrar a página certa e a recusá-la
   na mesma, só porque a pesquisa pedia um ano que a identidade da página
   nunca teve. Testado com o Villa Platanus 2022: com a exigência do ano,
   nota/avaliações/link vinham sempre vazios; sem ela, vieram certos e
   estáveis em três tentativas seguidas.

   Por isso há DUAS versões, e quem escolhe é `colheitaEspecifica` (vem do
   ecrã de escolha de campos — `iaEscolher`/`iaManualEscolher` — nunca por
   omissão): a ESTRITA exige o ano, para quando a pergunta é mesmo sobre
   ESTA colheita e nenhuma outra; a RELAXADA (o novo default) não exige,
   e diz ao modelo onde ler cada número para não confundir com outro sítio
   da página. */
const regraVivino = (colheitaEspecifica: boolean) => colheitaEspecifica
  ? `A nota do Vivino, o número de avaliações e o "vivinoUrl" têm de vir da
   MESMA página do Vivino, que tenhas mesmo visto. Confirma que essa página é
   DESTE vinho exato (mesmo produtor, ano e região) e não a de um homónimo —
   há vários vinhos com nomes parecidos, de produtores diferentes, e uma
   pesquisa por texto pode trazer a página errada. Se tiveres qualquer dúvida
   de que é o mesmo vinho, deixa "vivinoUrl" e "vivinoNota" vazios em vez de
   arriscar.`
  : `A página do Vivino é do VINHO, não de uma colheita específica: o ANO NÃO
   faz parte da identidade da página, e a nota que lá aparece é uma média
   entre colheitas. Para confirmares que é a página certa, basta o nome (já
   desambiguado na regra anterior) e o produtor baterem certo — não deixes a
   nota, as avaliações nem o link vazios só por causa do ano. A nota é o
   número entre 1.0 e 5.0 ao lado das estrelas; as avaliações vêm logo a
   seguir, entre parêntesis — não uses números de outra zona da página.
   Mesmo sem confirmares a nota, mantém o link se tiveres a certeza da
   página.`;
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
  campos: string[] | null, textosPesquisa: string, colheitaEspecifica: boolean,
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

BASE DE EVIDÊNCIA (trechos de pesquisa web já recolhidos):
${textosPesquisa}

REGRAS, e são a sério:
1. RESPONDE APENAS COM BASE NA BASE DE EVIDÊNCIA acima. Não procures na net.
2. NÃO INVENTES. Um campo que não consigas confirmar fica FORA do JSON (ou a
   null). Uma ficha com metade dos campos certos vale mais do que uma cheia
   com metade inventada — quem lê isto vai decidir o que abre ao jantar.
3. ${regraCuvee}
4. ${regraVivino(colheitaEspecifica)}
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
3. ${regraVivino(colheitaEspecifica)}
4. "imagemUrl" tem de ser link DIRETO de imagem (.jpg/.jpeg/.png/.webp/.avif), não link de página.
5. Se houver dúvida de homónimo, prioriza ano + produtor + região e explica no "aviso".
6. Castas separadas por nome (nunca "blend"/"lote"/"várias castas").
7. ${ano ? `"beberDe"/"beberAte" são anos (a janela DESTA colheita).` : `Este vinho não tem ano: sem colheita NÃO há janela de consumo — deixa "beberDe"/"beberAte" de fora.`}

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
  vivino_nota: "4.1", vivino_avaliacoes: "1234", vivino_url: '""', imagem_url: '""',
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
3. ${regraVivino(false)}
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
4. ${regraVivino(false)}
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
  if (res.ok && vivinoDado && (!campos || campos.includes("vivino_url"))) res.corpo.vivino_url = vivinoDado;
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
): Promise<Res> {
  if (!GEMINI_KEY) return { ok: false, status: 503, erro: "a IA com pesquisa web ainda não está configurada (falta GEMINI_API_KEY)" };
  if (modoIA === "gratis" && !SEARCH_API_KEY)
    return { ok: false, status: 503, erro: "a IA sem pesquisa web ainda não está configurada (falta SEARCH_API_KEY)" };
  const inicio = Date.now();
  const chave = chaveCache(modoIA, nome, ano, produtor, regiao, tipo, notas, sites, campos, colheitaEspecifica);
  // A profunda existe para refazer o que veio de memória: nem a cache nem o
  // catálogo (onde essa resposta de memória foi parar) respondem por ela.
  const cache = profunda ? null : await cacheLer(chave, signal);
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
  const pedidos = (campos && campos.length ? campos : Object.keys(CAMPOS))
    .filter((k) => ano !== null || (k !== "beber_de" && k !== "beber_ate"));
  const conhecido = profunda ? null : await catalogoProcurar(nome, produtor, ano, signal);
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

  // Os `sites` de confiança viram operadores `site:` na pesquisa externa —
  // é a única das duas formas de os aplicar que restringe a sério (o
  // `google_search` do grounding não tem esse parâmetro na API pública, daí
  // só entrar como pedido no texto do `promptComGrounding`).
  const siteQuery = sites.length ? ` (${sites.map((s) => `site:${s}`).join(" OR ")})` : "";
  const query = [nome, ano || "", produtor, regiao, notas, "vivino garrafeira nacional vinho portugal"]
    .filter(Boolean).join(" ") + siteQuery;
  /* A PROFUNDA É O "MODO GRÁTIS" (25/09/2026): a pesquisa é NOSSA (Serper)
     e o Gemini só lê os resultados, sem `google_search`. É a única forma de
     a pesquisa ser garantida — ver `PESQUISA PROFUNDA`, mais acima. Faz
     uma consulta a mais, ao Vivino, que a consulta geral nem sempre traz. */
  const usarSerper = modoIA === "gratis" || profunda;
  let pesquisa: PesquisaWeb = { texto: "", fontes: [], status: "grounding:google_search" };
  let serperConsultas = 0;
  if (usarSerper) {
    try {
      if (profunda) {
        const qVivino = `"${nome.replace(/"/g, "")}" ${produtor} site:vivino.com`.replace(/\s+/g, " ");
        const rs = await Promise.allSettled([obterResultadosPesquisa(query, signal), obterResultadosPesquisa(qVivino, signal)]);
        serperConsultas = 2;
        const boas = rs.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<PesquisaWeb>).value);
        if (!boas.length) throw (rs[0] as PromiseRejectedResult).reason;
        const fontes = boas.flatMap((b) => b.fontes).filter((f, i, a) => a.findIndex((x) => x.url === f.url) === i);
        pesquisa = { texto: boas.map((b) => b.texto).join("\n\n").slice(0, 9000), fontes, status: boas[0].status };
      } else {
        serperConsultas = 1;
        pesquisa = await obterResultadosPesquisa(query, signal);
      }
    } catch (e) {
      await registar("erro", { passo: "search-api", ...(profunda ? { profunda: true } : {}), erro: String((e as Error).message || "").slice(0, 300) }, quem);
      return { ok: false, status: 503, erro: "não consegui obter resultados de pesquisa agora — tenta outra vez daqui a pouco" };
    }
  }

  const texto0 = usarSerper
    ? prompt(nome, ano, produtor, regiao, tipo, notas, new Date().toISOString().slice(0, 10), campos_ia, pesquisa.texto, colheitaEspecifica)
    : promptComGrounding(nome, ano, produtor, regiao, tipo, notas, sites, new Date().toISOString().slice(0, 10), campos_ia, colheitaEspecifica);
  const tentativas: { modelo: string; modo: string; estado: number | string; usageMetadata?: UsageMetadata }[] = [];
  let usageTotal: UsageMetadata | null = null;
  let fontesGround: Fonte[] = [];
  const run = async (modelo: string, modo: string, maxTokens: number, semThinking: boolean) => {
    const ms = Math.max(8_000, Math.min(GEMINI_TIMEOUT_MS, budgetMs - (Date.now() - inicio) - 2_000));
    if (ms < 2_000) return null;
    const { signal: sp, limpar } = comLimiteProprio(signal, ms);
    try {
      const g = await chamarGemini(modelo, texto0, sp, maxTokens, semThinking, !usarSerper);
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

  const primeira = await run(MODELO_BARATO, "barato", 1800, true);
  let usadoModelo = MODELO_BARATO;
  let usadoModo = "barato";
  let parsed: any = primeira && primeira.ok ? primeira.parsed : null;
  let erroUltimo = primeira && !primeira.ok ? primeira.erro : "";
  let pesquisou: boolean | null = primeira && primeira.ok ? primeira.pesquisou : null;

  let ficha = parsed ? normalizar(parsed, ano, campos_ia) : null;
  if (!pesquisou) fontesGround = [];
  // Só escala em falha TÉCNICA do barato (erro HTTP, timeout, resposta
  // ilegível) — nunca só porque o conteúdo (já respondido com sucesso) ficou
  // com poucos campos. Um modelo maior não inventa o que a pesquisa não
  // encontrou; no modo premium (grounding) escalar por "qualidade" pagava a
  // pesquisa Google a DOBRAR por um ganho que quase nunca existe.
  const falhouTecnicamente = !primeira || !primeira.ok;
  if (falhouTecnicamente && MODELO_ESCALADO !== MODELO_BARATO) {
    const segunda = await run(MODELO_ESCALADO, "escalado", 2800, false);
    if (segunda && segunda.ok) {
      usadoModelo = MODELO_ESCALADO;
      usadoModo = "escalado";
      parsed = segunda.parsed;
      pesquisou = segunda.pesquisou;
      ficha = normalizar(parsed, ano, campos_ia);
    } else if (segunda && !segunda.ok) {
      erroUltimo = segunda.erro;
    }
  }

  // Na profunda a pesquisa foi nossa (Serper): houve pesquisa, garantida.
  if (profunda) pesquisou = true;

  if (!ficha && !Object.keys(doCatalogo).length) {
    await registar("erro", {
      passo: "vazio", nome, modo: usadoModo, modelo: usadoModelo,
      tentativas, erro: erroUltimo.slice(0, 300), ms: Date.now() - inicio,
      ...(usageTotal ? { usageMetadata: usageTotal } : {}),
    }, quem);
    return { ok: false, status: 404, erro: `não encontrei informação fiável sobre "${nome}". Confere o nome do rótulo e tenta outra vez.` };
  }

  /* O que a IA acabou de descobrir vai para o catálogo — é isto que faz a
     próxima pessoa (nesta app ou na WineSelection) não pagar a mesma
     pergunta. Só o que veio da IA: o que já era do catálogo voltar para lá
     não acrescenta nada e só remexia as datas de quem lá pôs primeiro. */
  if (ficha) {
    const { aviso: _aviso, ...factos } = ficha as Record<string, unknown>;
    await catalogoJuntar(
      nome, produtor, ano, factos, `vinho-info-${modoIA}`,
      (usarSerper ? pesquisa.fontes : fontesGround), signal,
    );
  }

  /* O catálogo por baixo, a IA por cima: a IA só foi chamada pelo que
     FALTAVA, por isso não há aqui um a tapar o outro — mas a ordem fica
     explícita, que é o que se quer ler daqui a um ano. */
  ficha = { ...doCatalogo, ...(ficha ?? {}) };

  await cacheEscrever(
    chave,
    { nome, ano, produtor, regiao, tipo, notas, sites, campos, query, fonte: pesquisa.status, modo_ia: modoIA },
    // `pesquisaWeb` vai com a cache para o botão da profunda não se perder
    // quando a mesma procura volta a sair daqui.
    { ...ficha, ...(pesquisou !== null ? { pesquisaWeb: pesquisou } : {}) },
    (usarSerper ? pesquisa.fontes : fontesGround),
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
    ...(pesquisou !== null ? { pesquisaWeb: pesquisou } : {}), ...(profunda ? { profunda: true } : {}),
    ...(serperConsultas ? { serper_consultas: serperConsultas } : {}),
    ms: dur, tentativas, custo_estimado_eur: custoEstimado,
    ...(usageTotal ? { usageMetadata: usageTotal } : {}),
  }, quem);
  return {
    ok: true,
    corpo: {
      ...ficha,
      fontes: [
        ...(usarSerper ? pesquisa.fontes : fontesGround),
        ...(Object.keys(doCatalogo).length ? (conhecido?.fontes ?? []) : []),
      ].filter((f, i, a) => a.findIndex((x) => x.url === f.url) === i).slice(0, 8),
      ...(Object.keys(doCatalogo).length
        ? { origem: "misto", catalogoCampos: Object.keys(doCatalogo), catalogoEm: conhecido?.atualizadoEm ?? "" }
        : {}),
      pesquisa: true,
      plano: modoIA,
      ...(pesquisou !== null ? { pesquisaWeb: pesquisou } : {}),
      ...(profunda ? { profunda: true } : {}),
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
  if (modoIA === "gratis" && !SEARCH_API_KEY)
    return { ok: false, status: 503, erro: "a IA sem pesquisa web ainda não está configurada (falta SEARCH_API_KEY)" };
  const inicio = Date.now();

  type Item = { v: VinhoLote; conhecido: Conhecido | null; doCatalogo: Record<string, unknown>; emFalta: string[] };
  const itens: Item[] = [];
  for (const v of vinhos) {
    // Sem colheita, a janela de consumo não se pede (ver `produzirFicha`).
    const pedidosV = campos.filter((k) => v.ano !== null || (k !== "beber_de" && k !== "beber_ate"));
    const conhecido = await catalogoProcurar(v.nome, v.produtor, v.ano, signal);
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
        pesquisasPorVinho.set(it.v.id, await obterResultadosPesquisa(query, signal));
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
    const sites: string[] = Array.isArray(body?.sites)
      ? [...new Set<string>(body.sites.map((s: unknown) => texto(s, 100).replace(/^https?:\/\//i, "").replace(/\/.*$/, "")).filter(Boolean))].slice(0, 5)
      : [];
    // Os sites viram só o domínio (acima) — mas um link do Vivino de UM vinho
    // colado ali é a resposta, não uma fonte: guarda-se inteiro, antes de o
    // corte o reduzir a "www.vivino.com", e o prompt fica a sabê-lo.
    const vivinoDado = Array.isArray(body?.sites)
      ? (body.sites as unknown[]).map((s) => vivinoLink(texto(s, 300))).find(Boolean) ?? ""
      : "";
    const notas = [texto(body?.notas, 300), vivinoDado ? `A página do Vivino deste vinho é ${vivinoDado} — usa esta, é a certa.` : ""]
      .filter(Boolean).join("\n");
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
      const analiseId = await criarAnalise(authHeader, { nome, ano, produtor, regiao, tipo, notas, sites, campos: camposPedidos }, vinhoId, quem!, ctrl.signal);
      if (analiseId != null) {
        const dono = quem!;
        // NÃO faz await: o trabalho pesado sobrevive ao pedido original.
        EdgeRuntime.waitUntil((async () => {
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), PROC_TIMEOUT_MS);
          try {
          const res = comVivinoDado(await produzirFicha(modoIA, nome, ano, produtor, regiao, dono, c.signal, PROC_TIMEOUT_MS, camposPedidos, colheitaEspecifica, tipo, notas, sites, profunda), vivinoDado, camposPedidos);
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

    const res = comVivinoDado(await produzirFicha(modoIA, nome, ano, produtor, regiao, quem, ctrl.signal, TIMEOUT_MS, camposPedidos, colheitaEspecifica, tipo, notas, sites, profunda), vivinoDado, camposPedidos);
    return res.ok ? json(res.corpo) : json({ error: res.erro }, res.status);
  } catch (e) {
    const err = e as Error, timeout = err.name === "AbortError";
    await registar("erro", { passo: timeout ? "timeout" : "excecao", erro: String(err.message).slice(0, 500) }, quem);
    if (timeout) return json({ error: "a procura demorou demasiado — tenta outra vez daqui a pouco" }, 504);
    return json({ error: err.message }, 500);
  } finally { clearTimeout(timer); }
});
