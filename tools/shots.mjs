// shots: the shared screenshot and layout check for every build phase.
// Serves a built directory over http on 127.0.0.1, then for each route takes
// shots at 320, 390, 768, 1024 and 1440 px. Widths under 500 render inside an
// iframe of that width, because headless Chrome clamps its window at 500 px.
// A touch run at 390 px emulates a phone (mobile, touch, coarse pointer).
// Checks per width: no sideways scroll; on the touch run, no visible button,
// tab, input or select smaller than 44 px in either side (links inside a
// sentence, display inline, are exempt as wcag 2.5.8 allows).
//
//   node tools/shots.mjs --dir dist/hosted --out <dir> [--routes "#/,#/chat"] [--widths 320,1440]
// READY=<selector> waits for that element before each shot (default body *).
// SETUP=<file.js> evaluates that script (an expression, awaited) in the page
// after READY, to open a panel or load a fixture through the app's own paths.
// Exit code 1 when a check fails; the report lists every failure.
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launch, openAt, serveDir } from './browse.mjs'

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const dir = resolve(arg('dir', 'dist/hosted'))
const out = resolve(arg('out', 'shots'))
const routes = arg('routes', '#/').split(',')
const widths = arg('widths', '320,390,768,1024,1440').split(',').map(Number)

const server = await serveDir(dir)
const base = server.base
mkdirSync(out, { recursive: true })

const SETUP = process.env.SETUP ? readFileSync(process.env.SETUP, 'utf8') : null
const slug = (route) => route.replace(/^#\/?/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'
const chrome = await launch({ prefix: 'suite-shots-' })
const browser = chrome.browser
const fails = []
const SMALL = `(() => {
  const bad = []
  for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role="tab"]')) {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el)
    if (!r.width || !r.height || s.visibility === 'hidden') continue
    if (s.display === 'inline') continue // a link inside a sentence: exempt under wcag 2.5.8
    if (el.getAttribute('aria-hidden') === 'true' && el.tabIndex < 0) continue // a hidden file input a button opens: not a target
    const lab = el.tagName === 'INPUT' && el.closest('label') // a checkbox or radio whose label is the target
    if (lab) { const lr = lab.getBoundingClientRect(); if (lr.width >= 44 && lr.height >= 44) continue }
    if (r.width < 44 || r.height < 44) bad.push((el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 30) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height))
  }
  return bad
})()`
const SIDEWAYS = `document.documentElement.scrollWidth - document.documentElement.clientWidth`

try {
  for (const route of routes) {
    const url = base + route
    for (const w of widths) {
      const name = `${slug(route)}-${w}.png`
      const { page, target, shot, errors } = await openAt(browser, url, { width: w, base, ready: process.env.READY ?? 'body *' })
      if (SETUP) { await target.evaluate(SETUP); await new Promise((r) => setTimeout(r, 300)) }
      const side = await target.evaluate(SIDEWAYS)
      if (side > 0) fails.push(`${route} at ${w}: sideways scroll ${side} px`)
      await shot(join(out, name))
      if (errors.length) fails.push(`${route} at ${w}: ${errors.join('; ')}`)
      await page.close()
    }
    // touch run: phone emulation at 390, coarse pointer
    const page = await browser.newPage()
    await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' })
    const cdp = await page.createCDPSession()
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }, { name: 'any-pointer', value: 'coarse' }] })
    await page.goto(url, { waitUntil: 'load' })
    await page.waitForSelector(process.env.READY ?? 'body *', { timeout: 10000 })
    if (SETUP) await page.evaluate(SETUP)
    await new Promise((r) => setTimeout(r, 300))
    const small = await page.evaluate(SMALL)
    for (const s of small) fails.push(`${route} touch: target under 44 px: ${s}`)
    await page.screenshot({ path: join(out, `${slug(route)}-touch-390.png`) })
    await page.close()
  }
} finally {
  await chrome.close(); server.close()
}
console.log(`shots: ${routes.length} routes x ${widths.length + 1} views into ${out}`)
if (fails.length) { console.log(`shots: ${fails.length} check failures\n` + fails.map((f) => '  ' + f).join('\n')); process.exitCode = 1 }
else console.log('shots: all checks pass')
