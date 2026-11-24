// smoke-stage: the phone stage lab page (#/lab/phone-stage) from the single
// file build on file://, as a phone (touch, coarse pointer). The 3d stage
// starts and draws pixels that are not one flat colour; a press up on the
// pad walks the body forward (away from the camera); resizing to 390 by
// 664 and then 844 by 390 keeps the canvas at its box with a drawing
// buffer of box times pixel ratio; the fps telemetry reads a number.
// Any request off file:// or console error fails the run.
//   npm run build:single && node tools/smoke-stage.mjs [--shot <file.png>]
// --shot saves the 844 by 390 landscape view as a PNG.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const url = `${pathToFileURL(file).href}#/lab/phone-stage`
const shotAt = process.argv.indexOf('--shot')
const shot = shotAt > 0 ? resolve(process.argv[shotAt + 1]) : ''
const profile = mkdtempSync(join(tmpdir(), 'suite-stage-'))
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, userDataDir: profile,
  args: ['--no-first-run', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const errors = []
const off = []
const fail = (why) => { throw new Error(errors.length ? `${why}\nconsole errors:\n${errors.join('\n')}` : why) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const phone = (width, height) => ({ width, height, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
try {
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) off.push(r.url()) })
  await page.setViewport(phone(390, 664))
  const cdp = await page.createCDPSession()
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }, { name: 'any-pointer', value: 'coarse' }] })
  await page.goto(url, { waitUntil: 'load' })

  await page.waitForFunction(() => document.querySelector('.hb-viewport-media')?.phoneStage && !document.querySelector('.hb-vp-cover'), { timeout: 15000 })
    .catch(async () => fail(`the stage did not start: ${await page.evaluate(() => document.querySelector('.hb-vp-cover')?.textContent ?? 'no cover')}`))
  if (await page.evaluate(() => !!document.querySelector('.hb-suite-nav, .hb-suitenav'))) fail('the suite shell drew around the lab page')

  // pixels: one frame rendered and read in the same task, more than a flat fill
  await wait(600)
  const px = await page.evaluate(async () => {
    const ps = document.querySelector('.hb-viewport-media').phoneStage
    const blob = await ps.stage.snapshot()
    const bmp = await createImageBitmap(blob)
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const g = c.getContext('2d')
    g.drawImage(bmp, 0, 0)
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data
    const colours = new Set()
    let lit = 0
    for (let i = 0; i < d.length; i += 4 * 7) {
      colours.add((d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3))
      if (d[i + 3] > 0 && d[i] + d[i + 1] + d[i + 2] > 30) lit++
    }
    return { w: bmp.width, h: bmp.height, colours: colours.size, lit }
  })
  if (px.colours < 8 || px.lit < 100) fail(`the canvas looks blank: ${JSON.stringify(px)}`)

  // pad: press up (forward is y < 0) for a second; the body walks away from the camera (-z here)
  const pos = () => page.evaluate(() => document.querySelector('.hb-viewport-media').phoneStage.position())
  const before = await pos()
  const r = await page.$eval('.hb-pad-base', (e) => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, h: b.height } })
  if (!r.h) fail('the pad is not shown on a coarse pointer')
  await page.touchscreen.touchStart(r.x, r.y)
  for (let i = 1; i <= 5; i++) { await page.touchscreen.touchMove(r.x, r.y - r.h * 0.1 * i); await wait(16) }
  await wait(1000)
  await page.touchscreen.touchEnd()
  const after = await pos()
  const walked = Math.hypot(after.x - before.x, after.z - before.z)
  if (walked < 0.3 || after.z >= before.z) fail(`the pad did not walk the body forward: ${JSON.stringify({ before, after })}`)

  // resize: canvas css size equals its box, drawing buffer is box times ratio
  const sizes = []
  for (const [w, h] of [[390, 664], [844, 390]]) {
    await page.setViewport(phone(w, h))
    await wait(700)
    const s = await page.evaluate(() => {
      const host = document.querySelector('.hb-viewport-media')
      const cv = host.querySelector('canvas')
      const b = host.getBoundingClientRect()
      const c = cv.getBoundingClientRect()
      const pr = host.phoneStage.stage.renderer.getPixelRatio()
      return { box: [Math.round(b.width), Math.round(b.height)], css: [Math.round(c.width), Math.round(c.height)], buf: [cv.width, cv.height], pr, scroll: document.documentElement.scrollWidth > innerWidth }
    })
    const want = [Math.round(s.box[0] * s.pr), Math.round(s.box[1] * s.pr)]
    if (s.css[0] !== s.box[0] || s.css[1] !== s.box[1]) fail(`at ${w}x${h} the canvas is ${s.css} in a ${s.box} box`)
    if (Math.abs(s.buf[0] - want[0]) > 1 || Math.abs(s.buf[1] - want[1]) > 1) fail(`at ${w}x${h} the buffer is ${s.buf}, want ${want}`)
    if (s.scroll) fail(`sideways scroll at ${w}x${h}`)
    if (shot && w === 844) await page.screenshot({ path: shot })
    sizes.push(`${w}x${h} box ${s.box.join('x')} buffer ${s.buf.join('x')} ratio ${s.pr}`)
  }

  // telemetry: fps and draw size read numbers
  await page.waitForFunction(() => /^\d+$/.test([...document.querySelectorAll('.hb-ov-tele .hb-hudstat')].find((e) => e.textContent.startsWith('fps'))?.querySelector('b')?.textContent ?? ''), { timeout: 5000 })
    .catch(() => fail('no fps in the telemetry slot'))
  const tele = await page.$$eval('.hb-ov-tele .hb-hudstat', (els) => els.map((e) => e.textContent.trim()).join(', '))

  if (off.length) fail(`requests off file://: ${off.join(', ')}`)
  if (errors.length) fail('console errors')
  console.log(`smoke-stage: ok. ${px.colours} colours, walked ${walked.toFixed(2)} m forward in 1 s, ${sizes.join('; ')}, telemetry ${tele} (measured headless, software gl), 0 requests off file://`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
