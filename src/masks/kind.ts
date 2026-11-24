// The masks document kind (design 3.6): one image with its hash, the
// instances cut from it (each with the prompts that made it, its mask as
// run length and its decoder score) and the saved masks, which are the
// history. Saved as `.hbmasks.json`; the instances export as a
// `.masks.json` file of COCO style run lengths, which the tool reads back.
// Framework free, so the tests run it in node.

import { maskFromRle, maskToRle, maskUnion, emptyMask, type Mask, type MaskRle, type SegmentPrompt } from '@hackbuild/vision'
import type { DocKind } from '../workspace/kinds.ts'

export const MASKS_KIND = 'masks.cutouts'
export const INSTANCES_EXT = '.masks.json'
/** Saved masks kept per document, newest first. */
export const SAVED_CAP = 12

/** A prompt as the prompt canvas places it, in image pixels. */
export type Prompt =
  | { kind: 'point'; x: number; y: number; positive: boolean }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number; positive: boolean }

export interface Instance {
  id: string
  /** Index into the instance colours; kept, so a colour never moves to another instance. */
  colour: number
  prompts: Prompt[]
  rle: MaskRle
  /** Decoder score 0 to 1, null for a mask brought in from a file. */
  score: number | null
  hidden: boolean
  /** Changed by hand after the decoder. */
  edited: boolean
}

export interface SavedMask {
  id: string
  name: string
  at: number
  rle: MaskRle
}

export interface MasksBody {
  /** Image name without its extension. */
  name: string
  /** A jpeg data url, or null before an image is in. */
  image: string | null
  width: number
  height: number
  /** FNV-1a of the image url: the key of its embedding. */
  hash: string
  instances: Instance[]
  saved: SavedMask[]
  /** The next instance colour. */
  next: number
}

export const newBody = (): MasksBody => ({ name: 'image', image: null, width: 0, height: 0, hash: '', instances: [], saved: [], next: 0 })

