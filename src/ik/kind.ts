// The ik document kind (design 3.11) and the pose file. A session keeps the
// solver, the chain in hand, the look and planting switches and every
// target with its pin, saved as `.hbik.json`; body files are never in it.
// A pose exports as json: each human bone's local rotation and the hips
// position, the shape the avatar and retarget tools read by bone name.
// Framework free.
import type { DocKind } from '../workspace/kinds.ts'

export const IK_KIND = 'ik.session'

export const TARGETS = ['leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'hips', 'look'] as const
export type TargetId = (typeof TARGETS)[number]

export const CHAINS = ['left arm', 'right arm', 'left leg', 'right leg', 'spine'] as const
export type ChainId = (typeof CHAINS)[number]
/** The target each chain is posed by. */
export const CHAIN_TARGET: Record<ChainId, TargetId> = {
  'left arm': 'leftHand', 'right arm': 'rightHand', 'left leg': 'leftFoot', 'right leg': 'rightFoot', spine: 'hips',
}

export const SOLVERS = ['two bone', 'fabrik', 'ccd'] as const
export type Solver = (typeof SOLVERS)[number]

export type Vec3 = [number, number, number]

export interface TargetState {
  /** World position, meters; null until the body has stood once. */
  pos: Vec3 | null
  /** Held where it was put; released, it follows the body. */
  pinned: boolean
}

export interface IkBody {
  solver: Solver
  chain: ChainId
  /** Planted feet stay on the floor where they landed. */
  plant: boolean
  /** The head turns to the look target. */
  look: boolean
  targets: Record<TargetId, TargetState>
}

export const newIkBody = (): IkBody => ({
  solver: 'two bone',
  chain: 'left arm',
  plant: true,
  look: true,
  targets: {
    leftHand: { pos: null, pinned: false },
    rightHand: { pos: null, pinned: false },
    leftFoot: { pos: null, pinned: true },
    rightFoot: { pos: null, pinned: true },
    hips: { pos: null, pinned: false },
    look: { pos: null, pinned: false },
  },
})

const isVec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))

export function checkIk(raw: unknown): string | null {
  const b = raw as Partial<IkBody> | null
  if (!b || typeof b !== 'object') return 'the body is not an object.'
  if (!(SOLVERS as readonly string[]).includes(String(b.solver))) return `solver ${String(b.solver)} is not two bone, fabrik or ccd.`
  if (!(CHAINS as readonly string[]).includes(String(b.chain))) return `chain ${String(b.chain)} is not one of ${CHAINS.join(', ')}.`
  if (typeof b.plant !== 'boolean' || typeof b.look !== 'boolean') return 'plant and look are on or off.'
  if (!b.targets || typeof b.targets !== 'object') return 'targets is missing.'
  for (const id of TARGETS) {
    const t = b.targets[id]
    if (!t || typeof t.pinned !== 'boolean') return `target ${id} is missing.`
    if (t.pos !== null && !isVec(t.pos)) return `target ${id} has no x, y, z.`
  }
  return null
}

export const ikKind: DocKind<IkBody> = {
  kind: IK_KIND,
  tool: 'ik',
  label: 'ik',
  ext: '.hbik.json',
  version: 1,
  create: newIkBody,
  check: checkIk,
}

/** A pose file: local rotations by human bone, the hips position, the targets that made it. */
export interface PoseFile {
  format: 'hackbuild.pose'
  version: 1
  body: string
  /** x, y, z, w by human bone name. */
  rotations: Record<string, [number, number, number, number]>
  /** The hips bone's local position, meters in its parent. */
  hips: Vec3
  targets: Partial<Record<TargetId, Vec3 & { length: 3 }>>
}

const r5 = (v: number) => Math.round(v * 1e5) / 1e5

export function poseFile(body: string, rotations: Record<string, ArrayLike<number>>, hips: ArrayLike<number>, targets: Partial<Record<TargetId, ArrayLike<number>>>): PoseFile {
  const q = Object.fromEntries(Object.entries(rotations).map(([k, v]) => [k, [r5(v[0]!), r5(v[1]!), r5(v[2]!), r5(v[3]!)]])) as PoseFile['rotations']
  const t = Object.fromEntries(Object.entries(targets).map(([k, v]) => [k, [r5(v![0]!), r5(v![1]!), r5(v![2]!)]])) as PoseFile['targets']
  return { format: 'hackbuild.pose', version: 1, body, rotations: q, hips: [r5(hips[0]!), r5(hips[1]!), r5(hips[2]!)], targets: t }
}

/** The copy for a target past the chain's reach, null within it. */
export function reachLine(over: number): string | null {
  return over > 0.005 ? `the target is out of reach by ${over.toFixed(2)} m. the chain is fully extended.` : null
}
