import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { generate, IMAGEGEN_RECORDS, loadLabel } from '@hackbuild/imagegen'
import { createKinds } from '../../src/workspace/kinds.ts'
import { genKind, newSession, pngText, pngWithText, PNG_KEY, readSettings, reuse, RUNS_CAP, runLine, sidecar, withRun } from '../../src/generate/kind.ts'
import { seededStubModel, stubTokenize } from '../../src/generate/runtimes.ts'

const run = (id, o = {}) => ({ id, at: 0, model: 'sd-turbo', prompt: 'p', negative: '', seed: 7, steps: 2, guidance: null, size: 512, ms: { text: 1, unet: 2, vae: 3, total: 2500 }, image: 'data:image/png;base64,AA', ...o })

// a 1 by 1 png built by hand
function png() {
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length)
    b.writeUInt32BE(data.length, 0)
    b.write(type, 4, 'latin1')
    data.copy(b, 8)
    return b
  }
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 1, 2, 3]))), chunk('IEND', Buffer.alloc(0))]))
}

test('the kind registers, checks its body and restores a sidecar', async () => {
  const k = createKinds()
  const kind = genKind()
  k.register(kind)
  assert.equal(k.byExt('a.hbimagegen.json')?.kind, 'generate.images')
  assert.equal(k.takers({ name: 'x.imagegen.json', type: 'application/json' })[0]?.kind.kind, 'generate.images')
  assert.equal(kind.check(newSession()), null)
  assert.match(kind.check({ ...newSession(), runs: [{ image: 'x' }] }), /no image/)
  const r = await kind.imports[0].read(new File([sidecar(run('a', { seed: 99, prompt: 'a kiln' }))], 'generate_sd-turbo_99.imagegen.json'))
  assert.equal(r.body.seed, 99)
  assert.equal(r.body.prompt, 'a kiln')
  assert.equal(r.body.runs.length, 0)
  assert.throws(() => readSettings('{"prompt":1}'), /no prompt/)
})

test('runs are newest first, capped, and the old current becomes the compare', () => {
  let b = newSession()
  for (let i = 0; i < RUNS_CAP + 2; i++) b = withRun(b, run(String(i)))
  assert.equal(b.runs.length, RUNS_CAP)
  assert.equal(b.current, String(RUNS_CAP + 1))
  assert.equal(b.compare, String(RUNS_CAP))
  const back = reuse(b, run('z', { seed: 3, steps: 4, prompt: 'q' }))
  assert.deepEqual([back.seed, back.steps, back.prompt, back.runs.length], [3, 4, 'q', RUNS_CAP])
  assert.equal(runLine(run('a')), 'sd-turbo, seed 7, 2 steps, 2.5 s')
})

test('a png carries its settings in a text chunk', () => {
  const s = sidecar(run('a', { seed: 41 }))
  const out = pngWithText(png(), PNG_KEY, s)
  assert.equal(readSettings(pngText(out)[PNG_KEY]).seed, 41)
  assert.deepEqual(pngText(png()), {})
  assert.throws(() => pngWithText(new Uint8Array(40), PNG_KEY, s), /not a png/)
})

test('the stub paints the same pixels for a seed and other pixels for another', async () => {
  const m = seededStubModel()
  const sessions = { textEncoder: m.sessions.text_encoder, unet: m.sessions.unet, vaeDecoder: m.sessions.vae_decoder }
  const go = (seed) => generate(m.ort, sessions, stubTokenize, { prompt: 'a kiln', seed, steps: 2, size: 64 })
  const [a, b, c] = await Promise.all([go(5), go(5), go(6)])
  assert.equal(a.width, 64)
  assert.deepEqual(a.rgba, b.rgba)
  assert.notDeepEqual(a.rgba, c.rgba)
  const spread = new Set(a.rgba.filter((_, i) => i % 4 === 0)).size
  assert.ok(spread > 50, `the stub picture is flat: ${spread} reds`)
})

test('the two records name their size with its source', () => {
  assert.deepEqual(IMAGEGEN_RECORDS.map((r) => r.id), ['sd-turbo', 'sd-1.5'])
  assert.match(loadLabel(IMAGEGEN_RECORDS[1]), /about 2\.0 gb \(vendor\)$/) // imagegen 0.1.2 cites the vendor size
})
