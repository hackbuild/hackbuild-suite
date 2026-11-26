// The sample scene: the original studio's test picture, a cube and three
// balls on a tiled floor under a sky, drawn here so it needs no file. The
// shapes are exported so the ?stub models can cut them with no weights.
export const W = 1024
export const H = 768

export interface Thing { label: string; score: number; kind: 'ball' | 'cube'; x: number; y: number; r: number; colour: string }

export const THINGS: Thing[] = [
  { label: 'cube', score: 0.97, kind: 'cube', x: 290, y: 418, r: 255, colour: '#5a4fb0' },
  { label: 'pink ball', score: 0.98, kind: 'ball', x: 692, y: 634, r: 147, colour: '#d92a6c' },
  { label: 'green ball', score: 0.93, kind: 'ball', x: 849, y: 496, r: 59, colour: '#3f7a3a' },
  { label: 'teal ball', score: 0.95, kind: 'ball', x: 967, y: 712, r: 83, colour: '#2f6f80' },
]

/** The cube as an outline: front face plus its top and side. */
const CUBE = (t: Thing) => [
  [t.x, t.y + 40], [t.x + 60, t.y], [t.x + t.r, t.y], [t.x + t.r, t.y + 175], [t.x + t.r - 60, t.y + 216], [t.x, t.y + 216],
] as const

function inPoly(x: number, y: number, pts: readonly (readonly [number, number])[]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!
    const [xj, yj] = pts[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Whether an image pixel of a w by h picture lies on a thing. */
export function on(t: Thing, x: number, y: number, w = W, h = H): boolean {
  const sx = (x * W) / w
  const sy = (y * H) / h
  return t.kind === 'ball' ? (sx - t.x) ** 2 + (sy - t.y) ** 2 <= t.r ** 2 : inPoly(sx, sy, CUBE(t))
}

/** A 0 or 255 mask of one thing at w by h. */
export function maskOf(t: Thing, w: number, h: number): Uint8Array {
  const m = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (on(t, x, y, w, h)) m[y * w + x] = 255
  return m
}

/** The sample picture. */
export function sampleCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const sky = g.createLinearGradient(0, 0, 0, 420)
  sky.addColorStop(0, '#7fb0e2')
  sky.addColorStop(1, '#e9f0f4')
  g.fillStyle = sky
  g.fillRect(0, 0, W, H)
  g.fillStyle = '#6c8f62'
  g.beginPath()
  g.ellipse(260, 430, 420, 90, 0, Math.PI, 0)
  g.ellipse(820, 430, 380, 80, 0, Math.PI, 0)
  g.fill()
  g.fillStyle = '#b39d7d'
  g.fillRect(0, 410, W, H - 410)
  g.strokeStyle = '#8c785c'
  g.lineWidth = 2
  for (let i = -12; i <= 12; i++) {
    g.beginPath()
    g.moveTo(W / 2 + i * 30, 410)
    g.lineTo(W / 2 + i * 140, H)
    g.stroke()
  }
  for (let y = 430; y < H; y += (y - 380) / 4) {
    g.beginPath()
    g.moveTo(0, y)
    g.lineTo(W, y)
    g.stroke()
  }
  for (const t of THINGS) {
    g.fillStyle = 'rgba(60, 45, 30, 0.35)'
    g.beginPath()
    g.ellipse(t.x + (t.kind === 'cube' ? t.r / 2 : 0), t.kind === 'cube' ? t.y + 222 : t.y + t.r * 0.9, t.kind === 'cube' ? t.r * 0.6 : t.r, 22, 0, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = t.colour
    if (t.kind === 'cube') {
      g.beginPath()
      CUBE(t).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
      g.closePath()
      g.fill()
      g.fillStyle = 'rgba(255,255,255,0.18)'
      g.beginPath()
      g.moveTo(t.x, t.y + 40); g.lineTo(t.x + 60, t.y); g.lineTo(t.x + t.r, t.y); g.lineTo(t.x + t.r - 60, t.y + 40)
      g.closePath()
      g.fill()
    } else {
      const shade = g.createRadialGradient(t.x - t.r / 3, t.y - t.r / 3, t.r / 8, t.x, t.y, t.r)
      shade.addColorStop(0, '#ffffff88')
      shade.addColorStop(0.3, t.colour)
      shade.addColorStop(1, '#1a1a1a')
      g.fillStyle = shade
      g.beginPath()
      g.arc(t.x, t.y, t.r, 0, Math.PI * 2)
      g.fill()
    }
  }
  return c
}
