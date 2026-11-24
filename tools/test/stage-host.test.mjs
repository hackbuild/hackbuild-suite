import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStageHost } from '../../src/stage/host.ts'

// Fakes for the browser globals the host reads, so the pause rules of
// design 2.9 run under node.
function rig({ reduced = false } = {}) {
  const listeners = {}
  const doc = { hidden: false, addEventListener: (t, f) => (listeners[t] = f), removeEventListener: (t) => delete listeners[t] }
  let ro, io
  class RO { constructor(cb) { ro = cb } observe() {} disconnect() { ro = null } }
  class IO { constructor(cb) { io = cb } observe() {} disconnect() { io = null } }
  const mq = { matches: reduced, addEventListener: (t, f) => (mq.fn = f), removeEventListener: () => (mq.fn = null) }
  const canvasEv = {}
  const canvas = { parentElement: null, addEventListener: (t, f) => (canvasEv[t] = f), removeEventListener: (t) => delete canvasEv[t], remove() { this.removed = true } }
  const host = { appendChild: (c) => (c.parentElement = host) }
  const r = { domElement: canvas, loop: null, sizes: [], ratio: 0, disposed: false, lostForced: false,
    setSize(w, h) { this.sizes.push([w, h]) }, setPixelRatio(x) { this.ratio = x },
    setAnimationLoop(fn) { this.loop = fn }, dispose() { this.disposed = true }, forceContextLoss() { this.lostForced = true } }
  const dts = []
  const env = { document: doc, devicePixelRatio: 3, ResizeObserver: RO, IntersectionObserver: IO, matchMedia: () => mq, now: () => 0 }
  const stage = createStageHost(host, { renderer: r, draw: (dt) => dts.push(dt), env, step: 1 / 60 })
  const size = (w, h) => ro([{ contentRect: { width: w, height: h } }])
  const seen = (on) => io([{ isIntersecting: on }])
  const tick = (ms) => r.loop?.(ms)
  return { stage, r, doc, listeners, size, seen, tick, dts, mq, canvas, canvasEv }
}

test('sizes to the container, caps the pixel ratio at 2', () => {
  const { r, size, canvas } = rig()
  size(320, 200.7)
  assert.deepEqual(r.sizes.at(-1), [320, 200])
  assert.equal(r.ratio, 2)
  assert.ok(canvas.parentElement)
})

test('zero size does not run; a size starts the loop and draws one frame at once', () => {
  const { stage, size, dts } = rig()
  assert.equal(stage.running, false)
  size(320, 180)
  assert.equal(stage.running, true)
  assert.equal(dts.length, 1)
})

test('a hidden page draws 0 frames, and the first delta after resume is one step', () => {
  const { stage, r, doc, listeners, size, tick, dts } = rig()
  size(320, 180)
  tick(1000); tick(1016)
  doc.hidden = true; listeners.visibilitychange()
  assert.equal(stage.running, false)
  assert.equal(r.loop, null)
  const before = stage.frames
  tick(5000)
  assert.equal(stage.frames, before)
  doc.hidden = false; listeners.visibilitychange()
  tick(9000)
  assert.ok(Math.abs(dts.at(-1) - 1 / 60) < 1e-9, `first delta ${dts.at(-1)}`)
})

test('off screen, inactive route and a covering sheet each stop the loop', () => {
  const { stage, size, seen } = rig()
  size(320, 180)
  seen(false); assert.equal(stage.running, false); seen(true); assert.equal(stage.running, true)
  stage.setActive(false); assert.equal(stage.running, false); stage.setActive(true); assert.equal(stage.running, true)
  stage.setCovered(true); assert.equal(stage.running, false); stage.setCovered(false); assert.equal(stage.running, true)
})

test('reduced motion draws on change only', () => {
  const { stage, size, dts } = rig({ reduced: true })
  size(320, 180)
  assert.equal(stage.running, false)
  assert.equal(dts.length, 1)
  stage.invalidate()
  assert.equal(dts.length, 2)
})

test('a lost context stops, a restored one draws again', () => {
  let prevented = false
  const { stage, size, canvasEv } = rig()
  size(320, 180)
  canvasEv.webglcontextlost({ preventDefault: () => (prevented = true) })
  assert.ok(prevented)
  assert.equal(stage.running, false)
  canvasEv.webglcontextrestored()
  assert.equal(stage.running, true)
})

test('dispose stops the loop, disposes the renderer and drops the context', () => {
  const { stage, r, size, canvas } = rig()
  size(320, 180)
  stage.dispose()
  assert.equal(r.loop, null)
  assert.ok(r.disposed && r.lostForced && canvas.removed)
  assert.equal(stage.running, false)
})
