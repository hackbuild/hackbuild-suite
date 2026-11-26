// Stand ins for the gate and the smokes, loaded only under ?stub: a machine
// fixture and a loader that moves the bar and hands back models that know
// the sample scene. The nano detector misses the cup, as small ones do. A
// visitor's page never imports this file.
import type { Env } from '@hackbuild/ai-env'
import type { Loader } from '@hackbuild/ai-views'
import { SCENE } from './scene'

/** A machine with an 8 gb class gpu, as a probe would report it (fixture). */
export const FIXTURE_ENV = {
  webgpu: true, f16: true, adapter: null, maxBufferBytes: null, isolated: false, protocol: 'https',
  opfs: true, cacheStorage: true, indexedDB: true, threads: 1, deviceMemoryGB: 8, promptApi: false,
} as unknown as Env

type Img = { width?: number; height?: number; videoWidth?: number; videoHeight?: number }
const dims = (i: unknown) => {
  const m = (i ?? {}) as Img
  return { w: m.videoWidth || m.width || 640, h: m.videoHeight || m.height || 480 }
}

function valueFor(id: string, provides: readonly string[]): unknown {
  if (provides.includes('detect')) {
    const keep = id === 'yolov10n' ? 2 : 3
    const lift = id === 'yolov10m' ? 0.06 : id === 'yolov10s' ? 0.03 : 0
    return async (img: unknown) => {
      const { w, h } = dims(img)
      return SCENE.slice(0, keep).map((s) => ({ label: s.label, score: Math.min(0.99, s.score + lift), x: s.x * w, y: s.y * h, w: s.w * w, h: s.h * h }))
    }
  }
  if (provides.some((p) => p.startsWith('landmarks'))) {
    const p = SCENE[0]
    const cx = p.x + p.w / 2
    const ring = (r: number, n: number, cy: number) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * 1.3 * Math.sin((i / n) * 2 * Math.PI), 0] as [number, number, number])
    const pose: [number, number, number][] = [[cx, 0.3, 0], [cx, 0.48, 0], [cx - 0.1, 0.5, 0], [cx + 0.1, 0.5, 0], [cx, 0.75, 0], [cx - 0.06, 0.9, 0], [cx + 0.06, 0.9, 0]]
    const pts = id.startsWith('face') ? ring(0.06, 24, 0.3) : id.startsWith('pose') ? pose : ring(0.03, 21, 0.62)
    return { detect: async () => ({ points: [pts], ...(id.startsWith('gesture') ? { gestures: [{ name: 'Open_Palm', score: 0.88 }] } : {}), source: id }) }
  }
  return async (_img: unknown, q?: string) => (q ? `the person sits at a desk. there is a laptop and a red cup.` : 'a person at a desk with a laptop and a red cup')
}

export const stubLoader: Loader = (rec, ctx) =>
  new Promise((ok, bad) => {
    let f = 0
    const t = setInterval(() => {
      f = Math.min(1, f + 0.25)
      ctx.onProgress(f)
      if (f < 1) return
      clearInterval(t)
      ok(valueFor(rec.id, rec.provides ?? []))
    }, 100)
    ctx.signal.addEventListener('abort', () => (clearInterval(t), bad(new Error('stopped'))))
  })
