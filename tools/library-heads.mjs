// library-heads: puts the suite on the head of every library it consumes,
// for the scheduled CI job that catches a library change before it is
// vendored (design 6.2 item 7.3). The pinned tarballs in tools/vendor stay
// what npm ci installs; this lays fresh packs over them in node_modules and
// leaves package.json and the lockfile alone.
//   node tools/library-heads.mjs [--root <dir>] [--out <dir>] [--no-ci] [--offline]
// --root holds the checkouts hackbuild-ui, hackbuild-browser-ai,
// hackbuild-motion and hackbuild-agents (default: the suite's parent).
// Each is built (npm ci first unless --no-ci) and every package the suite
// depends on is packed into --out (default .local/heads), then installed
// with npm install --no-save. --offline keeps that install off the network.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt }
const root = resolve(arg('--root', '..'))
const out = resolve(arg('--out', '.local/heads'))
const ci = !process.argv.includes('--no-ci')
const NPM = ['-y', 'npm@11.21.0']
const UI = 'hackbuild-ui'
const LIBS = ['hackbuild-browser-ai', 'hackbuild-motion', 'hackbuild-agents']

const run = (cwd, args) => {
  console.log(`library-heads: ${cwd.replace(root + '/', '')}: npm ${args.join(' ')}`)
  const r = spawnSync('npx', [...NPM, ...args], { cwd, stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`npm ${args.join(' ')} failed in ${cwd} with ${r.status}`)
}
const head = (cwd) => spawnSync('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()

const suite = JSON.parse(readFileSync('package.json', 'utf8'))
const wanted = Object.keys(suite.dependencies).filter((n) => n.startsWith('@hackbuild/'))
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

// which library holds each package the suite uses
const owner = new Map()
for (const lib of LIBS) {
  const dir = join(root, lib)
  if (!existsSync(join(dir, 'package.json'))) throw new Error(`no checkout at ${dir}`)
  for (const p of readdirSync(join(dir, 'packages'))) {
    const f = join(dir, 'packages', p, 'package.json')
    if (existsSync(f)) owner.set(JSON.parse(readFileSync(f, 'utf8')).name, lib)
  }
}
const missing = wanted.filter((n) => !owner.has(n))
if (missing.length) throw new Error(`no library holds ${missing.join(', ')}`)

const heads = {}
for (const repo of [UI, ...LIBS]) {
  const dir = join(root, repo)
  if (!existsSync(join(dir, 'package.json'))) throw new Error(`no checkout at ${dir}`)
  heads[repo] = head(dir)
  if (ci) run(dir, ['ci'])
  run(dir, ['run', 'build'])
  if (repo === UI) run(dir, ['pack', '--pack-destination', out])
  else {
    const mine = wanted.filter((n) => owner.get(n) === repo)
    run(dir, ['pack', ...mine.flatMap((n) => ['-w', n]), '--pack-destination', out])
  }
}

const tarballs = readdirSync(out).filter((f) => f.endsWith('.tgz')).map((f) => join(out, f))
if (tarballs.length !== wanted.length + 1) throw new Error(`packed ${tarballs.length} tarballs, expected ${wanted.length + 1}`)
run(process.cwd(), ['install', '--no-save', ...(process.argv.includes('--offline') ? ['--offline'] : []), ...tarballs])
console.log(`library-heads: ${tarballs.length} packages installed from ${Object.entries(heads).map(([r, h]) => `${r} ${h}`).join(', ')}`)
