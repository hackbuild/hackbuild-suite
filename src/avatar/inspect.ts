// What the avatar rack reads from a body on the stage, and the driver that
// lets the transport own a clip's time and holds blendshapes by hand. The
// view imports this module on mount, with the stage, so three.js stays out
// of the route chunk.
import { AnimationClip, Quaternion, QuaternionKeyframeTrack, type Mesh, type Object3D } from 'three'
import type { Body } from '@hackbuild/avatar-host/three'
import type { HbTreeNode } from '@virgilvox/hackbuild-ui'
import { checkRedistribution, type VrmMetaLike } from '@hackbuild/avatar'
import { sampleClip, sampleFace, type Clip } from '@hackbuild/presence'
import { applyPose, restStanceFromThree } from '@hackbuild/presence/three'
import { HUMAN_BONES, REQUIRED_BONES, type HumanBone } from '@hackbuild/rig/bones'
import { builtinClips, type ClipData } from './pose.ts'

/** Bones past the required 15 whose absence changes what the body can do. */
const WANTED: { bone: HumanBone; why: string }[] = [
  { bone: 'leftEye', why: 'the eyes do not turn on their own' },
  { bone: 'rightEye', why: 'the eyes do not turn on their own' },
  { bone: 'neck', why: 'gaze turns the head only' },
  { bone: 'jaw', why: 'the mouth moves by blendshapes only' },
  { bone: 'leftToes', why: 'feet may look wrong' },
  { bone: 'rightToes', why: 'feet may look wrong' },
]
const TREE_CAP = 400

export interface Inspection {
  format: string
  dialect: string
  names: HumanBone[]
  mapped: number
  /** The bones line: mapped of all, the missing ones and what that costs. */
  bonesLine: string
  /** The node tree for HbTree, the human bone as the quiet words of a node that maps. */
  tree: HbTreeNode[]
  nodes: number
  morphs: string[]
  expressions: string[]
  parts: { id: string; name: string; visible: boolean }[]
  licence: string
  warnings: string[]
  rest: Float32Array
  builtin: ClipData[]
  fileClips: ClipData[]
}

export function inspect(body: Body): Inspection {
  const a = body.avatar
  const human = new Map<Object3D, string>()
  for (const [k, o] of Object.entries(a.bones)) if (o) human.set(o, k)

  let nodes = 0
  let shown = 0
  const walk = (o: Object3D, path: string): HbTreeNode | null => {
    if ((o as Mesh).isMesh) return null
    nodes++
    const keep = shown < TREE_CAP
    if (keep) shown++
    const kids = o.children.map((c, i) => walk(c, `${path}.${i}`))
    if (!keep) return null
    const h = human.get(o)
    const children = kids.filter((k): k is HbTreeNode => !!k)
    return { id: path, label: o.name || o.type.toLowerCase(), sub: h && h !== o.name ? h : undefined, children: children.length ? children : undefined }
  }
  const top = walk(a.root, '0')
  const tree = top ? [top] : []
  if (nodes > shown) tree.push({ id: 'more', label: `and ${nodes - shown} more nodes.` })

  const morphs = new Set<string>()
  a.root.traverse((o) => {
    const d = (o as Mesh).morphTargetDictionary
    if (d) for (const k of Object.keys(d)) morphs.add(k)
  })

  const mapped = body.names.length
  const missing = [...REQUIRED_BONES, ...WANTED.map((w) => w.bone)].filter((b) => !a.bones[b])
  const costs = [...new Set(WANTED.filter((w) => missing.includes(w.bone)).map((w) => w.why))]
  if (missing.some((b) => (REQUIRED_BONES as readonly string[]).includes(b))) costs.unshift('clips made for a humanoid may not play')
  const bonesLine = `${mapped} of ${HUMAN_BONES.length} bones mapped by name.${missing.length ? ` ${missing.length} ${missing.length === 1 ? 'is' : 'are'} missing: ${missing.map((b) => b.toLowerCase()).join(', ')}. ${costs.join(', ')}.` : ''}`

  const verdict = a.vrm ? checkRedistribution(a.vrm.meta as VrmMetaLike, { modified: false }) : null
  const licence = a.dialect === 'placeholder' ? 'the built in mannequin, made in code. no file, nothing to license.' : verdict ? (verdict.ok ? 'the vrm licence allows sharing this file as is.' : (verdict.reason ?? '')) : 'no vrm metadata in this file. the licence is unknown, so keep it to yourself unless you made it.'

  // the rest stance and, posed in it, each bone's parent world rotation
  const stance = restStanceFromThree(body.bones, body.names, a.root)
  const rest = stance.rotations.slice(0, body.bones.length * 4)
  applyPose({ rotations: rest, root: new Float32Array(3) }, body.bones)
  a.root.updateMatrixWorld(true)
  const pw = new Float32Array(body.bones.length * 4)
  const q = new Quaternion()
  body.bones.forEach((b, i) => {
    if (b.parent) b.parent.getWorldQuaternion(q)
    else q.identity()
    q.toArray(pw, i * 4)
  })

  const fileClips: ClipData[] = []
  a.animations.forEach((anim, i) => {
    const c = body.clipOf(anim, false)
    if (c) fileClips.push({ ...c, name: anim.name || `clip ${i + 1}` })
  })

  return {
    format: a.format,
    dialect: a.dialect,
    names: [...body.names],
    mapped,
    bonesLine,
    tree,
    nodes,
    morphs: [...morphs].sort(),
    expressions: body.caps.expressions,
    parts: body.wardrobe.map((p) => ({ id: p.id, name: p.name, visible: p.visible })),
    licence,
    warnings: [...a.warnings],
    rest,
    builtin: builtinClips(body.names, rest, pw),
    fileClips,
  }
}

