import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ThinkSplitter } from '@hackbuild/chat'
import { createConversation, createChatStore } from '@hackbuild/converse'
import { stubChat, stubReply } from '../../src/chat/stub.ts'
import { chatKind, titleFrom } from '../../src/chat/kind.ts'
import { docSink } from '../../src/chat/sink.ts'
import { contextSegments, toLines } from '../../src/chat/lines.ts'

async function run(engine, text = 'hi there') {
  const out = { text: '', think: '', order: [] }
  for await (const ev of engine.stream([{ role: 'user', content: text }])) {
    if (ev.type === 'text') out.text += ev.text
    if (ev.type === 'think') out.think += ev.text
    if (ev.type !== 'done' && out.order.at(-1) !== ev.type) out.order.push(ev.type)
  }
  return out
}

test('the stub stream splits think text from the answer at every chunk size', async () => {
  for (const chunk of [1, 2, 3, 5, 7, 64]) {
    const r = await run(stubChat({ chunk, delayMs: 0 }))
    assert.match(r.think, /the person wrote "hi there"/)
    assert.doesNotMatch(r.text, /<\/?think>|the person wrote/)
    assert.match(r.text, /^this answer comes from a script/)
    assert.deepEqual(r.order, ['think', 'text'], `chunk ${chunk}`)
  }
})

test('the think splitter holds a tag cut across chunks and keeps an unclosed block as think', () => {
  const sp = new ThinkSplitter()
  const parts = ['<thi', 'nk>plan', ' it</th', 'ink>answer <', 'think>tail']
  let text = ''
  let think = ''
  for (const p of parts) {
    const o = sp.push(p)
    text += o.text
    think += o.think
  }
  const e = sp.end()
  assert.equal(text + e.text, 'answer ')
  assert.equal(think + e.think, 'plan ittail')
})

test('the stub reply names the turn and the last user text', () => {
  const r = stubReply([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'second' }])
  assert.match(r, /turn 2/)
  assert.match(r, /you wrote: second/)
})

test('the chat kind creates, checks and exports markdown', async () => {
  const b = chatKind.create()
  assert.equal(chatKind.check(b), null)
  assert.match(chatKind.check({ messages: 'no' }), /no messages list/)
  assert.match(chatKind.exports[0].write({ ...b, title: 't', messages: [{ id: '1', role: 'user', content: 'hey' }] }), /## user\n\nhey/)
  const file = { name: 'old.json', text: async () => JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) }
  const read = await chatKind.imports[0].read(file)
  assert.equal(read.name, 'old')
  assert.equal(read.body.messages.length, 1)
  assert.equal(titleFrom({ messages: [{ role: 'user', content: '  a   long\nfirst message that goes past forty characters' }] }), 'a long first message that goes past for...')
})

/** A document held in memory with the same edit shape the suite's useDocument has. */
function memDoc(id) {
  const d = { id, body: chatKind.create(), history: [] }
  return {
    d,
    sink: docSink({ read: () => ({ id: d.id, body: d.body }), write: (s) => { d.history.push(d.body); d.body = s } }),
  }
}
const timers = () => {
  const q = []
  return { q, t: { setTimeout: (fn) => (q.push(fn), q.length), clearTimeout: (h) => { q[h - 1] = null } }, run: () => { q.splice(0).forEach((f) => f?.()) } }
}

test('the session store saves a finished turn into the document under its id', async () => {
  const m = memDoc('doc1')
  const tm = timers()
  const c = createConversation({ engine: stubChat({ delayMs: 0 }), now: () => 1, id: 'doc1', sink: m.sink, timers: tm.t })
  const s = await c.restore()
  assert.equal(s.id, 'doc1')
  await c.send('hello')
  tm.run()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(m.d.body.id, 'doc1')
  assert.deepEqual(m.d.body.messages.map((x) => x.role), ['user', 'assistant'])
  assert.match(m.d.body.messages[1].think, /the person wrote/)
  assert.doesNotMatch(m.d.body.messages[1].content, /<think>|the person wrote/)
  // a new conversation on the same document reads it back
  const again = createConversation({ engine: stubChat({ delayMs: 0 }), now: () => 2, id: 'doc1', sink: m.sink })
  assert.equal((await again.restore()).messages.length, 2)
  // and one for another id finds nothing and saves nowhere
  const other = createConversation({ engine: stubChat({ delayMs: 0 }), now: () => 3, id: 'doc2', sink: m.sink })
  assert.equal((await other.restore()).messages.length, 0)
})

test('the store leaves a reply with no word yet out of the save', async () => {
  const m = memDoc('d')
  const tm = timers()
  const store = createChatStore(m.sink, { timers: tm.t })
  store.markRestored()
  store.save({ ...chatKind.create(), id: 'd', messages: [{ id: 'u', role: 'user', content: 'x' }, { id: 'a', role: 'assistant', content: '' }] })
  await store.flush()
  assert.deepEqual(m.d.body.messages.map((x) => x.id), ['u'])
})

test('lines carry actions, the live reply, errors and stats', () => {
  const s = {
    messages: [
      { id: 'u1', role: 'user', content: 'q' },
      { id: 'a1', role: 'assistant', content: 'a', stats: { tokens: 4, tokensSource: 'inferred', tokensPerSecond: 20, firstTokenMs: 10, totalMs: 200 } },
      { id: 'u2', role: 'user', content: 'q2' },
      { id: 'a2', role: 'assistant', content: '', error: 'the engine closed.' },
    ],
  }
  const l = toLines(s)
  assert.deepEqual(l[0].actions, ['copy', 'edit', 'remove'])
  assert.deepEqual(l[1].actions, ['speak', 'copy', 'remove'])
  assert.deepEqual(l[3].actions, ['speak', 'retry', 'copy', 'remove'])
  assert.equal(l[1].stats.source, 'inferred')
  assert.equal(l[3].note, 'reply stopped: the engine closed. press redo.')
  const live = toLines(s, { live: 'a2', pending: 'thinking' })
  assert.equal(live[3].done, false)
  assert.equal(live[3].pending, 'thinking')
  const seg = contextSegments({ system: 'abcd', messages: s.messages }, '12345678')
  assert.deepEqual(seg.map((x) => x.tokens), [1, 3, 2])
})
