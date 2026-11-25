import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeWav } from '@hackbuild/audio-dsp'
import { createKinds } from '../../src/workspace/kinds.ts'
import { checkLipsync, defaultMap, keysOf, lipsyncKind, morphWeights, newLipsyncBody, trackJson } from '../../src/lipsync/kind.ts'
import { fromSamples, fromText, voiced } from '../../src/lipsync/track.ts'
import { checkIk, ikKind, newIkBody, poseFile, reachLine } from '../../src/ik/kind.ts'
import { testWav } from '../test-wav.mjs'

test('the map starts from the body: oculus visemes, vowels, then the arkit jaw', () => {
  assert.equal(defaultMap(['viseme_aa', 'viseme_PP']).PP.morph, 'viseme_PP')
  const vrm = defaultMap(['Fcl_MTH_A', 'Fcl_MTH_I', 'Fcl_MTH_U', 'Fcl_MTH_E', 'Fcl_MTH_O'])
  assert.equal(vrm.aa.morph, 'Fcl_MTH_A')
  assert.equal(vrm.O.morph, 'Fcl_MTH_O')
  assert.equal(vrm.PP.morph, '')
  const arkit = defaultMap(['jawOpen', 'mouthClose'])
  assert.equal(arkit.aa.morph, 'jawOpen')
  assert.equal(arkit.PP.morph, 'mouthClose')
  assert.equal(defaultMap([]).aa.morph, '')
})

test('morph weights sum per shape and stay within 0 and 1', () => {
  const map = defaultMap(['aa', 'ih'])
  const f = new Float32Array(15)
  f[10] = 1 // aa
  f[7] = 1 // SS, half onto ih
  const w = morphWeights(map, f, 1.5)
  assert.equal(w.get('aa'), 1)
  assert.equal(w.get('ih'), 0.75)
})

test('a line and a recording both make tracks with visemes', () => {
  const t = fromText('peter piper picked a peck')
  assert.ok(voiced(t) > 0.5)
  assert.ok(keysOf(t).some((k) => k.viseme === 'PP'))
  const d = decodeWav(testWav())
  const a = fromSamples(d.channels[0], d.sampleRate, { name: 'test', kind: 'audio' })
  assert.equal(a.sources.length, 480)
  assert.ok(voiced(a) > 0.4)
  const j = trackJson(a)
  assert.equal(j.frames.length, 480)
  assert.equal(j.visemes.length, 15)
})

test('the lipsync and ik documents check their bodies', () => {
  assert.equal(checkLipsync(newLipsyncBody()), null)
  assert.match(checkLipsync({ ...newLipsyncBody(), edits: { XX: { morph: 'a', gain: 1 } } }), /not a viseme/)
  assert.equal(checkIk(newIkBody()), null)
  assert.match(checkIk({ ...newIkBody(), solver: 'jacobian' }), /solver/)
  const kinds = createKinds()
  assert.doesNotThrow(() => kinds.register(lipsyncKind))
  assert.doesNotThrow(() => kinds.register(ikKind))
})

test('the pose file rounds and the reach copy reads the overshoot', () => {
  const p = poseFile('mannequin', { hips: [0, 0, 0, 1] }, [0, 0.95, 0], { leftHand: [0.1234567, 1, 0] })
  assert.equal(p.format, 'hackbuild.pose')
  assert.deepEqual(p.targets.leftHand, [0.12346, 1, 0])
  assert.equal(reachLine(0.001), null)
  assert.equal(reachLine(0.12), 'the target is out of reach by 0.12 m. the chain is fully extended.')
})
