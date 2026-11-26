// Stand ins for the gate and the smokes, loaded only under ?stub: a machine
// fixture and a loader that moves the bar and hands back a depth call that
// reads the sample's shapes. A visitor's page never imports this file.
import type { Env } from '@hackbuild/ai-env'
import type { DepthFn, Loader } from '@hackbuild/ai-views'
import { sampleDepth } from './sample'

/** A machine with an 8 gb class gpu, as a probe would report it (fixture). */
export const FIXTURE_ENV = {
  webgpu: true, f16: true, adapter: null, maxBufferBytes: null, isolated: false, protocol: 'https',
  opfs: true, cacheStorage: true, indexedDB: true, threads: 1, deviceMemoryGB: 8, promptApi: false,
} as unknown as Env

const depth: DepthFn = async (image) => {
  const c = image as HTMLCanvasElement
  return sampleDepth(c.getContext('2d')!.getImageData(0, 0, c.width, c.height))
}

export const stubLoader: Loader = (_rec, ctx) =>
  new Promise((ok, bad) => {
    let f = 0
    const t = setInterval(() => {
      f = Math.min(1, f + 0.25)
      ctx.onProgress(f)
      if (f < 1) return
      clearInterval(t)
      ok(depth)
    }, 100)
    ctx.signal.addEventListener('abort', () => (clearInterval(t), bad(new Error('stopped'))))
  })
