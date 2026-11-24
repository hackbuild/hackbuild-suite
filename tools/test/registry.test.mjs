import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The registry is TypeScript; read it as text so this test needs no build.
const src = readFileSync(new URL('../../src/tools/registry.ts', import.meta.url), 'utf8')
const define = readFileSync(new URL('../../src/tools/define.ts', import.meta.url), 'utf8')

test('seven groups, in the design order', () => {
  const groups = [...define.matchAll(/\{ id: '([a-z]+)', title: '[a-z]+' \}/g)].map((m) => m[1])
  assert.deepEqual(groups, ['chat', 'voice', 'image', 'character', 'rooms', 'motion', 'agents'])
})

test('22 tools with unique ids', () => {
  const single = [...src.matchAll(/defineTool\(\{ id: '([a-z-]+)'/g)].map((m) => m[1])
  const listed = [...src.matchAll(/\.\.\.\[([^\]]+)\]\.map/g)].flatMap((m) => [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]))
  const ids = [...single, ...listed]
  assert.equal(ids.length, 22)
  assert.equal(new Set(ids).size, 22)
})

test('no tool imports another tool or loads at import time', () => {
  assert.doesNotMatch(src, /^import .*\/tools\/(?!define)/m)
  assert.doesNotMatch(src, /^await /m)
})
