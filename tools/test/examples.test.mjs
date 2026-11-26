// The examples' install lines match their imports, and an example imports
// only published packages (tools/example-packages.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, importsOf } from '../example-packages.mjs'

test('imports are read as packages, relative imports apart', () => {
  const got = importsOf(`import { a } from "@hackbuild/chat";\nimport type { B } from "@hackbuild/ai-views/elements";\nimport * as T from "three";\nimport x from "./x.js";\nconst m = await import("@hackbuild/vision");\nimport "left-pad";`)
  assert.deepEqual(got.packages, ['@hackbuild/chat', '@hackbuild/ai-views', 'three', '@hackbuild/vision', 'left-pad'])
  assert.deepEqual(got.relative, ['./x.js'])
  assert.deepEqual(got.disallowed, ['left-pad'])
})

test('every example lists exactly the packages it imports, and nothing else', () => {
  const { problems } = check()
  assert.deepEqual(problems, [])
})

test('a model example loads for real unless the gate passes stand ins', async () => {
  const { readFileSync } = await import('node:fs')
  const index = JSON.parse(readFileSync('examples/index.json', 'utf8'))
  for (const e of index.examples.filter((x) => x.model)) {
    const src = readFileSync(`examples/${e.job}/${e.id}/example.ts`, 'utf8')
    assert.ok(!/FIXTURE_ENV|stubLoader|scripted\(/.test(src), `${e.job}/${e.id} carries a stand in of its own`)
    assert.ok(/hooks\.loaderFor/.test(src) && /jobLoader\(/.test(src), `${e.job}/${e.id} does not load through jobLoader with the hooks as the only way in for stand ins`)
    assert.ok(/probe\(/.test(src) || /hooks\.env/.test(src), `${e.job}/${e.id} does not probe this machine`)
    assert.ok(src.includes('sample, no model loaded'), `${e.job}/${e.id} does not label its sample`)
  }
})
