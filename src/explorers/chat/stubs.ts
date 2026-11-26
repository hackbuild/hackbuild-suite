// Stand ins for the gate and the smokes, loaded only under ?stub: a machine
// fixture and a loader that moves the bar and hands back a scripted chat
// engine. A visitor's page never imports this file.
import type { Env } from '@hackbuild/ai-env'
import { scripted } from '@hackbuild/chat'
import type { Loader } from '@hackbuild/ai-views'

/** A machine with an 8 gb class gpu, as a probe would report it (fixture). */
export const FIXTURE_ENV = {
  webgpu: true, f16: true, adapter: null, maxBufferBytes: null, isolated: false, protocol: 'https',
  opfs: true, cacheStorage: true, indexedDB: true, threads: 1, deviceMemoryGB: 8, promptApi: false,
} as unknown as Env

export const stubLoader: Loader = (_rec, ctx) =>
  new Promise((ok, bad) => {
    let f = 0
    const t = setInterval(() => {
      f = Math.min(1, f + 0.25)
      ctx.onProgress(f)
      if (f < 1) return
      clearInterval(t)
      ok(scripted({ replies: ['stand in reply for the gate. no model ran. memory found the lines under this.'], chunk: 6 }))
    }, 120)
    ctx.signal.addEventListener('abort', () => (clearInterval(t), bad(new Error('stopped'))))
  })
