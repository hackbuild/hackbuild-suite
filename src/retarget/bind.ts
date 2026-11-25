// What the retarget tool does with three.js: reads a source clip (bvh, vmd,
// a rigged glb with an animation, an HBM1 motion file, or the built in
// walk), maps it and the body on the stage to humanoid bones, retargets
// through the humanoid interchange of @hackbuild/retarget with the floor
// and scale fixes, and draws the source as a stick figure beside or over
// the body. The transport's clock drives both. The view imports this module
// on mount, so three.js and the retarget core stay out of the route chunk.
import {
  Bone, Box3, BufferAttribute, Matrix4, Quaternion, BufferGeometry, Group, LineBasicMaterial, LineSegments, Vector3,
  type AnimationClip, type Interpolant, type Object3D,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  load as loadRetarget, analyzeMotion, packMotion, parseBvh, parseVmd, referenceSkeleton, settleOnFloor, unpackMotion,
  RetargetRig, type Clip, type HumanoidMotion, type MotionFindings, type Skeleton,
} from '@hackbuild/retarget'
import { readVmd } from '@hackbuild/retarget/formats'
import { pickTake, skeletonFromObject3D, toAnimationClip, type SceneSkeleton } from '@hackbuild/retarget/three'
import { load as loadRig, mapRig } from '@hackbuild/rig'
import type { AvatarStage, Body } from '@hackbuild/avatar-host/three'
import { inspect } from '../avatar/inspect.ts'
import { clipFile, type ClipFile } from '../avatar/pose.ts'
import { BUILTIN, applyEdits, mapNames, sourceKind, walkBvh, type BoneList, type MapEdits, type SourceKind } from './source.ts'
import { UNIT_METERS, type RetargetOpts } from './kind.ts'

export async function ready(): Promise<void> {
  await Promise.all([loadRetarget(), loadRig()])
}

export interface Source {
  name: string
  kind: SourceKind
  skeleton: Skeleton
  clip: Clip
  /** Meters per unit when the file says, else the rig reads it. */
  unit?: number
  /** The humanoid motion when the file is one (hbm) or a reader solved it (vmd legs). */
  motion?: HumanoidMotion
}

/**
 * Plays a clip's tracks on nodes at a given time, with the tracks' own
 * interpolants: no mixer, so the transport owns the time and the three.js
 * animation system stays out of the shared chunk.
 */
class TrackPlayer {
  private readonly parts: { node: Object3D; rot: boolean; at: Interpolant }[]
  constructor(readonly clip: AnimationClip, nodes: readonly Object3D[]) {
    const byKey = new Map<string, Object3D>()
    for (const o of nodes) {
      byKey.set(o.uuid, o)
      if (!byKey.has(o.name)) byKey.set(o.name, o)
    }
    this.parts = clip.tracks.flatMap((t) => {
      const dot = t.name.lastIndexOf('.')
      const node = byKey.get(t.name.slice(0, dot))
      const prop = t.name.slice(dot + 1)
      return node && (prop === 'quaternion' || prop === 'position') ? [{ node, rot: prop === 'quaternion', at: (t as unknown as { createInterpolant(): Interpolant }).createInterpolant() }] : []
    })
  }
  setTime(t: number) {
    for (const p of this.parts) {
      const v = p.at.evaluate(t) as unknown as number[]
      if (p.rot) p.node.quaternion.fromArray(v).normalize()
      else p.node.position.fromArray(v)
    }
  }
}

/**
 * A three.js clip on a scene skeleton, sampled at `fps` into a Clip, as the
 * library's sampleAnimationClip does but through the track player.
 */
