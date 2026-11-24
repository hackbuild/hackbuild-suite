import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryBackend } from '../../src/workspace/db.ts'
import { createKinds, FALLBACK_EXT } from '../../src/workspace/kinds.ts'
import { blobRef, createWorkspace } from '../../src/workspace/workspace.ts'
import { addDocFile, addWorkspace, readDoc, readWorkspace, writeDoc, writeWorkspace } from '../../src/workspace/files.ts'

// A kind the way a later tool (chat, transcription, memory) registers one.
const note = (over = {}) => ({
  kind: 'notes.page', tool: 'notes', label: 'note', ext: '.hbnote.json', version: 2,
  create: () => ({ text: '', lines: [] }),
  migrate: (b, from) => (from === 1 ? { text: b.t, lines: [] } : b),
  check: (b) => (typeof b?.text === 'string' ? null : 'no text'),
  models: (b) => (b.model ? [b.model] : []),
  imports: [{ accept: '.txt,text/plain', label: 'open as a note', read: async (f) => ({ name: f.name.replace(/\.txt$/, ''), body: { text: await f.text(), lines: [] } }) }],
  exports: [{ key: 'txt', label: 'text', ext: '.txt', write: (b) => b.text }],
  ...over,
})

function rig() {
  const kinds = createKinds()
  let t = 1000
  let n = 0
  const ws = createWorkspace(memoryBackend(), { kinds, now: () => t++, newId: () => `id${++n}`, delay: 5 })
  return { kinds, ws }
}

test('register checks the id, extension and version, and unregisters', () => {
  const { kinds } = rig()
  let changes = 0
  kinds.onChange(() => changes++)
  const off = kinds.register(note())
  assert.equal(kinds.get('notes.page').label, 'note')
  assert.throws(() => kinds.register(note()), /registered already/)
  assert.throws(() => kinds.register(note({ kind: 'notes.other' })), /belongs to notes.page/)
  assert.throws(() => kinds.register(note({ kind: 'Notes' })), /tool.noun/)
  assert.throws(() => kinds.register(note({ kind: 'chat.page', ext: '.hbx.json' })), /start with its tool id/)
  assert.throws(() => kinds.register(note({ kind: 'notes.a', ext: '.json' })), /\.hb<word>\.json/)
  assert.throws(() => kinds.register(note({ kind: 'notes.a', ext: FALLBACK_EXT })), /\.hb<word>\.json/)
  assert.throws(() => kinds.register(note({ kind: 'notes.a', ext: '.hba.json', version: 0 })), /version/)
  assert.equal(kinds.byExt('My Page.HBNOTE.json').kind, 'notes.page')
  assert.ok(kinds.isDocFile('x.hbchat.json'))
  assert.ok(!kinds.isDocFile('x.json'))
  off()
  assert.equal(kinds.get('notes.page'), undefined)
  assert.equal(changes, 2)
})

test('two tools that read the same file are both takers, so the router asks', () => {
  const { kinds } = rig()
  kinds.register(note())
  kinds.register(note({ kind: 'memo.item', tool: 'memo', ext: '.hbmemo.json', imports: [{ accept: '.txt', label: 'add to memory', read: async () => ({ name: 'm', body: {} }) }] }))
  assert.deepEqual(kinds.takers({ name: 'a.txt', type: 'text/plain' }).map((t) => t.via.label), ['open as a note', 'add to memory'])
  assert.deepEqual(kinds.takers({ name: 'a.srt', type: '' }), [])
})

test('upgrade migrates old bodies and names newer or broken files', () => {
  const { kinds } = rig()
  kinds.register(note())
  assert.deepEqual(kinds.upgrade('notes.page', { t: 'hi' }, 1), { text: 'hi', lines: [] })
  assert.throws(() => kinds.upgrade('notes.page', {}, 3), /newer suite/)
  assert.throws(() => kinds.upgrade('notes.page', { nope: 1 }, 2), /does not read: no text/)
  assert.deepEqual(kinds.upgrade('unknown.kind', { a: 1 }, 9), { a: 1 })
})

test('scratch exists on a first visit; projects open, rename, duplicate and delete', async () => {
  const { kinds, ws } = rig()
  kinds.register(note())
  assert.equal(await ws.ready(), 'scratch')
  await ws.createDoc('notes.page', { body: { text: 'a', lines: [] } })
  const p = await ws.newProject()
  assert.equal(ws.current(), p.id)
  assert.equal((await ws.docs()).length, 0)
  await ws.renameProject(p.id, ' bench ')
  await ws.openProject('scratch')
  const copy = await ws.duplicateProject('scratch')
  assert.equal(copy.name, 'scratch copy')
  assert.equal((await ws.docs(copy.id))[0].body.text, 'a')
  assert.notEqual((await ws.docs(copy.id))[0].id, (await ws.docs('scratch'))[0].id)
  await ws.deleteProject(copy.id)
  assert.equal(ws.current(), p.id, 'deleting the open project opens the newest left')
  assert.deepEqual((await ws.projects()).map((x) => x.name).sort(), ['bench', 'scratch'])
  await ws.deleteProject('scratch')
  await ws.deleteProject(p.id)
  assert.deepEqual((await ws.projects()).map((x) => x.id), ['scratch'], 'deleting every project brings scratch back')
})

