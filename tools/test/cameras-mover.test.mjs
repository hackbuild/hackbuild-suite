import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seededRng } from '@hackbuild/organic'
import { STEP_UP } from '@hackbuild/mover'
import { checkMover, collidersOf, footprintsOf, inside, moverKind, newItem, newMoverBody, planPath, seededWorld, stepOver, traceCsv } from '../../src/mover/kind.ts'
import { MoverSim } from '../../src/mover/sim.ts'
import { Walker, camerasKind, checkCameras, newCamerasBody, seededLoop } from '../../src/cameras/kind.ts'

test('world and cameras documents check what they hold', () => {
  assert.equal(checkMover(newMoverBody()), null)
  assert.equal(checkMover(seededWorld(seededRng(7))), null)
  assert.match(checkMover({ ...newMoverBody(), items: [{ label: 'x', kind: 'sofa', x: 0, z: 0, w: 1, d: 1, h: 1, turn: 0 }] }), /sofa is not one of/)
  assert.match(checkMover({ ...newMoverBody(), items: [newItem([], 'box', 0, 0)].map((t) => ({ ...t, x: 9 })) }), /off the floor/)
  assert.equal(moverKind.kind.startsWith(`${moverKind.tool}.`), true)
  assert.equal(checkCameras(newCamerasBody()), null)
  assert.match(checkCameras({ ...newCamerasBody(), rig: 'drone' }), /rig drone/)
  assert.equal(camerasKind.kind.startsWith(`${camerasKind.tool}.`), true)
})

test('a seed gives the same world and the same loop', () => {
  assert.deepEqual(seededWorld(seededRng(7)), seededWorld(seededRng(7)))
  assert.notDeepEqual(seededWorld(seededRng(7)), seededWorld(seededRng(8)))
  assert.deepEqual(seededLoop(seededRng(3)), seededLoop(seededRng(3)))
  const w = new Walker(seededLoop(seededRng(3)), 1.2)
  const x0 = w.x
  for (let i = 0; i < 60; i++) w.step(1 / 60)
  assert.ok(Math.hypot(w.x - x0, w.z - seededLoop(seededRng(3))[0].z) > 0.5)
})

test('things become colliders and footprints; a low box is stepped onto', () => {
  const items = [newItem([], 'wall', 0, 1.5), newItem([], 'cylinder', 2, 0)]
  const low = newItem(items, 'box', -2, 0, 0, { w: 0.6, d: 0.6, h: 0.3 })
  items.push(low)
  // the floor, four sides and the three things
  assert.equal(collidersOf(items).length, 8)
  assert.ok(low.h <= STEP_UP && stepOver(low))
  assert.deepEqual(footprintsOf(items).map((f) => f.id), ['wall 1', 'cylinder 1'])
  assert.equal(inside(items, 0, 1.5)?.label, 'wall 1')
  assert.equal(inside(items, -2, 0), null)
  // a long wall placed at the edge stays on the floor
  const edge = newItem([], 'wall', 4, 0, 0, { w: 4, d: 0.2, h: 1 })
  assert.ok(edge.x + edge.w / 2 <= 5)
})

test('the body walks round a wall to a goal behind it, and the keys take over', () => {
  const items = [newItem([], 'wall', 0, 1.5, 0, { w: 3, d: 0.2, h: 1.2 })]
  assert.equal(planPath(items, { x: 0, z: 0 }, { x: 0, z: 1.5 }), null)
  const s = new MoverSim(items, { x: 0, z: 0 })
  assert.match(s.setGoal(0, 1.5), /inside a wall/)
  assert.equal(s.setGoal(0.1, 3.2), null)
  assert.ok(s.path.length >= 2)
  let steps = 0
  for (; steps < 60 * 20 && s.goal; steps++) {
    s.step(1 / 60)
    assert.equal(inside(items, s.actor.pos.x, s.actor.pos.z, 0.2), null)
  }
  assert.equal(s.goal, null)
  assert.ok(Math.hypot(s.actor.pos.x - 0.1, s.actor.pos.z - 3.2) < 0.5)
  assert.ok(s.events.some((e) => e.kind === 'arrived'))
  s.setGoal(0, 0)
  s.step(1 / 60, { vx: 1, vz: 0 })
  assert.equal(s.goal, null)
  assert.equal(s.read().why, 'driven by the keys or the pad')
  assert.match(traceCsv(s.trace.slice(0, 2)), /^t,x,z,mode,why\n/)
})
