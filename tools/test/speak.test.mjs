import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderSpeech, renderedWavBytes, SPEAK_RECORDS } from '@hackbuild/speak'
import { createKinds } from '../../src/workspace/kinds.ts'
import { linesFrom, newScript, peaksOf, runThumb, speechKind, withRun, RUNS_CAP } from '../../src/speak/kind.ts'
import { SPEAK_ORDER, STUB_POCKET_VOICES, TRADES, stubPocket, toneEngine } from '../../src/speak/runtimes.ts'

test('the speech kind registers and checks its body', () => {
  const k = createKinds()
  k.register(speechKind)
  assert.equal(k.byExt('a.hbspeech.json')?.kind, 'speak.script')
  assert.equal(speechKind.check(newScript()), null)
  assert.match(speechKind.check({ text: 1 }), /no text/)
})

test('a txt or srt opens as lines to speak', () => {
  assert.equal(linesFrom('one\r\n\r\ntwo\n'), 'one\ntwo')
  assert.equal(linesFrom('1\n00:00:00,000 --> 00:00:01,000\nhello there\n\n2\n00:00:01,000 --> 00:00:02,000\nagain\n'), 'hello there\nagain')
})

test('the tone voice renders a tone per word with its times', async () => {
  const text = 'one two three'
  const r = await renderSpeech(toneEngine('t'), text)
  assert.equal(r.engine, 't')
  assert.equal(r.words.length, 3)
  assert.deepEqual(r.words.map((w) => text.slice(w.start, w.end)), ['one', 'two', 'three'])
  assert.ok(r.words.every((w, i) => !w.estimated && (i === 0 || w.t0 >= r.words[i - 1].t1)))
  const wav = renderedWavBytes(r)
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF')
  assert.ok(wav.length > 44)
  const p = peaksOf(r.samples)
  assert.equal(p.length, 24)
  assert.ok(Math.max(...p) > 0.1)
  assert.match(runThumb(p), /^data:image\/svg\+xml,/)
})

test('runs are newest first and capped', () => {
  let runs = []
  for (let i = 0; i < RUNS_CAP + 3; i++) runs = withRun(runs, { id: String(i), text: 'x', engine: 'e', voice: '', rate: 1, pitch: 1, at: i, duration: null, peaks: [] })
  assert.equal(runs.length, RUNS_CAP)
  assert.equal(runs[0].id, String(RUNS_CAP + 2))
})

test('every engine card has a record with a licence and a trade', () => {
  for (const id of SPEAK_ORDER) {
    const r = SPEAK_RECORDS.find((x) => x.id === id)
    assert.ok(r, id)
    assert.ok(r.licence.length > 3, id)
    assert.ok(TRADES[id].trade, id)
  }
  assert.ok(!SPEAK_ORDER.slice(0, 1).includes('kokoro-82m'), 'kokoro is never the first engine')
})

test('the stub pocket lists voices and clones a clip into "custom"', async () => {
  const p = stubPocket()
  assert.deepEqual(p.voices(), STUB_POCKET_VOICES)
  await assert.rejects(p.cloneVoice(new Float32Array(0), 16000))
  await p.cloneVoice(new Float32Array(16000).fill(0.1), 16000)
  assert.ok(p.voices().includes('custom'))
  const r = await renderSpeech(p, 'one two', { voice: { voice: 'custom' } })
  assert.equal(r.words.length, 2)
})
