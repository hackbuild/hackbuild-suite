// What the motion-net tool does with three.js and the weights store. The
// network's 27 bone skeleton is drawn as boxes from each bone to its
// parent, placed each frame from the host's world positions, with a disc
// under each planted paw. The weights come through the suite's one weight
// store, so a second visit reads them back with no download; a stub
// network stands in under ?stub. Only core three classes, no addon. The
// view imports this module on mount, so three and the network stay out of
// the route chunk.
import { BoxGeometry, CircleGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Quaternion, Vector3, type Object3D } from 'three'
import {
  BONES, BONE_COUNT, PARENTS, Predictor, QuadrupedHost, UPSTREAM, WEIGHT_LICENCE, loadWeights,
  type HostCommand, type Predicts, type StyleLabel,
} from '@hackbuild/motion-net'
import type { WeightStore } from '@hackbuild/weights'
import { StubNetwork, stubStyles } from './stub.ts'

export const PAW_SITES = ['LeftHandSite', 'RightHandSite', 'LeftFootSite', 'RightFootSite'].map((n) => BONES.indexOf(n as (typeof BONES)[number]))
/** Bake rate, frames a second (proposed, as the gait tool). */
export const BAKE_FPS = 30

export interface Network {
  predictor: Predicts & { dispose(): void }
  styles: Record<StyleLabel, ArrayLike<number>>
  /** worker, page or stub. */
  mode: string
  fallbackReason: string | null
  sha256: string | null
}

export interface FetchOptions {
  store: WeightStore
  url: string
  onProgress: (loaded: number, total: number | null) => void
  onLicence: (line: string) => void
  signal: AbortSignal
}

/** The manifest beside a binary url: the same name with .json. */
export const manifestFor = (bin: string) => (bin === UPSTREAM.bin ? UPSTREAM.manifest : bin.replace(/\.bin(\?.*)?$/, '.json$1'))

/** True when the binary is in the store already. */
export const stored = (store: WeightStore, url: string) => store.has(url)

/** Both parts through the store, checked by the package, then the predictor. Throws with words. */
export async function fetchNetwork(o: FetchOptions): Promise<Network> {
  const upstream = o.url === UPSTREAM.bin
  const ref = { licence: WEIGHT_LICENCE }
  const manifest = await o.store.get({ ...ref, url: manifestFor(o.url) }, { signal: o.signal })
  const bin = await o.store.get(
    { ...ref, url: o.url, sha256: upstream ? UPSTREAM.binSha256 : undefined },
    { signal: o.signal, onProgress: (p) => o.onProgress(p.loaded, p.total) },
  )
  return fromParts(manifest, bin, upstream ? UPSTREAM.binSha256 : undefined, o.onLicence)
}

/** The two dropped files, a .json manifest and a .bin. */
export async function fromFiles(files: File[], onLicence: (line: string) => void): Promise<Network> {
  const m = files.find((f) => /\.json$/i.test(f.name))
  const b = files.find((f) => /\.bin$/i.test(f.name))
  if (!m || !b) throw new Error('drop both parts: the .json manifest and the .bin weights')
  return fromParts(m, b, undefined, onLicence)
}

async function fromParts(manifest: Blob, bin: Blob, sha256: string | undefined, onLicence: (line: string) => void): Promise<Network> {
  let m: unknown
  try { m = JSON.parse(await manifest.text()) } catch { throw new Error('the manifest is not json') }
  const w = await loadWeights({ manifest: m as Parameters<typeof loadWeights>[0]['manifest'], bin, sha256, onLicence })
  const p = await Predictor.create(w, { worker: 'auto' })
  return { predictor: p, styles: w.styles, mode: p.mode, fallbackReason: p.fallbackReason, sha256: w.sha256 }
}

/** The stub network; `fail` throws as a weights check would, for the fallback smoke. */
export async function stubNetwork(fail: boolean): Promise<Network> {
  await new Promise((r) => setTimeout(r, 30))
  if (fail) throw new Error('tensor encoder.0.weight has 0 of 1024 values (forced by the smoke)')
  return { predictor: new StubNetwork(), styles: stubStyles(), mode: 'stub', fallbackReason: null, sha256: null }
}

export interface Colors { body: string; stance: string }

const Z = new Vector3(0, 0, 1)
const a = new Vector3()
const b = new Vector3()
const q = new Quaternion()
const qp = new Quaternion()

/** The network's skeleton on the stage and its run baked into a clip. */
export class NetRig {
  readonly root = new Group()
  host: QuadrupedHost | null = null
  net: Network | null = null
  /** Offset of the drawn body from the host's root, m: side by side puts it beside the procedural dog. */
  offsetX = 0
  bakeSeconds = 6
  private readonly links: { mesh: Mesh; bone: number; parent: number }[] = []
  private readonly discs: Mesh[] = []
  private readonly mat: MeshStandardMaterial
  private readonly discMat: MeshBasicMaterial
  private bakeT = 0
  private bakeRot: number[] = []
  private bakeRoot: number[] = []
  private bakeContacts: number[] = []

