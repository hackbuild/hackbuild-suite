// check-size: holds the suite builds to tools/size-budget.json.
//   node tools/check-size.mjs [--write-today]
// Reads dist/hosted (first load and every lazy chunk), dist/single and the
// seven group single files in dist/groups (design D11).
// --write-today records the measured figures in the "today" block.
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

const budgetPath = 'tools/size-budget.json'
const cfg = JSON.parse(readFileSync(budgetPath, 'utf8'))
const gz = (p) => gzipSync(readFileSync(p), { level: 9 }).length
const hosted = 'dist/hosted'
if (!existsSync(join(hosted, 'index.html')) || !existsSync('dist/single/index.html')) throw new Error('build both outputs first: npm run build:all')

// first load: what index.html references directly, plus their static imports
const html = readFileSync(join(hosted, 'index.html'), 'utf8')
const direct = [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1])
const seen = new Set()
const walk = (rel) => {
  if (seen.has(rel)) return
  seen.add(rel)
  if (!rel.endsWith('.js')) return
  const code = readFileSync(join(hosted, rel), 'utf8')
  for (const m of code.matchAll(/(?:^|[;}\s])import\s*(?:[^'"()]*?from\s*)?["']\.\/([^"']+\.js)["']/g)) walk('assets/' + m[1])
}
direct.forEach(walk)
const firstLoad = gz(join(hosted, 'index.html')) + [...seen].reduce((n, rel) => n + gz(join(hosted, rel)), 0)

const chunks = readdirSync(join(hosted, 'assets')).filter((f) => f.endsWith('.js') && !seen.has('assets/' + f))
const sizes = chunks.map((f) => [f, gz(join(hosted, 'assets', f))])
const largest = sizes.reduce((a, b) => (b[1] > a[1] ? b : a), ['none', 0])
const single = statSync('dist/single/index.html').size
const groupBudget = cfg.budgets['group-raw']
const groups = Object.keys(groupBudget).map((g) => {
  const f = `dist/groups/${g}.html`
  if (!existsSync(f)) throw new Error(`no ${f}: run npm run build:groups`)
  return [g, statSync(f).size]
})

const b = cfg.budgets
const fails = []
if (firstLoad > b['first-load-gzip']) fails.push(`first load ${firstLoad} B gzip over ${b['first-load-gzip']}`)
for (const [f, s] of sizes) if (s > b['tool-chunk-gzip']) fails.push(`chunk ${f} ${s} B gzip over ${b['tool-chunk-gzip']}`)
if (single > b['single-raw']) fails.push(`single file ${single} B over ${b['single-raw']}`)
for (const [g, n] of groups) if (n > groupBudget[g]) fails.push(`group file ${g}.html ${n} B over ${groupBudget[g]}`)

console.log(`check-size: first load ${firstLoad} B gzip (${seen.size} files), ${sizes.length} lazy chunks, largest ${largest[0]} ${largest[1]} B gzip, single ${single} B raw (measured)`)
const big = sizes.filter(([, s]) => s > 100_000).sort((x, y) => y[1] - x[1])
console.log(`check-size: group files raw, ${groups.map(([g, n]) => `${g} ${n} B`).join(', ')} (measured)`)
if (big.length) console.log(`chunks over 100 kB gzip: ${big.map(([f, s]) => `${f} ${s} B`).join(', ')} (measured)`)
if (process.argv.includes('--write-today')) {
  cfg.today = { note: cfg.today.note, 'first-load-gzip': firstLoad, 'largest-chunk-gzip': largest[1], 'single-raw': single, 'group-raw': Object.fromEntries(groups) }
  writeFileSync(budgetPath, JSON.stringify(cfg, null, 2) + '\n')
}
if (fails.length) { console.log(fails.join('\n')); process.exitCode = 1 }
