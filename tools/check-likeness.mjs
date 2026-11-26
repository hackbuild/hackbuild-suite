#!/usr/bin/env node
// The likeness check (design section 5 item 5). Fails when the git index of
// the repo (every tracked and staged file) holds an owner likeness file or
// a model or audio file above fixture size, when a tracked text file or the
// built dist names a likeness file, or when a path sits in a local assets
// folder. The dist may name the dog site's three plain owner files by their
// whole path, and nothing else of a likeness. Twin mode loads a body and a
// voice only from files the person drops; nothing of a likeness enters a repo.
//   node tools/check-likeness.mjs [--root <dir>] [--no-dist]
// The names are built from parts so this file does not name them itself.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined }
const root = resolve(arg('root') ?? '.')
const withDist = !process.argv.includes('--no-dist')

/** The two owner files and the folder they live in. */
const NAMES = [['moheeb', 'glb'], ['voice', 'wav']].map((p) => p.join('.'))
const FOLDER = ['assets', 'local'].join('-')
/** Fixture size: a generated stand in stays under this (computed: 64 kb). */
const FIXTURE_MAX = 64 * 1024
const HEAVY = /\.(glb|vrm|fbx|gltf|wav|mp3|ogg|flac|m4a|aac|opus|onnx|safetensors|gguf|bin|pt|pth|ckpt|tflite)$/i
const OWNER = new RegExp(`(^|/)${NAMES[0].split('.')[0]}[^/]*\\.(glb|vrm|fbx|gltf|wav|mp3|png|jpe?g)$`, 'i')

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const problems = []

// the index: tracked files and staged additions, with their staged sizes
const index = git('ls-files', '-s', '-z').split('\0').filter(Boolean).map((l) => {
  const [meta, path] = l.split('\t')
  return { path, blob: meta.split(' ')[1] }
})
const sizes = new Map()
const heavy = index.filter((f) => HEAVY.test(f.path))
if (heavy.length) {
  const out = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objectsize)'], { cwd: root, input: heavy.map((f) => f.blob).join('\n') + '\n', encoding: 'utf8' })
  for (const line of out.trim().split('\n')) {
    const [h, s] = line.split(' ')
    sizes.set(h, Number(s))
  }
}
for (const f of index) {
  const lower = f.path.toLowerCase()
  const base = lower.split('/').pop()
  if (NAMES.includes(base) || OWNER.test(lower)) problems.push(`${f.path}: an owner likeness file is tracked or staged`)
  else if (lower.split('/').includes(FOLDER)) problems.push(`${f.path}: a file from a local assets folder is tracked or staged`)
  else if (HEAVY.test(lower) && (sizes.get(f.blob) ?? 0) > FIXTURE_MAX) problems.push(`${f.path}: a model or audio file of ${sizes.get(f.blob)} bytes is tracked or staged; fixtures stay under ${FIXTURE_MAX} bytes`)
}

// tracked text and the built dist name no likeness file, except the three owner files the dog site serves as
// plain files (its dog, human and voice clip, the owner's own, shipped by the owner's decision of
// 2026-11-25), which the yard fetches by their whole path on that site
const SITE_FILES = ['dog.glb', 'human.glb', NAMES[1]].map((f) => `dog-simulator/assets/${f}`)
const stripSite = (t) => SITE_FILES.reduce((x, f) => x.split(f).join(''), t)
// tracked text that names a likeness file or the local assets folder
const self = new Set(['tools/check-likeness.mjs', 'tools/test/likeness.test.mjs', '.gitignore'])
const needles = [...NAMES, `${FOLDER}/`]
let hits = ''
try {
  hits = git('grep', '-I', '-i', '-l', '-F', ...needles.flatMap((n) => ['-e', n]), '--cached')
} catch (e) {
  if (e.status !== 1) throw e
}
for (const p of hits.split('\n').filter(Boolean)) {
  if (self.has(p)) continue
  const t = stripSite(git('show', `:${p}`).toLowerCase())
  if (needles.some((n) => t.includes(n.toLowerCase()))) problems.push(`${p}: names a likeness file or the local assets folder`)
}

// the built dist must not name the two files, except the dog site's plain files (SITE_FILES)
const dist = join(root, 'dist')
if (withDist && existsSync(dist)) {
  const walk = (d) => readdirSync(d).flatMap((n) => {
    const p = join(d, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
  for (const p of walk(dist)) {
    const text = stripSite(readFileSync(p, 'latin1').toLowerCase())
    for (const n of NAMES) if (text.includes(n)) problems.push(`${p.slice(root.length + 1)}: the build names ${n}`)
  }
}

if (problems.length) {
  console.error(`check-likeness: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n${problems.map((p) => `  ${p}`).join('\n')}`)
  process.exit(1)
}
console.log(`check-likeness: ok. ${index.length} indexed files, ${heavy.length} model or audio files under ${FIXTURE_MAX} bytes, no likeness name in tracked text${withDist && existsSync(dist) ? ' or dist' : ''} (measured)`)