  constructor(scene: Object3D, colors: Colors) {
    this.root.name = 'motion-net skeleton'
    this.mat = new MeshStandardMaterial({ color: colors.body, roughness: 0.6 })
    const box = new BoxGeometry(1, 1, 1)
    for (let i = 0; i < BONE_COUNT; i++) {
      const p = PARENTS[i]!
      if (p < 0) continue
      const mesh = new Mesh(box, this.mat)
      mesh.name = `${BONES[p]} to ${BONES[i]}`
      this.root.add(mesh)
      this.links.push({ mesh, bone: i, parent: p })
    }
    this.discMat = new MeshBasicMaterial({ color: colors.stance, transparent: true, opacity: 0.85, depthWrite: false })
    const dg = new CircleGeometry(0.035, 20)
    dg.rotateX(-Math.PI / 2)
    for (let i = 0; i < 4; i++) {
      const d = new Mesh(dg, this.discMat)
      d.renderOrder = 998
      this.root.add(d)
      this.discs.push(d)
    }
    this.root.visible = false
    scene.add(this.root)
  }

  /** Takes a network and starts a host on it; the old one is disposed. */
  use(net: Network | null): void {
    this.net?.predictor.dispose()
    this.net = net
    this.host = net ? new QuadrupedHost(net.predictor, net.styles) : null
    this.restart()
  }

  restart(): void {
    this.host?.reset(0, 0, 0)
    if (this.net?.predictor instanceof StubNetwork) this.net.predictor.reset()
    this.bakeT = 0
    this.bakeRot = []
    this.bakeRoot = []
    this.bakeContacts = []
  }

  /** One frame; draws the pose. Null when no network runs. */
  step(dt: number, cmd: HostCommand): QuadrupedHost | null {
    const h = this.host
    if (!h) { this.root.visible = false; return null }
    if (dt > 0) h.update(dt, cmd)
    this.root.visible = true
    this.root.position.set(this.offsetX, 0, 0)
    const P = h.positions
    for (const l of this.links) {
      a.set(P[l.parent * 3]!, P[l.parent * 3 + 1]!, P[l.parent * 3 + 2]!)
      b.set(P[l.bone * 3]!, P[l.bone * 3 + 1]!, P[l.bone * 3 + 2]!)
      const len = a.distanceTo(b)
      const w = l.parent <= 2 && l.bone <= 3 ? 0.13 : l.bone >= 24 ? 0.03 : 0.045
      l.mesh.visible = len > 1e-4
      l.mesh.position.copy(a).add(b).multiplyScalar(0.5)
      l.mesh.scale.set(w, w, Math.max(1e-4, len))
      if (len > 1e-4) l.mesh.quaternion.setFromUnitVectors(Z, b.sub(a).normalize())
    }
    h.paws.forEach((p, i) => {
      const d = this.discs[i]!
      const s = PAW_SITES[i]!
      d.visible = p.stance
      d.position.set(P[s * 3]!, 0.004, P[s * 3 + 2]!)
    })
    if (dt > 0) this.bake(dt, h)
    return h
  }

  private bake(dt: number, h: QuadrupedHost): void {
    this.bakeT += dt
    if (this.bakeT < 1 / BAKE_FPS && this.bakeRoot.length) return
    this.bakeT = 0
    const R = h.rotations
    for (let i = 0; i < BONE_COUNT; i++) {
      q.set(R[i * 4]!, R[i * 4 + 1]!, R[i * 4 + 2]!, R[i * 4 + 3]!)
      const p = PARENTS[i]!
      if (p >= 0) q.premultiply(qp.set(R[p * 4]!, R[p * 4 + 1]!, R[p * 4 + 2]!, R[p * 4 + 3]!).invert())
      q.normalize()
      this.bakeRot.push(q.x, q.y, q.z, q.w)
    }
    this.bakeRoot.push(h.root.x, 0, h.root.z, h.root.yaw)
    for (const p of h.paws) this.bakeContacts.push(p.stance ? 1 : 0)
    const over = this.bakeRoot.length / 4 - Math.round(this.bakeSeconds * BAKE_FPS)
    if (over > 0) {
      this.bakeRot.splice(0, over * BONE_COUNT * 4)
      this.bakeRoot.splice(0, over * 4)
      this.bakeContacts.splice(0, over * 4)
    }
  }

  /** The baked run: bone names, local rotations, root track and contacts. */
  baked(): { bones: string[]; rotations: number[]; root: number[]; contacts: number[]; frames: number } {
    return { bones: [...BONES], rotations: [...this.bakeRot], root: [...this.bakeRoot], contacts: [...this.bakeContacts], frames: this.bakeRoot.length / 4 }
  }

  dispose(): void {
    this.net?.predictor.dispose()
    this.root.removeFromParent()
    this.links[0]?.mesh.geometry.dispose()
    this.discs[0]?.geometry.dispose()
    this.mat.dispose()
    this.discMat.dispose()
  }
}
