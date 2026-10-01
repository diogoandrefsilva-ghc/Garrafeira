// Cache da PWA.
//
// REGRA: se mexeres em app.js, style.css ou index.html, SOBE o CACHE_NAME
// (v1 -> v2). Sem isso, o browser fica com a versão velha e não há aviso
// nenhum.
//
// E o número é dos TRÊS: o `CACHE_NAME` daqui, o `APP_BUILD` do app.js e o
// `data-build` do <body>. Sobem no mesmo commit, e é a discordância entre
// os dois últimos que o app.js apanha ao arrancar — o network-first abaixo
// manda no browser, mas não no CDN do GitHub Pages, que propaga um
// ficheiro de cada vez.
const CACHE_NAME = 'garrafeira-v154';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys().then((keys) =>
        Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null)))
    ));
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    const url = new URL(e.request.url);
    if (url.hostname !== self.location.hostname) return;

    // Network-first para o HTML **e para o JS/CSS**, os três juntos.
    // Com o JS em cache-first, um deploy dava ao browser o index.html NOVO
    // com o app.js VELHO na mesma carga: botões novos a chamar funções que
    // ainda não existiam, sem erro visível — carregava-se e não acontecia
    // nada. (Aconteceu no Goals; a correção veio de lá.) Estes ficheiros
    // andam sempre juntos, logo actualizam-se todos pela rede.
    if (url.pathname.endsWith('.html') || url.pathname === '/' || url.pathname.endsWith('/')
        || url.pathname.endsWith('/app.js') || url.pathname.endsWith('/style.css')) {
        e.respondWith(
            fetch(e.request.url, { cache: 'no-store' })   // no-store: não reusa HTML stale do CDN
                .then((res) => {
                    if (res && res.status === 200) {
                        const clone = res.clone();
                        caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
                    }
                    return res;
                })
                .catch(() => caches.match(e.request))
        );
        return;
    }

    // Cache-first para o resto (ícones, manifest, tipos de letra)
    e.respondWith(caches.match(e.request).then((cached) =>
        cached || fetch(e.request).then((res) => {
            if (res && res.status === 200) {
                const clone = res.clone();
                caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
            }
            return res;
        })
    ));
});

// ── NOTIFICAÇÕES PUSH (migração 27) ─────────────────────────────────────
// O texto vem da Edge Function `garrafeira-push`, que o leu da caixa de
// saída na base. O `url` diz onde o toque leva: a Garrafeira em
// "#comentarios" (quem escreveu) ou o Alertas do WineCatalog (o admin).
self.addEventListener('push', (e) => {
    let d = {};
    try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
    const base = self.registration.scope;
    e.waitUntil(self.registration.showNotification(d.title || 'Garrafeira', {
        body: d.body || '',
        icon: new URL('apple-touch-icon.png', base).href,
        badge: new URL('icone.svg', base).href,
        tag: d.tag || undefined,
        data: { url: d.url || base },
    }));
});

self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
    const semHash = (u) => u.split('#')[0];
    e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => {
        // Uma janela já aberta na mesma página: vai para lá (o hash diz o
        // sítio, e a app ouve o `hashchange`) em vez de abrir outra.
        const w = ws.find((x) => semHash(x.url) === semHash(url));
        if (w) return (w.navigate ? w.navigate(url) : Promise.resolve(w)).then((x) => (x || w).focus());
        return self.clients.openWindow(url);
    }));
});
