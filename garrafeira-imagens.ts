// supabase/functions/garrafeira-imagens/index.ts
// Garrafeira — as imagens das lojas copiadas para o Supabase (migração 34,
// db/migracao-imagens.sql).
//
// Descarrega cada link de `garrafeira.imagens_copia` que está à espera para
// o bucket PÚBLICO `garrafeira-imagens`, e a BD troca o link pelo da cópia
// no catálogo e em todas as garrafeiras (`imagem_resultado` →
// `imagem_trocar`). O link de origem fica na tabela.
//
// Quem chama:
//   · o cron `garrafeira-imagens` (pg_net, service_role, de hora a hora) —
//     responde logo e copia em segundo plano (`EdgeRuntime.waitUntil`);
//   · o admin, em Definições › Diagnóstico — espera pela resposta, e a app
//     chama outra vez enquanto houver `restantes`.
//
// O que se descarrega foi escrito por quem edita (a IA, ou à mão): só
// http(s) e nomes públicos, redireções conferidas uma a uma, até 6 MB, e só
// o que os BYTES dizem ser uma imagem (JPEG/PNG/WebP/GIF/AVIF — nunca SVG,
// que é código). A mesma prudência da `abrirPagina` da `vinho-info`.
//
// verify_jwt LIGADO. Deploy: supabase functions deploy garrafeira-imagens

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const BUCKET = "garrafeira-imagens";
const MAX_BYTES = 6 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const EM_PARALELO = 4;
// O admin espera pela resposta: pára a tempo e diz quantas faltam.
const ORCAMENTO_ADMIN_MS = 40_000;
const ORCAMENTO_CRON_MS = 120_000;
// Um browser a sério: há CDNs de lojas que recusam quem não se parece com um.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const srv = {
  apikey: SB_SRV, Authorization: `Bearer ${SB_SRV}`, "Content-Type": "application/json",
  "Content-Profile": "garrafeira", "Accept-Profile": "garrafeira",
};

async function rpc<T>(fn: string, corpo: unknown, headers: Record<string, string> = srv): Promise<T> {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(corpo) });
  const tx = await r.text();
  if (!r.ok) throw new Error(`${fn}: HTTP ${r.status} ${tx.slice(0, 200)}`);
  return (tx ? JSON.parse(tx) : null) as T;
}

// O `role` de dentro de um JWT (a assinatura já foi conferida à porta).
function papelDoToken(tok: string): string | null {
  try {
    const p = tok.split(".")[1] || "";
    const b = atob(p.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (p.length % 4)) % 4));
    return (JSON.parse(b) as { role?: string }).role ?? null;
  } catch {
    return null;
  }
}

function hostPublico(u: URL): boolean {
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.port || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(h) && !/(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(h);
}

// O tipo pelos BYTES, não pelo cabeçalho (há CDNs que dizem octet-stream).
function tipoDaImagem(b: Uint8Array): { tipo: string; ext: string } | null {
  const s = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { tipo: "image/jpeg", ext: "jpg" };
  if (b[0] === 0x89 && s(1, 3) === "PNG") return { tipo: "image/png", ext: "png" };
  if (s(0, 4) === "RIFF" && s(8, 4) === "WEBP") return { tipo: "image/webp", ext: "webp" };
  if (s(0, 4) === "GIF8") return { tipo: "image/gif", ext: "gif" };
  if (s(4, 4) === "ftyp" && /avi[fs]/.test(s(8, 4))) return { tipo: "image/avif", ext: "avif" };
  return null;
}

async function lerAte(r: Response, max: number): Promise<Uint8Array> {
  const partes: Uint8Array[] = [];
  let n = 0;
  const leitor = r.body!.getReader();
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    n += value.length;
    if (n > max) { await leitor.cancel().catch(() => {}); throw new Error(`maior do que ${max / 1048576} MB`); }
    partes.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of partes) { out.set(p, o); o += p.length; }
  return out;
}

