import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seededRng } from '@hackbuild/drives'
import { scripted } from '@hackbuild/chat'
import { seededLayout } from '../../src/agents/props.ts'
import { ROOM_THINGS, World } from '../../src/room/world.ts'
import { Mind, eventLine, roomReflex, roomScripted } from '../../src/room/brain.ts'
import { checkRoom, exportName, logCsv, newRoomBody } from '../../src/room/kind.ts'
import { BODY_ACCEPT, isBodyFile, isMmdFile } from '../../src/stagekit/body.ts'

const make = (seed = 7) => {
  const rng = seededRng(seed)
  const lines = []
  const world = new World(seededLayout(rng, ROOM_THINGS), rng, {
    log: (kind, text, live) => { if (live) return live.id; lines.push(`${kind} ${text}`); return lines.length },
    said: (t) => lines.push(`me ${t}`),
  })
  return { world, lines }
}
// runs the world clock until the act ends
async function settle(world, p) {
  let done = false
  p.finally(() => { done = true })
  for (let i = 0; i < 2000 && !done; i++) {
    world.tick(0.05)
    await Promise.resolve()
  }
  return p
}

test('reflex rules map the order chips to body steps', () => {
  const { world } = make()
  const r = roomReflex(world)
  assert.deepEqual(r.parse('mug to the shelf').steps.map((s) => s.tool), ['walk_to', 'pick_up', 'walk_to', 'put_on'])
  assert.deepEqual(r.parse('come here').steps, [{ tool: 'walk_to', args: ['you'] }])
  assert.deepEqual(r.parse('bring me the box').steps.map((s) => `${s.tool} ${s.args.join(' ')}`), ['walk_to box', 'pick_up box', 'walk_to you'])
  assert.equal(r.parse('sing a song'), null)
})

test('the body api fails in first person and carries what it lifts', async () => {
  const { world } = make()
  const mug = world.thing('mug')
  assert.throws(() => world.pickUp('mug'), /m away\. i walk closer first/)
  assert.throws(() => world.pickUp('shelf'), /too big to lift/)
  const ac = new AbortController()
  await settle(world, world.walkTo('mug', ac.signal))
  assert.match(world.pickUp('mug'), /right hand/)
  assert.equal(mug.held, 'right')
  await settle(world, world.walkTo('shelf', ac.signal))
  assert.match(world.putOn('mug', 'shelf'), /on the shelf/)
  assert.equal(mug.on, 'shelf')
  assert.equal(world.heldThing(), null)
})

test('the scripted planner answers from the body state', () => {
  const { world } = make()
  const p = roomScripted(world, () => ['shelf (ahead, 1.2 m)'])
  assert.match(JSON.parse(p({ text: 'what do you see?' })).say, /shelf \(ahead/)
  assert.match(JSON.parse(p({ text: 'where is the mug' })).say, /the mug is on the floor/)
  assert.equal(p({ text: 'mug to the shelf' }), null)
})

test('the chain steps down: a failing brain, then reflexes, each drop named', async () => {
  const { world, lines } = make()
  const failing = scripted({ replies: () => { throw new Error('out of gpu memory') } })
  const mind = new Mind({ world, persona: () => 'test', model: () => failing, loading: () => false, seen: () => [], log: (k, t) => lines.push(`${k} ${t}`) })
  const turn = mind.turn('come here')
  for (let i = 0; i < 400; i++) { world.tick(0.05); await new Promise((r) => setTimeout(r, 0)) }
  const r = await turn
  assert.equal(r.tier, 'reflex')
  assert.ok(lines.some((l) => /note the brain failed: out of gpu memory\. the scripted planner took over\./.test(l)), lines.join('\n'))
  assert.ok(lines.some((l) => /reflexes took over/.test(l)))
  assert.ok(lines.some((l) => /walking to you, /.test(l)))
  assert.equal(mind.cost.reflex, 1)
  // a question goes to the scripted planner when there is no brain
  const quiet = new Mind({ world, persona: () => '', model: () => null, loading: () => true, seen: () => [], log: (k, t) => lines.push(`${k} ${t}`) })
  const q = await quiet.turn('what are you holding')
  assert.equal(q.tier, 'scripted')
  assert.ok(lines.some((l) => /the brain is still loading\. the scripted planner took over\./.test(l)))
})

test('who decides: reflexes first skips the model, with hints puts the reflex step in the prompt', async () => {
  const { world, lines } = make()
  let calls = 0
  let seen = ''
  const model = scripted({ replies: (req) => { calls++; seen = req.messages.at(-1).content; return '{"think":"ok","say":"","do":[["walk_to","you"]],"done":true}' } })
  const base = { world, persona: () => 'test', model: () => model, loading: () => false, seen: () => [], log: (k, t) => lines.push(`${k} ${t}`) }
  const first = new Mind({ ...base, decide: () => 'reflexes first' })
  const run = first.turn('come here')
  for (let i = 0; i < 400; i++) { world.tick(0.05); await new Promise((r) => setTimeout(r, 0)) }
  assert.equal((await run).tier, 'reflex')
  assert.equal(calls, 0)
  world.stop()
  const hints = new Mind({ ...base, decide: () => 'with hints', params: () => ({ steps: 3, hits: 0, tokens: 100, temperature: 0 }), extra: () => 'always polite.' })
  assert.match(hints.system(), /always polite\./)
  const t2 = hints.turn('come here')
  for (let i = 0; i < 400; i++) { world.tick(0.05); await new Promise((r) => setTimeout(r, 0)) }
  assert.equal((await t2).tier, 'model')
  assert.match(seen, /hint: the reflexes would do walk_to you/)
})

test('an injected event reaches the reflexes as something happened', () => {
  const { world } = make()
  const r = roomReflex(world).parse(eventLine('a ball rolls in.'))
  assert.deepEqual(r.steps.map((s) => s.tool), ['say', 'explore'])
})

test('the room document checks its body, and exports carry the seed', () => {
  const b = newRoomBody()
  assert.equal(checkRoom(b), null)
  assert.match(checkRoom({ ...b, seed: 'x' }), /seed/)
  assert.match(checkRoom({ ...b, cast: [{ ...b.cast[0], decide: 'nobody' }] }), /who decides/)
  assert.equal(exportName('Ada Lovelace', 42), 'room-ada-lovelace-seed-42')
  assert.equal(logCsv([{ t: 1.234, agent: 'ada', kind: 'me', text: 'hi, "you"' }]), 't,agent,kind,text\n1.23,ada,me,"hi, ""you"""\n')
})

test('body drops take pmx and pmd beside glb and vrm', () => {
  for (const n of ['a.glb', 'b.VRM', 'c.pmx', 'd.pmd']) assert.ok(isBodyFile({ name: n }), n)
  assert.ok(isMmdFile({ name: 'x.PMX' }))
  assert.ok(!isBodyFile({ name: 'x.fbx.txt' }))
  assert.match(BODY_ACCEPT, /\.pmx,\.pmd/)
})
