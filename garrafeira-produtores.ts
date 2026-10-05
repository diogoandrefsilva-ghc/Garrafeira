// garrafeira-produtores — a IA olha para os produtores do catálogo (05/10/2026)
//
// O dono das apps: "dava jeito alguma coisa de IA aqui, seja IA automática,
// seja IA manual, para analisar todos os produtores e tentar ver se existiam
// duplicados, se existiam casas-mãe que fizessem sentido criar. Sempre com
// ecrã de confirmação."
//
// Três acções, todas só do admin do catálogo (`winecatalog.produtores_autorizado`,
// perguntado à BD com o JWT de quem chamou):
//   pedido   → o texto do pedido, para colar noutro assistente (a IA manual);
//   validar  → limpa uma resposta colada: só nomes que existem, nada do que
//              já está decidido (síncrono, sem Gemini);
//   analisar → o mesmo pedido ao Gemini, em segundo plano: cria a linha em
//              `garrafeira.produtores_analises`, responde já com o id, e a app
//              sonda-a (como as cartas das Sugestões).
// O pedido e a limpeza vivem SÓ aqui — a IA manual e a automática passam pela
// mesma regra. Esta função não muda produtor nenhum: as propostas aplicam-se
// na app, confirmadas, pelas funções de sempre.
//
// Deploy: supabase functions deploy garrafeira-produtores
// Usa o GEMINI_API_KEY (é só do admin), sem pesquisa web: a pergunta é de
// conhecimento ("quem é dono de quem"), e a app di-lo — confirma antes de aplicar.

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GAPI = "https://generativelanguage.googleapis.com/v1beta";
const PROC_TIMEOUT_MS = 140_000;
const SYNC_TIMEOUT_MS = 20_000;
const CUSTO_ANALISE_EUR = 0.01;   // ordem de grandeza (~15k tokens de entrada)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* ── Supabase ── */
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
async function autorizar(auth: string, signal: AbortSignal): Promise<{ ok: boolean; email: string }> {
  if (!auth) return { ok: false, email: "" };
  const u = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_SRV, Authorization: auth }, signal });
  if (!u.ok) return { ok: false, email: "" };
  const email = String((await u.json()).email ?? "").toLowerCase();
  if (!email) return { ok: false, email: "" };
  try {
    const r = await sb("rpc/produtores_autorizado", { method: "POST", body: "{}", signal }, "winecatalog", auth);
    return { ok: r.ok && (await r.json()) === true, email };
  } catch (_) { return { ok: false, email }; }
}
// A lista vai buscar-se com o JWT de quem pediu (a função da BD confere-o).
async function lerLista(auth: string, signal: AbortSignal): Promise<any> {
  const r = await sb("rpc/produtores_para_ia", { method: "POST", body: "{}", signal }, "winecatalog", auth);
  if (!r.ok) throw new Error("não consegui ler os produtores (" + r.status + ")");
  return await r.json();
}

