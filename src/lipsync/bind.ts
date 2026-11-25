// What the lipsync tool does with three.js: finds the mouth shapes of the
// body on the stage (the morph targets of its meshes; the built in
// mannequin gets the procedural mouth of stage/face.ts first) and writes
// the mapped weights into them after the body's own update, so the track
// wins over the body's idle face. The view imports this module on mount,
// so three.js stays out of the route chunk.
import { Box3, Quaternion, Vector3, type Mesh, type Object3D } from 'three'
import type { AvatarStage } from '@hackbuild/avatar-host/three'
import { addFace } from '../stage/face.ts'

type Morphed = Mesh & { morphTargetDictionary: Record<string, number>; morphTargetInfluences: number[] }

export class Mouth {
  readonly meshes: Morphed[] = []
  private written = new Set<string>()

  constructor(root: Object3D) {
    root.traverse((o) => {
      const m = o as Morphed
      if (m.isMesh && m.morphTargetDictionary && m.morphTargetInfluences && Object.keys(m.morphTargetDictionary).length) this.meshes.push(m)
    })
  }

  /** Morph names over every mesh, first seen first. */
  names(): string[] {
    const s = new Set<string>()
    for (const m of this.meshes) for (const k of Object.keys(m.morphTargetDictionary)) s.add(k)
    return [...s]
  }

  /** Writes the weights; a morph written before and missing now goes back to 0. */
  write(weights: Map<string, number>): void {
    for (const k of this.written) if (!weights.has(k)) this.set(k, 0)
    for (const [k, w] of weights) this.set(k, w)
    this.written = new Set(weights.keys())
  }

  /** The weight a morph shows now, the largest over meshes. */
  read(name: string): number {
    let w = 0
    for (const m of this.meshes) {
      const i = m.morphTargetDictionary[name]
      if (i !== undefined) w = Math.max(w, m.morphTargetInfluences[i] ?? 0)
    }
    return w
  }

  private set(name: string, w: number) {
    for (const m of this.meshes) {
      const i = m.morphTargetDictionary[name]
      if (i !== undefined) m.morphTargetInfluences[i] = w
    }
  }
}

/** The mouth of the body on the stage; the mannequin gets its face first. */
export function mouthOf(stage: AvatarStage, placeholder: boolean): Mouth | null {
  const body = stage.body
  if (!body) return null
  const head = body.avatar.bones.head
  if (placeholder && head) addFace(head)
  return new Mouth(body.avatar.root)
}

/** Runs `fn` on every render after the stage has posed the body; returns the undo. */
export function afterPose(stage: AvatarStage, fn: () => void): () => void {
  const prev = stage.scene.onBeforeRender
  stage.scene.onBeforeRender = (...a) => {
    prev.apply(stage.scene, a)
    fn()
  }
  return () => { stage.scene.onBeforeRender = prev }
}

/** Frames the face from the front: the mouth is what this tool is about. The camera chips frame the whole body again. */
export function frameFace(stage: AvatarStage): void {
  const b = stage.body
  const head = b?.avatar.bones.head
  if (!b || !head) return
  b.avatar.root.updateMatrixWorld(true)
  const c = head.getWorldPosition(new Vector3()).add(new Vector3(0, 0.05, 0))
  const box = new Box3().setFromCenterAndSize(c, new Vector3(0.45, 0.45, 0.45))
  const d = stage.follow.fitDistance(box)
  const fwd = new Vector3(0, 0, 1).applyQuaternion(b.avatar.root.getWorldQuaternion(new Quaternion()))
  stage.controls.target.copy(c)
  stage.camera.position.copy(c).addScaledVector(fwd, d)
  stage.camera.lookAt(c)
  stage.controls.update()
  stage.follow.released(box, d)
  stage.loop.invalidate()
}
