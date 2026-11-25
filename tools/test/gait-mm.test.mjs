import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bakedClip, chipSpeed, checkGait, gaitKind, groundAt, newGaitBody, RIDGE } from '../../src/gait/kind.ts'
import { BUILTIN_CLIPS, checkMm, fewClipsLine, fitLine, mmKind, newMmBody, relative, toWorld, traceCsv } from '../../src/motionmatch/kind.ts'

test('gait documents check what they hold', () => {
  assert.equal(checkGait(newGaitBody()), null)
  assert.match(checkGait({ ...newGaitBody(), gait: 'amble' }), /amble is not one of/)
  assert.match(checkGait({ ...newGaitBody(), terrain: 'ice' }), /ice is not flat/)
  assert.match(checkGait({ ...newGaitBody(), bake: 0 }), /bake is seconds/)
  assert.equal(gaitKind.kind.startsWith(`${gaitKind.tool}.`), true)
})

test('a gait chip puts the froude number in the middle of its band', () => {
  const L = 0.38
  const fr = (v) => (v * v) / (9.81 * L)
  assert.ok(fr(chipSpeed('walk', L)) < 0.12)
  assert.ok(fr(chipSpeed('trot', L)) > 0.42 && fr(chipSpeed('trot', L)) < 1.5)
  assert.ok(fr(chipSpeed('canter', L)) > 1.5 && fr(chipSpeed('canter', L)) < 3.9)
  assert.ok(fr(chipSpeed('gallop', L)) > 3.9)
})

test('the slope is a ridge and the bumps stay above the floor', () => {
  assert.equal(groundAt('flat', 12, 1, 1), 0)
  assert.equal(groundAt('slope', 12, 0, RIDGE + 1), 0)
  assert.ok(Math.abs(groundAt('slope', 45, 0, 0) - RIDGE) < 1e-9)
  for (let x = -5; x <= 5; x += 0.25) for (let z = -5; z <= 5; z += 0.25) assert.ok(groundAt('bumps', 0, x, z) >= 0)
})

test('a baked clip keeps every frame of root, bones and contacts', () => {
  const c = bakedClip('dog', 'gait', 30, ['a', 'b'], new Array(2 * 2 * 4).fill(0.123456789), [0, 0, 0, 0, 1, 0, 1, 0.5], ['LF', 'RF'], [1, 0, 0, 1])
  assert.equal(c.format, 'hackbuild.clip')
  assert.equal(c.frames, 2)
  assert.equal(c.rotations[0], 0.12346)
  assert.deepEqual(c.contacts, [1, 0, 0, 1])
})

test('motion-match documents and copy', () => {
  assert.equal(checkMm(newMmBody()), null)
  assert.match(checkMm({ ...newMmBody(), off: [3] }), /list of clip names/)
  assert.equal(mmKind.kind.startsWith(`${mmKind.tool}.`), true)
  assert.equal(fewClipsLine(2), 'the clip set has 2 clips. matching needs more to look right.')
  assert.equal(fewClipsLine(BUILTIN_CLIPS.length), null)
  assert.equal(new Set(BUILTIN_CLIPS.map((c) => c.name)).size, BUILTIN_CLIPS.length)
})

test('relative and toWorld undo each other', () => {
  const a = { x: 1, z: -2, yaw: 0.7 }
  const b = { x: -0.5, z: 3, yaw: 1.1 }
  const l = relative(a, b)
  const w = toWorld(a, l.x, l.z)
  assert.ok(Math.abs(w.x - b.x) < 1e-12 && Math.abs(w.z - b.z) < 1e-12)
  // yaw 0 faces +z: a point ahead is +z in the root frame
  assert.ok(Math.abs(relative({ x: 0, z: 0, yaw: 0 }, { x: 0, z: 2, yaw: 0 }).z - 2) < 1e-12)
})

test('the line fit recovers an affine map and flat input', () => {
  const xs = [0, 1, 2, 3, 4]
  const f = fitLine(xs, xs.map((x) => 2.5 * x - 1))
  assert.ok(Math.abs(f.a - 2.5) < 1e-12 && Math.abs(f.b + 1) < 1e-12)
  assert.deepEqual(fitLine([1, 1, 1], [2, 4, 6]), { a: 0, b: 4 })
})

test('the trace csv has one row a frame', () => {
  const csv = traceCsv([{ t: 0, clip: 'walk', frame: 3.5, cost: 0.25, jumped: true, speed: 1.2, turnRate: 0 }, { t: 0.033, clip: 'walk', frame: 4.5, cost: Infinity, jumped: false, speed: 1.2, turnRate: 0 }])
  const lines = csv.trim().split('\n')
  assert.equal(lines[0], 't,clip,frame,cost,jumped,speed,turn_rate')
  assert.equal(lines[1], '0.000,"walk",3.5,0.2500,1,1.200,0.000')
  assert.equal(lines[2].split(',')[3], '')
})
