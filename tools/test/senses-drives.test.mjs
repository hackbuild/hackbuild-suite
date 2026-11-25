import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seededRng } from '@hackbuild/drives'
import { seededLayout, fnv, hex8 } from '../../src/agents/props.ts'
import { bearingDeg, bearingWords, checkSenses, depthFeed, feedText, inViewLine, newSensesBody, seenEarlierLine, sensesKind, SENSE_THINGS, FAR } from '../../src/senses/kind.ts'
import { SenseCore, coneTest, ready as sensesReady } from '../../src/senses/core.ts'
import { DriveSim, eventOf, runCsv, runSteps, ready as drivesReady } from '../../src/drives/sim.ts'
import { checkDrives, drivesKind, newDrivesBody } from '../../src/drives/kind.ts'

test('senses documents check what they hold', () => {
  assert.equal(checkSenses(newSensesBody()), null)
  assert.match(checkSenses({ ...newSensesBody(), things: [{ label: 'sofa', x: 0, z: 0 }] }), /sofa is not one of/)
  assert.match(checkSenses({ ...newSensesBody(), fov: 20 }), /field of view/)
  assert.match(checkSenses({ ...newSensesBody(), feed: 'pixels' }), /feed pixels/)
  assert.equal(sensesKind.kind.startsWith(`${sensesKind.tool}.`), true)
  assert.equal(checkDrives(newDrivesBody()), null)
  assert.match(checkDrives({ ...newDrivesBody(), startHour: 30 }), /start hour/)
  assert.equal(drivesKind.kind.startsWith(`${drivesKind.tool}.`), true)
})

test('bearings read as the room original says them', () => {
  assert.equal(bearingWords(5), 'ahead')
  assert.equal(bearingWords(36.2), '36 deg right')
  assert.equal(bearingWords(-40), '40 deg left')
  // facing +z, the agent's right is -x
  assert.ok(Math.abs(bearingDeg(-1, 1, 0) - 45) < 1e-9)
  assert.equal(inViewLine('shelf', 36, 0.34), 'shelf (36 deg right, 0.3 m)')
  assert.equal(seenEarlierLine('mug', 'shelf', 12.2, 0.9), 'mug (last seen near the shelf, 12 s ago, confidence 0.90)')
})

test('the depth feed skips the floor and finds the nearest wall per zone', () => {
  const w = 24, h = 10
  const depth = new Float32Array(w * h).fill(FAR)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 8; c++) depth[r * w + c] = 2
  const f = depthFeed(depth, w, h, 74)
  assert.equal(f.left, 2)
  assert.equal(f.ahead, FAR)
  assert.equal(f.grid.length, 5)
  assert.equal(f.grid[0].length, 8)
  const t = feedText('clearances and an 8 by 5 grid', f, ['shelf (ahead, 1.0 m)'])
  assert.match(t.text, /CLEAR: left 2\.0 m/)
  assert.equal(t.tokens, Math.ceil(t.text.length / 4))
})

function senseRun(seed) {
  const rng = seededRng(seed)
  const core = new SenseCore(rng, seededLayout(rng, SENSE_THINGS))
  for (let k = 0; k < 400; k++) {
    const t = k / 20
    // a turn on the spot, then a walk: no atan2 anywhere in the run
    const a = { x: k > 200 ? (k - 200) * 0.01 : 0, z: 0, yaw: k * 0.02 }
    if (k % 5 === 0) core.sense(t, a, coneTest(a, 0.9), null, 4)
    core.smell(0.05, t, a)
  }
  const out = { hash: core.hashHex, events: core.events.length, kinds: new Set(core.events.map((e) => e.kind)), earlier: core.seenEarlier(20) }
  core.dispose()
  return out
}

test('a seeded senses run gives the same trace hash twice', async () => {
  await sensesReady()
  const a = senseRun(7)
  const b = senseRun(7)
  assert.equal(a.hash, b.hash)
  assert.ok(a.kinds.has('see') && a.kinds.has('lost'), [...a.kinds].join(','))
  assert.ok(a.earlier.length > 0)
  assert.notEqual(senseRun(8).hash, a.hash)
})

test('a seeded drives run gives the same trace hash twice, and events steer it', async () => {
  await drivesReady()
  const opts = { startHour: 8, temperature: 0.06, commitment: 0.12 }
  const run = (seed, events = []) => { const s = new DriveSim(seededRng(seed), opts); const h = runSteps(s, 3000, events); const r = { h, rows: s.rows, goals: s.goals.slice() }; s.dispose(); return r }
  const a = run(7)
  const b = run(7)
  assert.equal(a.h, b.h)
  // the wasm core and the hash are the same in chrome: smoke-drives checks this value
  const g = new DriveSim(seededRng(7), opts)
  assert.equal(runSteps(g, 1500), '50663d28')
  g.dispose()
  assert.notEqual(run(8).h, a.h)
  const acts = new Set(a.rows.map((r) => r.act))
  assert.ok(acts.size >= 3, [...acts].join(','))
  const ev = [{ step: 100, text: 'food arrives' }]
  const c = run(7, ev)
  assert.equal(c.h, run(7, ev).h)
  assert.notEqual(c.h, a.h)
  assert.equal(c.goals[0].id, 'eat')
  const csv = runCsv(a.rows.slice(0, 3)).trim().split('\n')
  assert.equal(csv[0], 't,hour,hunger,rest,play,social,act,reason,probability,switched,sleep,pressure,why')
  assert.equal(csv.length, 4)
  assert.equal(eventOf('someone knocks at the door'), 'a visitor')
  assert.equal(eventOf('it is sunny'), null)
  assert.equal(hex8(fnv('a')), 'e40c292c')
})