/* ── O pedido ── */
const s = (v: unknown, max = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
function linhaProdutor(p: any): string {
  const extra: string[] = [];
  if (p.casa_mae) extra.push("casa-mãe: " + s(p.casa_mae));
  if (Array.isArray(p.grafias) && p.grafias.length) extra.push("também escrito: " + p.grafias.map((x: unknown) => s(x, 60)).join(", "));
  const partes = [
    `- ${s(p.nome, 80)}${p.confirmado ? " [confirmado]" : ""}${extra.length ? ` (${extra.join("; ")})` : ""}`,
    `${Number(p.vinhos) || 0} vinhos`,
  ];
  if (Array.isArray(p.regioes) && p.regioes.length) partes.push(p.regioes.slice(0, 3).map((x: unknown) => s(x, 30)).join("/"));
  if (Array.isArray(p.exemplos) && p.exemplos.length) partes.push("ex.: " + p.exemplos.slice(0, 4).map((x: unknown) => s(x, 60)).join("; "));
  return partes.join(" · ");
}
function montarPedido(lista: any): string {
  const linhas = (lista?.produtores ?? []).map(linhaProdutor).join("\n");
  return `És um especialista em vinho português e no mundo dos produtores (quem é dono de quem, que quintas e marcas pertencem a que grupo).

Recebes a lista dos produtores de um catálogo de vinhos. Cada linha tem o nome, se já foi confirmado como nome oficial, a casa-mãe que já tem (se tiver), outras grafias que já se juntaram a ele, quantos vinhos tem, as regiões e exemplos de vinhos.

Procura duas coisas:

1. DUPLICADOS — linhas diferentes que são o MESMO produtor escrito de outra maneira (ex.: "Ramos Pinto" e "Adriano Ramos Pinto"; "Esporão" e "Herdade do Esporão"; "Quinta do Vallado" e "Vallado"). NÃO são duplicados:
   - produtores diferentes com nomes parecidos (ex.: "Quinta Nova" e "Herdade da Malhadinha Nova"; "Adega Monte Branco" e "Herdade do Monte Branco");
   - casas diferentes do mesmo grupo (ex.: "Casa Ferreirinha" e "Sandeman" são ambas da Sogrape — isso é casa-mãe, não duplicado).
   Para cada grupo diz qual dos nomes deve ficar como oficial: o nome por que o produtor é conhecido; em igualdade, um já confirmado.

2. CASAS-MÃE — grupos empresariais que detêm hoje dois ou mais produtores da lista (ex.: a Sogrape detém Casa Ferreirinha, Herdade do Peso e Quinta dos Carvalhais; a Symington detém Graham's, Dow's e Quinta do Vesúvio). A casa-mãe pode não estar na lista: escreve o nome dela como o grupo se apresenta. Um produtor da lista também pode ser a casa-mãe de outros. Não proponhas o que já está feito (um produtor com essa mesma casa-mãe). Uma casa-mãe nunca tem casa-mãe.

Regras:
- Usa os nomes dos produtores EXATAMENTE como estão escritos na lista.
- Não inventes. Só o que sabes; "certeza": "alta" quando é conhecido e atual, "media" quando tens boas razões mas não a certeza. Palpites não entram.
- "porque": uma frase curta em português.

Responde SÓ com JSON, sem mais nada:
{"duplicados":[{"nomes":["…","…"],"oficial":"…","certeza":"alta","porque":"…"}],
 "casas_mae":[{"casa_mae":"…","produtores":["…","…"],"certeza":"alta","porque":"…"}]}

A LISTA:
${linhas}`;
}

/* ── A limpeza: só nomes que existem, nada do que já está decidido ── */
const lc = (x: unknown) => String(x ?? "").trim().toLowerCase();
function limpar(resp: any, lista: any) {
  const prods: any[] = lista?.produtores ?? [];
  const porNome = new Map<string, any>();
  for (const p of prods) porNome.set(lc(p.nome), p);
  const achar = (n: unknown) => porNome.get(lc(n)) ?? null;
  const distChaves = new Set((lista?.distintos_chaves ?? []).map((d: string[]) => [d[0], d[1]].sort().join("|")));
  const distGraf = new Set((lista?.distintos_grafias ?? []).map((d: string[]) => [lc(d[0]), lc(d[1])].sort().join("|")));
  const distintos = (a: any, b: any) =>
    distChaves.has([a.chave, b.chave].sort().join("|")) || distGraf.has([lc(a.nome), lc(b.nome)].sort().join("|"));
  const cert = (c: unknown) => (c === "alta" ? "alta" : "media");
  const temFilhos = (nome: string) => prods.some((p) => lc(p.casa_mae) === lc(nome));

  const duplicados: any[] = [];
  const vistos = new Set<string>();
  for (const d of Array.isArray(resp?.duplicados) ? resp.duplicados : []) {
    const ps = [...new Map((Array.isArray(d?.nomes) ? d.nomes : []).map(achar).filter(Boolean).map((p: any) => [lc(p.nome), p])).values()];
    if (ps.length < 2) continue;
    // Um par já marcado como diferente não volta (num grupo maior, sai quem o é).
    const fica = ps.filter((p: any, i: number) => !ps.some((q: any, j: number) => j !== i && distintos(p, q)));
    if (fica.length < 2) continue;
    const chave = fica.map((p: any) => lc(p.nome)).sort().join("|");
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    const of = achar(d?.oficial);
    const oficial = (of && fica.includes(of) ? of : (fica.find((p: any) => p.confirmado) ?? fica[0])).nome;
    duplicados.push({ nomes: fica.map((p: any) => p.nome), oficial, certeza: cert(d?.certeza), porque: s(d?.porque, 300) });
  }

  const casas_mae: any[] = [];
  for (const c of Array.isArray(resp?.casas_mae) ? resp.casas_mae : []) {
    const mae = s(c?.casa_mae, 80);
    if (!mae) continue;
    const maeP = achar(mae);
    if (maeP?.casa_mae) continue;   // uma casa-mãe não tem casa-mãe
    const filhos = [...new Map((Array.isArray(c?.produtores) ? c.produtores : []).map(achar).filter(Boolean)
      .filter((p: any) => lc(p.nome) !== lc(mae) && lc(p.casa_mae) !== lc(mae) && !temFilhos(p.nome))
      .map((p: any) => [lc(p.nome), p])).values()];
    if (!filhos.length) continue;
    casas_mae.push({
      casa_mae: maeP ? maeP.nome : mae, existe: !!maeP,
      produtores: filhos.map((p: any) => ({ nome: p.nome, atual: p.casa_mae || null })),
      certeza: cert(c?.certeza), porque: s(c?.porque, 300),
    });
  }
  return { duplicados, casas_mae };
}

/* ── O Gemini (sem pesquisa, JSON direto; um 200 vazio passa ao modelo seguinte) ── */
type Usage = { promptTokenCount: number; candidatesTokenCount: number; thoughtsTokenCount: number; totalTokenCount: number };
function usageDe(raw: any): Usage | null {
  const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? Math.round(x) : 0; };
  const u = raw?.usageMetadata;
  if (!u || typeof u !== "object") return null;
  return { promptTokenCount: n(u.promptTokenCount), candidatesTokenCount: n(u.candidatesTokenCount), thoughtsTokenCount: n(u.thoughtsTokenCount), totalTokenCount: n(u.totalTokenCount) };
}
async function gerar(prompt: string, signal: AbortSignal) {
  const fixo = Deno.env.get("GEMINI_MODEL");
  const modelos = [...new Set([...(fixo ? [fixo] : []), "gemini-flash-latest", "gemini-flash-lite-latest"])];
  let erro = "";
  for (const m of modelos) {
    for (const pensar of [4096, null]) {
      if (signal.aborted) break;
      const generationConfig: Record<string, unknown> = { temperature: 0, response_mime_type: "application/json" };
      if (pensar != null) generationConfig.thinkingConfig = { thinkingBudget: pensar };
      const r = await fetch(`${GAPI}/models/${m}:generateContent?key=${GEMINI_KEY}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal,
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig }),
      });
      if (r.status === 400 && pensar != null) continue;
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        let msg = ""; try { msg = JSON.parse(t)?.error?.message ?? ""; } catch (_) { /**/ }
        erro = `gemini ${r.status} (${m})${msg ? ": " + msg.slice(0, 200) : ""}`;
        break;
      }
      const d = await r.json();
      const cand = d?.candidates?.[0];
      const texto = (cand?.content?.parts ?? []).map((x: any) => x?.text ?? "").join("").trim();
      if (texto) return { texto, modelo: m, usage: usageDe(d), erro: "" };
      erro = `o modelo não devolveu resposta (${cand?.finishReason || "vazia"}, ${m})`;
      break;
    }
  }
  return { texto: "", modelo: "", usage: null as Usage | null, erro: erro || "sem resposta do modelo" };
}
function extrairJson(txt: string): any {
  const t = String(txt || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(t); } catch (_) { /* segue */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) { /**/ } }
  return null;
}

/* ── Registo (sync_log + ia_uso; nunca deita o trabalho abaixo) ── */
async function registar(estado: string, detalhe: Record<string, unknown>, quem: string | null) {
  try {
    await sb("sync_log", { method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ origem: "function", acao: "garrafeira-produtores", estado, quem, detalhe }) });
  } catch (_) { /**/ }
  if (!detalhe.modelo && estado !== "erro") return;
  try {
    const u = (detalhe.usageMetadata ?? null) as Usage | null;
    await sb("registos", { method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        app: "garrafeira", funcao: "garrafeira-produtores", estado: estado === "erro" ? "erro" : "ok",
        modelo: (detalhe.modelo as string | undefined) ?? null, pesquisa_web: false,
        tokens_entrada: u?.promptTokenCount ?? null, tokens_saida: u?.candidatesTokenCount ?? null,
        tokens_pensamento: u?.thoughtsTokenCount ?? null, tokens_total: u?.totalTokenCount ?? null,
        custo_estimado_eur: (detalhe.custo_estimado_eur as number | undefined) ?? null,
        duracao_ms: (detalhe.ms as number | undefined) ?? null, quem,
        erro: estado === "erro" ? String(detalhe.erro ?? "").slice(0, 500) || null : null, detalhe,
      }) }, "ia_uso");
  } catch (_) { /**/ }
}

async function marcar(id: number, patch: Record<string, unknown>) {
  try {
    await sb(`produtores_analises?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ ...patch, atualizado_em: new Date().toISOString() }) });
  } catch (_) { /**/ }
}

