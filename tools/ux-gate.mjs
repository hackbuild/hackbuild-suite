// ux-gate: measures whole screens against the page template (rebuild plan
// sections 2 and 8). Serves a built directory, opens each route at 1440x900
// and 390x844 (390 through an iframe) with model and weight downloads blocked,
// shoots it, and checks ten things per route and width:
//   modal     no entry modal or dialog over the first view
//   bar       one bar, 52 px tall or less
//   controls  15 or fewer visible, enabled controls in first view outside the rack
//   disabled  no disabled control in first view
//   pink      exactly one action (a button at rest, not a selected tab, a
//             pressed toggle or a chip) whose background is --hb-pink
//   subject   60 percent of the viewport unoccluded at 1440; its top in the
//             upper half at 390
//   rack      380 px wide at 1440, the same width on every rack tab, 3 to 5
//             tabs, 20 controls at most
//   hscroll   no sideways scroll
//   overlap   no two header items cross
//   words     no internal word (organ, tier, provider, rung, phase, inferred,
//             measured, computed, unverified) in first view text outside
//             closed details, [hidden], aria-hidden and data-ux="detail"
//
// Markers: layouts set data-ux on their parts and the gate prefers them.
//   data-ux="bar"      the one top bar
//   data-ux="subject"  the frame, canvas, room or conversation that fills
//   data-ux="rack"     the 380 px tab column (a bottom sheet on a phone)
//   data-ux="verbs"    the action row on the subject
//   data-ux="inset"    a card on the subject (an eye view); counts as subject
//   data-ux="detail"   a detail pane, where internal words are allowed
// Without markers the gate guesses: bar is the topmost full width header or
// [role=banner]; subject is the largest visible canvas, video, img, iframe,
// main child or *stage*, *drop*, *frame*, *viewport* class element; rack is an
// aside or *rack* class element on the right. Each result says which
// detector fired, so a reader knows how far to trust it.
//
// A visible entry modal is its own failure; the gate then closes it (Escape,
// else its close button) and measures the screen under it. Subject area
// counts only where hit tests reach the subject (overlays occlude it).
// Markers are checked, not trusted: a subject with more than 3 controls is
// rejected, and the rack must carry 3 to 5 tabs and at most 20 controls.
//
// Layouts (rebuild plan section 2) come per route from --layouts (default
// tools/ux-routes.json): { "<route>": { "layout": "stage-rack", "setup": "<js>" } }.
// gate and home skip the rack check; home's subject is the yard tile
// (data-ux="subject" or a *yard* class element). A setup expression loads the
// route's built-in sample (never weights) and the checks run again as a
// second, loaded row. --layout sets the layout for routes the file lacks.
//
//   node tools/ux-gate.mjs --dir dist/hosted --routes "#/,#/chat/chat" --out <dir> [--name suite] [--report-only]
// For a non hash site pass file routes, like --routes "index.html".
// Writes <out>/<name>-<slug>[-loaded]-<width>.png, <out>/report.json and <out>/report.md.
// Exit code 1 on any failed check, 0 with --report-only.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launch, openAt, serveDir } from './browse.mjs'
import { CHECKS, LAYOUTS, judge, modalScript, pageScript, slug } from './ux-probe.mjs'

const argv = process.argv
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i > 0 ? argv[i + 1] : d }
const dir = resolve(arg('dir', 'dist/hosted'))
const out = resolve(arg('out', 'ux-gate'))
const name = arg('name', 'suite')
const routes = arg('routes', '#/').split(',').map((r) => r.trim()).filter(Boolean)
const reportOnly = argv.includes('--report-only')
const layoutsFile = resolve(arg('layouts', 'tools/ux-routes.json'))
const layouts = existsSync(layoutsFile) ? JSON.parse(readFileSync(layoutsFile, 'utf8')) : {}
const fallback = arg('layout', 'stage-rack')
const VIEWS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }]
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
for (const [route, l] of Object.entries(layouts)) if (!LAYOUTS.includes(l.layout)) throw new Error(`ux-gate: ${route} has layout ${l.layout}, not one of ${LAYOUTS.join(' ')}`)

