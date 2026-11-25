// Poses and clips of the avatar tool as files, and the built in clips that
// play on any humanoid body, the mannequin included. Framework free and
// three free: rotations are local quaternions x y z w over a bone name
// list, the order @hackbuild/presence clips use.

export type Quat = [number, number, number, number]

/** A presence clip, as `@hackbuild/presence` reads it. */
export interface ClipData {
  name: string
  fps: number
  frames: number
  bones: number
  loop: boolean
  /** frames * bones * 4 local rotations. */
  rotations: Float32Array
  root?: Float32Array
}

export const POSE_FORMAT = 'hackbuild.pose'
export const CLIP_FORMAT = 'hackbuild.clip'
export const POSE_EXT = '.pose.json'
export const CLIP_EXT = '.clip.json'

export interface PoseFile {
  format: typeof POSE_FORMAT
  version: 1
  name: string
  /** Human bone name to local rotation. */
  bones: Record<string, Quat>
  /** Blendshapes held by hand, by morph name. */
  morphs: Record<string, number>
  expression: string | null
}

export interface ClipFile {
  format: typeof CLIP_FORMAT
  version: 1
  name: string
  fps: number
  frames: number
  loop: boolean
  /** Human bone names, the order of the rotations. */
  bones: string[]
  /** frames * bones * 4, rounded to 5 places. */
  rotations: number[]
}

const round = (v: number) => Math.round(v * 1e5) / 1e5
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Seconds a clip runs: the last frame's time. */
export const clipSeconds = (c: Pick<ClipData, 'frames' | 'fps'>) => Math.max(0, c.frames - 1) / c.fps

export function poseFile(name: string, names: readonly string[], rotations: ArrayLike<number>, morphs: Record<string, number>, expression: string | null): PoseFile {
  const bones: Record<string, Quat> = {}
  names.forEach((n, i) => { bones[n] = [0, 1, 2, 3].map((k) => round(rotations[i * 4 + k]!)) as Quat })
  return { format: POSE_FORMAT, version: 1, name, bones, morphs: { ...morphs }, expression }
}

/** A pose file read back; throws with words that name what is wrong. */
export function readPose(raw: unknown): PoseFile {
  const o = raw as Partial<PoseFile> | null
  if (!o || typeof o !== 'object') throw new Error('this file is not a pose: it is not a json object.')
  if (o.format !== POSE_FORMAT) throw new Error(`this file is not a pose: format is ${String(o.format ?? 'missing')}.`)
  if (o.version !== 1) throw new Error(`this pose is version ${String(o.version)} and this build reads 1.`)
  if (!o.bones || typeof o.bones !== 'object') throw new Error('this pose has no bones.')
  for (const [k, q] of Object.entries(o.bones)) if (!Array.isArray(q) || q.length !== 4 || !q.every(isNum)) throw new Error(`bone ${k} is not four numbers.`)
  const morphs: Record<string, number> = {}
  for (const [k, v] of Object.entries(o.morphs ?? {})) if (isNum(v)) morphs[k] = Math.min(1, Math.max(0, v))
  return { format: POSE_FORMAT, version: 1, name: String(o.name ?? 'pose'), bones: o.bones, morphs, expression: typeof o.expression === 'string' ? o.expression : null }
}

/** A pose as a two frame held clip over a body's bones; bones the pose lacks keep `rest`. */
export function poseClip(p: PoseFile, names: readonly string[], rest: ArrayLike<number>): { clip: ClipData; matched: number } {
  const n = names.length
  const rotations = new Float32Array(n * 8)
  let matched = 0
  names.forEach((name, i) => {
    const q = p.bones[name]
    if (q) matched++
    for (let k = 0; k < 4; k++) rotations[i * 4 + k] = rotations[(n + i) * 4 + k] = q ? q[k]! : rest[i * 4 + k]!
  })
  return { clip: { name: `pose ${p.name}`, fps: 30, frames: 2, bones: n, loop: true, rotations }, matched }
}

export function clipFile(c: ClipData, names: readonly string[]): ClipFile {
  return { format: CLIP_FORMAT, version: 1, name: c.name, fps: c.fps, frames: c.frames, loop: c.loop, bones: [...names], rotations: Array.from(c.rotations, round) }
}

