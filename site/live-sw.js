/* 只做一件事：给播放页的文档响应补上跨域隔离头。
   Moonshine 的默认 WASM 构建开了多线程，需要 SharedArrayBuffer，而 SAB 只在
   跨域隔离的页面里可用。GitHub Pages 不能自定义响应头，所以由这个同源
   Service Worker 在导航响应上补 COOP/COEP。

   用 credentialless 而不是 require-corp：require-corp 会把所有不带 CORP 的
   跨域子资源（封面图、没开 CORS 的音频）一起挡掉，而 credentialless 允许它们
   以“不带凭据”的方式正常加载，普通播放因此不受影响。

   只处理 mode=navigate 的同源文档请求，其余请求一律放行，不缓存、不改写。 */
const COOP = 'same-origin';
const COEP = 'credentialless';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.mode !== 'navigate') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const response = await fetch(request, { credentials: 'same-origin' });
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', COOP);
    headers.set('Cross-Origin-Embedder-Policy', COEP);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  })());
});
