// What the mover tool draws with three.js: the world's things through the
// agents room (sized per thing), the goal ring and the planned path on the
// floor. The view imports this module on mount, so three stays out of the
// route chunk. Core three classes only.
import { BufferAttribute, BufferGeometry, DoubleSide, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, RingGeometry, type Scene } from 'three'
import { Room } from '../agents/scene.ts'
import { itemDef, type Spot, type WorldItem } from './kind.ts'

export { screenOf } from '../agents/scene.ts'
export { MoverSim } from './sim.ts'

const MAX_PATH = 64

export class WorldView {
  readonly room: Room
  private items: WorldItem[] = []
  private ring: Mesh
  private line: Line
  private pos = new Float32Array(MAX_PATH * 3)
  private scene: Scene

  constructor(scene: Scene, items: readonly WorldItem[], ink: string) {
    this.scene = scene
    this.room = new Room(scene, [], (t) => {
      const it = this.items.find((x) => x.label === t.label)
      return it ? itemDef(it) : undefined
    })
    this.ring = new Mesh(new RingGeometry(0.16, 0.24, 28), new MeshBasicMaterial({ color: ink, side: DoubleSide, depthWrite: false }))
    this.ring.rotation.x = -Math.PI / 2
    this.ring.visible = false
    const g = new BufferGeometry().setAttribute('position', new BufferAttribute(this.pos, 3))
    g.setDrawRange(0, 0)
    this.line = new Line(g, new LineBasicMaterial({ color: ink }))
    this.line.frustumCulled = false
    scene.add(this.ring, this.line)
    this.set(items)
  }

  set(items: readonly WorldItem[]) {
    this.items = items.map((t) => ({ ...t }))
    this.room.set(this.items.map((t) => ({ label: t.label, x: t.x, z: t.z, turn: t.turn ? Math.PI / 2 : 0 })))
  }

  /** The goal ring and the path from the body through the waypoints left. */
  goal(goal: Spot | null, from: Spot, path: readonly Spot[]) {
    this.ring.visible = !!goal
    if (goal) this.ring.position.set(goal.x, 0.02, goal.z)
    const pts = goal ? [from, ...path].slice(0, MAX_PATH) : []
    pts.forEach((p, i) => this.pos.set([p.x, 0.03, p.z], i * 3))
    const g = this.line.geometry
    ;(g.getAttribute('position') as BufferAttribute).needsUpdate = true
    g.setDrawRange(0, pts.length)
  }

  dispose() {
    this.room.dispose()
    for (const m of [this.ring, this.line]) {
      this.scene.remove(m)
      m.geometry.dispose()
      ;(m.material as MeshBasicMaterial).dispose()
    }
  }
}
