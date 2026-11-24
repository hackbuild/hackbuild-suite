// The vision runtimes on the one hub (design 2.2, 3.4). The vision rows
// join the catalogue; MediaPipe answers detect and landmarks, read through
// the weight store, and transformers.js answers captions and questions.
// Under ?stub every task answers from a stub with no weight and no fetch:
// the detector returns canned boxes placed on the sample scene.
import type { ModelRecord } from '@hackbuild/models'
import type { Detector } from '@hackbuild/vision'

/** The sample scene's objects as fractions of the frame: what the canned detector finds. */
export const SCENE = [
  { label: 'person', score: 0.91, x: 0.08, y: 0.18, w: 0.3, h: 0.74 },
  { label: 'laptop', score: 0.84, x: 0.46, y: 0.52, w: 0.36, h: 0.3 },
  { label: 'cup', score: 0.67, x: 0.86, y: 0.6, w: 0.1, h: 0.16 },
] as const

/** Canned boxes in frame pixels, best first, for any image with a width and height. */
export function cannedDetector(): Detector {
  return {
    async detect(img, o = {}) {
      const { width = 64, height = 48 } = (img ?? {}) as { width?: number; height?: number }
      return SCENE.filter((s) => s.score >= (o.scoreThreshold ?? 0))
        .slice(0, o.maxResults ?? Infinity)
        .map((s) => ({ label: s.label, score: s.score, box: { x: s.x * width, y: s.y * height, w: s.w * width, h: s.h * height } }))
    },
  }
}

/**
 * The sample scene: a figure, a laptop and a cup drawn on a canvas in the
 * kit's plate and part colours, so the tool runs with no file and no camera.
 */
export function drawScene(c: HTMLCanvasElement, tone: (name: string) => string): void {
  const x = c.getContext('2d')
  if (!x) return
  const W = c.width
  const H = c.height
  x.fillStyle = tone('--hb-void')
  x.fillRect(0, 0, W, H)
  x.fillStyle = tone('--hb-ink-3')
  x.fillRect(0, H * 0.82, W, H * 0.18)
  const [p, l, k] = SCENE
  // the figure: a head over a body
  x.fillStyle = tone('--hb-plate-teal')
  x.beginPath()
  x.arc((p.x + p.w / 2) * W, (p.y + 0.12) * H, p.w * 0.3 * W, 0, Math.PI * 2)
  x.fill()
  x.fillRect((p.x + p.w * 0.1) * W, (p.y + 0.26) * H, p.w * 0.8 * W, (p.h - 0.26) * H)
  // the laptop: a lid and a base
  x.fillStyle = tone('--hb-part-c')
  x.fillRect((l.x + l.w * 0.08) * W, l.y * H, l.w * 0.84 * W, l.h * 0.7 * H)
  x.fillStyle = tone('--hb-part-d')
  x.fillRect(l.x * W, (l.y + l.h * 0.72) * H, l.w * W, l.h * 0.28 * H)
  // the cup
  x.fillStyle = tone('--hb-part-b')
  x.fillRect(k.x * W, k.y * H, k.w * W, k.h * H)
}

let added = false
/** Add the rows and the runtimes. Safe to call more than once. */
export async function addVisionRuntimes(): Promise<void> {
  if (added) return
  added = true
  const [vision, hub] = await Promise.all([import('@hackbuild/vision'), import('../models/hub.ts')])
  hub.addRows(vision.VISION_RECORDS)
  const providers = [...new Set(vision.VISION_RECORDS.map((r: ModelRecord) => r.provider))]
  if (hub.STUB) {
    hub.addStubs({ ...vision.visionStubs(), detect: () => cannedDetector() }, providers)
    return
  }
  hub.provideRuntime('mediapipe', vision.mediapipeProvider({ runtime: vision.loadTasksVision(), store: hub.weights() }))
  const tjs = hub.transformers()
  if (tjs) {
    tjs.loader('vision.caption', vision.vlmLoader)
    tjs.loader('vision.ask', vision.vlmLoader)
    tjs.loader('segment', vision.samLoader)
  }
}
