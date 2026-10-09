// garrafeira-colheitas — a IA olha para as colheitas que não batem certo (09/10/2026)
//
// O dono das apps: "um menu no backoffice que me desse alertas … quando tenho
// o mesmo vinho, diferentes anos/colheitas e diferenças na caracterização …
// era giro que colocasses uma opção de analisar diferenças com IA e o Gemini
// ajudava a analisar as diferenças e propunha uma ação para cada diferença."
//
// Uma acção, só do admin do catálogo (`winecatalog.produtores_autorizado`,
// perguntado à BD com o JWT de quem chamou):
//   analisar → recebe as famílias (as colheitas do mesmo vinho) e os campos
//              em que a app viu diferenças, LÊ AS LINHAS DA BD (os valores
//              nunca vêm do browser), pergunta ao Gemini e devolve uma
//              proposta por diferença: manter · uniformizar (com o valor) ·
//              rever (com as linhas suspeitas).
// Síncrona e em lotes pequenos (a app manda até 4 vinhos de cada vez): sem
// pesquisa web, a resposta vem em segundos, e o browser corta perto dos 60 s.
//
// A LIMPEZA vive aqui e é o que impede a IA de inventar: uma proposta só
// passa para um vinho e um campo que foram pedidos; "uniformizar" só nos
// campos que são do vinho (região, classificação, castas, harmonização, nota
// do Vivino de todas as colheitas) e, tirando a harmonização, só com um valor
// que já está numa das colheitas (nas castas, só castas que já lá estão).
// Esta função não muda nada: a app aplica, confirmada, pela `winecatalog.editar`.
//
// Deploy: supabase functions deploy garrafeira-colheitas
// Usa o GEMINI_API_KEY (é só do admin), sem pesquisa web — a app di-lo.

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GAPI = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_TIMEOUT_MS = 50_000;
const SYNC_TIMEOUT_MS = 15_000;
const MAX_FAMILIAS = 6;
const MAX_LINHAS = 12;
const CUSTO_ANALISE_EUR = 0.003;   // ordem de grandeza (~4k tokens de entrada)

// Os campos que a app compara, e o que cada um deixa fazer.
const CAMPOS = ["regiao", "classificacao", "teor", "castas", "harmonizacao", "vivino_nota_global", "vivino_nota", "preco"];
const UNIFORMIZA = new Set(["regiao", "classificacao", "castas", "harmonizacao", "vivino_nota_global"]);
const NOMES: Record<string, string> = {
  regiao: "Região", classificacao: "Classificação", teor: "Álcool (%)", castas: "Castas",
  harmonizacao: "Harmonização", vivino_nota_global: "Nota Vivino de TODAS as colheitas",
  vivino_nota: "Nota Vivino da COLHEITA", preco: "Preço",
};
const LOJAS: Record<string, string> = {
  garrafeira_nacional: "Garrafeira Nacional", granvine: "Granvine", vinha: "Vinha.pt", vivino: "Vivino",
};

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
// As linhas pedidas, lidas da BD (as fundidas noutra não contam).
async function lerLinhas(ids: number[], signal: AbortSignal): Promise<Map<number, any>> {
  const r = await sb(`vinhos?id=in.(${ids.join(",")})&select=id,nome,produtor,ano,cor,ficha`, { signal }, "winecatalog");
  if (!r.ok) throw new Error("não consegui ler as linhas do catálogo (" + r.status + ")");
  const rows: any[] = await r.json();
  const a = await sb(`alias?id_de=in.(${ids.join(",")})&select=id_de`, { signal }, "winecatalog");
  const mortos = new Set<number>(a.ok ? (await a.json()).map((x: any) => Number(x.id_de)) : []);
  return new Map(rows.filter((x) => !mortos.has(Number(x.id))).map((x) => [Number(x.id), x]));
}

