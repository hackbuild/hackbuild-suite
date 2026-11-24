// The relief document kind (design 3.5, flow F-4 up to the export step).
// One photo, its depth map stored as a grey png beside it so the model
// never reruns for a saved design (P-DEPTH-1), the height source, the
// bench parameters and the keep mask the erase and restore brush paints.
// Saved as `.hbrelief.json`; the depth png exports from the document.
// Framework free, so the tests run it in node.

import { RELIEF_DEFAULTS, type HeightSourceName, type ReliefParams } from '@hackbuild/depth-mesh'
import type { MaskRle } from '@hackbuild/vision'
import type { DocKind } from '../workspace/kinds.ts'

export const RELIEF_KIND = 'relief.design'

export interface ReliefBody {
  /** Image name without its extension. */
  name: string
  /** A jpeg data url, or null before a photo is in. */
  image: string | null
  width: number
  height: number
  /** The depth map as a grey png data url, at the photo's size; null until depth runs. */
  depth: string | null
  /** The model that made the depth map, for the manifest. */
  depthModel: string | null
  source: HeightSourceName
  params: ReliefParams
  keepLargest: boolean
  /** Cells the brush left in the relief: run length at the photo's size, null for all of it. */
  keep: MaskRle | null
}

export const newBody = (): ReliefBody => ({
  name: 'photo', image: null, width: 0, height: 0, depth: null, depthModel: null, source: 'brightness', params: { ...RELIEF_DEFAULTS }, keepLargest: false, keep: null,
})

/** A body for a fresh photo: the depth map and the brush go, the settings stay. */
export const withImage = (b: ReliefBody, name: string, f: { image: string; width: number; height: number }): ReliefBody =>
  ({ ...b, name, ...f, depth: null, depthModel: null, keep: null, source: b.source === 'depth' ? 'brightness' : b.source })

/** The bytes of a base64 data url. */
export function dataUrlBytes(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(',') + 1)
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

/** Clamp the parameters to the bench's ranges, base under height. */
export function clampParams(p: ReliefParams): ReliefParams {
  const c = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo))
  const base = c(p.base, 0, 1.2)
  return {
    width: c(p.width, 6, 100), base, height: c(p.height, Math.max(0.36, base + 0.12), 30), gamma: c(p.gamma, 0.3, 3), bgcut: c(p.bgcut, 0, 0.9),
    smooth: c(p.smooth, 0, 2), invert: !!p.invert, threshold: c(p.threshold, 0.05, 0.95),
  }
}

function check(b: unknown): string | null {
  const s = b as Partial<ReliefBody> | null
  if (!s || typeof s !== 'object') return 'a relief document is an object.'
  if (s.image !== null && (typeof s.image !== 'string' || !s.image.startsWith('data:image/'))) return 'its photo is not a data url.'
  if (s.depth !== null && (typeof s.depth !== 'string' || !s.depth.startsWith('data:image/png'))) return 'its depth map is not a png data url.'
  if (!['depth', 'brightness', 'inflate'].includes(s.source as string)) return `${String(s.source)} is not a height source.`
  if (!s.params || typeof s.params.height !== 'number') return 'it has no relief settings.'
  if (s.keep && (s.keep.size?.[0] !== s.height || s.keep.size?.[1] !== s.width)) return 'the brush mask does not match the photo size.'
  return null
}

/** The kind; `read` turns a dropped image into a stored frame. */
export function reliefKind(read: (file: File) => Promise<{ image: string; width: number; height: number }>): DocKind<ReliefBody> {
  return {
    kind: RELIEF_KIND,
    tool: 'relief',
    label: 'relief',
    ext: '.hbrelief.json',
    version: 1,
    create: newBody,
    check,
    models: (b) => (b.depthModel ? [b.depthModel] : []),
    imports: [
      {
        accept: 'image/*,.png,.jpg,.jpeg,.webp',
        label: 'make a relief',
        async read(file) {
          if (file.type && !file.type.startsWith('image/')) throw new Error(`${file.name} is not an image.`)
          const name = file.name.replace(/\.[a-z0-9]+$/i, '')
          return { name, body: withImage(newBody(), name, await read(file)) }
        },
      },
    ],
    exports: [
      {
        key: 'depth', label: 'depth png', ext: '.depth.png', note: 'the stored depth map, 8 bit grey, nearer is lighter.', type: 'image/png',
        write: (b) => {
          if (!b.depth) throw new Error('no depth map yet. run depth first.')
          return dataUrlBytes(b.depth)
        },
      },
    ],
  }
}