function sampleTracks(anim: AnimationClip, scene: SceneSkeleton, fps = 30): Clip {
  const { nodes, rootParents, scales } = scene
  const saved = nodes.map((o) => [o.position.clone(), o.quaternion.clone()] as const)
  const frames = Math.max(2, Math.round(anim.duration * fps) + 1)
  const n = nodes.length
  const times = new Float64Array(frames)
  const rotations = new Float64Array(frames * n * 4)
  const translations = new Float64Array(frames * n * 3)
  const moved = new Set(anim.tracks.filter((t) => t.name.endsWith('.position')).map((t) => t.name.slice(0, -'.position'.length)))
  const moves = Uint8Array.from(nodes, (o) => (moved.has(o.name) || moved.has(o.uuid) ? 1 : 0))
  const player = new TrackPlayer(anim, nodes)
  const roots = new Map([...rootParents].map(([j, m]) => [j, { m, q: new Quaternion().setFromRotationMatrix(new Matrix4().extractRotation(m)) }]))
  const pos = new Vector3()
  const rot = new Quaternion()
  for (let f = 0; f < frames; f++) {
    const t = Math.min(anim.duration, f / fps)
    times[f] = t
    player.setTime(t)
    nodes.forEach((o, j) => {
      pos.copy(o.position)
      rot.copy(o.quaternion)
      const r = roots.get(j)
      if (r) { pos.applyMatrix4(r.m); rot.premultiply(r.q) } else pos.multiplyScalar(scales[j]!)
      rot.toArray(rotations, (f * n + j) * 4)
      pos.toArray(translations, (f * n + j) * 3)
    })
  }
  nodes.forEach((o, i) => { o.position.copy(saved[i]![0]); o.quaternion.copy(saved[i]![1]) })
  return { times, rotations, translations, moves }
}

const nodesOf = (s: Skeleton) => s.names.map((name, i) => ({ name, parent: s.parents[i]! < 0 ? null : s.parents[i]! }))

/** Meters per unit of a bvh, from its offsets: over 5 reads as centimeters (inferred). */
function bvhUnit(s: Skeleton): number {
  let m = 0
  for (let i = 1; i < s.restT.length; i += 3) m = Math.max(m, Math.abs(s.restT[i]!))
  return m > 5 ? 0.01 : 1
}

function onReference(motion: HumanoidMotion): { skeleton: Skeleton; clip: Clip } {
  const skeleton = referenceSkeleton()
  const rig = new RetargetRig(skeleton)
  try {
    return { skeleton, clip: rig.bind(motion) }
  } finally {
    rig.dispose()
  }
}

export function builtinSource(): Source {
  const { skeleton, clip } = parseBvh(walkBvh())
  return { name: BUILTIN.name, kind: 'builtin', skeleton, clip, unit: BUILTIN.unit }
}

/** A dropped or picked clip file as a source; throws with words that name the failure. */
export async function readSource(file: File): Promise<Source> {
  const kind = sourceKind(file.name)
  const name = file.name.replace(/\.[^.]+$/, '')
  if (kind === 'bvh') {
    const { skeleton, clip } = parseBvh(await file.text())
    return { name, kind, skeleton, clip, unit: bvhUnit(skeleton) }
  }
  if (kind === 'vmd') {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const v = parseVmd(bytes)
    // the reader solves legs keyed by foot ik only
    const { motion } = readVmd(bytes)
    return { name, kind, skeleton: v.skeleton, clip: v.clip, unit: v.unit, motion }
  }
  if (kind === 'hbm') {
    const motion = unpackMotion(new Uint8Array(await file.arrayBuffer()))
    if (!motion) throw new Error('this file is not an hbm1 motion.')
    return { name, kind, ...onReference(motion), motion }
  }
  if (kind === 'glb') {
    const gltf = await new GLTFLoader().parseAsync(await file.arrayBuffer(), '')
    if (!gltf.animations.length) throw new Error('this glb has no animation. drop a glb that carries one, or drop it as the body.')
    const scene = skeletonFromObject3D(gltf.scene)
    const anim = pickTake(gltf.animations)
    return { name: anim.name ? `${name} ${anim.name}` : name, kind, skeleton: scene.skeleton, clip: sampleTracks(anim, scene) }
  }
  throw new Error(`this file is a ${file.name.replace(/^.*\./, '') || 'file with no extension'}. drop a bvh, vmd, glb or hbm.`)
}

export interface MapRow {
  bone: string
  source: string | null
  target: string | null
  edited: boolean
}

