// A stand in body for the smokes, made here, so no model file is read.
/** A stand in body: a humanoid bone tree with the vrm bone names and one
 * triangle skinned to the hips. Made here, so no model file is read. */
export function standInGlb() {
  const bones = [
    ['hips', -1, [0, 1, 0]], ['spine', 0, [0, 0.2, 0]], ['head', 1, [0, 0.45, 0]],
    ['leftUpperArm', 1, [0.2, 0.3, 0]], ['leftLowerArm', 3, [0.28, 0, 0]], ['leftHand', 4, [0.25, 0, 0]],
    ['rightUpperArm', 1, [-0.2, 0.3, 0]], ['rightLowerArm', 6, [-0.28, 0, 0]], ['rightHand', 7, [-0.25, 0, 0]],
    ['leftUpperLeg', 0, [0.1, -0.05, 0]], ['leftLowerLeg', 9, [0, -0.45, 0]], ['leftFoot', 10, [0, -0.45, 0]],
    ['rightUpperLeg', 0, [-0.1, -0.05, 0]], ['rightLowerLeg', 12, [0, -0.45, 0]], ['rightFoot', 13, [0, -0.45, 0]],
  ]
  const pos = new Float32Array([-0.3, 0, 0, 0.3, 0, 0, 0, 1.6, 0])
  const joints = new Uint16Array(12)
  const weights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(joints.buffer), Buffer.from(weights.buffer)])
  const nodes = bones.map(([name, , t]) => ({ name, translation: t }))
  bones.forEach(([, parent], i) => { if (parent >= 0) (nodes[parent].children ??= []).push(i) })
  nodes.push({ name: 'stand in', mesh: 0, skin: 0 })
  const json = JSON.stringify({
    asset: { version: '2.0', generator: 'suite smoke' },
    scene: 0, scenes: [{ nodes: [0, bones.length] }], nodes,
    skins: [{ joints: bones.map((_, i) => i), skeleton: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.3, 0, 0], max: [0.3, 1.6, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'VEC4' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
    ],
    bufferViews: [{ buffer: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }, { buffer: 0, byteOffset: 60, byteLength: 48 }],
    buffers: [{ byteLength: bin.length }],
  })
  const j = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4, ' '))
  const head = Buffer.alloc(12)
  head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8)
  const chunk = (data, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.write(type, 4); return Buffer.concat([h, data]) }
  return Buffer.concat([head, chunk(j, 'JSON'), chunk(bin, 'BIN\0')])
}