test('autosave writes after the delay; flush writes now and counts', async () => {
  const { kinds, ws } = rig()
  kinds.register(note())
  await ws.ready()
  const d = await ws.createDoc('notes.page')
  assert.equal(d.name, 'note')
  assert.equal((await ws.createDoc('notes.page')).name, 'note 2', 'names stay unique in a project')
  ws.change({ ...d, body: { text: 'one', lines: [] } })
  assert.equal(ws.pendingCount(), 1)
  assert.equal((await ws.getDoc(d.id)).body.text, 'one', 'a waiting change reads back before it is written')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(ws.pendingCount(), 0)
  ws.change({ ...d, body: { text: 'two', lines: [] } })
  assert.equal(await ws.flush(), 1)
  assert.equal(await ws.flush(), 0)
  await ws.deleteDoc(d.id)
  ws.change({ ...d, body: { text: 'ghost', lines: [] } })
  await ws.flush()
  assert.equal(await ws.getDoc(d.id), undefined, 'a late autosave does not bring a deleted document back')
  await assert.rejects(ws.createDoc('nobody.kind'), /no tool in this build/)
})

test('a document file round trips with its blobs; local blobs stay out unless asked', async () => {
  const { kinds, ws } = rig()
  kinds.register(note())
  await ws.ready()
  const pub = await ws.putBlob(new Uint8Array([1, 2, 3]), { name: 'a.png', type: 'image/png' })
  const mine = await ws.putBlob(new Uint8Array([9]), { name: 'voice.bin', type: 'audio/wav', local: true })
  const d = await ws.createDoc('notes.page', { name: 'Field Notes', body: { text: 'x', lines: [blobRef(pub), blobRef(mine)] } })
  const out = await writeDoc(ws, kinds, d)
  assert.equal(out.name, 'field-notes.hbnote.json')
  assert.deepEqual(out.left, ['voice.bin'])
  const f = readDoc(kinds, out.text)
  assert.deepEqual(Object.keys(f.blobs), [pub])
  const back = await addDocFile(ws, f)
  assert.equal(back.name, 'Field Notes 2')
  assert.deepEqual(back.body, d.body)
  const withLocal = readDoc(kinds, (await writeDoc(ws, kinds, d, { includeLocal: true })).text)
  assert.equal(withLocal.blobs[mine].local, true)
  assert.throws(() => readDoc(kinds, '{"a":1}'), /not a suite document/)
  assert.throws(() => readDoc(kinds, 'nope'), /not json/)
})

test('a document of a kind this build lacks is kept and exports under the fallback extension', async () => {
  const { kinds, ws } = rig()
  await ws.ready()
  const f = readDoc(kinds, JSON.stringify({ format: 'hackbuild-suite.doc', schema: 1, kind: 'later.thing', tool: 'later', version: 4, name: 'later', body: { a: 1 } }))
  const d = await addDocFile(ws, f)
  assert.equal((await writeDoc(ws, kinds, d)).name, `later${FALLBACK_EXT}`)
})

test('the workspace zip round trips into another project and replaces nothing', async () => {
  const { kinds, ws } = rig()
  kinds.register(note())
  await ws.ready()
  const pub = await ws.putBlob(new Uint8Array([7, 7]), { name: 'shot.png', type: 'image/png' })
  const mine = await ws.putBlob(new Uint8Array([5]), { name: 'body.glb', type: 'model/gltf-binary', local: true })
  await ws.createDoc('notes.page', { name: 'a', body: { text: 'a', lines: [blobRef(pub)], model: 'qwen-0.5b' } })
  await ws.createDoc('notes.page', { name: 'a/b', body: { text: 'b', lines: [blobRef(mine)] } })
  const out = await writeWorkspace(ws, kinds, { at: new Date(2026, 10, 24) })
  assert.equal(out.name, 'scratch.hbsuite.zip')
  assert.deepEqual(out.manifest.left, ['body.glb'])
  assert.deepEqual(out.manifest.models, ['qwen-0.5b'])
  assert.deepEqual(out.manifest.tools, { 'notes.page': 2 })
  assert.equal(out.manifest.files.filter((f) => f.path.startsWith('docs/')).length, 2)
  const read = await readWorkspace(kinds, out.bytes)
  assert.equal(read.docs.length, 2)
  assert.equal(read.blobs.length, 1)
  const p = await ws.newProject('restore')
  const added = await addWorkspace(ws, read, p.id)
  assert.deepEqual(added.map((d) => d.body.text).sort(), ['a', 'b'])
  assert.equal((await ws.docs('scratch')).length, 2, 'the source project is untouched')
  // A damaged entry is named.
  const bad = out.bytes.slice()
  const at = Buffer.from(bad).indexOf('"text": "a"')
  bad[at + 10] = 'z'.charCodeAt(0)
  await assert.rejects(readWorkspace(kinds, bad), /crc32|sha-256/)
})