/** Closes an entry modal the way a visitor would; returns { label, dismissed } or null. */
async function dismissModal(page, target) {
  const label = await target.evaluate(modalScript(false))
  if (!label) return null
  await target.evaluate(() => (document.activeElement ?? document.body)?.focus?.())
  await page.keyboard.press('Escape')
  await wait(400)
  if (!(await target.evaluate(modalScript(false)))) return { label, dismissed: 'closed by escape' }
  await target.evaluate(modalScript(true))
  await wait(600)
  if (!(await target.evaluate(modalScript(false)))) return { label, dismissed: 'closed by its button' }
  return { label, dismissed: 'would not close' }
}

mkdirSync(out, { recursive: true })
const server = await serveDir(dir)
const chrome = await launch({ prefix: 'ux-gate-', blockModels: true })
const results = []
const log = (r) => {
  const failed = CHECKS.filter((c) => r.checks[c].pass === false)
  console.log(`ux-gate: ${r.route}${r.state === 'loaded' ? ' loaded' : ''} at ${r.width}: ${failed.length ? `${failed.length} fail (${failed.join(' ')})` : 'pass'}`)
}
try {
  for (const route of routes) {
    const { layout = fallback, setup } = layouts[route] ?? {}
    for (const { width, height } of VIEWS) {
      const r = { route, width, layout, state: 'first view', shot: `${name}-${slug(route)}-${width}.png` }
      const rows = [r]
      let page
      try {
        const o = await openAt(chrome.browser, server.base + route, { width, height, base: server.base, block: true, settle: 600 })
        page = o.page
        await o.shot(join(out, r.shot)) // the first view as a visitor meets it, modal and all
        const modal = await dismissModal(page, o.target)
        const m = await o.target.evaluate(pageScript(layout))
        m.modal = modal
        Object.assign(r, { detectors: m.detectors, checks: judge(m, width, layout, layouts[route] ?? {}), measured: m, errors: o.errors, blocked: o.blocked.length })
        if (setup) {
          const l = { route, width, layout, state: 'loaded', shot: `${name}-${slug(route)}-loaded-${width}.png` }
          rows.push(l)
          await o.target.evaluate(setup)
          await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {})
          await wait(1200)
          await o.shot(join(out, l.shot))
          const ml = await o.target.evaluate(pageScript(layout))
          ml.modal = null
          Object.assign(l, { detectors: ml.detectors, checks: judge(ml, width, layout, layouts[route] ?? {}), measured: ml, errors: o.errors, blocked: o.blocked.length })
        }
      } catch (e) {
        for (const x of rows) if (!x.checks) {
          x.checks = Object.fromEntries(CHECKS.map((c) => [c, { pass: false, value: 'probe failed' }]))
          x.errors = [String(e)]
        }
      }
      await page?.close()
      for (const x of rows) { results.push(x); log(x) }
    }
  }
} finally {
  await chrome.close()
  server.close()
}

const cell = (c) => (c.pass === null ? 'n/a' : `${c.pass ? 'pass' : 'fail'} ${c.value}`)
const det = (d) => (d ? `bar ${d.bar}, subject ${d.subject}, rack ${d.rack}` : 'none')
const md = [
  `# ux gate: ${name}`,
  '',
  `${results.length} screens, ${routes.length} routes at 1440 and 390 (measured, headless Chrome, weights blocked).`,
  '',
  `| route | layout | state | width | ${CHECKS.join(' | ')} | detectors |`,
  `|${' --- |'.repeat(CHECKS.length + 5)}`,
  ...results.map((r) => `| ${r.route} | ${r.layout} | ${r.state} | ${r.width} | ${CHECKS.map((c) => cell(r.checks[c])).join(' | ')} | ${det(r.detectors)} |`),
  '',
]
writeFileSync(join(out, 'report.md'), md.join('\n'))
writeFileSync(join(out, 'report.json'), JSON.stringify({ name, dir, routes, results }, null, 2))
const failing = results.filter((r) => CHECKS.some((c) => r.checks[c].pass === false))
console.log(`ux-gate: ${failing.length} of ${results.length} screens fail; report in ${out}`)
if (failing.length && !reportOnly) process.exitCode = 1