async function descarregar(url0: string): Promise<{ bytes: Uint8Array; tipo: string; ext: string }> {
  let url = url0;
  const sinal = AbortSignal.timeout(TIMEOUT_MS);
  let r: Response | null = null;
  for (let i = 0; i < 5; i++) {
    const u = new URL(url);
    if (!hostPublico(u)) throw new Error("endereço não permitido");
    r = await fetch(u, {
      redirect: "manual", signal: sinal,
      headers: { "User-Agent": UA, Accept: "image/avif,image/webp,image/*,*/*;q=0.8", Referer: `${u.origin}/` },
    });
    const loc = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
    if (!loc) break;
    await r.body?.cancel().catch(() => {});
    url = new URL(loc, url).toString();
    r = null;
  }
  if (!r) throw new Error("redireções a mais");
  if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new Error(`HTTP ${r.status}`); }
  const bytes = await lerAte(r, MAX_BYTES);
  const t = tipoDaImagem(bytes);
  if (!t) throw new Error(`não é uma imagem (${(r.headers.get("content-type") ?? "?").split(";")[0]})`);
  if (bytes.length < 500) throw new Error("imagem vazia");
  return { bytes, ...t };
}

async function hashDe(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d.subarray(0, 16), (x) => x.toString(16).padStart(2, "0")).join("");
}

async function copiarUma(origem: string): Promise<boolean> {
  try {
    const img = await descarregar(origem);
    const caminho = `${await hashDe(origem)}.${img.ext}`;
    const up = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${caminho}`, {
      method: "POST",
      headers: { apikey: SB_SRV, Authorization: `Bearer ${SB_SRV}`, "Content-Type": img.tipo,
        "x-upsert": "true", "Cache-Control": "max-age=31536000" },
      body: new Blob([img.bytes as BlobPart]),
    });
    if (!up.ok) throw new Error(`storage: HTTP ${up.status} ${(await up.text()).slice(0, 120)}`);
    await rpc("imagem_resultado", {
      p_origem: origem, p_ok: true, p_caminho: caminho,
      p_url: `${SB_URL}/storage/v1/object/public/${BUCKET}/${caminho}`,
      p_bytes: img.bytes.length, p_tipo: img.tipo,
    });
    return true;
  } catch (e) {
    const err = e as Error;
    const msg = err.name === "TimeoutError" ? "não respondeu a tempo" : String(err.message || e).slice(0, 200);
    await rpc("imagem_resultado", { p_origem: origem, p_ok: false, p_erro: msg }).catch(() => {});
    return false;
  }
}

async function copiar(orcamentoMs: number) {
  const fim = Date.now() + orcamentoMs;
  let copiadas = 0, falhadas = 0;
  await rpc<number>("imagens_descobrir", {});
  while (Date.now() < fim - TIMEOUT_MS) {
    const lote = await rpc<string[]>("imagens_por_copiar", { p_limite: EM_PARALELO * 2 });
    if (!lote || !lote.length) break;
    for (let i = 0; i < lote.length; i += EM_PARALELO) {
      const oks = await Promise.all(lote.slice(i, i + EM_PARALELO).map(copiarUma));
      for (const ok of oks) ok ? copiadas++ : falhadas++;
    }
  }
  // As que falharam há menos de 10 minutos também contam: voltam a ser
  // tentadas na volta seguinte (até 3 vezes).
  const restantes = await rpc<number>("imagens_descobrir", {});
  return { copiadas, falhadas, restantes };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  const auth = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (auth === SB_SRV || papelDoToken(auth) === "service_role") {
    // O cron: responde já (o pg_net não espera) e copia em segundo plano.
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil(copiar(ORCAMENTO_CRON_MS).catch(() => {}));
    return json({ aceite: true }, 202);
  }

  // O admin da app — perguntado à BD com o JWT de quem chamou.
  let admin = false;
  try {
    admin = await rpc<boolean>("is_admin", {}, {
      apikey: SB_ANON, Authorization: `Bearer ${auth}`, "Content-Type": "application/json",
      "Content-Profile": "garrafeira", "Accept-Profile": "garrafeira",
    });
  } catch { /* fica false */ }
  if (!admin) return json({ error: "só o admin" }, 403);

  try {
    return json(await copiar(ORCAMENTO_ADMIN_MS));
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
