// smoke-locomotion: the gait and motion-match tools from the single file
// build on file://, as a phone (touch, coarse pointer).
//   gait: the pad held up walks the dog's root, the four feet alternate
//   planted and swing, the run bakes into a clip file.
//   motion-match: standing on the idle clip, the pad held up changes the
//   matched clip, a cost is reported and the page's own cheapest cost agrees
//   with the matcher's brute search; the run exports as a clip and a trace.
// Any request off file:// or console error fails the run.
//   npm run build:single && node tools/smoke-locomotion.mjs gait|motionmatch
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const mode = process.argv[2]
if (mode !== 'gait' && mode !== 'motionmatch') throw new Error('usage: smoke-locomotion.mjs gait|motionmatch')
const name = `smoke-${mode}`
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const url = `${pathToFileURL(file).href}#/motion/${mode === 'gait' ? 'gait' : 'motion-match'}`
const handle = mode === 'gait' ? 'gait' : 'mm'

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
  await page.waitForFunction((h) => document.querySelector('.hb-viewport-host')?.[h], { timeout: 20000 }, handle)
    .catch(async () => fail(`the tool did not start: ${await page.evaluate(() => document.querySelector('.hb-viewport')?.textContent ?? 'no stage')}`))
  const h = (fn, ...a) => page.evaluate((src, key, ...b) => (0, eval)(src)(document.querySelector('.hb-viewport-host')[key], ...b), fn.toString(), handle, ...a)
  await wait(1200)
  await page.evaluate(() => document.querySelector('.hb-viewport').scrollIntoView({ block: 'start' }))

  const pos = () => (mode === 'gait' ? h((g) => g.pose()) : h((m) => m.root()))
  const before = await pos()
  const clip0 = mode === 'motionmatch' ? await h((m) => m.live.clip) : ''

  // hold the pad up for two seconds
  const r = await page.$eval('.hb-pad-base', (e) => { const x = e.getBoundingClientRect(); return { x: x.x + x.width / 2, y: x.y + x.height / 2, h: x.height } })
  if (!r.h) fail('the pad is not shown on a coarse pointer')
  const clips = new Set()
  await page.touchscreen.touchStart(r.x, r.y)
  for (let i = 1; i <= 5; i++) { await page.touchscreen.touchMove(r.x, r.y - r.h * 0.1 * i); await wait(16) }
  for (let i = 0; i < 15; i++) {
    await wait(200)
    if (mode === 'motionmatch') clips.add(await h((m) => m.live.clip))
  }
  const contacts = mode === 'gait' ? await h((g) => g.contacts()) : null
  const live = await h((x) => JSON.parse(JSON.stringify(x.live)))
  await page.touchscreen.touchEnd()
  const after = await pos()
  const walked = Math.hypot(after.x - before.x, after.z - before.z)
  if (walked < 0.5) fail(`the pad did not move the root: ${JSON.stringify({ before, after, clips: [...clips], live })}`)

  let detail = ''
  if (mode === 'gait') {
    // every leg both planted and in the air over the window, and the pairs differ somewhere
    const legs = [0, 1, 2, 3].map((i) => contacts.map((row) => row[i]))
    for (const [i, l] of legs.entries()) if (!l.includes(true) || !l.includes(false)) fail(`leg ${i} did not alternate: ${l.map(Number).join('')}`)
    const differ = contacts.filter((row) => row[0] !== row[1]).length
    if (!differ) fail('the fore feet never differed: no alternation')
    const swaps = legs[0].reduce((n, c, k) => n + (k && c !== legs[0][k - 1] ? 1 : 0), 0)
    detail = `walked ${walked.toFixed(2)} m at ${live.speed.toFixed(2)} m/s, stride ${live.freq.toFixed(2)} Hz, froude ${live.froude.toFixed(3)}; over ${contacts.length} frames the left fore foot changed ${swaps} times and the fore feet differed on ${differ} frames`
  } else {
    if (clips.size < 2 && [...clips][0] === clip0) fail(`the matched clip did not change from ${clip0}: ${[...clips]}`)
    if (!Number.isFinite(live.cost)) fail(`no cost: ${JSON.stringify(live)}`)
    const cost = await page.evaluate(() => document.querySelector('[data-cost]')?.textContent ?? '')
    if (!/\d\.\d{3}/.test(cost)) fail(`the cost is not on the page: ${cost}`)
    if (!(Math.abs(live.best - live.brute) < 1e-6)) fail(`page cost ${live.best} differs from the brute search ${live.brute}`)
    detail = `walked ${walked.toFixed(2)} m; the clip went from ${clip0} through ${[...clips].join(', ')}; cost ${live.cost.toFixed(3)} after ${live.transitions} jumps; the page's cheapest cost ${live.best.toFixed(4)} matched the brute search ${live.brute.toFixed(4)}`
  }

  // export
  const exportAs = async (label, ext) => {
    await page.evaluate((l) => [...document.querySelectorAll('.hb-export-formats button')].find((b) => b.textContent.trim() === l)?.click(), label)
    await wait(100)
    const clicked = await page.evaluate((e) => {
      const b = [...document.querySelectorAll('.hb-export button')].find((x) => x.textContent.trim().startsWith('export') && x.textContent.trim().endsWith(e) && !x.disabled)
      b?.click(); return !!b
    }, ext)
    if (!clicked) fail(`no export ${ext} button`)
    for (let i = 0; i < 50; i++) {
      const f = readdirSync(downloads).find((n) => n.endsWith(ext))
      if (f) return join(downloads, f)
      await wait(100)
    }
    fail(`no ${ext} download`)
  }
  const clip = JSON.parse(readFileSync(await exportAs('clip', '.clip.json'), 'utf8'))
  const feet = clip.feet?.length ?? 0
  if (clip.format !== 'hackbuild.clip' || clip.frames < 10 || clip.rotations.length !== clip.frames * clip.bones.length * 4 || clip.root.length !== clip.frames * 4 || clip.contacts.length !== clip.frames * feet) {
    fail(`the clip is not whole: ${JSON.stringify({ format: clip.format, frames: clip.frames, bones: clip.bones?.length, rot: clip.rotations?.length, root: clip.root?.length, contacts: clip.contacts?.length })}`)
  }
  detail += `; the clip exported ${clip.frames} frames of ${clip.bones.length} bones`
  if (mode === 'motionmatch') {
    const csv = readFileSync(await exportAs('trace', '.csv'), 'utf8').trim().split('\n')
    if (csv[0] !== 't,clip,frame,cost,jumped,speed,turn_rate' || csv.length < 20) fail(`the trace is not whole: ${csv.slice(0, 2)}`)
    detail += ` and the trace ${csv.length - 1} rows`
  }
  await page.close()

  if (errors.length) fail('console errors')
  if (off.length) fail(`requests off file://: ${off.slice(0, 5).join(', ')}`)
  console.log(`${name}: ok. ${detail}; 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
