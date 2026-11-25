// ux-gate: measures whole screens against the page template (rebuild plan
// sections 2 and 8). Serves a built directory, opens each route at 1440x900
// and 390x844 (390 through an iframe) with model and weight downloads blocked,
// shoots it, and checks nine things per route and width:
//   bar       one bar, 52 px tall or less
//   controls  15 or fewer visible, enabled controls in first view outside the rack
//   disabled  no disabled control in first view
//   pink      exactly one control whose background is the resolved --hb-pink
//   subject   60 percent of the viewport at 1440; its top above the fold at 390
//   rack      380 px wide at 1440, the same width on every rack tab
//   hscroll   no sideways scroll
//   overlap   no two header items cross
//   words     no internal word (organ, tier, provider, rung, phase, inferred,
//             measured, computed, unverified) in first view text outside
//             closed details, [hidden], aria-hidden and detail panes
//
// Markers: layouts set data-ux on their parts and the gate trusts them.
//   data-ux="bar"      the one top bar
//   data-ux="subject"  the frame, canvas, room or conversation that fills
//   data-ux="rack"     the 380 px tab column (a bottom sheet on a phone)
//   data-ux="verbs"    the action row on the subject
//   data-ux="detail"   a detail pane, where internal words are allowed
// Without markers the gate guesses: bar is the topmost full width header or
// [role=banner]; subject is the largest visible canvas, video, img, iframe,
// main child or *stage*, *drop*, *frame*, *viewport* class element; rack is an
// aside or *rack* class element on the right. Each
// result says which detector fired, so a reader knows how far to trust it.
//
//   node tools/ux-gate.mjs --dir dist/hosted --routes "#/,#/chat/chat" --out <dir> [--name suite] [--report-only]
// For a non hash site pass file routes, like --routes "index.html".
// Writes <out>/<name>-<slug>-<width>.png, <out>/report.json and <out>/report.md.
// Exit code 1 on any failed check, 0 with --report-only.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launch, openAt, serveDir } from './browse.mjs'
import { CHECKS, judge, pageScript, slug } from './ux-probe.mjs'

const argv = process.argv
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i > 0 ? argv[i + 1] : d }
const dir = resolve(arg('dir', 'dist/hosted'))
const out = resolve(arg('out', 'ux-gate'))
const name = arg('name', 'suite')
const routes = arg('routes', '#/').split(',').map((r) => r.trim()).filter(Boolean)
const reportOnly = argv.includes('--report-only')
const VIEWS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }]

mkdirSync(out, { recursive: true })
const server = await serveDir(dir)
const chrome = await launch({ prefix: 'ux-gate-', blockModels: true })
const results = []
try {
  for (const route of routes) {
    for (const { width, height } of VIEWS) {
      const shotFile = `${name}-${slug(route)}-${width}.png`
      const r = { route, width, shot: shotFile }
      let page
      try {
        const o = await openAt(chrome.browser, server.base + route, { width, height, base: server.base, block: true, settle: 600 })
        page = o.page
        await o.shot(join(out, shotFile)) // before the probe clicks rack tabs
        const m = await o.target.evaluate(pageScript)
        Object.assign(r, { detectors: m.detectors, checks: judge(m, width), measured: m, errors: o.errors, blocked: o.blocked.length })
      } catch (e) {
        r.checks = Object.fromEntries(CHECKS.map((c) => [c, { pass: false, value: 'probe failed' }]))
        r.errors = [String(e)]
      }
      await page?.close()
      results.push(r)
      const failed = CHECKS.filter((c) => r.checks[c].pass === false)
      console.log(`ux-gate: ${route} at ${width}: ${failed.length ? `${failed.length} fail (${failed.join(' ')})` : 'pass'}`)
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
  `| route | width | ${CHECKS.join(' | ')} | detectors |`,
  `|${' --- |'.repeat(CHECKS.length + 3)}`,
  ...results.map((r) => `| ${r.route} | ${r.width} | ${CHECKS.map((c) => cell(r.checks[c])).join(' | ')} | ${det(r.detectors)} |`),
  '',
]
writeFileSync(join(out, 'report.md'), md.join('\n'))
writeFileSync(join(out, 'report.json'), JSON.stringify({ name, dir, routes, results }, null, 2))
const failing = results.filter((r) => CHECKS.some((c) => r.checks[c].pass === false))
console.log(`ux-gate: ${failing.length} of ${results.length} screens fail; report in ${out}`)
if (failing.length && !reportOnly) process.exitCode = 1
