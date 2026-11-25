import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffRows } from '@hackbuild/scenario/browser'
import { BUILT_IN, checkScenarioBody, checkScenarioFile, goldenOf, newScenarioBody, readScenario, scenarioKind } from '../../src/scenario/kind.ts'
import { runFile } from '../../src/scenario/run.ts'

test('scenario documents and files check what they hold', () => {
  assert.equal(checkScenarioBody(newScenarioBody()), null)
  assert.equal(scenarioKind.kind.startsWith(`${scenarioKind.tool}.`), true)
  for (const s of BUILT_IN) assert.equal(checkScenarioFile(s), null)
  assert.match(checkScenarioFile({ ...BUILT_IN[0], sim: 'boat' }), /sim boat is not one of/)
  assert.match(checkScenarioFile({ ...BUILT_IN[0], seed: 1.5 }), /whole number/)
  assert.match(String(readScenario('{')), /not json/)
})

for (const sc of BUILT_IN) {
  test(`${sc.name}: passes, replays, and a new seed differs`, async () => {
    const a = await runFile(sc, sc.seed, null, { date: '2026-11-24', browser: 'node' })
    console.log(a.text)
    assert.equal(a.pass, true, a.text)
    const b = await runFile(sc, sc.seed, goldenOf(a.trace, sc.seed), { date: '2026-11-24', browser: 'node' })
    assert.equal(b.hash, a.hash)
    assert.equal(b.diff, 'traces match')
    assert.equal(b.pass, true)
    const c = await runFile(sc, sc.seed + 1, goldenOf(a.trace, sc.seed), { date: '2026-11-24', browser: 'node' })
    assert.equal(c.pass, false)
    assert.ok(diffRows(c.trace, a.trace).differing > 0)
    assert.match(c.diff, /^trace differs at row \d+: /)
    console.log(sc.name, a.hash, c.diff)
  })
}
