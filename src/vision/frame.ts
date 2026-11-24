// Frames for the vision tool: decode an image into a stored frame, turn a
// stored frame back into a canvas the models read, and draw what was found
// over it. The drawn canvas is the annotated png export, so the colours are
// the instance list's and the face is the kit's utility face.
import { instanceColour } from '@virgilvox/hackbuild-ui/vanilla'
import { kinds, registerKind } from '../workspace/state'
import { fitSide, VISION_KIND, visionKind, type Capture, type Found } from './kind.ts'

/** A kit token read from the page, for canvas drawing. */
export const tone = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/** An image url or blob as a stored frame: a jpeg data url, at most FRAME_SIDE on its long side. */
export async function readFrame(src: Blob | string): Promise<{ image: string; width: number; height: number }> {
  const url = typeof src === 'string' ? src : URL.createObjectURL(src)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return toFrame(img, img.naturalWidth, img.naturalHeight)
  } catch {
    throw new Error('the image does not decode. try a png or a jpeg.')
  } finally {
    if (typeof src !== 'string') URL.revokeObjectURL(url)
  }
}

/** Any drawable at w by h on a canvas at most FRAME_SIDE on its long side; `into` is reused when given. */
export function fitCanvas(src: CanvasImageSource, w: number, h: number, into?: HTMLCanvasElement | null): HTMLCanvasElement {
  const { width, height } = fitSide(w, h)
  const canvas = into ?? document.createElement('canvas')
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  canvas.getContext('2d')!.drawImage(src, 0, 0, width, height)
  return canvas
}

/** Any drawable at w by h as a stored frame. */
export function toFrame(src: CanvasImageSource, w: number, h: number): { image: string; width: number; height: number } {
  const canvas = fitCanvas(src, w, h)
  return { image: canvas.toDataURL('image/jpeg', 0.85), width: canvas.width, height: canvas.height }
}

const frames = new Map<string, Promise<HTMLCanvasElement>>()
/** The canvas the models read for a capture, decoded once per capture. */
export function frameOf(c: Capture): Promise<HTMLCanvasElement> {
  let f = frames.get(c.id)
  if (!f) {
    f = (async () => {
      const img = new Image()
      img.src = c.image
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = c.width
      canvas.height = c.height
      canvas.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
      return canvas
    })()
    frames.set(c.id, f)
    if (frames.size > 12) frames.delete(frames.keys().next().value!)
  }
  return f
}

/** The frame with each box, its label and score, and the landmark points. */
export function drawSeen(out: HTMLCanvasElement, src: CanvasImageSource, w: number, h: number, found: readonly Found[], points: Capture['points']): void {
  if (out.width !== w) out.width = w
  if (out.height !== h) out.height = h
  const x = out.getContext('2d')
  if (!x) return
  x.drawImage(src, 0, 0, w, h)
  const lw = Math.max(2, Math.round(Math.max(w, h) / 240))
  const fs = Math.max(12, Math.round(Math.max(w, h) / 32))
  x.font = `${fs}px ${tone('--hb-utility') || 'monospace'}`
  x.textBaseline = 'top'
  found.forEach((f, i) => {
    if (f.hidden) return
    const col = instanceColour(i)
    const { x: bx, y: by, w: bw, h: bh } = f.box
    x.strokeStyle = col
    x.lineWidth = lw
    x.strokeRect(bx, by, bw, bh)
    const text = `${f.label} ${Math.round(Math.min(1, f.score) * 100)}`
    const tw = x.measureText(text).width + 8
    const ty = by - fs - 6 >= 0 ? by - fs - 6 : by
    x.fillStyle = col
    x.fillRect(bx - lw / 2, ty, tw, fs + 6)
    x.fillStyle = tone('--hb-ink')
    x.fillText(text, bx + 4 - lw / 2, ty + 3)
  })
  const r = Math.max(2, lw)
  points.forEach((p, k) => {
    x.fillStyle = instanceColour(found.length + k)
    for (const set of p.sets) for (const [px, py] of set) x.fillRect(px * w - r / 2, py * h - r / 2, r, r)
  })
}

/** Register the session kind, so an image dropped on any page opens in vision. */
export function registerVision(): void {
  if (!kinds.get(VISION_KIND)) registerKind(visionKind(readFrame))
}
