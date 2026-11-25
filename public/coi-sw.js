// Cross origin isolation for hosts that send no COOP or COEP headers, such
// as GitHub Pages (design 5 item 10). The hosted build carries and registers it;
// the single file builds never do. It adds the two headers to same origin
// documents and worker scripts so the page gets SharedArrayBuffer and wasm
// can run on several threads. Every other request goes straight to the
// network untouched. It keeps no cache: the weight store stays the only
// place weights live.
//
// ?coep=credentialless (default) or ?coep=require-corp on the script url
// picks the embedder policy; the page picks require-corp where the browser
// has no credentialless.
const COEP = new URL(self.location.href).searchParams.get('coep') === 'require-corp' ? 'require-corp' : 'credentialless'
const KINDS = new Set(['document', 'iframe', 'frame', 'worker', 'sharedworker'])

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

/** Whether a request gets the headers: same origin GET documents and worker scripts. */
function wants(req, origin) {
  if (req.method !== 'GET') return false
  if (new URL(req.url).origin !== origin) return false
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return false
  return req.mode === 'navigate' || KINDS.has(req.destination)
}

/** The response with the isolation headers; opaque responses pass as they are. */
function isolate(res, coep = COEP) {
  if (res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect') return res
  const headers = new Headers(res.headers)
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Embedder-Policy', coep)
  if (coep === 'require-corp') headers.set('Cross-Origin-Resource-Policy', 'same-origin')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

self.addEventListener('fetch', (e) => {
  if (!wants(e.request, self.location.origin)) return
  e.respondWith(fetch(e.request).then((res) => isolate(res)))
})
