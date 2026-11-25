import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BONES, IN, QuadrupedHost, UPSTREAM } from '@hackbuild/motion-net'
import { StubNetwork, stubStyles } from '../../src/motionnet/stub.ts'
import { WEIGHTS_MB, checkNet, netKind, newNetBody, sourceOf, weightsLine } from '../../src/motionnet/kind.ts'

const tick = () => new Promise((r) => setImmediate(r))

async function run(speed, turnRate, frames = 600) {
  const host = new QuadrupedHost(new StubNetwork(), stubStyles())
  let mid = null
  for (let i = 0; i < frames; i++) {
    host.update(1 / 60, { speed, turnRate })
    await tick()
    if (i === frames / 2 - 1) mid = { ...host.root }
  }
  return { host, mid, secs: frames / 120 }
}

test('motion-net documents check what they hold', () => {
  assert.equal(checkNet(newNetBody()), null)
  assert.match(checkNet({ ...newNetBody(), style: 'Gallop' }), /gallop is not auto/i)
  assert.match(checkNet({ ...newNetBody(), show: 'split' }), /split is not network/)
  assert.match(checkNet({ ...newNetBody(), bake: 40 }), /bake is seconds/)
  assert.equal(netKind.kind.startsWith(`${netKind.tool}.`), true)
})

test('the weights row names the size and the source', () => {
  assert.equal(WEIGHTS_MB, 17.7)
  assert.match(sourceOf(UPSTREAM.bin), /^raw\.githubusercontent\.com, \w+\/[\w-]+$/)
  assert.match(weightsLine({ state: 'none' }), /when you press load, 17\.7 mb/)
  assert.match(weightsLine({ state: 'loading', loaded: 4e6 }), /^weights, 4\.0 of 17\.7 mb\. the procedural gait runs meanwhile\.$/)
  assert.match(weightsLine({ state: 'failed', error: 'http 404' }), /http 404\. the procedural gait is running/)
})

test('the stub network is deterministic', async () => {
  const a = new StubNetwork()
  const b = new StubNetwork()
  const input = new Float32Array(IN.length)
  for (let k = 0; k < 16; k++) input[IN.trajVelocities + k * 2 + 1] = 1
  for (let i = 0; i < 3; i++) assert.deepEqual((await a.predict(input)).frames, (await b.predict(input)).frames)
  await assert.rejects(a.predict(new Float32Array(3)), /takes 339 values/)
})

test('the host on the stub meets the command and keeps the left paws on the left', async () => {
  for (const v of [0.6, 1.2, 2]) {
    const { host, mid, secs } = await run(v, 0)
    const got = Math.hypot(host.root.x - mid.x, host.root.z - mid.z) / secs
    assert.ok(Math.abs(got - v) / v < 0.05, `speed ${v} gave ${got}`)
    const lh = BONES.indexOf('LeftHandSite')
    assert.ok(host.positions[lh * 3] > 0, 'left paw at +x while facing +z')
  }
  const { host, mid, secs } = await run(1, 1)
  const rate = (host.root.yaw - mid.yaw) / secs
  assert.ok(Math.abs(rate - 1) < 0.1, `turn rate 1 gave ${rate}`)
  const still = await run(0, 0, 180)
  assert.ok(Math.hypot(still.host.root.x, still.host.root.z) < 0.05)
})
