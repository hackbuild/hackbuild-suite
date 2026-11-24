import { test } from 'node:test'
import assert from 'node:assert/strict'

// ?stub: an in memory store and stub providers, so nothing is fetched
globalThis.location = { search: '?stub', href: 'http://localhost/?stub' }
const hub = await import('../../src/models/hub.ts')
const { checkEndpoint } = await import('../../src/chat/runtimes.ts')
await hub.start()

test('a stub load turns the record loaded and resident, and unload frees it', async () => {
  const id = 'qwen2.5-0.5b-instruct-gguf'
  assert.equal(hub.states.value[id].state, 'none')
  await hub.load(id)
  assert.equal(hub.states.value[id].state, 'loaded')
  assert.ok(hub.resident.value.some((r) => r.id === id))
  assert.equal(hub.organ('brain').state, 'ok')
  await hub.unload(id)
  assert.equal(hub.states.value[id].state, 'none')
})

test('provideRuntime puts a factory on the hub that load and use reach', async () => {
  let made = 0
  hub.provideRuntime('wllama', async (ctx) => ({ made: ++made, id: ctx.record.id }))
  const id = hub.allRecords.value.find((r) => r.provider === 'wllama').id
  const l = await hub.hub().use({ id })
  assert.deepEqual(l.value, { made: 1, id })
  hub.hub().release(l)
  await hub.unload(id)
})

test('a load that throws leaves a fault with named words', async () => {
  hub.provideRuntime('tjs', async () => { throw new Error('the model did not load: out of memory') })
  const id = hub.allRecords.value.find((r) => r.provider === 'tjs' && r.provides.includes('chat')).id
  await hub.load(id)
  assert.equal(hub.states.value[id].state, 'fault')
  assert.ok(hub.states.value[id].error.length > 0)
})

test('custom rows: mlc, gguf and endpoint become records on their runtimes; the key never enters a row', () => {
  const mlc = hub.addCustom('mlc', { url: 'https://huggingface.co/me/Thing-q4f16_1-MLC', lib: 'base', base: 'x', f16: true })
  const gguf = hub.addCustom('gguf', { repo: 'me/Thing-GGUF', file: 'thing-Q4_K_M.gguf', ctx: '2048' })
  const ep = hub.addCustom('endpoint', { url: 'http://localhost:11434/v1', model: 'gemma4:e4b', key: 'sk-secret-should-not-stay' })
  const rec = (id) => hub.allRecords.value.find((r) => r.id === id)
  assert.equal(rec(mlc).provider, 'webllm')
  assert.deepEqual(rec(mlc).ladder[0].needs, ['f16'])
  assert.equal(rec(gguf).provider, 'wllama')
  assert.deepEqual(rec(gguf).source, { repo: 'me/Thing-GGUF', file: 'thing-Q4_K_M.gguf' })
  assert.equal(rec(gguf).ctx, 2048)
  assert.equal(rec(ep).provider, 'remote')
  assert.equal(rec(ep).source.url, 'http://localhost:11434/v1')
  assert.equal(hub.customOf(ep).values.key, undefined)
  assert.deepEqual(hub.customSaved.value.map((s) => s.mode), ['endpoint', 'gguf', 'mlc'])
  for (const id of [mlc, gguf, ep]) hub.removeCustom(id)
  assert.equal(rec(ep), undefined)
})

test('a mode with no check fails in words; provideCustomCheck adds the mode', async () => {
  await hub.checkCustom('gguf', {})
  assert.equal(hub.customCheck.value.state, 'fail')
  assert.match(hub.customCheck.value.lines[0], /no check for gguf/)
  hub.provideCustomCheck('gguf', async () => ({ state: 'ok', sizeMB: 12, lines: ['f.gguf'] }))
  assert.ok(hub.customModes.value.includes('gguf'))
  await hub.checkCustom('gguf', {})
  assert.equal(hub.customCheck.value.sizeMB, 12)
})

test('the webllm cache shows as its own group and evicts through its adapter', async () => {
  const rec = hub.allRecords.value.find((r) => r.provider === 'webllm')
  const gone = []
  let list = [{ modelId: rec.source.modelId, bytes: 5 * 1024 * 1024 }]
  await hub.keepWebllm({ list: async () => list, evict: async (m) => { gone.push(m); list = [] } })
  const row = hub.stored.value.find((s) => s.keeper === 'webllm')
  assert.equal(row.key, rec.id)
  assert.equal(hub.states.value[rec.id].state, 'stored')
  await hub.evict(rec.id)
  assert.deepEqual(gone, [rec.source.modelId])
  assert.equal(hub.stored.value.filter((s) => s.keeper === 'webllm').length, 0)
})

test('the endpoint check reads /models and names a down endpoint', async () => {
  const ok = await checkEndpoint({ url: 'http://h/v1/', model: 'm' }, async (u) => {
    assert.equal(u, 'http://h/v1/models')
    return new Response(JSON.stringify({ data: [{ id: 'm' }, { id: 'n' }] }))
  })
  assert.match(ok.lines[0], /2 models listed, m among them/)
  await assert.rejects(checkEndpoint({ url: 'http://h/v1', model: 'm' }, async () => { throw new TypeError('failed to fetch') }), /no answer from your endpoint/)
})