/** A clip file onto a body's bones by name; bones the file lacks keep `rest`. Throws with words. */
export function readClip(raw: unknown, names: readonly string[], rest: ArrayLike<number>): { clip: ClipData; matched: number } {
  const o = raw as Partial<ClipFile> | null
  if (!o || typeof o !== 'object') throw new Error('this file is not a clip: it is not a json object.')
  if (o.format !== CLIP_FORMAT) throw new Error(`this file is not a clip: format is ${String(o.format ?? 'missing')}.`)
  if (o.version !== 1) throw new Error(`this clip is version ${String(o.version)} and this build reads 1.`)
  const { fps, frames, bones, rotations } = o
  if (!isNum(fps) || fps <= 0 || !isNum(frames) || frames < 1 || !Array.isArray(bones) || !Array.isArray(rotations)) throw new Error('this clip is missing fps, frames, bones or rotations.')
  if (rotations.length !== frames * bones.length * 4) throw new Error(`this clip has ${rotations.length} rotation numbers where ${frames * bones.length * 4} were expected.`)
  const n = names.length
  const from = names.map((name) => bones.indexOf(name))
  const out = new Float32Array(frames * n * 4)
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < n; i++) {
      const j = from[i]!
      for (let k = 0; k < 4; k++) out[(f * n + i) * 4 + k] = j >= 0 ? Number(rotations[(f * bones.length + j) * 4 + k]) : rest[i * 4 + k]!
    }
  }
  return { clip: { name: String(o.name ?? 'clip'), fps, frames, bones: n, loop: !!o.loop, rotations: out }, matched: from.filter((j) => j >= 0).length }
}

// ------------------------------------------------------------- built in clips

const mul = (a: ArrayLike<number>, b: ArrayLike<number>): Quat => [
  a[3]! * b[0]! + a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]!,
  a[3]! * b[1]! - a[0]! * b[2]! + a[1]! * b[3]! + a[2]! * b[0]!,
  a[3]! * b[2]! + a[0]! * b[1]! - a[1]! * b[0]! + a[2]! * b[3]!,
  a[3]! * b[3]! - a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]!,
]
const inv = (q: ArrayLike<number>): Quat => [-q[0]!, -q[1]!, -q[2]!, q[3]!]
const axisAngle = (axis: 0 | 1 | 2, a: number): Quat => {
  const q: Quat = [0, 0, 0, Math.cos(a / 2)]
  q[axis] = Math.sin(a / 2)
  return q
}
/** 0 to 1 and back with eased ends over [0, len]: in for `ease` seconds, out for the last `ease`. */
const envelope = (t: number, len: number, ease: number) => {
  const s = (x: number) => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c) }
  return s(t / ease) * s((len - t) / ease)
}

interface Turn {
  bone: string
  /** World axis: 0 x (nod forward), 1 y (turn), 2 z (raise to the side). */
  axis: 0 | 1 | 2
  angle: (t: number) => number
}

interface Recipe {
  name: string
  seconds: number
  turns: Turn[]
}

/** Angles and timings set by eye on the mannequin (inferred). The body faces +Z; its right side is -X. */
export const RECIPES: readonly Recipe[] = [
  {
    name: 'wave',
    seconds: 2.4,
    turns: [
      { bone: 'rightUpperArm', axis: 2, angle: (t) => -2.2 * envelope(t, 2.4, 0.4) },
      { bone: 'rightLowerArm', axis: 2, angle: (t) => -0.35 * Math.sin(2 * Math.PI * 2.2 * t) * envelope(t, 2.4, 0.5) },
    ],
  },
  {
    name: 'nod',
    seconds: 1.6,
    turns: [{ bone: 'head', axis: 0, angle: (t) => 0.28 * Math.sin((Math.PI * t) / 0.8) ** 2 }],
  },
  {
    name: 'look around',
    seconds: 3,
    turns: [
      { bone: 'neck', axis: 1, angle: (t) => 0.25 * Math.sin((2 * Math.PI * t) / 3) },
      { bone: 'head', axis: 1, angle: (t) => 0.35 * Math.sin((2 * Math.PI * t) / 3) },
    ],
  },
  {
    name: 'bow',
    seconds: 2,
    turns: [{ bone: 'spine', axis: 0, angle: (t) => 0.55 * envelope(t, 2, 0.6) }],
  },
]

/**
 * The recipes as clips over one body. `rest` holds each bone's local
 * rotation at rest and `parentWorld` each bone's parent world rotation at
 * rest, so a turn about a world axis reads the same on any rig. Recipes
 * whose bones the body lacks are left out.
 */
export function builtinClips(names: readonly string[], rest: ArrayLike<number>, parentWorld: ArrayLike<number>, fps = 30): ClipData[] {
  const n = names.length
  const out: ClipData[] = []
  for (const r of RECIPES) {
    const turns = r.turns.map((t) => ({ ...t, i: names.indexOf(t.bone) })).filter((t) => t.i >= 0)
    if (!turns.length) continue
    const frames = Math.round(r.seconds * fps) + 1
    const rotations = new Float32Array(frames * n * 4)
    for (let f = 0; f < frames; f++) {
      for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) rotations[(f * n + i) * 4 + k] = rest[i * 4 + k]!
      for (const t of turns) {
        const p = Array.prototype.slice.call(parentWorld, t.i * 4, t.i * 4 + 4) as Quat
        const local = mul(mul(inv(p), axisAngle(t.axis, t.angle(f / fps))), p)
        const q = mul(local, Array.prototype.slice.call(rest, t.i * 4, t.i * 4 + 4) as Quat)
        rotations.set(q, (f * n + t.i) * 4)
      }
    }
    out.push({ name: r.name, fps, frames, bones: n, loop: false, rotations })
  }
  return out
}
