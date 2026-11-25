import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createKinds } from '../../src/workspace/kinds.ts'
import { avatarKind, newAvatarBody } from '../../src/avatar/kind.ts'
import { builtinClips, clipFile, clipSeconds, poseClip, poseFile, readClip, readPose } from '../../src/avatar/pose.ts'

const names = ['hips', 'spine', 'neck', 'head', 'rightUpperArm', 'rightLowerArm']
const ident = (n) => Float32Array.from({ length: n * 4 }, (_, i) => (i % 4 === 3 ? 1 : 0))

test('a pose goes to a file and back as a held clip', () => {
  const rot = ident(names.length)
  rot.set([0, 0, 0.5, Math.sqrt(0.75)], 4 * 4)
  const p = readPose(JSON.parse(JSON.stringify(poseFile('wave', names, rot, { smile: 0.8 }, 'happy'))))
  assert.equal(p.morphs.smile, 0.8)
  const { clip, matched } = poseClip(p, [...names, 'jaw'], ident(names.length + 1))
  assert.equal(matched, names.length)
  assert.equal(clip.frames, 2)
  assert.ok(Math.abs(clip.rotations[4 * 4 + 2] - 0.5) < 1e-5)
  assert.throws(() => readPose({ format: 'other' }), /not a pose/)
})

test('a clip file maps onto another bone order by name', () => {
  const [wave] = builtinClips(names, ident(names.length), ident(names.length))
  assert.equal(wave.name, 'wave')
  assert.ok(clipSeconds(wave) > 2)
  const file = clipFile(wave, names)
  const other = [...names].reverse()
  const { clip, matched } = readClip(JSON.parse(JSON.stringify(file)), other, ident(other.length))
  assert.equal(matched, names.length)
  const f = 30
  const at = (c, order, bone) => [...c.rotations.slice((f * order.length + order.indexOf(bone)) * 4, (f * order.length + order.indexOf(bone)) * 4 + 4)]
  at(clip, other, 'rightUpperArm').forEach((v, k) => assert.ok(Math.abs(v - at(wave, names, 'rightUpperArm')[k]) < 1e-4))
  assert.throws(() => readClip({ ...file, rotations: [1] }, names, ident(names.length)), /rotation numbers/)
})

test('the avatar kind registers and checks its body', () => {
  const k = createKinds()
  k.register(avatarKind)
  assert.equal(k.byExt('a.hbavatar.json')?.kind, 'avatar.session')
  assert.equal(avatarKind.check(newAvatarBody()), null)
  assert.match(avatarKind.check({ ...newAvatarBody(), mode: 'shout' }), /gaze mode/)
})