/** FNV-1a 32 over a string, as hex. */
export function hashText(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** A body for a fresh image: every instance and saved mask goes. */
export const withImage = (name: string, f: { image: string; width: number; height: number }): MasksBody =>
  ({ ...newBody(), name, ...f, hash: hashText(f.image) })

/**
 * Canvas prompts as a decoder prompt. SAM takes one box, so the last kept
 * box goes; a leave out box becomes a leave out point at its centre.
 */
export function toSegmentPrompt(ps: Prompt[]): SegmentPrompt {
  const points: NonNullable<SegmentPrompt['points']> = []
  let box: SegmentPrompt['box']
  for (const p of ps) {
    if (p.kind === 'point') points.push({ x: p.x, y: p.y, label: p.positive ? 1 : 0 })
    else if (p.positive) box = { x: p.x0, y: p.y0, w: p.x1 - p.x0, h: p.y1 - p.y0 }
    else points.push({ x: (p.x0 + p.x1) / 2, y: (p.y0 + p.y1) / 2, label: 0 })
  }
  return { ...(points.length ? { points } : {}), ...(box ? { box } : {}) }
}

/** True when the prompts can make a mask: a kept point or a kept box. */
export const canDecode = (ps: Prompt[]): boolean => ps.some((p) => p.positive)

/** The union of the shown instances, or of every instance. */
export function unionOf(b: MasksBody, all = false): Mask {
  let m = emptyMask(b.width, b.height)
  for (const i of b.instances) if (all || !i.hidden) m = maskUnion(m, maskFromRle(i.rle))
  return m
}

/** Every instance merged into one, which keeps the first one's colour. */
export function mergeAll(b: MasksBody): MasksBody {
  const first = b.instances[0]
  if (b.instances.length < 2 || !first) return b
  const merged: Instance = { ...first, prompts: b.instances.flatMap((i) => i.prompts), rle: maskToRle(unionOf(b, true)), score: null, hidden: false, edited: true }
  return { ...b, instances: [merged] }
}

/** Push a saved mask, newest first, capped. */
export function withSaved(b: MasksBody, s: SavedMask): MasksBody {
  return { ...b, saved: [s, ...b.saved.filter((x) => x.id !== s.id)].slice(0, SAVED_CAP) }
}

/** The instances file: size, image hash and one run length per instance. */
export function instancesJson(b: MasksBody): string {
  return JSON.stringify({
    tool: 'hackbuild masks', version: 1,
    image: { name: b.name, width: b.width, height: b.height, hash: b.hash },
    instances: b.instances.map((i, n) => ({ id: i.id, label: `instance ${n + 1}`, score: i.score, hidden: i.hidden, prompts: i.prompts, rle: i.rle })),
  })
}

/** Masks read back from an instances file; throws with the copy to show. */
export function readInstances(text: string, width: number, height: number): { rle: MaskRle; score: number | null; prompts: Prompt[] }[] {
  let o: { instances?: { rle?: MaskRle; score?: number | null; prompts?: Prompt[] }[] }
  try {
    o = JSON.parse(text) as typeof o
  } catch {
    throw new Error('the masks file is not json.')
  }
  if (!Array.isArray(o?.instances)) throw new Error('the file holds no instances.')
  return o.instances.map((i) => {
    const r = i.rle
    if (!r || !Array.isArray(r.counts) || !Array.isArray(r.size)) throw new Error('an instance has no run length.')
    if (r.size[0] !== height || r.size[1] !== width) throw new Error(`the masks are ${r.size[1]} by ${r.size[0]} and the image is ${width} by ${height}.`)
    return { rle: r, score: typeof i.score === 'number' ? i.score : null, prompts: Array.isArray(i.prompts) ? i.prompts : [] }
  })
}

/** A grey or alpha mask image as a mask: 128 and up on the alpha, or on the grey when the image is opaque. */
export function maskFromRgba(width: number, height: number, rgba: ArrayLike<number>): Mask {
  const n = width * height
  let opaque = true
  for (let i = 0; i < n && opaque; i++) if (rgba[i * 4 + 3]! < 255) opaque = false
  const data = new Uint8Array(n)
  for (let i = 0; i < n; i++) data[i] = (opaque ? rgba[i * 4]! : rgba[i * 4 + 3]!) >= 128 ? 255 : 0
  return { width, height, data }
}

/** Paint a stroke's coverage into a mask: erase takes out, restore puts back. */
export function strokeInto(m: Mask, cover: ArrayLike<number>, tool: 'erase' | 'restore'): Mask {
  const data = m.data.slice()
  const v = tool === 'erase' ? 0 : 255
  for (let i = 0; i < data.length; i++) if (cover[i * 4 + 3]! >= 128) data[i] = v
  return { width: m.width, height: m.height, data }
}

function check(b: unknown): string | null {
  const s = b as Partial<MasksBody> | null
  if (!s || typeof s !== 'object') return 'a masks document is an object.'
  if (!Array.isArray(s.instances) || !Array.isArray(s.saved)) return 'it has no instance list.'
  if (s.image !== null && (typeof s.image !== 'string' || !s.image.startsWith('data:image/'))) return 'its image is not a data url.'
  if (s.instances.some((i) => !i?.rle || i.rle.size?.[0] !== s.height || i.rle.size?.[1] !== s.width)) return 'an instance mask does not match the image size.'
  return null
}

/** The kind; `read` turns a dropped image into a stored frame. */
export function masksKind(read: (file: File) => Promise<{ image: string; width: number; height: number }>): DocKind<MasksBody> {
  return {
    kind: MASKS_KIND,
    tool: 'masks',
    label: 'masks',
    ext: '.hbmasks.json',
    version: 1,
    create: newBody,
    check,
    imports: [
      {
        accept: 'image/*,.png,.jpg,.jpeg,.webp,.gif',
        label: 'cut out in masks',
        async read(file) {
          if (file.type && !file.type.startsWith('image/')) throw new Error(`${file.name} is not an image.`)
          const name = file.name.replace(/\.[a-z0-9]+$/i, '')
          return { name, body: withImage(name, await read(file)) }
        },
      },
    ],
    exports: [
      { key: 'instances', label: 'instances', ext: INSTANCES_EXT, note: 'one run length mask per instance with its prompts and score.', type: 'application/json', write: (b) => instancesJson(b) },
    ],
  }
}
