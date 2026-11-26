// Stand ins for the gate and the smokes, loaded only under ?stub: a machine
// fixture and a loader that moves the bar and hands back an image model that
// paints a seeded pattern through the same steps and stages as the real one.
// A visitor's page never imports this file.
import type { Env } from '@hackbuild/ai-env'
import type { Loader } from '@hackbuild/ai-views'
import { formOf } from '@hackbuild/imagegen'

/** A machine with an 8 gb class gpu, as a probe would report it (fixture). */
export const FIXTURE_ENV = {
  webgpu: true, f16: true, adapter: null, maxBufferBytes: null, isolated: false, protocol: 'https',
  opfs: true, cacheStorage: true, indexedDB: true, threads: 1, deviceMemoryGB: 8, promptApi: false,
} as unknown as Env

interface Opts { prompt: string; seed?: number; steps?: number; size?: number; onStep?: (p: { stage: 'text' | 'denoise' | 'decode'; step: number; steps: number; ms: number }) => void }

function paint(o: Opts) {
  const n = o.size ?? 512
  const c = document.createElement('canvas')
  c.width = c.height = n
  const x = c.getContext('2d')!
  let h = o.seed ?? 1
  for (const ch of o.prompt) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const hue = h % 360
  const g = x.createLinearGradient(0, 0, 0, n)
  g.addColorStop(0, `hsl(${hue} 60% 78%)`)
  g.addColorStop(1, `hsl(${(hue + 40) % 360} 45% 52%)`)
  x.fillStyle = g
  x.fillRect(0, 0, n, n)
  x.fillStyle = '#fe0386'
  x.beginPath()
  x.arc(n * (0.3 + ((h >> 4) % 40) / 100), n * 0.6, n * 0.18, 0, Math.PI * 2)
  x.fill()
  x.fillStyle = '#2f5fa7'
  x.fillRect(n * 0.55, n * 0.42, n * 0.26, n * 0.26)
  return x.getImageData(0, 0, n, n).data
}

export const stubLoader: Loader = (rec, ctx) =>
  new Promise((ok, bad) => {
    let f = 0
    const t = setInterval(() => {
      f = Math.min(1, f + 0.25)
      ctx.onProgress(f)
      if (f < 1) return
      clearInterval(t)
      const form = formOf(rec)!
      ok({
        record: rec,
        form,
        release() {},
        async make(o: Opts) {
          const steps = o.steps ?? form.steps.default
          o.onStep?.({ stage: 'text', step: 1, steps: 1, ms: 40 })
          for (let i = 1; i <= steps; i++) {
            await new Promise((r) => setTimeout(r, 60))
            o.onStep?.({ stage: 'denoise', step: i, steps, ms: 60 })
          }
          o.onStep?.({ stage: 'decode', step: 1, steps: 1, ms: 30 })
          return { width: o.size ?? 512, height: o.size ?? 512, rgba: paint(o), seed: o.seed ?? 1, ms: { text: 40, unet: 60 * steps, vae: 30 } }
        },
      })
    }, 100)
    ctx.signal.addEventListener('abort', () => (clearInterval(t), bad(new Error('stopped'))))
  })
