import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashedEmbedder, loadCore, memorySink, open } from '@hackbuild/memory'
import { MEMORY_WASM_BASE64 } from '@hackbuild/memory/inline'
import { emptyData, memoryKind, readExport } from '../../src/memory/kind.ts'
import { pinCount, pinIndex, rememberLine, toEntries, traceEntries, traceHits, whenText } from '../../src/memory/lines.ts'
import { toLines } from '../../src/chat/lines.ts'

let t0 = Date.UTC(2026, 10, 24, 12)
const mem = async (id = 'm') => open(id, { core: await loadCore({ base64: MEMORY_WASM_BASE64 }), embed: hashedEmbedder(), sink: memorySink(), now: () => t0 })

test('remember that saves the line; other turns save nothing', () => {
  assert.equal(rememberLine('remember that the mug goes on the shelf.'), 'the mug goes on the shelf')
  assert.equal(rememberLine('Please remember: my name is ada'), 'my name is ada')
  assert.equal(rememberLine('do you remember the mug'), null)
  assert.equal(rememberLine('remember'), null)
})

test('entries list pinned lines first, then memories newest first with when words', async () => {
  const m = await mem()
  await m.add('the mug goes on the shelf', { kind: 'fact', meta: { from: 'chat' } })
  t0 += 1000
  await m.add('the cat sleeps on the red chair', { kind: 'note' })
  await m.remember('my name is ada')
  const e = toEntries(m.all(), m.core.lines)
  assert.deepEqual(e.map((x) => x.kind), ['pin', 'note', 'fact'])
  assert.equal(pinIndex(e[0].id), 0)
  assert.equal(pinIndex(e[1].id), -1)
  assert.equal(e[2].when, 'nov 24 from chat')
  assert.equal(whenText({ created: t0, edited: t0 }), 'nov 24 edited')
  assert.equal(pinCount(m.core.lines), '14 of 700 characters')
})

test('a recall trace becomes ranked entries and bars, the used ones marked', async () => {
  const m = await mem()
  await m.add('the mug goes on the shelf', { kind: 'fact' })
  await m.add('the cat sleeps on the red chair', { kind: 'fact' })
  const t = await m.explain('where does the mug go', { k: 1 })
  const e = traceEntries(t, m.all())
  assert.equal(e[0].text, 'the mug goes on the shelf')
  assert.ok(e[0].score > 0)
  const h = traceHits(t)
  assert.deepEqual(h[0].parts.map((p) => p.key), ['rel', 'rec', 'imp'])
  assert.equal(h.filter((x) => x.used).length, 1)
})

test('export reads back from a memory export or a memory document, and a stranger file is named', async () => {
  const m = await mem()
  await m.add('the mug goes on the shelf', { kind: 'fact' })
  const data = m.export()
  assert.equal(readExport(JSON.stringify(data), 'a.json').items.length, 1)
  assert.equal(readExport(JSON.stringify({ kind: 'memory.store', body: { store: 'chat', data } }), 'b.hbmem.json').items.length, 1)
  assert.throws(() => readExport('{"x":1}', 'notes.json'), /notes\.json is not a memory export/)
  assert.throws(() => readExport('nope', 'n.json'), /n\.json is not json/)
  assert.equal(memoryKind.check(memoryKind.create()), null)
  assert.match(memoryKind.check({ store: 'chat' }), /no memory export/)
  const back = await mem('n')
  assert.equal(await back.import(data), 1)
  assert.equal(memoryKind.exports[0].write({ store: 'x', data: emptyData('x') }, 'x').includes('"hackbuild-memory"'), true)
})

test('memory used shows under the reply the recall fed, not under the turn', () => {
  const lines = toLines({ messages: [
    { id: 'u', role: 'user', content: 'where does the mug go', recalled: [{ id: '1', text: 'the mug goes on the shelf' }] },
    { id: 'a', role: 'assistant', content: 'on the shelf' },
  ] })
  assert.equal(lines[0].recalled, undefined)
  assert.deepEqual(lines[1].recalled, [{ title: 'the mug goes on the shelf', ref: '1' }])
})
