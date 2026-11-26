// The sample photo: a cube and two balls on a light floor, drawn here so it
// needs no file and no model. Brightness and inflate work on it as is; the
// ?stub depth model reads the same shapes back as near and far.
export const W = 640
export const H = 480

export function samplePhoto(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const x = c.getContext('2d')!
  x.fillStyle = '#efe9db'
  x.fillRect(0, 0, W, H)
  // the cube: front, top and side
  x.fillStyle = '#5a4fb0'
  x.fillRect(110, 200, 170, 150)
  x.fillStyle = '#8379d0'
  x.beginPath(), x.moveTo(110, 200), x.lineTo(160, 160), x.lineTo(330, 160), x.lineTo(280, 200), x.fill()
  x.fillStyle = '#3d3480'
  x.beginPath(), x.moveTo(280, 200), x.lineTo(330, 160), x.lineTo(330, 310), x.lineTo(280, 350), x.fill()
  for (const [cx, cy, r, a, b] of [[430, 290, 90, '#ff7ab4', '#a3124f'], [540, 360, 50, '#7fd0a0', '#2d6a40']] as const) {
    const g = x.createRadialGradient(cx - r / 3, cy - r / 3, r / 8, cx, cy, r)
    g.addColorStop(0, a)
    g.addColorStop(1, b)
    x.fillStyle = g
    x.beginPath(), x.arc(cx, cy, r, 0, Math.PI * 2), x.fill()
  }
  return c
}

/** Near is 1, far is 0: the sample's shapes read back from their colours, the floor falling away to the top. */
export function sampleDepth(img: { width: number; height: number; data: ArrayLike<number> }): { width: number; height: number; data: Float32Array } {
  const { width: w, height: h, data } = img
  const out = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4]!, g = data[i * 4 + 1]!, b = data[i * 4 + 2]!
    const floor = Math.abs(r - 239) + Math.abs(g - 233) + Math.abs(b - 219) < 30
    const y = Math.floor(i / w) / h
    out[i] = floor ? 0.1 + 0.15 * y : 0.55 + 0.45 * ((r + g + b) / 765)
  }
  return { width: w, height: h, data: out }
}
