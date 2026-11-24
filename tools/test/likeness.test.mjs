// The likeness check on throwaway git repos: a clean repo passes; a planted
// owner file, a file in a local assets folder, a staged heavy model, a
// tracked line naming a likeness file and a dist that names one each fail.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const script = join(import.meta.dirname, '..', 'check-likeness.mjs')
const TEMPS = []
after(() => { for (const d of TEMPS) rmSync(d, { recursive: true, force: true }) })
// the names are built from parts, as in the script
const BODY = ['moheeb', 'glb'].join('.')
const CLIP = ['voice', 'wav'].join('.')
const FOLDER = ['assets', 'local'].join('-')

function repo(files = {}) {
  const d = mkdtempSync(join(tmpdir(), 'likeness-'))
  TEMPS.push(d)
  const g = (...a) => execFileSync('git', a, { cwd: d, stdio: 'pipe' })
  g('init', '-q')
  g('config', 'user.email', 'test@example.com')
  g('config', 'user.name', 'test')
  g('config', 'core.hooksPath', '/dev/null')
  writeFileSync(join(d, 'readme.txt'), 'a clean repo\n')
  writeFileSync(join(d, 'small.glb'), Buffer.alloc(2048))
  g('add', '.')
  g('commit', '-q', '-m', 'start')
  for (const [p, data] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true })
    writeFileSync(join(d, p), data)
  }
  return { d, g }
}
const run = (d, ...a) => spawnSync(process.execPath, [script, '--root', d, ...a], { encoding: 'utf8' })

test('a clean repo with a small fixture passes', () => {
  const { d } = repo()
  const r = run(d)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /check-likeness: ok/)
})

test('an untracked owner file does not fail; staged, it does', () => {
  const { d, g } = repo({ [`models/${BODY}`]: Buffer.alloc(100) })
  assert.equal(run(d).status, 0)
  g('add', '.')
  const r = run(d)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /owner likeness file is tracked or staged/)
})

test('a committed voice clip fails', () => {
  const { d, g } = repo({ [CLIP]: Buffer.alloc(100) })
  g('add', '.')
  g('commit', '-q', '-m', 'plant')
  assert.match(run(d).stderr, new RegExp(CLIP.replace('.', '\\.')))
})

test('a file in a local assets folder fails', () => {
  const { d, g } = repo({ [`${FOLDER}/notes.txt`]: 'x' })
  g('add', '.')
  assert.match(run(d).stderr, /local assets folder/)
})

test('a staged model above fixture size fails', () => {
  const { d, g } = repo({ 'public/body.vrm': Buffer.alloc(200 * 1024) })
  g('add', '.')
  const r = run(d)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /body\.vrm: a model or audio file of 204800 bytes/)
})

test('tracked text naming a likeness file fails', () => {
  const { d, g } = repo({ 'src/load.ts': `fetch('/${BODY}')\n` })
  g('add', '.')
  assert.match(run(d).stderr, /src\/load\.ts: names a likeness file/)
})

test('a dist that names a likeness file fails, and --no-dist skips it', () => {
  const { d } = repo({ 'dist/index.html': `<script>load("${CLIP}")</script>` })
  const r = run(d)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /dist\/index\.html: the build names/)
  assert.equal(run(d, '--no-dist').status, 0)
})