export interface Driver {
  /** The clip the transport drives, or null to hand the body back to its idle. */
  setClip(c: ClipData | null): void
  /** Blendshapes held by hand, written after the face each frame. */
  readonly morphs: Map<string, number>
  /** The bones' local rotations as drawn last. */
  pose(): Float32Array
  /** The weight a morph shows now, from the first mesh that has it. */
  morphWeight(name: string): number | null
  dispose(): void
}

/** Puts the transport's clock on a body: while a clip is set, each frame samples it at `time()`. */
export function drive(body: Body, time: () => number): Driver {
  const player = body.player
  const a = body.avatar
  const update = player.update
  const after = a.update
  let clip: Clip | null = null
  const morphs = new Map<string, number>()
  const targets = new Map<string, { mesh: Mesh; index: number }[]>()
  a.root.traverse((o) => {
    const m = o as Mesh
    const d = m.morphTargetDictionary
    if (d) for (const [k, i] of Object.entries(d)) targets.set(k, [...(targets.get(k) ?? []), { mesh: m, index: i }])
  })

  player.update = (dt: number) => {
    if (!clip) return update.call(player, dt)
    const t = time()
    sampleClip(clip, t, player.pose)
    player.faces.clear()
    for (const f of clip.faces ?? []) player.faces.set(f.name, sampleFace(clip, f, t))
    return player.pose
  }
  a.update = (dt: number) => {
    after.call(a, dt)
    for (const [k, w] of morphs) for (const t of targets.get(k) ?? []) if (t.mesh.morphTargetInfluences) t.mesh.morphTargetInfluences[t.index] = w
  }

  return {
    morphs,
    setClip(c) {
      clip = c ? (c as Clip) : null
    },
    pose() {
      const out = new Float32Array(body.bones.length * 4)
      body.bones.forEach((b, i) => b.quaternion.toArray(out, i * 4))
      return out
    },
    morphWeight(name) {
      const t = targets.get(name)?.[0]
      return t?.mesh.morphTargetInfluences?.[t.index] ?? null
    },
    dispose() {
      player.update = update
      a.update = after
      clip = null
    },
  }
}

/** A presence clip as a three clip over the normalized bone names, for a
 * preview on the clay placeholder figure (its nodes carry those names). */
export function threeClip(c: ClipData, names: readonly string[]): AnimationClip {
  const times = Float32Array.from({ length: c.frames }, (_, f) => f / c.fps)
  const tracks = names.slice(0, c.bones).map((n, b) => {
    const v = new Float32Array(c.frames * 4)
    for (let f = 0; f < c.frames; f++) v.set(c.rotations.subarray((f * c.bones + b) * 4, (f * c.bones + b) * 4 + 4), f * 4)
    return new QuaternionKeyframeTrack(`${n}.quaternion`, times, v)
  })
  return new AnimationClip(c.name, Math.max(0, c.frames - 1) / c.fps, tracks)
}