async function analisar(id: number, quem: string, lista: any) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROC_TIMEOUT_MS);
  try {
    const g = await gerar(montarPedido(lista), ctrl.signal);
    const resp = g.texto ? extrairJson(g.texto) : null;
    if (!resp) {
      const erro = g.erro || "a resposta da IA não se percebe";
      await marcar(id, { estado: "erro", erro });
      await registar("erro", { analise: id, erro, modelo: g.modelo || null, usageMetadata: g.usage, ms: Date.now() - t0 }, quem);
      return;
    }
    const res = limpar(resp, lista);
    await marcar(id, { estado: "concluida", resultado: { ...res, modelo: g.modelo, produtores: (lista?.produtores ?? []).length } });
    await registar("ok", { analise: id, modelo: g.modelo, usageMetadata: g.usage, ms: Date.now() - t0,
      custo_estimado_eur: CUSTO_ANALISE_EUR, duplicados: res.duplicados.length, casas_mae: res.casas_mae.length }, quem);
  } catch (e) {
    const erro = String((e as Error).message || e).slice(0, 300);
    await marcar(id, { estado: "erro", erro: ctrl.signal.aborted ? "a IA demorou demasiado — tenta outra vez" : erro });
    await registar("erro", { analise: id, erro, ms: Date.now() - t0 }, quem);
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
    if (!auth.ok) return json({ error: "Só o admin do catálogo." }, 403);
    const body = await req.json().catch(() => ({} as any));
    const lista = await lerLista(authHeader, ctrl.signal);

    if (body?.acao === "pedido") return json({ pedido: montarPedido(lista), produtores: (lista?.produtores ?? []).length });

    if (body?.acao === "validar") {
      const resp = typeof body.resposta === "string" ? extrairJson(body.resposta) : body.resposta;
      if (!resp || typeof resp !== "object") return json({ error: "Não encontrei JSON na resposta colada." }, 400);
      return json({ ...limpar(resp, lista), modelo: "manual", produtores: (lista?.produtores ?? []).length });
    }

    if (body?.acao === "analisar") {
      const r = await sb("produtores_analises", { method: "POST", headers: { Prefer: "return=representation" }, signal: ctrl.signal,
        body: JSON.stringify({ quem }) });
      const id = r.ok ? (await r.json())?.[0]?.id : null;
      if (typeof id !== "number") return json({ error: "não consegui começar a análise — tenta outra vez" }, 502);
      EdgeRuntime.waitUntil(analisar(id, quem!, lista));
      return json({ id, estado: "pendente" }, 202);
    }

    return json({ error: "acção desconhecida" }, 400);
  } catch (e) {
    const err = e as Error;
    await registar("erro", { passo: "excecao_inicial", erro: String(err.message).slice(0, 300) }, quem);
    return json({ error: err.message || "erro inesperado" }, 500);
  } finally { clearTimeout(timer); }
});
