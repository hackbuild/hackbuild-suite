// Stand ins for the gate and the smokes, loaded only under ?stub: a machine
// fixture and a loader that moves the bar and hands back a transcriber with
// written lines and levels. A visitor's page never imports this file.
import type { Env } from '@hackbuild/ai-env'
import type { Loader, Transcriber } from '@hackbuild/ai-views'

/** A machine with an 8 gb class gpu, as a probe would report it (fixture). */
export const FIXTURE_ENV = {
  webgpu: true, f16: true, adapter: null, maxBufferBytes: null, isolated: false, protocol: 'https',
  opfs: true, cacheStorage: true, indexedDB: true, threads: 1, deviceMemoryGB: 8, promptApi: false,
} as unknown as Env

const LINES = ['stand in line one. no model ran.', 'stand in line two, from the gate.', 'stand in line three.']
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const run: Transcriber = async (_file, ctx) => {
  for (let f = 0.25; f <= 1; f += 0.25) {
    await sleep(80)
    ctx.onProgress(f)
  }
  const db = Array.from({ length: 120 }, (_, i) => (Math.floor(i / 20) % 2 ? -62 : -24 + 6 * Math.sin(i)))
  return {
    segments: LINES.map((text, i) => ({ start: i * 3, end: i * 3 + 2.6, text })),
    duration: 9, language: 'en', model: 'stand in',
    stats: { dur: 9, noiseDb: -60, speechDb: -21, snrDb: 39, gainDb: 1.2, density: 0.5, thrDb: -54, loudDb: -12, reels: 1, wall: 0.3, rtf: 30, forced: false },
    rail: { db, kept: db.map((d) => (d > -50 ? 1 : 0)) },
  }
}

export const stubLoader: Loader = (_rec, ctx) =>
  new Promise((ok, bad) => {
    let f = 0
    const t = setInterval(() => {
      f = Math.min(1, f + 0.25)
      ctx.onProgress(f)
      if (f < 1) return
      clearInterval(t)
      ok(run)
    }, 100)
    ctx.signal.addEventListener('abort', () => (clearInterval(t), bad(new Error('stopped'))))
  })
