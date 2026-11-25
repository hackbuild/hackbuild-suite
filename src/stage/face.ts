// A procedural mouth for the built in mannequin, so the lipsync tool has a
// real face to drive: one mesh on the head bone with the five VRM vowel
// morphs (aa, ih, ou, ee, oh), made in code. The closed mouth is a thin
// slit on the head's front; each morph opens it to that vowel's shape.
// No asset file. Imported by tool bind modules only, never the route chunk.
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshStandardMaterial, type Object3D } from 'three'

/** The morph names the mouth carries, in order. */
export const FACE_MORPHS = ['aa', 'ih', 'ou', 'ee', 'oh'] as const

// half width, half height, drop of the lower lip, push forward; meters
// (proposed, set by eye on the mannequin's head)
const SHAPES: Record<(typeof FACE_MORPHS)[number] | 'rest', [number, number, number, number]> = {
  rest: [0.026, 0.0022, 0, 0],
  aa: [0.024, 0.017, 0.007, 0],
  ih: [0.029, 0.007, 0.002, 0],
  ou: [0.011, 0.009, 0.002, 0.007],
  ee: [0.032, 0.0055, 0.001, 0],
  oh: [0.017, 0.014, 0.004, 0.004],
}

const RING = 28
// the mouth's centre in the head bone's frame (the mannequin head sphere is
// centred 0.09 m above the bone, 0.105 m across)
const Y0 = 0.035
const Z0 = 0.0995

function shape([w, h, drop, push]: [number, number, number, number]): number[] {
  const out = [0, Y0 - drop / 2, Z0 + push]
  for (let i = 0; i < RING; i++) {
    const a = (i / RING) * Math.PI * 2
    const x = Math.cos(a) * w
    const s = Math.sin(a)
    const y = Y0 + (s >= 0 ? s * h : s * h - drop * -s)
    // follow the head's curve back at the corners
    const z = Z0 + push * (1 - Math.abs(Math.cos(a))) - 0.0055 * (x / 0.03) ** 2
    out.push(x, y, z)
  }
  return out
}

/** Builds the mouth mesh: its morph dictionary holds FACE_MORPHS. */
export function mouthMesh(): Mesh {
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(shape(SHAPES.rest), 3))
  const idx: number[] = []
  for (let i = 0; i < RING; i++) idx.push(0, 1 + i, 1 + ((i + 1) % RING))
  g.setIndex(idx)
  g.morphAttributes.position = FACE_MORPHS.map((m) => {
    const a = new Float32BufferAttribute(shape(SHAPES[m]), 3)
    a.name = m
    return a
  })
  g.morphTargetsRelative = false
  g.computeVertexNormals()
  const mesh = new Mesh(g, new MeshStandardMaterial({ name: 'mouth', color: 0x3b2226, roughness: 0.9 }))
  mesh.name = 'mouth'
  mesh.frustumCulled = false
  mesh.updateMorphTargets()
  return mesh
}

/** Puts a mouth on a head bone once; returns the mouth. */
export function addFace(head: Object3D): Mesh {
  const had = head.getObjectByName('mouth')
  if (had instanceof Mesh) return had
  const m = mouthMesh()
  head.add(m)
  return m
}