/* ── Os valores de uma linha ── */
const s = (v: unknown, max = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const n = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const x = Number(String(v).replace(",", "."));
  return Number.isFinite(x) ? x : null;
};
const semAc = (t: unknown) => String(t ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const ano = (l: any) => (l.ano ? String(l.ano) : "s/a");
function castasDe(f: any): string[] {
  return Array.isArray(f?.castas) ? f.castas.map((c: unknown) => s(c, 40)).filter(Boolean) : [];
}
function precosDe(f: any): string {
  const out: string[] = [];
  const pm = n(f?.preco_medio);
  if (pm != null) out.push(`referência ${pm.toFixed(2)} €`);
  const ps = f?.precos && typeof f.precos === "object" && !Array.isArray(f.precos) ? f.precos : {};
  for (const [loja, x] of Object.entries(ps) as [string, any][]) {
    if (!x || typeof x !== "object" || x.retirado) continue;
    const p = n(x.preco);
    if (p == null || p <= 0) continue;
    out.push(`${LOJAS[loja] ?? loja} ${p.toFixed(2)} €${x.colheita ? ` (colheita ${s(x.colheita, 4)})` : ""}`);
  }
  return out.join(" · ") || "—";
}
function valorTxt(campo: string, f: any): string {
  switch (campo) {
    case "regiao": return s(f?.regiao, 60) || "—";
    case "classificacao": return s(f?.classificacao, 40) || "—";
    case "teor": { const x = n(f?.teor); return x == null ? "—" : `${x} %`; }
    case "castas": return castasDe(f).join(", ") || "—";
    case "harmonizacao": return s(f?.harmonizacao, 500) || "—";
    case "vivino_nota_global": {
      const x = n(f?.vivino_nota_global); if (x == null) return "—";
      const a = n(f?.vivino_avaliacoes_global);
      return `${x}${a != null ? ` (${a} avaliações)` : ""}${f?.vivino_url ? ` · link ${s(f.vivino_url, 120)}` : ""}`;
    }
    case "vivino_nota": {
      const x = n(f?.vivino_nota); if (x == null) return "—";
      const a = n(f?.vivino_avaliacoes);
      return `${x}${a != null ? ` (${a} avaliações)` : ""}${f?.vivino_url ? ` · link ${s(f.vivino_url, 120)}` : ""}`;
    }
    case "preco": return precosDe(f);
  }
  return "—";
}

/* ── O pedido ── */
function montarPedido(fams: any[]): string {
  const blocos = fams.map((F, i) => {
    const l0 = F.linhas[0];
    const cab = `F${i + 1} · ${s(l0.nome, 100)}${l0.produtor ? ` — ${s(l0.produtor, 80)}` : ""} · ${s(l0.ficha?.tipo || l0.cor, 20)}`;
    const linhas = "  Colheitas: " + F.linhas.map((l: any) => `#${l.id} (${ano(l)})`).join(", ");
    const campos = F.campos.map((c: string) =>
      `  ${c} — ${NOMES[c]}:\n` + F.linhas.map((l: any) => `    #${l.id} (${ano(l)}): ${valorTxt(c, l.ficha)}`).join("\n")).join("\n");
    return `${cab}\n${linhas}\n${campos}`;
  }).join("\n\n");
  return `És um especialista em vinho português e em catálogos de vinhos.

Num catálogo, as várias COLHEITAS do mesmo vinho (o mesmo nome, produtor e cor) têm fichas que não batem certo nalguns campos. Cada linha do catálogo é uma colheita (#id e o ano; "s/a" é sem ano). Para cada diferença listada abaixo, diz o que fazer.

Como pensar em cada campo:
- regiao e classificacao (DOC, Vinho Regional, …): são do VINHO e não mudam de colheita para colheita (só se o produtor mudou a certificação, o que é raro). Uma diferença é quase sempre um erro: escolhe a certa.
- castas: o lote pode mudar um pouco entre colheitas (uma casta a mais ou a menos é normal); castas muito diferentes é erro.
- teor (álcool): muda de colheita para colheita, normalmente até 1 %. Mais do que isso, ou um valor fora do normal para este vinho, é de rever.
- harmonizacao: é do vinho. Textos diferentes que dizem o mesmo por outras palavras devem ficar iguais — propõe UM texto, curto, que junte o que as colheitas dizem, sem acrescentar pratos que nenhuma diz.
- vivino_nota_global: é uma nota só, do vinho todo — TEM de ser igual em todas as colheitas. Escolhe a que tem mais avaliações, a não ser que o link mostre que é de outro vinho.
- vivino_nota: a nota da colheita muda de ano para ano; 0,3 ou mais já é muito. Diz se parece normal (uma colheita muito melhor ou pior, poucas avaliações) ou se é de rever (o link é de outro vinho).
- preco: as colheitas mais antigas costumam custar mais. Um preço várias vezes maior ou menor do que o das outras é quase sempre de outra garrafa (magnum, outro vinho da casa) — de rever.

Ações possíveis (uma por diferença):
- "manter": a diferença é normal entre colheitas; não há nada a corrigir.
- "uniformizar": o campo deve ficar igual em TODAS as colheitas; "valor" é o que se põe em todas. Só em regiao, classificacao, castas, harmonizacao e vivino_nota_global. Na regiao, na classificacao e na vivino_nota_global escolhe um dos valores que já lá estão; nas castas usa só castas que já aparecem nalguma colheita (lista JSON); na harmonizacao podes escrever o texto que junta os outros.
- "rever": há um valor que parece errado e não sabes o certo — tem de ser visto à mão. Põe em "linhas" os #id que parecem errados (números) e em "porque" o que verificar.

Regras:
- Exatamente uma proposta por diferença listada (família + campo).
- Não inventes factos. Sem certeza, "rever" com "certeza": "media".
- "certeza": "alta" ou "media".
- "porque": uma frase curta, em português de Portugal.

Responde SÓ com JSON, sem mais nada:
{"propostas":[{"familia":"F1","campo":"<campo>","acao":"manter|uniformizar|rever","valor":null,"linhas":[],"certeza":"alta|media","porque":"…"}]}

AS DIFERENÇAS:
${blocos}`;
}

/* ── A limpeza: só o que foi pedido, só valores que já lá estão ── */
function limpar(resp: any, fams: any[]) {
  const propostas: any[] = [];
  const vistos = new Set<string>();
  const cert = (c: unknown) => (c === "alta" ? "alta" : "media");
  for (const p of Array.isArray(resp?.propostas) ? resp.propostas : []) {
    const m = /^F?(\d+)$/i.exec(String(p?.familia ?? "").trim());
    const F = m ? fams[Number(m[1]) - 1] : null;
    if (!F) continue;
    const campo = String(p?.campo ?? "").trim();
    if (!F.campos.includes(campo)) continue;
    const k = F.chave + "\u0001" + campo;
    if (vistos.has(k)) continue;
    let acao = ["manter", "uniformizar", "rever"].includes(p?.acao) ? p.acao : "";
    if (!acao) continue;
    let porque = s(p?.porque, 300);
    const ids = new Set(F.linhas.map((l: any) => Number(l.id)));
    const linhas = (Array.isArray(p?.linhas) ? p.linhas : [])
      .map((x: unknown) => Number(String(x).replace("#", ""))).filter((x: number) => ids.has(x));
    let valor: unknown = null, de: number | null = null;
    if (acao === "uniformizar") {
      if (!UNIFORMIZA.has(campo)) acao = "rever";
      else if (campo === "regiao" || campo === "classificacao") {
        const ex = F.linhas.map((l: any) => s(l.ficha?.[campo], 80)).filter(Boolean);
        valor = ex.find((x: string) => semAc(x) === semAc(p?.valor)) ?? null;
      } else if (campo === "vivino_nota_global") {
        const alvo = n(p?.valor);
        const com = F.linhas.filter((l: any) => alvo != null && n(l.ficha?.vivino_nota_global) != null
          && Math.abs(n(l.ficha.vivino_nota_global)! - alvo) < 0.001)
          .sort((a: any, b: any) => (n(b.ficha?.vivino_avaliacoes_global) ?? 0) - (n(a.ficha?.vivino_avaliacoes_global) ?? 0));
        if (com.length) { valor = n(com[0].ficha.vivino_nota_global); de = Number(com[0].id); }
      } else if (campo === "castas") {
        const todas = new Map<string, string>();
        F.linhas.forEach((l: any) => castasDe(l.ficha).forEach((c) => todas.set(semAc(c), c)));
        const pedidas = Array.isArray(p?.valor) ? p.valor : String(p?.valor ?? "").split(",");
        const ok = [...new Set(pedidas.map((c: unknown) => todas.get(semAc(c))).filter(Boolean))] as string[];
        valor = ok.length ? ok.sort((a, b) => a.localeCompare(b, "pt")) : null;
      } else if (campo === "harmonizacao") {
        valor = s(p?.valor, 500) || null;
      }
      if (acao === "uniformizar" && valor == null) {
        acao = "rever";
        porque = porque || "A IA propôs um valor que não está em nenhuma colheita.";
      }
    }
    vistos.add(k);
    propostas.push({ chave: F.chave, campo, acao, valor, de, linhas, certeza: cert(p?.certeza), porque });
  }
  return propostas;
}

/* ── O Gemini (sem pesquisa, JSON direto; um 200 vazio passa ao modelo seguinte) ── */
type Usage = { promptTokenCount: number; candidatesTokenCount: number; thoughtsTokenCount: number; totalTokenCount: number };
function usageDe(raw: any): Usage | null {
  const k = (v: unknown) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? Math.round(x) : 0; };
  const u = raw?.usageMetadata;
  if (!u || typeof u !== "object") return null;
  return { promptTokenCount: k(u.promptTokenCount), candidatesTokenCount: k(u.candidatesTokenCount), thoughtsTokenCount: k(u.thoughtsTokenCount), totalTokenCount: k(u.totalTokenCount) };
}
async function gerar(prompt: string, signal: AbortSignal) {
  const fixo = Deno.env.get("GEMINI_MODEL");
  const modelos = [...new Set([...(fixo ? [fixo] : []), "gemini-flash-latest", "gemini-flash-lite-latest"])];
  let erro = "";
  for (const m of modelos) {
    for (const pensar of [1024, null]) {
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
      body: JSON.stringify({ origem: "function", acao: "garrafeira-colheitas", estado, quem, detalhe }) });
  } catch (_) { /**/ }
  if (!detalhe.modelo && estado !== "erro") return;
  try {
    const u = (detalhe.usageMetadata ?? null) as Usage | null;
    await sb("registos", { method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        app: "garrafeira", funcao: "garrafeira-colheitas", estado: estado === "erro" ? "erro" : "ok",
        modelo: (detalhe.modelo as string | undefined) ?? null, pesquisa_web: false,
        tokens_entrada: u?.promptTokenCount ?? null, tokens_saida: u?.candidatesTokenCount ?? null,
        tokens_pensamento: u?.thoughtsTokenCount ?? null, tokens_total: u?.totalTokenCount ?? null,
        custo_estimado_eur: (detalhe.custo_estimado_eur as number | undefined) ?? null,
        duracao_ms: (detalhe.ms as number | undefined) ?? null, quem,
        erro: estado === "erro" ? String(detalhe.erro ?? "").slice(0, 500) || null : null, detalhe,
      }) }, "ia_uso");
  } catch (_) { /**/ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  const authHeader = req.headers.get("Authorization") ?? "";
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SYNC_TIMEOUT_MS);
  let quem: string | null = null;
  try {
    const auth = await autorizar(authHeader, ctrl.signal);
    quem = auth.email || null;
    if (!auth.ok) return json({ error: "Só o admin do catálogo." }, 403);
    const body = await req.json().catch(() => ({} as any));
    if (body?.acao !== "analisar") return json({ error: "acção desconhecida" }, 400);

    // O pedido: só a chave, as linhas e os campos — os valores lêem-se cá.
    const pedidas = (Array.isArray(body.familias) ? body.familias : []).slice(0, MAX_FAMILIAS).map((f: any) => ({
      chave: s(f?.chave, 400),
      ids: [...new Set((Array.isArray(f?.ids) ? f.ids : []).map(Number).filter((x: number) => Number.isInteger(x) && x > 0))].slice(0, MAX_LINHAS) as number[],
      campos: [...new Set((Array.isArray(f?.campos) ? f.campos : []).map(String).filter((c: string) => CAMPOS.includes(c)))] as string[],
    })).filter((f: any) => f.chave && f.ids.length >= 2 && f.campos.length);
    if (!pedidas.length) return json({ error: "Nada para analisar." }, 400);
    const linhas = await lerLinhas(pedidas.flatMap((f: any) => f.ids), ctrl.signal);
    clearTimeout(timer);
    const fams = pedidas.map((f: any) => ({
      ...f, linhas: f.ids.map((id: number) => linhas.get(id)).filter(Boolean)
        .sort((a: any, b: any) => (a.ano ?? 0) - (b.ano ?? 0)),
    })).filter((f: any) => f.linhas.length >= 2);
    if (!fams.length) return json({ error: "As linhas já não estão no catálogo (foram fundidas?)." }, 409);

    const gctrl = new AbortController();
    const gtimer = setTimeout(() => gctrl.abort(), GEMINI_TIMEOUT_MS);
    let g;
    try { g = await gerar(montarPedido(fams), gctrl.signal); }
    catch (e) { g = { texto: "", modelo: "", usage: null, erro: gctrl.signal.aborted ? "a IA demorou demasiado — tenta outra vez" : String((e as Error).message || e) }; }
    finally { clearTimeout(gtimer); }
    const resp = g.texto ? extrairJson(g.texto) : null;
    if (!resp) {
      const erro = g.erro || "a resposta da IA não se percebe";
      await registar("erro", { erro, modelo: g.modelo || null, usageMetadata: g.usage, ms: Date.now() - t0, familias: fams.length }, quem);
      return json({ error: erro }, 502);
    }
    const propostas = limpar(resp, fams);
    await registar("ok", { modelo: g.modelo, usageMetadata: g.usage, ms: Date.now() - t0, custo_estimado_eur: CUSTO_ANALISE_EUR,
      familias: fams.length, diferencas: fams.reduce((a: number, f: any) => a + f.campos.length, 0), propostas: propostas.length }, quem);
    return json({ propostas, modelo: g.modelo });
  } catch (e) {
    const err = e as Error;
    await registar("erro", { passo: "excecao_inicial", erro: String(err.message).slice(0, 300) }, quem);
    return json({ error: err.message || "erro inesperado" }, 500);
  } finally { clearTimeout(timer); }
});