export interface Result {
  findings: MotionFindings
  motion: HumanoidMotion
  /** Lines that name what the clip lacks or what a fix did. */
  notes: string[]
  /** Meters the floor fix moved the motion. */
  shift: number
  srcUnit: number
  srcBones: BoneList
  dstBones: BoneList
  duration: number
  frames: number
  fps: number
}

/** A copy of the hips track: from the first frame's spot, or with no travel across the floor. */
function travel(m: HumanoidMotion, origin: boolean, inPlace: boolean): HumanoidMotion {
  const h = m.hips
  if (!h || (!origin && !inPlace)) return m
  const out = h.slice()
  const x0 = h[0]!
  const z0 = h[2]!
  for (let i = 0; i < out.length; i += 3) {
    if (inPlace) { out[i] = origin ? 0 : x0; out[i + 2] = origin ? 0 : z0 } else { out[i] = out[i]! - x0; out[i + 2] = out[i + 2]! - z0 }
  }
  return { ...m, hips: out }
}

export class Retargeter {
  source: Source = builtinSource()
  body: Body | null = null
  result: Result | null = null
  layout: 'side' | 'overlay' = 'side'
  private dst: SceneSkeleton | null = null
  private dstAuto: BoneList = []
  private dstHuman: BoneList = []
  private srcAuto: BoneList = []
  private srcBones: BoneList = []
  private player: TrackPlayer | null = null
  private srcRoot: Group | null = null
  private srcPlayer: TrackPlayer | null = null
  private lines: LineSegments | null = null
  private srcNodes: Bone[] = []
  private srcUnit = 1
  private srcStart = new Vector3()
  private hooked: { body: Body; update: (dt: number) => void } | null = null
  private readonly tmp = new Vector3()
  private readonly tmp2 = new Vector3()

  constructor(private readonly scene: Object3D, private readonly time: () => number, private readonly colour: string) {}

  /** Takes the body on the stage as the target; its rest is read now, so call this as it lands. */
  setTarget(body: Body): { bonesLine: string; names: string[] } {
    this.unhook()
    this.body = body
    const root = body.avatar.root
    this.dst = skeletonFromObject3D(root)
    this.dstAuto = mapRig(nodesOf(this.dst.skeleton)).bones
    const human = new Map<Object3D, string>()
    for (const [k, o] of Object.entries(body.avatar.bones)) if (o) human.set(o, k)
    this.dstHuman = this.dst.nodes.map((o) => human.get(o) ?? null)
    const info = inspect(body)
    body.gazeOn = false
    const update = body.avatar.update
    body.avatar.update = (dt: number) => {
      update.call(body.avatar, dt)
      this.frame()
    }
    this.hooked = { body, update }
    return { bonesLine: info.bonesLine, names: this.dst.skeleton.names }
  }

