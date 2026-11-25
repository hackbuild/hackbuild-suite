// The retarget tool's plain parts: the built in walk written as bvh text in
// code (ported from the motion library's retarget example: a source rig
// with other bone names, centimeters, longer legs and arms down at 70
// degrees, so the retarget has real work to do), source file kinds, and the
// bone map edits as joint renames. Framework free and three free.

/** The humanoid bones a person can map by hand: the body, no fingers. */
export const BODY_BONES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftEye', 'rightEye', 'jaw',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
] as const
export type BodyBone = (typeof BODY_BONES)[number]
export const isBodyBone = (s: string): s is BodyBone => (BODY_BONES as readonly string[]).includes(s)

/** Files the source pick takes: clips, a rigged glb with an animation, a motion file. */
export const SOURCE_ACCEPT = '.bvh,.vmd,.glb,.gltf,.hbm'
export type SourceKind = 'bvh' | 'vmd' | 'glb' | 'hbm' | 'builtin'
const ext = (name: string) => name.toLowerCase().replace(/^.*\./, '')
export function sourceKind(name: string): SourceKind | null {
  const e = ext(name)
  if (e === 'bvh' || e === 'vmd' || e === 'hbm') return e
  if (e === 'glb' || e === 'gltf') return 'glb'
  return null
}
/** A clip file by name: what a drop anywhere sends to the source, not the body. */
export const isClipFile = (f: { name: string }) => ['bvh', 'vmd', 'hbm'].includes(ext(f.name))

/** Joint index to humanoid bone, null when unmapped. */
export type BoneList = (string | null)[]
/** Hand edits: joint name to the bone it plays, or '' for none. */
export type MapEdits = Record<string, string>

/**
 * The bone per joint after the hand edits: an edited joint takes its bone,
 * and a joint that loses its bone to an edit elsewhere plays none.
 */
export function applyEdits(names: readonly string[], auto: BoneList, edits: MapEdits): BoneList {
  const out = auto.slice()
  names.forEach((n, i) => {
    const e = edits[n]
    if (e === undefined) return
    if (e) out.forEach((b, j) => { if (b === e && j !== i) out[j] = null })
    out[i] = e || null
  })
  return out
}

/**
 * Joint names a mapper reads as the bones given: only joints whose bone
 * differs from the auto map are renamed, a body bone to its humanoid name
 * and a joint that plays none out of the mapper's way. The rest keep their
 * names, so the mapper still reads the rig's family from them.
 */
export function mapNames(names: readonly string[], auto: BoneList, bones: BoneList): string[] {
  return names.map((n, i) => {
    const b = bones[i] ?? null
    if (b === (auto[i] ?? null)) return n
    if (b && isBodyBone(b)) return b
    return b ? n : `unmapped ${i}`
  })
}

// ------------------------------------------------------------- built in walk

type J = [name: string, parent: number, offset: [number, number, number]]
const JOINTS: J[] = [
  ['Hips', -1, [0, 0, 0]],
  ['Spine', 0, [0, 12, 0]],
  ['Spine1', 1, [0, 16, 0]],
  ['Neck', 2, [0, 26, 0]],
  ['Head', 3, [0, 11, 0]],
  ['LeftArm', 2, [18, 22, 0]],
  ['LeftForeArm', 5, [29, 0, 0]],
  ['LeftHand', 6, [26, 0, 0]],
  ['RightArm', 2, [-18, 22, 0]],
  ['RightForeArm', 8, [-29, 0, 0]],
  ['RightHand', 9, [-26, 0, 0]],
  ['LeftUpLeg', 0, [10, -6, 0]],
  ['LeftLeg', 11, [0, -47, 0]],
  ['LeftFoot', 12, [0, -45, 0]],
  ['LeftToeBase', 13, [0, -8, 14]],
  ['RightUpLeg', 0, [-10, -6, 0]],
  ['RightLeg', 15, [0, -47, 0]],
  ['RightFoot', 16, [0, -45, 0]],
  ['RightToeBase', 17, [0, -8, 14]],
]
const HIP_Y = 106

export const BUILTIN = { name: 'walk', unit: 0.01, seconds: 2.4 }

/** A walk as bvh text: centimeters, a hips track that travels on +Z. */
export function walkBvh(seconds = BUILTIN.seconds, fps = 30): string {
  const kids = (i: number) => JOINTS.map((j, k) => [j, k] as const).filter(([j]) => j[1] === i)
  const write = (i: number, depth: number): string => {
    const [name, parent, o] = JOINTS[i]!
    const pad = '  '.repeat(depth)
    const ch = parent < 0 ? 'CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation' : 'CHANNELS 3 Zrotation Xrotation Yrotation'
    const c = kids(i)
    const body = c.length ? c.map(([, k]) => write(k, depth + 1)).join('') : `${pad}  End Site\n${pad}  {\n${pad}    OFFSET 0 6 0\n${pad}  }\n`
    return `${pad}${parent < 0 ? 'ROOT' : 'JOINT'} ${name}\n${pad}{\n${pad}  OFFSET ${o.join(' ')}\n${pad}  ${ch}\n${body}${pad}}\n`
  }
  const order: number[] = []
  const visit = (i: number) => {
    order.push(i)
    for (const [, k] of kids(i)) visit(k)
  }
  visit(0)
  const n = Math.round(seconds * fps)
  const lines: string[] = []
  for (let f = 0; f < n; f++) {
    const t = f / fps
    const ph = t * 2 * Math.PI * 0.9
    const s = Math.sin(ph)
    const rot: Record<string, [number, number, number]> = {
      LeftUpLeg: [0, -28 * s, 0],
      RightUpLeg: [0, 28 * s, 0],
      LeftLeg: [0, 45 * Math.max(0, Math.sin(ph + 1.4)), 0],
      RightLeg: [0, 45 * Math.max(0, Math.sin(ph + 1.4 + Math.PI)), 0],
      LeftFoot: [0, -10 * s, 0],
      RightFoot: [0, 10 * s, 0],
      LeftArm: [-70, 22 * s, 0],
      RightArm: [70, -22 * s, 0],
      LeftForeArm: [0, 0, -15],
      RightForeArm: [0, 0, 15],
      Spine: [0, 2, 4 * s],
      Head: [0, -3, -3 * s],
    }
    const vals: number[] = []
    for (const i of order) {
      if (i === 0) vals.push(0, HIP_Y + 2.5 * Math.cos(2 * ph), t * 120, 2 * s, 0, 3 * s)
      else vals.push(...(rot[JOINTS[i]![0]] ?? [0, 0, 0]))
    }
    lines.push(vals.map((v) => v.toFixed(4)).join(' '))
  }
  return `HIERARCHY\n${write(0, 0)}MOTION\nFrames: ${n}\nFrame Time: ${(1 / fps).toFixed(6)}\n${lines.join('\n')}\n`
}
