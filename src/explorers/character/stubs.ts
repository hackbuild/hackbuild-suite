// Stand ins for the gate and the smokes, loaded only under ?stub: a machine
// fixture and a loader that moves a bar, fetches nothing, and resolves to
// what jobLoader would for each job, written in code. A visitor's page never
// imports this file.
import type { Env } from '@hackbuild/ai-env'
import type { Job, Loader } from '@hackbuild/ai-views'
import { scripted } from '@hackbuild/chat'
import { hashedEmbedder } from '@hackbuild/memory'
import { stubEngine } from '@hackbuild/speak'

/** A machine with an 8 gb class gpu, as a probe would report it (fixture). */
export const env = {
  webgpu: true, f16: true, adapter: null, maxBufferBytes: null, isolated: false, protocol: 'https',
  opfs: true, cacheStorage: true, indexedDB: true, threads: 1, deviceMemoryGB: 8, promptApi: false,
} as unknown as Env

const REPLIES = ['stand in reply for the gate. no model ran.', 'still a stand in. the voice and the mouth are real code, the words are written.']

function runtime(job: Job): unknown {
  if (job === 'chat') return scripted({ replies: REPLIES, chunk: 6 })
  if (job === 'voice') return stubEngine()
  if (job === 'embed') return hashedEmbedder(512)
  return undefined
}

/** Moves the bar to full over about half a second, then hands back the stand in. */
export const loaderFor = (job: Job): Loader => (_rec, ctx) =>
  new Promise((ok, bad) => {
    let f = 0
    const t = setInterval(() => {
      f = Math.min(1, f + 0.25)
      ctx.onProgress(f)
      if (f < 1) return
      clearInterval(t)
      ok(runtime(job))
    }, 120)
    ctx.signal.addEventListener('abort', () => (clearInterval(t), bad(new Error('stopped'))))
  })
