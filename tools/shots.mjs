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
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const dir = resolve(arg('dir', 'dist/hosted'))
const out = resolve(arg('out', 'shots'))
const routes = arg('routes', '#/').split(',')
const widths = arg('widths', '320,390,768,1024,1440').split(',').map(Number)
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' }

const server = createServer(async (req, res) => {
  try {
    let p = join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname))
    if ((await stat(p)).isDirectory()) p = join(p, 'index.html')
    res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' })
    res.end(await readFile(p))
  } catch { res.writeHead(404).end() }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/`
mkdirSync(out, { recursive: true })

const SETUP = process.env.SETUP ? readFileSync(process.env.SETUP, 'utf8') : null
const slug = (route) => route.replace(/^#\/?/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'
const profile = mkdtempSync(join(tmpdir(), 'suite-shots-'))
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args: ['--no-first-run', '--window-size=1440,900'] })
const fails = []
const SMALL = `(() => {
  const bad = []
  for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role="tab"]')) {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el)
    if (!r.width || !r.height || s.visibility === 'hidden') continue
    if (s.display === 'inline') continue // a link inside a sentence: exempt under wcag 2.5.8
    if (el.getAttribute('aria-hidden') === 'true' && el.tabIndex < 0) continue // a hidden file input a button opens: not a target
    if (r.width < 44 || r.height < 44) bad.push((el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 30) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height))
  }
  return bad
})()`
const SIDEWAYS = `document.documentElement.scrollWidth - document.documentElement.clientWidth`

try {
  for (const route of routes) {
    const url = base + route
    for (const w of widths) {
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(String(e)))
      const name = `${slug(route)}-${w}.png`
      if (w < 500) {
        await page.setViewport({ width: 600, height: 900 })
        await page.goto(base, { waitUntil: 'load' })
        await page.setContent(`<body style="margin:0;background:#888"><iframe id="f" src="${url}" style="border:0;width:${w}px;height:900px;display:block"></iframe></body>`, { waitUntil: 'load' })
        const frame = await (await page.$('#f')).contentFrame()
        await frame.waitForSelector(process.env.READY ?? 'body *', { timeout: 10000 })
        if (SETUP) await frame.evaluate(SETUP)
        await new Promise((r) => setTimeout(r, 300))
        const side = await frame.evaluate(SIDEWAYS)
        if (side > 0) fails.push(`${route} at ${w}: sideways scroll ${side} px`)
        await (await page.$('#f')).screenshot({ path: join(out, name) })
      } else {
        await page.setViewport({ width: w, height: 900 })
        await page.goto(url, { waitUntil: 'load' })
        await page.waitForSelector(process.env.READY ?? 'body *', { timeout: 10000 })
        if (SETUP) await page.evaluate(SETUP)
        await new Promise((r) => setTimeout(r, 300))
        const side = await page.evaluate(SIDEWAYS)
        if (side > 0) fails.push(`${route} at ${w}: sideways scroll ${side} px`)
        await page.screenshot({ path: join(out, name) })
      }
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
  await browser.close(); server.close(); rmSync(profile, { recursive: true, force: true })
}
console.log(`shots: ${routes.length} routes x ${widths.length + 1} views into ${out}`)
if (fails.length) { console.log(`shots: ${fails.length} check failures\n` + fails.map((f) => '  ' + f).join('\n')); process.exitCode = 1 }
else console.log('shots: all checks pass')
