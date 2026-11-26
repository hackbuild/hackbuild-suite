// Stand ins for the gate and the smokes, loaded only under ?stub: a machine
// fixture and a loader that moves the bar and hands back mask models that
// know the sample scene. A visitor's page never imports this file.
import type { Env } from '@hackbuild/ai-env'
import type { Loader } from '@hackbuild/ai-views'
import type { MaskModels } from '@hackbuild/ai-views/elements'
import { THINGS, maskOf, on } from './scene'

/** A machine with an 8 gb class gpu, as a probe would report it (fixture). */
export const FIXTURE_ENV = {
  webgpu: true, f16: true, adapter: null, maxBufferBytes: null, isolated: false, protocol: 'https',
  opfs: true, cacheStorage: true, indexedDB: true, threads: 1, deviceMemoryGB: 8, promptApi: false,
} as unknown as Env

const models: MaskModels = {
  segment: async (img, p) => {
    const t = THINGS.find((s) => on(s, p.x, p.y, img.width, img.height))
    return t ? maskOf(t, img.width, img.height) : null
  },
  everything: async (img, o) => THINGS.filter((t) => t.score >= (o?.confidence ?? 0)).map((t) => ({ label: t.label, score: t.score, mask: maskOf(t, img.width, img.height) })),
}

export const stubLoader: Loader = (_rec, ctx) =>
  new Promise((ok, bad) => {
    let f = 0
    const t = setInterval(() => {
      f = Math.min(1, f + 0.25)
      ctx.onProgress(f)
      if (f < 1) return
      clearInterval(t)
      ok(models)
    }, 100)
    ctx.signal.addEventListener('abort', () => (clearInterval(t), bad(new Error('stopped'))))
  })
