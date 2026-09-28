// supabase/functions/garrafeira-push/index.ts
// Garrafeira — notificações Web Push (migração 27, db/migracao-push.sql).
//
// Duas perguntas, e só duas:
//   · { acao: "chave" }   — a chave pública VAPID, para a app subscrever o
//                           aparelho. Qualquer sessão válida (é pública).
//   · { acao: "enviar" }  — envia o que está à espera na caixa de saída
//                           (`garrafeira.push_avisos`). Só com a
//                           service_role: quem a chama são os gatilhos (pelo
//                           pg_net) e o cron `garrafeira-push-retry`, com a
//                           chave do cofre — nunca o browser.
//
// O texto de cada aviso NÃO vem de quem chama: foi escrito na base pelos
// gatilhos (a partir do comentário e da fala), e esta função só o entrega.
// E escreve de volta o que aconteceu a cada um (`push_resultado`): enviado a
// quantos aparelhos, sem ninguém com as notificações ligadas, ou o erro do
// serviço de push. É o que faltou ao Goals, que passou semanas a "enviar"
// sem nada chegar.
//
// Mesmo par VAPID das irmãs (os secrets são do projeto, não da função):
// VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (opcional).
// verify_jwt LIGADO. Deploy: supabase functions deploy garrafeira-push

import webpush from "npm:web-push@3.6.7";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@garrafeira.app";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const srv = {
  apikey: SB_SRV, Authorization: `Bearer ${SB_SRV}`, "Content-Type": "application/json",
  "Content-Profile": "garrafeira", "Accept-Profile": "garrafeira",
};

async function rpc<T>(fn: string, corpo: unknown): Promise<T> {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: srv, body: JSON.stringify(corpo) });
  const tx = await r.text();
  if (!r.ok) throw new Error(`${fn}: HTTP ${r.status} ${tx.slice(0, 200)}`);
  return (tx ? JSON.parse(tx) : null) as T;
}

// O `role` de dentro de um JWT (a parte do meio, base64url).
function papelDoToken(tok: string): string | null {
  try {
    const p = tok.split(".")[1] || "";
    const b = atob(p.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (p.length % 4)) % 4));
    return (JSON.parse(b) as { role?: string }).role ?? null;
  } catch {
    return null;
  }
}

type Sub = { endpoint: string; p256dh: string; auth_key: string };
type Aviso = { id: number; titulo: string; corpo: string; url: string | null; origem: string | null; tentativas: number; subs: Sub[] };

async function enviarUm(a: Aviso): Promise<boolean> {
  if (!a.subs.length) {
    await rpc("push_resultado", { p_id: a.id, p_estado: "sem_subscricao",
      p_resultado: "ninguém com as notificações ligadas", p_mortos: [] });
    return false;
  }
  const payload = JSON.stringify({ title: a.titulo, body: a.corpo, url: a.url || "/Garrafeira/", tag: a.origem || undefined });
  let ok = 0;
  const mortos: string[] = [];
  const erros: string[] = [];
  await Promise.all(a.subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload, { TTL: 86400 });
      ok++;
    } catch (e) {
      const st = (e as { statusCode?: number }).statusCode;
      // 404/410: o aparelho deixou de existir (desinstalou, limpou o browser).
      if (st === 404 || st === 410) mortos.push(s.endpoint);
      erros.push(st ? `HTTP ${st}` : String((e as Error).message || e).slice(0, 80));
    }
  }));
  const estado = ok > 0 ? "enviado"
    : mortos.length === a.subs.length ? "sem_subscricao"
    : a.tentativas >= 10 ? "falhou" : "pendente";
  await rpc("push_resultado", {
    p_id: a.id, p_estado: estado, p_mortos: mortos,
    p_resultado: ok > 0
      ? `enviado a ${ok} de ${a.subs.length} aparelho(s)` + (erros.length ? ` · ${erros.join(", ")}` : "")
      : `falhou: ${erros.join(", ")}` + (mortos.length ? ` · ${mortos.length} aparelho(s) já não existe(m)` : ""),
  });
  return ok > 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  let b: { acao?: string } = {};
  try { b = await req.json(); } catch { /* sem corpo */ }

  if (b.acao === "chave") return json({ chave: VAPID_PUBLIC });

  // Enviar: só a service_role (os gatilhos e o cron, com a chave do cofre).
  // Pelo PAPEL do token e não pela chave letra a letra: a do cofre
  // (`service_role_key`) e a do ambiente da função deixaram de ser a mesma
  // cadeia de caracteres — a comparação dava 403 a um token certo (e é o que
  // está a acontecer ao `push-retry-goals`, 28/09/2026). A assinatura já foi
  // conferida à porta (verify_jwt), por isso ler o papel chega.
  const auth = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (auth !== SB_SRV && papelDoToken(auth) !== "service_role") return json({ error: "não autorizado" }, 403);

  let total = 0, enviados = 0;
  try {
    // Umas voltas no máximo: o que chegar entretanto apanha a próxima.
    for (let volta = 0; volta < 5; volta++) {
      const lote = await rpc<Aviso[]>("push_por_enviar", { p_limite: 50 });
      if (!lote || !lote.length) break;
      for (const a of lote) {
        total++;
        try { if (await enviarUm(a)) enviados++; }
        catch (e) {
          await rpc("push_resultado", { p_id: a.id, p_estado: a.tentativas >= 10 ? "falhou" : "pendente",
            p_resultado: `erro: ${String((e as Error).message || e).slice(0, 200)}`, p_mortos: [] }).catch(() => {});
        }
      }
    }
    return json({ total, enviados });
  } catch (e) {
    return json({ error: (e as Error).message, total, enviados }, 500);
  }
});
