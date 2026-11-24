import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VISION_RECORDS, visionStubs } from '@hackbuild/vision'
import { createKinds } from '../../src/workspace/kinds.ts'
import { bearing, capOf, captureMeta, CAPTURES_CAP, fitSide, newSession, results, visionKind, withCapture } from '../../src/vision/kind.ts'
import { cannedDetector, SCENE } from '../../src/vision/runtimes.ts'

const cap = (id, o = {}) => ({ id, name: id, at: 0, from: 'sample', image: 'data:image/jpeg;base64,AA', width: 640, height: 480, found: [], points: [], caption: null, answers: [], ms: {}, models: [], ...o })

test('the session kind registers, checks its body and reads an image', async () => {
  const k = createKinds()
  const kind = visionKind(async () => ({ image: 'data:image/jpeg;base64,AA', width: 4, height: 3 }))
  k.register(kind)
  assert.equal(k.byExt('a.hbvision.json')?.kind, 'vision.session')
  assert.equal(k.takers({ name: 'desk.png', type: 'image/png' })[0]?.kind.kind, 'vision.session')
  assert.equal(kind.check(newSession()), null)
  assert.match(kind.check({ ...newSession(), captures: [{ image: 'x' }] }), /no frame/)
  const r = await kind.imports[0].read(new File([new Uint8Array(4)], 'desk.png', { type: 'image/png' }))
  assert.equal(r.name, 'desk')
  assert.equal(r.body.captures.length, 1)
  assert.equal(r.body.current, r.body.captures[0].id)
})

test('captures are newest first, capped, and the new one is current', () => {
  let b = newSession()
  for (let i = 0; i < CAPTURES_CAP + 2; i++) b = withCapture(b, cap(String(i)))
  assert.equal(b.captures.length, CAPTURES_CAP)
  assert.equal(b.captures[0].id, String(CAPTURES_CAP + 1))
  assert.equal(b.current, String(CAPTURES_CAP + 1))
})

test('frames fit without enlarging; bearings read left and right', () => {
  assert.deepEqual(fitSide(1280, 720), { width: 640, height: 360 })
  assert.deepEqual(fitSide(200, 100), { width: 200, height: 100 })
  assert.equal(bearing({ x: 0, y: 0, w: 64, h: 10 }, 640), '27 deg left')
  assert.equal(bearing({ x: 288, y: 0, w: 64, h: 10 }, 640), 'ahead')
  assert.equal(bearing({ x: 576, y: 0, w: 64, h: 10 }, 640), '27 deg right')
})

test('the results json leaves the frames out', () => {
  const b = withCapture(newSession(), cap('a', { found: [{ label: 'cup', score: 0.5, box: { x: 1, y: 2, w: 3, h: 4 }, hidden: true }], caption: 'a cup.', ms: { detect: 3 } }))
  const r = JSON.parse(results(b, 'desk'))
  assert.equal(r.session, 'desk')
  assert.equal('image' in r.captures[0], false)
  assert.deepEqual(r.captures[0].found[0], { label: 'cup', score: 0.5, box: { x: 1, y: 2, w: 3, h: 4 } })
  assert.equal(captureMeta(b.captures[0]), '1 found, caption, 3 ms')
})

test('every task routes to a vision record, and the canned detector places the scene', async () => {
  for (const t of ['detect', 'landmarks', 'caption', 'ask']) {
    const c = capOf(t, 'hand')
    assert.ok(VISION_RECORDS.some((r) => r.provides.includes(c)), c)
    assert.ok(visionStubs()[c], c)
  }
  const d = await cannedDetector().detect({ width: 100, height: 50 }, { scoreThreshold: 0.7 })
  assert.deepEqual(d.map((x) => x.label), ['person', 'laptop'])
  assert.deepEqual(d[0].box, { x: SCENE[0].x * 100, y: SCENE[0].y * 50, w: SCENE[0].w * 100, h: SCENE[0].h * 50 })
})
