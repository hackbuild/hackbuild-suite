// A procedural body for the avatar smoke, made here, so no model file is
// read: the vrm bone names in a humanoid tree, one triangle skinned to the
// hips with two blendshapes (smile, puff), and one clip (raise) that lifts
// the right arm over two seconds.
const BONES = [
  ['hips', -1, [0, 1, 0]], ['spine', 0, [0, 0.2, 0]], ['neck', 1, [0, 0.35, 0]], ['head', 2, [0, 0.1, 0]],
  ['leftUpperArm', 1, [0.2, 0.3, 0]], ['leftLowerArm', 4, [0.28, 0, 0]], ['leftHand', 5, [0.25, 0, 0]],
  ['rightUpperArm', 1, [-0.2, 0.3, 0]], ['rightLowerArm', 7, [-0.28, 0, 0]], ['rightHand', 8, [-0.25, 0, 0]],
  ['leftUpperLeg', 0, [0.1, -0.05, 0]], ['leftLowerLeg', 10, [0, -0.45, 0]], ['leftFoot', 11, [0, -0.45, 0]],
  ['rightUpperLeg', 0, [-0.1, -0.05, 0]], ['rightLowerLeg', 13, [0, -0.45, 0]], ['rightFoot', 14, [0, -0.45, 0]],
]
export const MORPHS = ['smile', 'puff']
export const CLIP = { name: 'raise', seconds: 2, bone: 'rightUpperArm' }

export function avatarGlb() {
  const f32 = (a) => Buffer.from(new Float32Array(a).buffer)
  const zq = (a) => [0, 0, Math.sin(a / 2), Math.cos(a / 2)]
  const parts = [
    f32([-0.3, 0, 0, 0.3, 0, 0, 0, 1.6, 0]), // position
    Buffer.from(new Uint16Array(12).buffer), // joints
    f32([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), // weights
    f32([0, 0, 0, 0, 0, 0, 0.2, 0, 0]), // smile moves the top
    f32([0, 0, 0, 0, 0, 0, 0, 0, 0.3]), // puff pushes it out
    f32([0, 1, 2]), // clip times
    f32([...zq(0), ...zq(-1.2), ...zq(0)]), // right arm about z
  ]
  let at = 0
  const views = parts.map((p) => { const v = { buffer: 0, byteOffset: at, byteLength: p.length }; at += p.length; return v })
  const bin = Buffer.concat(parts)
  const nodes = BONES.map(([name, , t]) => ({ name, translation: t }))
  BONES.forEach(([, parent], i) => { if (parent >= 0) (nodes[parent].children ??= []).push(i) })
  nodes.push({ name: 'smoke body', mesh: 0, skin: 0 })
  const json = JSON.stringify({
    asset: { version: '2.0', generator: 'suite smoke' },
    scene: 0, scenes: [{ nodes: [0, BONES.length] }], nodes,
    skins: [{ joints: BONES.map((_, i) => i), skeleton: 0 }],
    meshes: [{
      primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 }, targets: [{ POSITION: 3 }, { POSITION: 4 }] }],
      weights: [0, 0],
      extras: { targetNames: MORPHS },
    }],
    animations: [{
      name: CLIP.name,
      samplers: [{ input: 5, output: 6, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: BONES.findIndex(([n]) => n === CLIP.bone), path: 'rotation' } }],
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.3, 0, 0], max: [0.3, 1.6, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'VEC4' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
      { bufferView: 3, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [0.2, 0, 0] },
      { bufferView: 4, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [0, 0, 0.3] },
      { bufferView: 5, componentType: 5126, count: 3, type: 'SCALAR', min: [0], max: [2] },
      { bufferView: 6, componentType: 5126, count: 3, type: 'VEC4' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  })
  const j = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4, ' '))
  const head = Buffer.alloc(12)
  head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8)
  const chunk = (data, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.write(type, 4); return Buffer.concat([h, data]) }
  return Buffer.concat([head, chunk(j, 'JSON'), chunk(bin, 'BIN\0')])
}
