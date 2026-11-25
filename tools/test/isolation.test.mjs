// The isolation worker (public/coi-sw.js) on a fake worker scope: headers
// on same origin documents and workers, nothing else touched, no cache.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../../public/coi-sw.js', import.meta.url), 'utf8')

function load(query = '') {
  const on = {}
  const self = { location: { href: `https://x.test/suite/coi-sw.js${query}`, origin: 'https://x.test' }, addEventListener: (k, fn) => { on[k] = fn }, skipWaiting() {}, clients: { claim: async () => {} } }
  const fetch = async () => new Response('ok', { status: 200, headers: { 'content-type': 'text/html' } })
  new Function('self', 'fetch', SRC)(self, fetch)
  return async (url, init = {}) => {
    let reply = null
    on.fetch({ request: { url, method: 'GET', mode: 'no-cors', destination: '', cache: 'default', ...init }, respondWith: (p) => { reply = p } })
    return reply && (await reply)
  }
}

test('a same origin document gets coop and coep credentialless', async () => {
  const res = await load()('https://x.test/suite/', { mode: 'navigate', destination: 'document' })
  assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin')
  assert.equal(res.headers.get('cross-origin-embedder-policy'), 'credentialless')
  assert.equal(await res.text(), 'ok')
})

test('require-corp on the script url', async () => {
  const res = await load('?coep=require-corp')('https://x.test/suite/w.js', { destination: 'worker' })
  assert.equal(res.headers.get('cross-origin-embedder-policy'), 'require-corp')
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin')
})

test('cross origin, scripts, images and posts pass untouched', async () => {
  const go = load()
  assert.equal(await go('https://huggingface.co/x/resolve/main/model.onnx', { mode: 'cors' }), null)
  assert.equal(await go('https://x.test/suite/assets/a.js', { destination: 'script' }), null)
  assert.equal(await go('https://x.test/suite/', { mode: 'navigate', method: 'POST' }), null)
})

test('the worker never touches the cache api', () => {
  assert.doesNotMatch(SRC, /caches\s*\.|cache\.put/)
})
