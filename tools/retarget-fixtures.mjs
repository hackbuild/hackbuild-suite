// Fixtures for the retarget smoke, made here, so no model or clip file is
// read: a target glb whose bones carry game engine names (pelvis, thigh_l)
// and stand 0.8 m at the hips, a source bvh with other names in
// centimeters where the left shin is a joint no mapper can read (jnt_07),
// and a vmd that swings the left arm, its bone name in Shift-JIS.

const TARGET = [
  ['pelvis', -1, [0, 0.8, 0]], ['spine_01', 0, [0, 0.15, 0]], ['spine_02', 1, [0, 0.15, 0]], ['neck_01', 2, [0, 0.25, 0]], ['head', 3, [0, 0.1, 0]],
  ['clavicle_l', 2, [0.05, 0.2, 0]], ['upperarm_l', 5, [0.12, 0, 0]], ['lowerarm_l', 6, [0.24, 0, 0]], ['hand_l', 7, [0.22, 0, 0]],
  ['clavicle_r', 2, [-0.05, 0.2, 0]], ['upperarm_r', 9, [-0.12, 0, 0]], ['lowerarm_r', 10, [-0.24, 0, 0]], ['hand_r', 11, [-0.22, 0, 0]],
  ['thigh_l', 0, [0.09, -0.04, 0]], ['calf_l', 13, [0, -0.37, 0]], ['foot_l', 14, [0, -0.37, 0]], ['ball_l', 15, [0, -0.02, 0.1]],
  ['thigh_r', 0, [-0.09, -0.04, 0]], ['calf_r', 17, [0, -0.37, 0]], ['foot_r', 18, [0, -0.37, 0]], ['ball_r', 19, [0, -0.02, 0.1]],
]
export const TARGET_NAMES = { leftUpperLeg: 'thigh_l', leftLowerLeg: 'calf_l' }

export function targetGlb() {
  const f32 = (a) => Buffer.from(new Float32Array(a).buffer)
  const parts = [f32([-0.3, 0, 0, 0.3, 0, 0, 0, 1.4, 0]), Buffer.from(new Uint16Array(12).buffer), f32([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])]
  let at = 0
  const views = parts.map((p) => { const v = { buffer: 0, byteOffset: at, byteLength: p.length }; at += p.length; return v })
  const bin = Buffer.concat(parts)
  const nodes = TARGET.map(([name, , t]) => ({ name, translation: t }))
  TARGET.forEach(([, parent], i) => { if (parent >= 0) (nodes[parent].children ??= []).push(i) })
  nodes.push({ name: 'smoke target', mesh: 0, skin: 0 })
  const json = JSON.stringify({
    asset: { version: '2.0', generator: 'suite smoke' },
    scene: 0, scenes: [{ nodes: [0, TARGET.length] }], nodes,
    skins: [{ joints: TARGET.map((_, i) => i), skeleton: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.3, 0, 0], max: [0.3, 1.4, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'VEC4' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
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

const SOURCE = [
  ['Root', -1, [0, 0, 0]], ['Torso', 0, [0, 12, 0]], ['Chest', 1, [0, 16, 0]], ['Neck', 2, [0, 26, 0]], ['Head', 3, [0, 11, 0]],
  ['LeftArm', 2, [18, 22, 0]], ['LeftForeArm', 5, [29, 0, 0]], ['LeftHand', 6, [26, 0, 0]],
  ['RightArm', 2, [-18, 22, 0]], ['RightForeArm', 8, [-29, 0, 0]], ['RightHand', 9, [-26, 0, 0]],
  ['LeftUpLeg', 0, [10, -6, 0]], ['jnt_07', 11, [0, -47, 0]], ['LeftFoot', 12, [0, -45, 0]],
  ['RightUpLeg', 0, [-10, -6, 0]], ['RightLeg', 14, [0, -47, 0]], ['RightFoot', 15, [0, -45, 0]],
]
/** The unreadable joint and the bone it plays. */
export const REMAP = { joint: 'jnt_07', bone: 'leftLowerLeg' }
export const SOURCE_SECONDS = 2

/** A kick: the left thigh and shin swing, the right arm waves, at 30 fps. */
export function sourceBvh(fps = 30) {
  const kids = (i) => SOURCE.map((j, k) => [j, k]).filter(([j]) => j[1] === i)
  const order = []
  const write = (i, d) => {
    order.push(i)
    const [name, parent, o] = SOURCE[i]
    const pad = '  '.repeat(d)
    const ch = parent < 0 ? 'CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation' : 'CHANNELS 3 Zrotation Xrotation Yrotation'
    const c = kids(i)
    const inner = c.length ? c.map(([, k]) => write(k, d + 1)).join('') : `${pad}  End Site\n${pad}  {\n${pad}    OFFSET 0 6 0\n${pad}  }\n`
    return `${pad}${parent < 0 ? 'ROOT' : 'JOINT'} ${name}\n${pad}{\n${pad}  OFFSET ${o.join(' ')}\n${pad}  ${ch}\n${inner}${pad}}\n`
  }
  const tree = write(0, 0)
  const n = SOURCE_SECONDS * fps
  const lines = []
  for (let f = 0; f < n; f++) {
    const s = Math.sin((f / fps) * Math.PI)
    const rot = { LeftUpLeg: [0, -20 * s, 0], jnt_07: [0, 80 * s, 0], LeftArm: [-70, 0, 0], RightArm: [70 - 90 * s, 0, 0] }
    const vals = []
    for (const i of order) vals.push(...(i === 0 ? [0, 100, 0, 0, 0, 0] : rot[SOURCE[i][0]] ?? [0, 0, 0]))
    lines.push(vals.map((v) => v.toFixed(4)).join(' '))
  }
  return `HIERARCHY\n${tree}MOTION\nFrames: ${n}\nFrame Time: ${(1 / fps).toFixed(6)}\n${lines.join('\n')}\n`
}

/** A vmd: the left arm (左腕, Shift-JIS) turns about z over a second. */
export function sourceVmd() {
  const arm = [0x8d, 0xb6, 0x98, 0x72]
  const header = new Uint8Array(50)
  header.set(Buffer.from('Vocaloid Motion Data 0002'))
  const key = (frame, angle) => {
    const b = new Uint8Array(111)
    b.set(arm)
    const v = new DataView(b.buffer)
    v.setUint32(15, frame, true)
    v.setFloat32(39, Math.sin(angle / 2), true)
    v.setFloat32(43, Math.cos(angle / 2), true)
    return b
  }
  const keys = [key(0, 0), key(30, 1.2)]
  const count = new Uint8Array(4)
  new DataView(count.buffer).setUint32(0, keys.length, true)
  return Buffer.from(new Uint8Array([...header, ...count, ...keys.flatMap((k) => [...k]), 0, 0, 0, 0]))
}
