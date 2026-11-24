import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadDsp, unzipStore } from '@hackbuild/audio-dsp'
import { AUDIO_DSP_WASM_BASE64 } from '@hackbuild/audio-dsp/inline'
import { createHub, createRegistry } from '@hackbuild/models'
import { bundle, TRANSCRIBE_RECORDS, transcribe } from '@hackbuild/transcribe'
import { createKinds } from '../../src/workspace/kinds.ts'
import { CAPTURE, docOf, emptyBody, sketch, transcriptKind, withRun } from '../../src/transcribe/kind.ts'
import { STUB_LINES, stubTranscriber } from '../../src/transcribe/runtimes.ts'
import { testWav } from '../test-wav.mjs'

const blobs = new Map()
const kind = transcriptKind(async (data, meta) => {
  const h = `h${blobs.size}`
  blobs.set(h, { data, ...meta })
  return h
})

/** The test wav as float samples, 16 kHz mono. */
function pcm() {
  const w = testWav()
  const s = new Int16Array(w.buffer, 44)
  return Float32Array.from(s, (v) => v / 32768)
}

async function run() {
  const hub = createHub({ registry: createRegistry(TRANSCRIBE_RECORDS), env: { webgpu: false, threads: 4 } })
  hub.provide('tjs', async () => stubTranscriber())
  const dsp = await loadDsp({ base64: AUDIO_DSP_WASM_BASE64 })
  return transcribe(hub, dsp, pcm(), { ...CAPTURE, model: 'whisper-base.en', language: 'auto' })
}

test('the kind registers with its extension and takes recordings and transcripts', () => {
  const kinds = createKinds()
  kinds.register(kind)
  assert.equal(kinds.byExt('take.hbtranscript.json')?.kind, 'transcribe.transcript')
  assert.equal(kinds.takers({ name: 'take.wav', type: 'audio/wav' })[0]?.via.label, 'transcribe this recording')
  assert.equal(kinds.takers({ name: 'clip.mov', type: '' })[0]?.via.label, 'transcribe this recording')
  assert.equal(kinds.takers({ name: 'take.srt', type: '' })[0]?.via.label, 'open as a transcript')
  assert.equal(kinds.takers({ name: 'notes.txt', type: 'text/plain' }).length, 0)
  assert.equal(kind.check({ segments: [{ start: 0, end: 1, text: 'a' }] }), null)
  assert.match(kind.check({ segments: [{ start: 0 }] }), /no start, end or text/)
  assert.match(kind.check({}), /no segments/)
})

test('a dropped recording is stored local only and queued', async () => {
  const f = new File([testWav(1)], 'take one.wav', { type: 'audio/wav' })
  const r = await kind.imports[0].read(f)
  assert.equal(r.name, 'take one')
  assert.equal(r.body.state, 'queued')
  assert.equal(r.body.source, 'take one.wav')
  const stored = blobs.get(r.body.audio.$blob)
  assert.equal(stored.local, true)
  assert.equal(stored.data.length, f.size)
  await assert.rejects(kind.imports[0].read(new File(['x'], 'notes.txt', { type: 'text/plain' })), /not audio or video/)
})

test('a run on the stub transcriber gives segments, a rail sketch and the run facts', async () => {
  const t = await run()
  assert.ok(t.segments.length >= 2, `${t.segments.length} segments`)
  assert.ok(t.segments.every((s) => STUB_LINES.includes(s.text)))
  assert.equal(t.model, 'whisper-base.en')
  assert.equal(t.language, 'en')
  const b = withRun(emptyBody({ source: 'take.wav' }), t)
  assert.equal(b.state, 'done')
  assert.ok(b.rail.db.length > 0 && b.rail.db.length <= 480)
  assert.equal(b.rail.db.length, b.rail.kept.length)
  assert.ok(b.rail.kept.some((k) => k === 1) && b.rail.kept.some((k) => k === 0), 'the gate keeps the bursts and cuts the gaps')
  assert.ok(b.rail.noiseDb < b.rail.thrDb)
  assert.ok(Math.abs(b.rail.duration - 8) < 0.05)
})

test('exports write every listed format, and srt and json import back to the same lines', async () => {
  const t = await run()
  const b = withRun(emptyBody({ source: 'take.wav' }), t)
  b.segments[0] = { ...b.segments[0], speaker: 'ana', edited: true }
  const out = Object.fromEntries(kind.exports.map((e) => [e.key, String(e.write(b, 'take'))]))
  assert.deepEqual(Object.keys(out), ['txt', 'srt', 'vtt', 'json', 'lrc'])
  assert.match(out.srt, /-->/)
  assert.match(out.vtt, /^WEBVTT/)
  assert.match(out.vtt, /<v ana>/)
  assert.match(out.lrc, /^\[ti:take\]|\[\d\d:\d\d\.\d\d\]/m)
  const json = JSON.parse(out.json)
  assert.equal(json.model, 'whisper-base.en')
  assert.equal(json.segments[0].edited, true)
  for (const key of ['srt', 'json']) {
    const back = await kind.imports[1].read(new File([out[key]], `take.${key}`))
    assert.deepEqual(back.body.segments.map((s) => s.text), b.segments.map((s) => s.text), key)
    assert.equal(back.body.segments[0].speaker, 'ana', key)
    assert.equal(back.body.audio, null)
  }
  await assert.rejects(kind.imports[1].read(new File(['not a transcript'], 'x.srt')))
})

test('the zip of every file records each run in its manifest', async () => {
  const t = await run()
  const b = withRun(emptyBody({ source: 'take.wav' }), t)
  const { zip, manifest } = bundle([docOf(b), docOf({ ...b, source: 'take.mp3', language: 'fr' })], { date: new Date(0) })
  assert.equal(manifest.files.length, 2)
  assert.equal(manifest.language, 'mixed')
  const names = unzipStore(zip).map((e) => e.name)
  assert.deepEqual(names.slice(0, 5), ['manifest.json', 'take.txt', 'take.srt', 'take.vtt', 'take.json'])
  assert.ok(names.includes('take-2.json'))
})

test('a sketch folds any frame count and marks a bin kept when most frames pass', () => {
  const rail = { db: Float32Array.from([-60, -60, -20, -20, -20, -60]), open: Uint8Array.from([0, 0, 1, 1, 1, 0]), duration: 0.06, noiseDb: -60, thrDb: -40, loudDb: -20 }
  const s = sketch(rail, 3)
  assert.deepEqual(s.db, [-60, -20, -20])
  assert.deepEqual(s.kept, [0, 1, 1])
  assert.equal(sketch(rail).db.length, 6)
})
