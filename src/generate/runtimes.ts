// The image generation runtimes on the one hub (design 2.2, 3.7). The
// imagegen records join the catalogue and load through the hub's ort
// provider and the weight store, so the tool never builds sessions by hand.
// Under ?stub a weightless model answers: the UNet predicts no noise and
// the VAE paints the seeded latent as smooth colour fields, so the same
// seed gives the same pixels and nothing is fetched.
import type { ModelRecord } from '@hackbuild/models'
import type { ClipTokenize, ImagegenModel } from '@hackbuild/imagegen'

class Tensor {
  readonly type: string
  readonly data: Float32Array | Int32Array | BigInt64Array
  readonly dims: number[]
  constructor(type: string, data: Float32Array | Int32Array | BigInt64Array, dims: number[]) {
    this.type = type
    this.data = data
    this.dims = dims
  }
}

/** A weightless model whose picture is a function of the seed alone; `stepMs` slows each UNet call so stop can land. */
export function seededStubModel(stepMs = 0): ImagegenModel {
  const pause = () => (stepMs ? new Promise((r) => setTimeout(r, stepMs)) : Promise.resolve())
  return {
    ort: { Tensor },
    sessions: {
      text_encoder: { run: async () => ({ last_hidden_state: { data: new Float32Array(77 * 8), dims: [1, 77, 8] } }) },
      unet: {
        run: async (f) => {
          await pause()
          return { out_sample: { data: new Float32Array((f.sample as Tensor).data.length) } }
        },
      },
      vae_decoder: {
        run: async (f) => {
          const t = f.latent_sample as Tensor
          return { sample: { data: paint(t.data as Float32Array, t.dims[2]!, t.dims[3]!) } }
        },
      },
    },
  }
}

/** The latent (4 by h by w) upsampled 8 times with bilinear weights into rgb in -1 to 1. */
export function paint(lat: Float32Array, h: number, w: number): Float32Array {
  const n = h * w
  const ch = [0, 1, 2, 3].map((c) => {
    const s = blur(lat.subarray(c * n, (c + 1) * n), h, w, 3)
    let m = 0
    for (const v of s) m += v
    m /= n
    let d = 0
    for (const v of s) d += (v - m) ** 2
    const sd = Math.sqrt(d / n) || 1
    return Float32Array.from(s, (v) => (v - m) / sd)
  })
  const H = h * 8
  const W = w * 8
  const out = new Float32Array(3 * H * W)
  const at = (c: Float32Array, y: number, x: number) => {
    const y0 = Math.min(h - 1, Math.floor(y))
    const x0 = Math.min(w - 1, Math.floor(x))
    const y1 = Math.min(h - 1, y0 + 1)
    const x1 = Math.min(w - 1, x0 + 1)
    const fy = y - y0
    const fx = x - x0
    return (c[y0 * w + x0]! * (1 - fx) + c[y0 * w + x1]! * fx) * (1 - fy) + (c[y1 * w + x0]! * (1 - fx) + c[y1 * w + x1]! * fx) * fy
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ly = y / 8
      const lx = x / 8
      const d = at(ch[3]!, ly, lx) * 0.5
      for (let c = 0; c < 3; c++) out[c * H * W + y * W + x] = Math.tanh(0.9 * (at(ch[c]!, ly, lx) + d))
    }
  }
  return out
}

/** A separable box blur of radius r, so the seeded noise reads as colour fields. */
function blur(src: Float32Array, h: number, w: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length)
  const out = new Float32Array(src.length)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0
    for (let k = -r; k <= r; k++) a += src[y * w + Math.min(w - 1, Math.max(0, x + k))]!
    tmp[y * w + x] = a
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0
    for (let k = -r; k <= r; k++) a += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]!
    out[y * w + x] = a
  }
  return out
}

/** Character codes as ids for the stub; the real tool uses the record's CLIP tokenizer. */
export const stubTokenize: ClipTokenize = (p) => Int32Array.from([49406, ...[...p.slice(0, 75)].map((c) => c.charCodeAt(0) % 49405), 49407])

let tokenizers = new Map<string, Promise<ClipTokenize>>()
/** The CLIP tokenizer a form names, through transformers.js, once per id. */
export function clipTokenizer(id: string): Promise<ClipTokenize> {
  let p = tokenizers.get(id)
  if (!p) {
    p = (async () => {
      const { loadTransformers } = await import('@hackbuild/devices')
      const tjs = (await loadTransformers()()) as unknown as { AutoTokenizer: { from_pretrained(id: string): Promise<(t: string, o: object) => Promise<{ input_ids: { data: ArrayLike<number | bigint> } }>> } }
      const tok = await tjs.AutoTokenizer.from_pretrained(id)
      return async (text: string) => Int32Array.from((await tok(text, { padding: 'max_length', max_length: 77, truncation: true })).input_ids.data, (v) => Number(v))
    })()
    p.catch(() => tokenizers.delete(id))
    tokenizers.set(id, p)
  }
  return p
}
export const resetTokenizers = () => { tokenizers = new Map() }

/** Per file download rows of the loading model, keyed by record then file. */
export type FileRows = (recordId: string, file: string, fraction: number | null) => void

let added = false
/** Add the records and the ort runtime. Safe to call more than once. */
export async function addGenerateRuntimes(onFile: FileRows): Promise<void> {
  if (added) return
  added = true
  const [gen, hub] = await Promise.all([import('@hackbuild/imagegen'), import('../models/hub.ts')])
  if (hub.STUB) {
    // stub pages run headless where webgpu may be missing: a wasm rung lets the weightless model load anyway
    hub.addRows(gen.IMAGEGEN_RECORDS.map((r: ModelRecord) => ({ ...r, ladder: [...r.ladder, { device: 'wasm' as const }] })))
    hub.addStubs({ imagegen: () => seededStubModel(60) }, ['ort'])
    return
  }
  hub.addRows(gen.IMAGEGEN_RECORDS)
  const { loadOrt, ortProvider } = await import('@hackbuild/devices')
  hub.provideRuntime('ort', ortProvider({ runtime: loadOrt(), store: hub.weights(), onProgress: onFile }).factory)
}
