// The walking stage: an AvatarStage from @hackbuild/avatar-host in the
// studio scene of @hackbuild/environment (lit from the three.js room
// environment, made in code, with a floor and a backdrop; no HDRI, no model
// file), and the placeholder mannequin, also made in code. The pad walks
// the body; camera views frame it from a side. The phone stage lab page and
// the motion and agents tools share it. Views import this module on mount,
// so three.js and the motion packages stay out of the first load.
import { Box3, Vector3 } from 'three'
import { AvatarStage, type StageStats } from '@hackbuild/avatar-host/three'

export interface Move {
  x: number
  y: number
}

/** Camera views of the shared toolbar's chips. */
export type View = 'front' | 'side' | 'back' | 'top'
export const VIEWS: View[] = ['front', 'side', 'back', 'top']

export interface WalkOptions {
  /** Walking speed at full stick, meters a second, read each frame. */
  speed?: () => number
}

export interface PhoneStage {
  readonly stage: AvatarStage
  /** Pad vector: x right, y down, so forward is y < 0. */
  setMove(v: Move): void
  /** Where the body stands on the floor, meters. */
  position(): { x: number; z: number }
  /** Puts the body on a spot, facing a heading in radians (0 faces the front camera). */
  place(x: number, z: number, heading: number): void
  /** Frames the body from one side. */
  view(v: View): void
  dispose(): void
}

/** Walking speed at full stick, meters a second (proposed). */
export const SPEED = 1.4
/** The body stays inside this radius of the spot, meters (proposed; the studio floor is 12). */
export const REACH = 5

const UP = new Vector3(0, 1, 0)

export function createPhoneStage(host: HTMLElement, onStats: (s: StageStats) => void, opts: WalkOptions = {}): PhoneStage {
  const stage = new AvatarStage(host, { environment: 'studio' })
  stage.showPlaceholder()
  stage.on('stats', (e) => onStats(e.stats))
  const speed = opts.speed ?? (() => SPEED)

  let move: Move = { x: 0, y: 0 }
  let last = stage.loop.time
  const fwd = new Vector3()
  const right = new Vector3()
  const step = new Vector3()

  // The walk runs on the stage's own clock, just before each render, so a
  // paused stage walks nowhere and a resume does not jump.
  stage.scene.onBeforeRender = () => {
    const t = stage.loop.time
    const dt = Math.min(0.1, Math.max(0, t - last))
    last = t
    const root = stage.body?.avatar.root
    if (!root || (move.x === 0 && move.y === 0)) return
    // camera relative: up on the pad walks away from the viewer
    stage.camera.getWorldDirection(fwd)
    fwd.y = 0
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1)
    fwd.normalize()
    right.crossVectors(fwd, UP).normalize()
    step.copy(fwd).multiplyScalar(-move.y).addScaledVector(right, move.x)
    const amount = Math.min(1, step.length())
    if (amount < 1e-3) return
    step.normalize()
    root.position.addScaledVector(step, amount * speed() * dt)
    const r = Math.hypot(root.position.x, root.position.z)
    if (r > REACH) root.position.multiplyScalar(REACH / r).setY(0)
    // the body faces +Z at rest
    root.rotation.y = Math.atan2(step.x, step.z)
    root.updateMatrixWorld(true)
    // under reduced motion the loop runs only on change: keep it going while walking
    stage.loop.invalidate()
  }

  const box = new Box3()
  const centre = new Vector3()
  const dirs: Record<View, Vector3> = {
    front: new Vector3(0, 0, 1),
    side: new Vector3(1, 0, 0),
    back: new Vector3(0, 0, -1),
    // a hair off vertical, so the orbit keeps its up
    top: new Vector3(0, 1, 0.001).normalize(),
  }

  return {
    stage,
    setMove(v) {
      move = { x: v.x, y: v.y }
      stage.loop.invalidate()
    },
    position() {
      const p = stage.body?.avatar.root.position
      return { x: p?.x ?? 0, z: p?.z ?? 0 }
    },
    place(x, z, heading) {
      const root = stage.body?.avatar.root
      if (!root) return
      root.position.set(x, 0, z)
      root.rotation.y = heading
      root.updateMatrixWorld(true)
      stage.loop.invalidate()
    },
    view(v) {
      const root = stage.body?.avatar.root
      if (v === 'front' || !root) {
        stage.resetView()
        stage.loop.invalidate()
        return
      }
      box.setFromObject(root)
      box.getCenter(centre)
      const d = stage.follow.fitDistance(box)
      stage.controls.target.copy(centre)
      stage.camera.position.copy(centre).addScaledVector(dirs[v], d)
      stage.camera.lookAt(centre)
      stage.controls.update()
      // the follow keeps the person's distance and pan from here
      stage.follow.released(box, d)
      stage.loop.invalidate()
    },
    dispose() {
      stage.dispose()
    },
  }
}
