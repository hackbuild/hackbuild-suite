// The sample scene: a figure at a desk with a laptop and a cup, drawn on a
// canvas in the kit's plate and part colours, so the lab runs with no file
// and no camera. SCENE is where each thing sits, as fractions of the frame.

export const SCENE = [
  { label: 'person', score: 0.91, x: 0.08, y: 0.18, w: 0.3, h: 0.74 },
  { label: 'laptop', score: 0.84, x: 0.46, y: 0.52, w: 0.36, h: 0.3 },
  { label: 'cup', score: 0.67, x: 0.86, y: 0.6, w: 0.1, h: 0.16 },
] as const

/** The scene on a fresh 640 by 480 canvas. */
export function sampleCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 640
  c.height = 480
  const x = c.getContext('2d')!
  const W = c.width
  const H = c.height
  x.fillStyle = '#efe9db'
  x.fillRect(0, 0, W, H)
  x.fillStyle = '#d9d0bd'
  x.fillRect(0, H * 0.82, W, H * 0.18)
  const [p, l, k] = SCENE
  x.fillStyle = '#2b8a8a'
  x.beginPath()
  x.arc((p.x + p.w / 2) * W, (p.y + 0.12) * H, p.w * 0.3 * W, 0, Math.PI * 2)
  x.fill()
  x.fillRect((p.x + p.w * 0.1) * W, (p.y + 0.26) * H, p.w * 0.8 * W, (p.h - 0.26) * H)
  x.fillStyle = '#2f5fa7'
  x.fillRect((l.x + l.w * 0.08) * W, l.y * H, l.w * 0.84 * W, l.h * 0.7 * H)
  x.fillStyle = '#1a1a1a'
  x.fillRect(l.x * W, (l.y + l.h * 0.72) * H, l.w * W, l.h * 0.28 * H)
  x.fillStyle = '#c3251f'
  x.fillRect(k.x * W, k.y * H, k.w * W, k.h * H)
  return c
}
