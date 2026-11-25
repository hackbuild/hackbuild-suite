import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createKinds } from '../../src/workspace/kinds.ts'
import { checkRetarget, newRetargetBody, retargetKind } from '../../src/retarget/kind.ts'
import { applyEdits, mapNames, sourceKind, walkBvh } from '../../src/retarget/source.ts'

test('a hand edit takes the bone from the joint that had it', () => {
  const names = ['a', 'b', 'c']
  const auto = ['hips', 'leftUpperLeg', null]
  const bones = applyEdits(names, auto, { c: 'leftUpperLeg' })
  assert.deepEqual(bones, ['hips', null, 'leftUpperLeg'])
  assert.deepEqual(mapNames(names, auto, bones), ['a', 'unmapped 1', 'leftUpperLeg'])
  assert.deepEqual(applyEdits(names, auto, { a: '' }), [null, 'leftUpperLeg', null])
})

test('the retarget document checks its body', () => {
  assert.equal(checkRetarget(newRetargetBody()), null)
  assert.match(checkRetarget({ ...newRetargetBody(), edits: { x: 'tail' } }), /not a body bone/)
  assert.match(checkRetarget({ ...newRetargetBody(), layout: 'stacked' }), /layout/)
  assert.doesNotThrow(() => createKinds().register(retargetKind))
})

test('source files route by kind and the built in walk is bvh', () => {
  assert.equal(sourceKind('a.BVH'), 'bvh')
  assert.equal(sourceKind('dance.vmd'), 'vmd')
  assert.equal(sourceKind('run.glb'), 'glb')
  assert.equal(sourceKind('body.vrm'), null)
  const t = walkBvh(1, 10)
  assert.match(t, /^HIERARCHY\nROOT Hips/)
  assert.match(t, /Frames: 10/)
})
