// The retarget document kind (design 3.11): what the tool was set to, saved
// as `.hbretarget.json`. It keeps the source's name and kind, the bone map
// edits by joint name, the floor and scale fixes and the layout. Clip and
// body files are never saved: they stay in the tab, and the built in walk
// and the mannequin stand in on reload. Framework free.
import type { DocKind } from '../workspace/kinds.ts'
import { isBodyBone, type MapEdits, type SourceKind } from './source.ts'

export const RETARGET_KIND = 'retarget.session'

export const UNITS = ['auto', 'm', 'cm', 'mm', 'in'] as const
export type UnitName = (typeof UNITS)[number]
export const UNIT_METERS: Record<Exclude<UnitName, 'auto'>, number> = { m: 1, cm: 0.01, mm: 0.001, in: 0.0254 }

export interface RetargetOpts {
  /** Settle the motion on the floor: the lowest foot touches y = 0. */
  settle: boolean
  /** Start the hips travel at the origin. */
  origin: boolean
  /** Drop the hips travel across the floor, keep the bounce. */
  inPlace: boolean
  /** Source units; auto reads them from the rig. */
  units: UnitName
}

export interface RetargetBody {
  source: { name: string; kind: SourceKind } | null
  /** Source joint name to the humanoid bone it plays, '' for none. */
  edits: MapEdits
  opts: RetargetOpts
  layout: 'side' | 'overlay'
}

export const newRetargetBody = (): RetargetBody => ({
  source: null,
  edits: {},
  opts: { settle: true, origin: true, inPlace: false, units: 'auto' },
  layout: 'side',
})

export function checkRetarget(raw: unknown): string | null {
  const b = raw as Partial<RetargetBody> | null
  if (!b || typeof b !== 'object') return 'the body is not an object.'
  if (!b.edits || typeof b.edits !== 'object') return 'edits is missing.'
  for (const [k, v] of Object.entries(b.edits)) if (typeof v !== 'string' || (v && !isBodyBone(v))) return `joint ${k} maps to ${String(v)}, which is not a body bone.`
  const o = b.opts
  if (!o || typeof o !== 'object') return 'opts is missing.'
  for (const k of ['settle', 'origin', 'inPlace'] as const) if (typeof o[k] !== 'boolean') return `${k} is not on or off.`
  if (!(UNITS as readonly string[]).includes(String(o.units))) return `units ${String(o.units)} is not auto, m, cm, mm or in.`
  if (b.layout !== 'side' && b.layout !== 'overlay') return `layout ${String(b.layout)} is not side or overlay.`
  return null
}

export const retargetKind: DocKind<RetargetBody> = {
  kind: RETARGET_KIND,
  tool: 'retarget',
  label: 'retarget',
  ext: '.hbretarget.json',
  version: 1,
  create: newRetargetBody,
  check: checkRetarget,
}
