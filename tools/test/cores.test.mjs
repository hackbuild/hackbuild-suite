import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { core, coreState, provide, onCore, resetCores, CORES } from '../../src/cores.ts'

beforeEach(() => resetCores())

test('every core starts on a stub that loads nothing', async () => {
  for (const name of Object.keys(CORES)) {
    const c = await core(name)
    assert.deepEqual(c, { stub: true, name, package: CORES[name] })
    assert.equal(coreState(name), 'ready')
  }
})

test('two callers share one promise and one instance', async () => {
  let made = 0
  provide('dsp', async () => ({ id: ++made }))
  const [a, b] = await Promise.all([core('dsp'), core('dsp')])
  assert.equal(a, b)
  assert.equal(made, 1)
  assert.throws(() => provide('dsp', async () => ({})), /already loading/)
})

test('nothing loads until asked', () => {
  let made = 0
  provide('memory', async () => ({ id: ++made }))
  assert.equal(made, 0)
  assert.equal(coreState('memory'), 'idle')
})

test('a failed load is forgotten so a retry starts again', async () => {
  let tries = 0
  const seen = []
  onCore((e) => seen.push(e.state))
  provide('character', async () => { if (++tries === 1) throw new Error('no wasm here'); return { ok: true } })
  await assert.rejects(core('character'), /no wasm here/)
  assert.equal(coreState('character'), 'failed')
  assert.deepEqual(await core('character'), { ok: true })
  assert.deepEqual(seen, ['loading', 'failed', 'loading', 'ready'])
})

test('an unknown name is refused', async () => {
  await assert.rejects(core('nope'), /no core named nope/)
})
