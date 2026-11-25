// contact-sheet: one PNG per route that puts the rebuild's 1440 and 390 shots
// beside its original's, labelled, for a reviewer to compare whole screens
// (rebuild plan section 8). Reads the shots and routes ux-gate wrote, and the
// route to original map in tools/ux-originals.json:
//   { "<route>": { "original": "<html file>", "shot1440": "<png>", "shot390": "<png>", "note": "" } | null }
// A route whose original has no shot gets one: the original HTML is served and
// shot headless at 1440 and 390 with model hosts and weight files blocked, and
// kept under --originals for the next run. Original HTML is untrusted data:
// it is only loaded and shot.
//
//   node tools/contact-sheet.mjs --gate <ux-gate out dir> --out <dir> [--map tools/ux-originals.json] [--originals <dir>]
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launch, openAt, serveDir } from './browse.mjs'
import { slug } from './ux-probe.mjs'

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const home = (p) => (p ? resolve(p.replace(/^~(?=\/)/, homedir())) : p)
const gate = resolve(arg('gate', 'ux-gate'))
const out = resolve(arg('out', 'contact-sheets'))
const map = JSON.parse(readFileSync(resolve(arg('map', 'tools/ux-originals.json')), 'utf8'))
const originals = home(arg('originals', '~/Projects/hackbuild/web-ai-knowledge/research/rebuild-shots/originals'))
const report = JSON.parse(readFileSync(join(gate, 'report.json'), 'utf8'))
mkdirSync(out, { recursive: true })
mkdirSync(originals, { recursive: true })

const chrome = await launch({ prefix: 'contact-sheet-', blockModels: true })
const unmapped = []

/** Shoots an original HTML file at 1440 and 390 unless a shot is kept already. */
async function shootOriginal(file) {
  const stem = basename(file, '.html').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
  const shots = { 1440: join(originals, `${stem}-1440.png`), 390: join(originals, `${stem}-390.png`) }
  if (existsSync(shots[1440]) && existsSync(shots[390])) return shots
  const server = await serveDir(dirname(file))
  try {
    for (const width of [1440, 390]) {
      const height = width < 500 ? 844 : 900
      const url = server.base + encodeURIComponent(basename(file))
      const o = await openAt(chrome.browser, url, { width, height, base: server.base, block: true, settle: 2500 })
      await o.shot(shots[width])
      await o.page.close()
    }
  } finally { server.close() }
  return shots
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const img = (p, cls) => (p && existsSync(p) ? `<img class="${cls}" src="${pathToFileURL(p)}">` : `<div class="${cls} none">no shot</div>`)

try {
  const page = await chrome.browser.newPage()
  await page.setViewport({ width: 1488, height: 900 })
  for (const route of report.routes) {
    const entry = map[route]
    let o1440 = null
    let o390 = null
    if (entry) {
      o1440 = home(entry.shot1440)
      o390 = home(entry.shot390)
      if (!o1440 && !o390) ({ 1440: o1440, 390: o390 } = await shootOriginal(home(entry.original)))
    } else unmapped.push(route)
    const mine = (w) => join(gate, `${report.name}-${slug(route)}-${w}.png`)
    const origLabel = entry ? `original: ${basename(home(entry.original))}${entry.note ? `, ${entry.note}` : ''}` : 'no original mapped'
    const html = `<!doctype html><meta charset="utf-8"><style>
      body { margin: 0; padding: 16px; background: #f3efe6; font: 14px/1.3 ui-monospace, Menlo, monospace; color: #111; width: 1456px; }
      h1 { font-size: 18px; margin: 0 0 12px; }
      .grid { display: grid; grid-template-columns: 720px 720px; gap: 16px; }
      .lab { font-weight: bold; margin: 0 0 6px; }
      .w1440 { width: 720px; height: 450px; object-fit: cover; object-position: top; border: 2px solid #111; display: block; }
      .w390 { width: 260px; height: 563px; object-fit: cover; object-position: top; border: 2px solid #111; display: block; margin-top: 12px; }
      .none { display: grid; place-items: center; background: #ddd; color: #555; box-sizing: border-box; }
    </style><h1>${esc(report.name)} ${esc(route)}</h1><div class="grid">
      <div><p class="lab">rebuild, 1440 and 390</p>${img(mine(1440), 'w1440')}${img(mine(390), 'w390')}</div>
      <div><p class="lab">${esc(origLabel)}</p>${img(o1440, 'w1440')}${img(o390, 'w390')}</div>
    </div>`
    const tmp = join(out, '.sheet.html')
    writeFileSync(tmp, html)
    await page.goto(pathToFileURL(tmp).href, { waitUntil: 'load' })
    await page.screenshot({ path: join(out, `${report.name}-${slug(route)}.png`), fullPage: true })
    rmSync(tmp)
    console.log(`contact-sheet: ${route}`)
  }
} finally {
  await chrome.close()
}
console.log(`contact-sheet: ${report.routes.length} sheets in ${out}${unmapped.length ? `; no original for ${unmapped.join(' ')}` : ''}`)
