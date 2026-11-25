import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bannedWords, intersects, judge, overlapArea, slug } from '../ux-probe.mjs'

test('internal words are found as whole words, plurals too', () => {
  assert.deepEqual(bannedWords('552 MB (Measured), two Tiers, phase 2'), ['measured', 'tier', 'phase'])
  assert.deepEqual(bannedWords('organic phases of a computer'), ['phase'])
  assert.deepEqual(bannedWords('the dog sleeps'), [])
})

test('rects that touch do not intersect, rects that cross do', () => {
  const a = { left: 0, top: 0, right: 10, bottom: 10 }
  assert.equal(overlapArea(a, { left: 10, top: 0, right: 20, bottom: 10 }), 0)
  assert.equal(overlapArea(a, { left: 5, top: 5, right: 15, bottom: 15 }), 25)
  assert.equal(intersects(a, { left: 9, top: 9, right: 20, bottom: 20 }), false)
  assert.equal(intersects(a, { left: 5, top: 5, right: 15, bottom: 15 }), true)
})

test('verdicts follow the template numbers', () => {
  const m = {
    viewport: { width: 1440, height: 900 },
    bar: { height: 52 }, bars: 1, controls: Array(15).fill('x'), disabled: [], pinkVar: '#FE0386', pink: ['throw'],
    subject: { share: 0.6, top: 52 }, rack: { widths: [380, 380, 381] }, hscroll: 0, overlaps: [], words: [],
  }
  const v = judge(m, 1440)
  assert.ok(Object.values(v).every((c) => c.pass === true), JSON.stringify(v))
  const phone = judge({ ...m, viewport: { width: 390, height: 844 }, bar: { height: 60 }, subject: { share: 0.2, top: 900 } }, 390)
  assert.equal(phone.rack.pass, null)
  assert.equal(phone.bar.pass, false)
  assert.equal(phone.subject.pass, false)
  assert.equal(judge({ ...m, rack: { widths: [380, 460] } }, 1440).rack.pass, false)
  assert.equal(slug('#/chat/chat'), 'chat-chat')
  assert.equal(slug('#/'), 'home')
})
