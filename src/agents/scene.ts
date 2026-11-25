// The built in room of the agents tools in three.js: one mesh per placed
// thing, made from boxes, cylinders and spheres in code (no model file).
// Clicks pick a thing or a spot on the floor. Core three classes only.
import {
  BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, Plane, Raycaster, SphereGeometry, Vector2, Vector3,
  type Camera, type Object3D,
} from 'three'
import { propDef, type Placed, type PropDef } from './props.ts'

/** What a placed thing is made of; the props list by default, a tool may size its own (mover). */
export type DefOf = (t: Placed) => PropDef | undefined

export class Room {
  readonly group = new Group()
  readonly meshes = new Map<string, Mesh>()
  private ray = new Raycaster()
  private floor = new Plane(new Vector3(0, 1, 0), 0)
  private hit = new Vector3()

  private defOf: DefOf

  constructor(parent: Object3D, things: readonly Placed[], defOf: DefOf = (t) => propDef(t.label)) {
    this.defOf = defOf
    this.group.name = 'agents room'
    parent.add(this.group)
    this.set(things)
  }

  /** Puts the things where the list says, making meshes for new labels. */
  set(things: readonly Placed[]) {
    for (const [label, m] of this.meshes) {
      if (things.some((t) => t.label === label)) continue
      this.group.remove(m)
      m.geometry.dispose()
      ;(m.material as MeshStandardMaterial).dispose()
      this.meshes.delete(label)
    }
    for (const t of things) {
      const d = this.defOf(t)
      if (!d) continue
      const shape = `${d.shape} ${d.w} ${d.h} ${d.d} ${d.color}`
      let m = this.meshes.get(t.label)
      if (m && m.userData.shape !== shape) {
        // resized in place: a new mesh for the new size
        this.group.remove(m)
        m.geometry.dispose()
        ;(m.material as MeshStandardMaterial).dispose()
        this.meshes.delete(t.label)
        m = undefined
      }
      if (!m) {
        const g = d.shape === 'ball' ? new SphereGeometry(d.w / 2, 20, 14) : d.shape === 'cyl' ? new CylinderGeometry(d.w / 2, d.w / 2, d.h, 20) : new BoxGeometry(d.w, d.h, d.d)
        m = new Mesh(g, new MeshStandardMaterial({ color: d.color, roughness: 0.7 }))
        m.name = t.label
        m.userData.label = t.label
        m.userData.shape = shape
        this.group.add(m)
        this.meshes.set(t.label, m)
      }
      m.position.set(t.x, d.h / 2, t.z)
      m.rotation.y = t.turn ?? 0
      m.updateMatrixWorld(true)
    }
  }

  /** A click at normalised device coordinates: the thing under it, else the floor spot. */
  pick(ndc: Vector2, camera: Camera): { label: string } | { x: number; z: number } | null {
    this.ray.setFromCamera(ndc, camera)
    const hits = this.ray.intersectObjects([...this.meshes.values()], false)
    if (hits[0]) return { label: String(hits[0].object.userData.label) }
    return this.ray.ray.intersectPlane(this.floor, this.hit) ? { x: this.hit.x, z: this.hit.z } : null
  }

  dispose() {
    this.set([])
    this.group.removeFromParent()
  }
}

/** Screen pixels of a floor spot inside an element, for the smokes. */
export function screenOf(x: number, z: number, camera: Camera, el: HTMLElement): { x: number; y: number } {
  const v = new Vector3(x, 0, z).project(camera)
  const r = el.getBoundingClientRect()
  return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }
}
