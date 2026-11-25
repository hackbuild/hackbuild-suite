// A stub network for the motion-net tool: a kinematic trot with the
// network's own input and output layout, so the host, the stage, the
// readouts and the export run in smokes and shots with no weights and no
// request. Deterministic: the same inputs in the same order give the same
// frames. It reads the speed and turn the host asks for from the
// trajectory in the input, as the real network does, and answers with a
// 27 bone pose, paw contacts and root motion. It is not the network; the
// tool says "stub network" while it runs. Framework free and three free.
import { BONES, BONE_COUNT, FRAMES, FRAME_DT, IN, OUT, STYLES, type Predicts, type RawPrediction, type StyleLabel } from '@hackbuild/motion-net'

type V3 = [number, number, number]

/** Rest pose in the network's root frame, meters, +Z forward, +X to the right (the host mirrors it to +X left), Y up (proposed shape, about the 0.45 m hip height of DEFAULT_TUNING). */
const REST: Record<string, V3> = {
  Hips: [0, 0.45, -0.18], Spine: [0, 0.46, -0.04], Spine1: [0, 0.47, 0.1], Neck: [0, 0.52, 0.2], Head: [0, 0.6, 0.28], HeadSite: [0, 0.6, 0.4],
  LeftShoulder: [-0.07, 0.46, 0.16], LeftArm: [-0.09, 0.4, 0.17], LeftForeArm: [-0.09, 0.22, 0.15], LeftHand: [-0.09, 0.05, 0.17], LeftHandSite: [-0.09, 0, 0.2],
  RightShoulder: [0.07, 0.46, 0.16], RightArm: [0.09, 0.4, 0.17], RightForeArm: [0.09, 0.22, 0.15], RightHand: [0.09, 0.05, 0.17], RightHandSite: [0.09, 0, 0.2],
  LeftUpLeg: [-0.08, 0.42, -0.2], LeftLeg: [-0.09, 0.25, -0.15], LeftFoot: [-0.09, 0.08, -0.22], LeftFootSite: [-0.09, 0, -0.19],
  RightUpLeg: [0.08, 0.42, -0.2], RightLeg: [0.09, 0.25, -0.15], RightFoot: [0.09, 0.08, -0.22], RightFootSite: [0.09, 0, -0.19],
  Tail: [0, 0.47, -0.24], Tail1: [0, 0.5, -0.36], Tail1Site: [0, 0.52, -0.48],
}

/** Paw chains of the stub, in contact order (front left, front right, hind left, hind right): the bones that swing with each paw. */
const LEG_BONES: string[][] = [
  ['LeftForeArm', 'LeftHand', 'LeftHandSite'],
  ['RightForeArm', 'RightHand', 'RightHandSite'],
  ['LeftLeg', 'LeftFoot', 'LeftFootSite'],
  ['RightLeg', 'RightFoot', 'RightFootSite'],
]
/** Trot: diagonal pairs together (front left with hind right). */
const OFFSET = [0, 0.5, 0.5, 0]
const DUTY = 0.6

/** Style poses for the host: 81 values each, the rest pose for every label. */
export function stubStyles(): Record<StyleLabel, Float32Array> {
  const pose = new Float32Array(BONE_COUNT * 3)
  BONES.forEach((b, i) => pose.set(REST[b]!, i * 3))
  return Object.fromEntries(STYLES.map((s) => [s, pose.slice()])) as Record<StyleLabel, Float32Array>
}

export interface StubOptions {
  /** Seconds between requests, the host's interval; the stub's clock steps by it. */
  interval?: number
}

/** A deterministic stand in for `Predictor`: same `predict` shape, no wasm, no weights. */
export class StubNetwork implements Predicts {
  readonly mode = 'stub' as const
  readonly inputLength = IN.length
  private clock = 0
  private readonly interval: number
  constructor(opts: StubOptions = {}) {
    this.interval = opts.interval ?? 0.1
  }

  reset(): void { this.clock = 0 }

  predict(input: Float32Array): Promise<RawPrediction> {
    if (input.length !== IN.length) return Promise.reject(new Error(`the stub network takes ${IN.length} values, got ${input.length}`))
    const started = performance.now()
    const t0 = this.clock
    this.clock += this.interval
    // speed and turn from the far half of the trajectory the host built
    let vz = 0
    let vx = 0
    for (let k = 8; k < 16; k++) { vx += input[IN.trajVelocities + k * 2]!; vz += input[IN.trajVelocities + k * 2 + 1]! }
    const speed = Math.hypot(vx, vz) / 8
    const dirX = input[IN.trajDirections + 15 * 2]!
    const dirZ = input[IN.trajDirections + 15 * 2 + 1]!
    const ahead = 0.25 + 15 / 60
    const turn = Number.isFinite(dirX) && Number.isFinite(dirZ) && Math.hypot(dirX, dirZ) > 1e-6 ? Math.atan2(dirX, dirZ) / ahead : 0
    const freq = speed < 0.05 ? 0 : Math.min(3.2, 1.2 + 0.7 * speed)
    const reach = freq ? Math.min(0.3, (speed * DUTY) / freq / 2) : 0
    const frames = new Float32Array(FRAMES * OUT.length)
    for (let f = 0; f < FRAMES; f++) {
      const o = f * OUT.length
      const t = t0 + f * FRAME_DT
      frames[o + OUT.dx] = 0
      frames[o + OUT.dz] = speed * FRAME_DT
      frames[o + OUT.dyaw] = turn
      const bob = freq ? 0.01 * Math.cos(4 * Math.PI * freq * t) : 0
      const pose = BONES.map((b) => [...REST[b]!] as V3)
      pose.forEach((p) => { p[1] += bob })
      LEG_BONES.forEach((chain, li) => {
        const ph = freq ? (((freq * t + OFFSET[li]!) % 1) + 1) % 1 : 0
        const stance = !freq || ph < DUTY
        // stance sweeps the paw back under the body, swing brings it forward and up
        const s = stance ? 1 - (2 * ph) / DUTY : -1 + (2 * (ph - DUTY)) / (1 - DUTY)
        const lift = stance ? 0 : Math.sin((Math.PI * (ph - DUTY)) / (1 - DUTY)) * 0.06
        chain.forEach((b, k) => {
          const w = (k + 1) / chain.length
          const p = pose[BONES.indexOf(b as (typeof BONES)[number])]!
          p[2] += s * reach * w
          p[1] += lift * w - bob * w
        })
        frames[o + OUT.contacts + li] = stance ? 1 : 0
      })
      pose.forEach((p, i) => {
        frames.set(p, o + OUT.positions + i * 3)
        frames.set([0, 0, 1], o + OUT.axisZ + i * 3)
        frames.set([0, 1, 0], o + OUT.axisY + i * 3)
        frames.set([0, 0, speed], o + OUT.velocities + i * 3)
      })
      frames.set(input.subarray(IN.style, IN.style + BONE_COUNT * 3), o + OUT.style)
    }
    return Promise.resolve({ frames, code: new Float32Array(1024), code0: new Float32Array(1024), ms: performance.now() - started })
  }

  dispose(): void {}
}
