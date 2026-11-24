import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discSegmenter, maskArea, maskFromRle, maskToRle } from '@hackbuild/vision'
import { createKinds } from '../../src/workspace/kinds.ts'
import {
  canDecode, instancesJson, maskFromRgba, masksKind, mergeAll, newBody, readInstances, strokeInto, toSegmentPrompt, unionOf, withImage, withSaved, SAVED_CAP,
} from '../../src/masks/kind.ts'

const frame = { image: 'data:image/jpeg;base64,AA', width: 64, height: 48 }
const disc = async (prompts) => (await discSegmenter().segment(frame, toSegmentPrompt(prompts)))[0]
const inst = (id, m, colour = 0) => ({ id, colour, prompts: [], rle: maskToRle(m), score: 0.9, hidden: false, edited: false })

test('the kind registers, checks its body and reads an image', async () => {
  const k = createKinds()
  const kind = masksKind(async () => frame)
  k.register(kind)
  assert.equal(k.byExt('a.hbmasks.json')?.kind, 'masks.cutouts')
  assert.equal(kind.check(newBody()), null)
  const r = await kind.imports[0].read(new File([new Uint8Array(4)], 'desk.png', { type: 'image/png' }))
  assert.equal(r.name, 'desk')
  assert.equal(r.body.width, 64)
  assert.match(r.body.hash, /^[0-9a-f]{8}$/)
  assert.match(kind.check({ ...r.body, instances: [{ rle: { size: [1, 1], counts: [1] } }] }), /size/)
})

test('prompts become a decoder prompt: kept and left out points, the last kept box', () => {
  const p = toSegmentPrompt([
    { kind: 'point', x: 10, y: 12, positive: true },
    { kind: 'point', x: 20, y: 22, positive: false },
    { kind: 'box', x0: 1, y0: 2, x1: 11, y1: 22, positive: true },
    { kind: 'box', x0: 0, y0: 0, x1: 4, y1: 4, positive: false },
  ])
  assert.deepEqual(p.points, [{ x: 10, y: 12, label: 1 }, { x: 20, y: 22, label: 0 }, { x: 2, y: 2, label: 0 }])
  assert.deepEqual(p.box, { x: 1, y: 2, w: 10, h: 20 })
  assert.equal(canDecode([{ kind: 'point', x: 1, y: 1, positive: false }]), false)
})

test('stroke, merge, save and the instances file round trip', async () => {
  const a = await disc([{ kind: 'point', x: 16, y: 24, positive: true }])
  const b = await disc([{ kind: 'box', x0: 40, y0: 14, x1: 60, y1: 34, positive: true }])
  let body = { ...withImage('desk', frame), instances: [inst('a', a), inst('b', b, 1)] }
  const cover = new Uint8ClampedArray(64 * 48 * 4)
  cover[(24 * 64 + 16) * 4 + 3] = 255
  const cut = strokeInto(a, cover, 'erase')
  assert.equal(maskArea(cut), maskArea(a) - 1)
  assert.equal(maskArea(strokeInto(cut, cover, 'restore')), maskArea(a))
  const merged = mergeAll(body)
  assert.equal(merged.instances.length, 1)
  assert.equal(maskArea(maskFromRle(merged.instances[0].rle)), maskArea(unionOf(body)))
  for (let i = 0; i < SAVED_CAP + 2; i++) body = withSaved(body, { id: String(i), name: `mask ${i}`, at: i, rle: maskToRle(a) })
  assert.equal(body.saved.length, SAVED_CAP)
  const back = readInstances(instancesJson(body), 64, 48)
  assert.equal(back.length, 2)
  assert.equal(maskArea(maskFromRle(back[1].rle)), maskArea(b))
  assert.throws(() => readInstances(instancesJson(body), 32, 48), /64 by 48 and the image is 32 by 48/)
})

test('a mask image reads from its grey or its alpha', () => {
  const grey = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255])
  assert.deepEqual([...maskFromRgba(2, 1, grey).data], [255, 0])
  const alpha = new Uint8ClampedArray([255, 255, 255, 0, 255, 255, 255, 200])
  assert.deepEqual([...maskFromRgba(2, 1, alpha).data], [0, 255])
})
