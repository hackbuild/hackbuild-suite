// smoke-agents: the senses and drives tools from the single file build on
// file://, as a phone (touch, coarse pointer).
//   senses: a tap on a thing chip and a tap on the floor in front of the
//   agent puts the ball in view, listed with a bearing and a distance; a
//   tap behind the agent moves it out of view and into "seen earlier".
//   drives: with the transport paused, a restart and 1500 steps twice give
//   the same trace hash; the needs change over the run; an injected event
//   lands; the run exports as csv and as a trace whose hash matches.
// Any request off file:// or console error fails the run.
//   npm run build:single && node tools/smoke-agents.mjs senses|drives
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const mode = process.argv[2]
if (mode !== 'senses' && mode !== 'drives') throw new Error('usage: smoke-agents.mjs senses|drives')
const name = `smoke-${mode}`
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const url = `${pathToFileURL(file).href}#/agents/${mode}`

const profile = mkdtempSync(join(tmpdir(), `suite-${mode}-`))
const downloads = join(profile, 'downloads')
mkdirSync(downloads)
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, userDataDir: profile,
  args: ['--no-first-run', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const errors = []
const off = []
const fail = (why) => { throw new Error(errors.length ? `${why}\nconsole errors:\n${errors.join('\n')}` : why) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const NODE_HASH = '50663d28'

try {
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) off.push(r.url()) })
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  const cdp = await page.createCDPSession()
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }, { name: 'any-pointer', value: 'coarse' }] })
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction((h) => document.querySelector('.hb-viewport-host')?.[h], { timeout: 20000 }, mode)
    .catch(async () => fail(`the tool did not start: ${await page.evaluate(() => document.querySelector('.hb-viewport')?.textContent ?? 'no stage')}`))
  const h = (fn, ...a) => page.evaluate((src, key, ...b) => (0, eval)(src)(document.querySelector('.hb-viewport-host')[key], ...b), fn.toString(), mode, ...a)
  await wait(1200)
  await page.evaluate(() => document.querySelector('.hb-viewport').scrollIntoView({ block: 'start' }))
  const pane = (p) => page.$$eval(`[data-pane="${p}"] .hb-row`, (rows) => rows.map((r) => r.textContent.trim()))
  const until = async (what, test, ms = 6000) => {
    for (let i = 0; i < ms / 100; i++) { if (await test()) return; await wait(100) }
    fail(`${what}: pixels ${JSON.stringify(await h((s) => s.pixels?.()))}; in view ${JSON.stringify(await pane('in-view'))}, seen earlier ${JSON.stringify(await pane('seen-earlier'))}`)
  }

  let detail = ''
  if (mode === 'senses') {
    // the top view puts the floor in front of and behind the agent on screen
    await page.evaluate(() => [...document.querySelectorAll('.hb-cams button')].find((b) => b.textContent.trim().startsWith('top'))?.click())
    await wait(300)
    await wait(300)
    // pick the ball by its chip, then tap open floor
    await page.evaluate(() => [...document.querySelectorAll('[data-place] button')].find((b) => b.textContent.trim() === 'ball')?.click())
    const things = await h((s) => JSON.parse(JSON.stringify(s.opts.things)))
    const open = (cands) => cands.find(([x, z]) => things.every((t) => t.label === 'ball' || (t.x - x) ** 2 + (t.z - z) ** 2 > 0.6))
    const tapFloor = async ([x, z]) => {
      const p = await h((s, a, b) => s.screenOf(a, b), x, z)
      await page.touchscreen.tap(p.x, p.y)
      await wait(150)
      const b = await h((s) => JSON.parse(JSON.stringify(s.opts.things.find((t) => t.label === 'ball'))))
      if (!(Math.hypot(b.x - x, b.z - z) < 0.25)) fail(`the tap at ${p.x}, ${p.y} (over ${await page.evaluate((a, b) => { const e = document.elementFromPoint(a, b); return e ? e.className + ' ' + e.tagName : 'none' }, p.x, p.y)}) did not move the ball to ${x}, ${z}: it stands at ${b.x}, ${b.z}; picked ${await h((s) => s.picked.value)}; caption ${await page.$eval('.hb-viewport', (e) => e.textContent.slice(0, 300))}`)
    }
    // turn the agent to face screen right with the pad, so its front and back are clear of the overlays
    const pad = await page.$eval('.hb-pad-base', (e) => { const x = e.getBoundingClientRect(); return { x: x.x + x.width / 2, y: x.y + x.height / 2, w: x.width } })
    await page.touchscreen.touchStart(pad.x, pad.y)
    for (let i = 1; i <= 4; i++) { await page.touchscreen.touchMove(pad.x + pad.w * 0.1 * i, pad.y); await wait(16) }
    await wait(250)
    await page.touchscreen.touchEnd()
    await wait(300)
    const a = await h((s) => s.agent())
    const fx = Math.sin(a.yaw)
    const fz = Math.cos(a.yaw)
    const spots = (ds) => ds.flatMap((d) => [0, 0.25, -0.25, 0.5].map((l) => [a.x + fx * d - fz * l, a.z + fz * d + fx * l]))
    const front = open(spots([1.1, 1.25, 1]))
    const back = open(spots([-1.1, -1.25, -0.9]))
    if (!front || !back) fail(`no open floor in front of or behind the agent: ${JSON.stringify(things)}`)
    await tapFloor(front)
    const line = /^ball \((ahead|\d+ deg (left|right)), \d+\.\d m\)$/
    await until('the ball did not come into view with a bearing', async () => (await pane('in-view')).some((l) => line.test(l)))
    const seen = (await pane('in-view')).find((l) => line.test(l))
    await tapFloor(back)
    await until('the ball out of view did not move to seen earlier', async () => {
      const v = await pane('in-view')
      const e = await pane('seen-earlier')
      return !v.some((l) => l.startsWith('ball (')) && e.some((l) => /^ball \(last seen .+, \d+ s ago, confidence \d\.\d\d\)$/.test(l))
    })
    const earlier = (await pane('seen-earlier')).find((l) => l.startsWith('ball ('))
    const feed = await h((s) => s.live.feed.map((e) => e.kind))
    if (!feed.includes('see') || !feed.includes('lost')) fail(`the sense feed has no see and lost tags: ${feed.join(',')}`)
    const csv = readFileSync(await exportAs(page, 'sense feed', '.csv'), 'utf8').trim().split('\n')
    if (csv[0] !== 't,kind,text' || csv.length < 3) fail(`the feed csv is not whole: ${csv.slice(0, 2)}`)
    detail = `in view "${seen}", then seen earlier "${earlier}"; feed ${feed.length} events, csv ${csv.length - 1} rows`
  } else {
    await page.click('.hb-transport button[aria-label="pause"]')
    await wait(200)
    const run = async () => {
      await page.evaluate(() => [...document.querySelectorAll('button[aria-keyshortcuts="r"]')].find((b) => b.textContent.trim() === 'restart')?.click())
      await wait(400)
      const before = await h((d) => ({ ...d.live.needs, step: d.step() }))
      const hash = await h((d) => d.steps(1500))
      const after = await h((d) => ({ ...d.live.needs }))
      return { before, after, hash }
    }
    const a = await run()
    const b = await run()
    if (a.before.step !== 0) fail(`the restart did not reset the run: step ${a.before.step}`)
    if (!a.hash || a.hash !== b.hash) fail(`the same seed gave two hashes: ${a.hash} and ${b.hash}`)
    // node gives the same for seed 7 and 1500 steps (tools/test/senses-drives.test.mjs)
    if (a.hash !== NODE_HASH) fail(`chrome gave ${a.hash}, node gives ${NODE_HASH}`)
    const moved = ['hunger', 'rest', 'play', 'social'].filter((k) => Math.abs(a.after[k] - a.before[k]) > 0.01)
    if (moved.length < 2) fail(`the drive bars did not change: ${JSON.stringify(a)}`)
    const shown = await page.$eval('[data-hash]', (e) => e.textContent)
    if (!shown.includes(a.hash)) fail(`the hash on the page ${shown} is not ${a.hash}`)
    // inject an event through the input
    await page.type('[data-pane="inject"] input', 'a friend knocks at the door')
    await page.evaluate(() => document.querySelector('[data-inject]').click())
    await wait(100)
    const note = await page.$eval('[data-note]', (e) => e.textContent)
    if (!/^a visitor lands at step \d+\.$/.test(note)) fail(`the event did not land: ${note}`)
    const c = await h((d) => d.steps(200))
    const csv = readFileSync(await exportAs(page, 'run', '.csv'), 'utf8').trim().split('\n')
    if (csv[0] !== 't,hour,hunger,rest,play,social,act,reason,probability,switched,sleep,pressure,why' || csv.length < 1700) fail(`the run csv is not whole: ${csv.length} rows, ${csv[0]}`)
    const trace = JSON.parse(readFileSync(await exportAs(page, 'trace', '.trace.json'), 'utf8'))
    if (trace.hash !== c || trace.events.length !== 1 || trace.rows.length !== 1700) fail(`the trace is not whole: hash ${trace.hash} for ${c}, ${trace.events?.length} events, ${trace.rows?.length} rows`)
    detail = `two runs of 1500 steps from seed 7 gave hash ${a.hash} both times, the same as node; ${moved.join(', ')} moved; "${note}"; csv ${csv.length - 1} rows, trace hash ${trace.hash}`
  }
  await page.close()
  if (errors.length) fail('console errors')
  if (off.length) fail(`requests off file://: ${off.slice(0, 5).join(', ')}`)
  console.log(`${name}: ok. ${detail}; 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}

async function exportAs(page, label, ext) {
  await page.evaluate((l) => [...document.querySelectorAll('.hb-export-formats button')].find((b) => b.textContent.trim() === l)?.click(), label)
  await wait(100)
  const clicked = await page.evaluate((e) => {
    const b = [...document.querySelectorAll('.hb-export button')].find((x) => x.textContent.trim().startsWith('export') && x.textContent.trim().endsWith(e) && !x.disabled)
    b?.click(); return !!b
  }, ext)
  if (!clicked) fail(`no export ${ext} button`)
  for (let i = 0; i < 50; i++) {
    const f = readdirSync(downloads).find((n) => n.endsWith(ext) && !n.endsWith('.crdownload'))
    // the file moves out of the folder, so the next export of the same extension is found
    if (f) { const keep = join(profile, `got-${Date.now()}${ext}`); renameSync(join(downloads, f), keep); return keep }
    await wait(100)
  }
  fail(`no ${ext} download`)
}