  setSource(s: Source) {
    this.source = s
    this.srcAuto = mapRig(nodesOf(s.skeleton)).bones
    if (this.srcRoot) {
      this.srcRoot.removeFromParent()
      this.lines?.geometry.dispose()
    }
    // bones for the parsed skeleton, so the source plays beside the target
    const root = new Group()
    root.name = 'retarget source'
    const nodes: Bone[] = []
    s.skeleton.names.forEach((name, i) => {
      const b = new Bone()
      b.name = name
      b.position.fromArray(s.skeleton.restT, i * 3)
      b.quaternion.fromArray(s.skeleton.restR, i * 4)
      nodes.push(b)
      ;(s.skeleton.parents[i]! < 0 ? root : nodes[s.skeleton.parents[i]!]!).add(b)
    })
    const pairs = s.skeleton.names.length * 2
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(new Float32Array(pairs * 3), 3))
    this.lines = new LineSegments(geo, new LineBasicMaterial({ color: this.colour, depthTest: false }))
    this.lines.frustumCulled = false
    this.lines.renderOrder = 2
    const holder = new Group()
    holder.add(root, this.lines)
    this.srcRoot = holder
    this.srcNodes = nodes
    this.scene.add(holder)
    const srcScene = skeletonFromObject3D(root)
    this.srcPlayer = new TrackPlayer(toAnimationClip(s.clip, srcScene, `${s.name} source`), nodes)
  }

  /** Source bone per joint after the edits. */
  sourceBones(edits: MapEdits): BoneList {
    return applyEdits(this.source.skeleton.names, this.srcAuto, edits)
  }

  /** Runs the retarget with the edits and the fixes; throws with words when the source cannot be mapped. */
  apply(edits: MapEdits, opts: RetargetOpts): Result {
    const s = this.source
    if (!this.body || !this.dst) throw new Error('the body is not on the stage yet.')
    const notes: string[] = []
    this.srcBones = this.sourceBones(edits)
    const renamed: Skeleton = { ...s.skeleton, names: mapNames(s.skeleton.names, this.srcAuto, this.srcBones) }
    const unit = opts.units === 'auto' ? s.unit : UNIT_METERS[opts.units]
    const src = new RetargetRig(renamed, unit === undefined ? {} : { unit })
    const dst = new RetargetRig({ ...this.dst.skeleton, names: mapNames(this.dst.skeleton.names, this.dstAuto, this.dstHuman) }, { unit: 1 })
    try {
      let m = s.motion && !Object.keys(edits).length ? s.motion : src.toHumanoid(s.clip, { settle: false })
      if (!m.hips) notes.push('this clip has no hips track. it will play in place.')
      m = travel(m, opts.origin, opts.inPlace)
      let shift = 0
      if (opts.settle) ({ motion: m, shift } = settleOnFloor(m))
      const bound = dst.bind(m)
      this.player = new TrackPlayer(toAnimationClip(bound, this.dst, s.name), this.dst.nodes)
      this.srcUnit = src.unit
      this.srcRoot?.children[0]?.scale.setScalar(this.srcUnit)
      const hips = s.skeleton.parents.findIndex((p) => p < 0)
      this.srcStart.fromArray(s.clip.translations, Math.max(0, hips) * 3).multiplyScalar(this.srcUnit).setY(0)
      const frames = m.times.length
      const duration = frames > 1 ? m.times[frames - 1]! : 0
      const fps = frames > 1 ? Math.round((frames - 1) / duration) : 30
      if (Math.abs(src.unit - 1) > 1e-6 || opts.units !== 'auto') notes.push(`source units read as ${src.unit} m each${opts.units === 'auto' ? ' (inferred)' : ''}.`)
      const missing = ['hips', 'leftUpperLeg', 'rightUpperLeg', 'leftUpperArm', 'rightUpperArm', 'head'].filter((b) => !this.srcBones.includes(b))
      if (missing.length) notes.push(`the source has no ${missing.map((b) => b.toLowerCase()).join(', ')}. map them by hand below or those parts stay at rest.`)
      this.result = { findings: analyzeMotion(m), motion: m, notes, shift, srcUnit: src.unit, srcBones: this.srcBones, dstBones: this.dstHuman, duration, frames, fps }
      return this.result
    } finally {
      src.dispose()
      dst.dispose()
    }
  }

  /** The bone map: one row per body bone either side plays. */
  rows(bones: readonly string[], edits: MapEdits): MapRow[] {
    const sn = this.source.skeleton.names
    const tn = this.dst?.skeleton.names ?? []
    const sb = this.sourceBones(edits)
    return bones.map((bone) => {
      const si = sb.indexOf(bone)
      const ti = this.dstHuman.indexOf(bone)
      const source = si >= 0 ? sn[si]! : null
      return { bone, source, target: ti >= 0 ? tn[ti]! : null, edited: source !== null ? edits[source] === bone : Object.values(edits).includes(bone) }
    })
  }

  /** Puts both rigs at the transport's time; runs after the body's own update each frame. */
  frame() {
    const t = this.time()
    this.player?.setTime(t)
    this.srcPlayer?.setTime(t)
    this.drawSource()
  }

  private drawSource() {
    const holder = this.srcRoot
    const root = this.body?.avatar.root
    if (!holder || !this.lines || !root) return
    // side by side: one step to the body's right as the camera sees it
    holder.position.copy(root.position).sub(this.srcStart)
    if (this.layout === 'side') holder.position.x -= 0.9
    holder.updateMatrixWorld(true)
    const pos = this.lines.geometry.getAttribute('position') as BufferAttribute
    const par = this.source.skeleton.parents
    let k = 0
    this.srcNodes.forEach((b, i) => {
      const p = par[i]!
      if (p < 0) return
      b.getWorldPosition(this.tmp)
      this.srcNodes[p]!.getWorldPosition(this.tmp2)
      holder.worldToLocal(this.tmp)
      holder.worldToLocal(this.tmp2)
      pos.setXYZ(k++, this.tmp.x, this.tmp.y, this.tmp.z)
      pos.setXYZ(k++, this.tmp2.x, this.tmp2.y, this.tmp2.z)
    })
    this.lines.geometry.setDrawRange(0, k)
    pos.needsUpdate = true
  }

  /** Frames the body and, side by side, the source too; the follow keeps that pan. */
  fit(stage: AvatarStage) {
    const root = this.body?.avatar.root
    if (!root) return
    const body = new Box3().setFromObject(root)
    const both = body.clone()
    if (this.layout === 'side') both.union(body.clone().translate(this.tmp.set(-0.9, 0, 0)))
    const centre = both.getCenter(this.tmp2)
    const d = stage.follow.fitDistance(both)
    stage.controls.target.copy(centre)
    stage.camera.position.copy(centre).add(this.tmp.set(0, 0, d))
    stage.camera.lookAt(centre)
    stage.controls.update()
    stage.follow.released(body, d)
    stage.loop.invalidate()
  }

  /** World direction of a humanoid bone toward its first child, on either rig; null when unmapped. */
  boneDir(which: 'source' | 'target', bone: string): number[] | null {
    const nodes: Object3D[] = which === 'source' ? this.srcNodes : (this.dst?.nodes ?? [])
    const bones = which === 'source' ? this.srcBones : this.dstHuman
    const parents = which === 'source' ? this.source.skeleton.parents : this.dst?.skeleton.parents
    const i = bones.indexOf(bone)
    if (i < 0 || !parents) return null
    const c = [...parents].findIndex((p) => p === i)
    if (c < 0) return null
    nodes[i]!.updateWorldMatrix(true, false)
    nodes[c]!.updateWorldMatrix(true, false)
    nodes[i]!.getWorldPosition(this.tmp)
    nodes[c]!.getWorldPosition(this.tmp2)
    return this.tmp2.sub(this.tmp).normalize().toArray()
  }

  /** The retargeted motion in the compact binary form. */
  hbm(): Uint8Array | null {
    return this.result ? packMotion(this.result.motion) : null
  }

  /** The retargeted clip over the body's human bones, as the avatar tool reads it. */
  clipJson(name: string): ClipFile | null {
    const b = this.body
    const r = this.result
    if (!b || !r || !this.player) return null
    const frames = r.frames
    const rot = new Float32Array(frames * b.bones.length * 4)
    for (let f = 0; f < frames; f++) {
      this.player.setTime(r.motion.times[f]!)
      b.bones.forEach((o, i) => o.quaternion.toArray(rot, (f * b.bones.length + i) * 4))
    }
    this.frame()
    return clipFile({ name, fps: r.fps, frames, bones: b.bones.length, loop: r.findings.looping, rotations: rot }, b.names)
  }

  /** The body with the retargeted clip as a glb animation. */
  async glb(): Promise<ArrayBuffer | null> {
    const b = this.body
    if (!b || !this.player) return null
    const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js')
    const root = b.avatar.root
    const saved = root.position.clone()
    const savedY = root.rotation.y
    root.position.set(0, 0, 0)
    root.rotation.y = 0
    try {
      return (await new GLTFExporter().parseAsync(root, { binary: true, animations: [this.player.clip] })) as ArrayBuffer
    } finally {
      root.position.copy(saved)
      root.rotation.y = savedY
      root.updateMatrixWorld(true)
    }
  }

  private unhook() {
    if (this.hooked) this.hooked.body.avatar.update = this.hooked.update
    this.hooked = null
    this.player = null
  }

  dispose() {
    this.unhook()
    this.srcRoot?.removeFromParent()
    this.lines?.geometry.dispose()
    ;(this.lines?.material as LineBasicMaterial | undefined)?.dispose()
    this.srcRoot = null
  }
}
