// Cache da PWA.
//
// REGRA: se mexeres em app.js, style.css ou index.html, SOBE o CACHE_NAME
// (v1 -> v2). Sem isso, o browser fica com a versão velha e não há aviso
// nenhum.
const CACHE_NAME = 'garrafeira-v11';

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
