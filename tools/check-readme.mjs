// check-readme: the suite's README and docs/BUILDING.md follow the README
// template the libraries use (rebuild plan 7), shaped for an app:
//   template  H1 is the repository name, then one line, then a badge line,
//             then these H2 sections in this order and no others.
//   explorers the explorers table matches src/shell/explorers.ts (written by
//             node tools/llms.mjs).
//   examples  every job in examples/index.json has a row in the examples table.
//   text      no "not on npm" text, no internal design ids, no internal words
//             in prose (organ, tier, provider, rung, phase).
//   numbers   a size, a time or a share in prose carries measured, computed,
//             vendor, inferred or unknown; tables and code are left alone.
//   links     every relative link resolves to a file in the repository.
//   building  docs/BUILDING.md exists with its sections.
// Usage: node tools/check-readme.mjs
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { explorerRows } from './explorer-rows.mjs'

const SECTIONS = ['What it does', 'Use it', 'Explorers', 'Examples', 'Privacy', 'Browser support', 'Works with', 'What is verified', 'Changelog and licences']
const BUILDING = ['The layers', 'The six layouts', 'Add an explorer', 'Add an example', 'The gates', 'Builds']
const fails = []
const fail = (f, m) => fails.push(`${f}: ${m}`)

function prose(md) {
  // drop fenced code, tables, inline code and link targets
  return md.replace(/```[\s\S]*?```/g, '').split('\n').filter((l) => !l.startsWith('|') && !l.startsWith('<!--')).join('\n').replace(/`[^`]*`/g, '').replace(/\]\([^)]*\)/g, ']').replace(/<https?:[^>]*>/g, '')
}
function common(file, md, sections) {
  const h2 = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim())
  if (h2.join('|') !== sections.join('|')) fail(file, `sections are "${h2.join(', ')}", want "${sections.join(', ')}"`)
  const p = prose(md)
  if (/not on npm/i.test(p)) fail(file, 'says "not on npm"')
  const id = p.match(/\b[A-Z]{1,6}-[A-Z]+-\d+\b|\bitem \d+(\.\d+)?\b/)
  if (id) fail(file, `internal design id "${id[0]}"`)
  const word = p.match(/\b(organ|tier|provider|rung|phase)s?\b/i)
  if (word) fail(file, `internal word "${word[0]}"`)
  for (const m of p.matchAll(/\b\d+(\.\d+)?\s?(kb|mb|gb|ms|s|px|%|percent|fps|bytes?)\b[^.\n]*/gi))
    if (!/\b(measured|computed|vendor|inferred|unknown)\b/.test(m[0])) fail(file, `number without a label: "${m[0].slice(0, 60)}"`)
  for (const m of md.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
    const t = m[1]
    if (/^[a-z]+:/i.test(t)) continue
    if (!existsSync(join(dirname(file), t))) fail(file, `link to ${t} does not resolve`)
  }
}

const readme = readFileSync('README.md', 'utf8')
const lines = readme.split('\n')
if (lines[0] !== '# hackbuild-suite') fail('README.md', 'H1 is not "# hackbuild-suite"')
if (!lines[2]?.trim() || lines[2].startsWith('#')) fail('README.md', 'no one line under the H1')
if (!/img\.shields\.io/.test(lines[4] ?? '')) fail('README.md', 'no badge line under the one line')
common('README.md', readme, SECTIONS)
for (const e of explorerRows()) if (!readme.includes(`| ${e.title} | ${e.line} | \`${e.live}\` | [${e.source}](${e.source}) |`)) fail('README.md', `explorer ${e.id} is missing or stale in the table. run node tools/llms.mjs`)
const jobs = JSON.parse(readFileSync('examples/index.json', 'utf8')).jobs
for (const j of jobs) if (!new RegExp(`^\\| ${j.id} \\|`, 'm').test(readme)) fail('README.md', `no examples row for the job ${j.id}`)

if (!existsSync('docs/BUILDING.md')) fail('docs/BUILDING.md', 'missing')
else common('docs/BUILDING.md', readFileSync('docs/BUILDING.md', 'utf8'), BUILDING)

if (fails.length) {
  console.error(`check-readme: ${fails.length} failed\n${fails.map((f) => `  ${f}`).join('\n')}`)
  process.exit(1)
}
console.log(`check-readme: ok. README.md with ${SECTIONS.length} sections, ${explorerRows().length} explorers, ${jobs.length} jobs; docs/BUILDING.md with ${BUILDING.length} sections (computed)`)
