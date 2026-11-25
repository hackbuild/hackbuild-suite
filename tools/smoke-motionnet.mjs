// smoke-motionnet: the motion-net tool from the single file build on
// file:// with the stub network (?stub), as a phone (touch, coarse pointer).
// A forced weights failure falls back to the procedural gait and says so,
// and the pad still walks it; the stub network then loads, the pad changes
// the network's pose and moves its root, the inference time is on the page,
// and the run exports as a clip of the 27 bones. Any request off file:// or
// console error fails the run.
//   npm run build:single && node tools/smoke-motionnet.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const url = `${pathToFileURL(file).href}?stub#/motion/motion-net`

const profile = mkdtempSync(join(tmpdir(), 'suite-motionnet-'))
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
  await page.waitForFunction(() => document.querySelector('.hb-viewport-host')?.motionnet, { timeout: 20000 })
    .catch(async () => fail(`the tool did not start: ${await page.evaluate(() => document.querySelector('.hb-viewport')?.textContent ?? 'no stage')}`))
  const h = (fn, ...a) => page.evaluate((src, ...b) => (0, eval)(src)(document.querySelector('.hb-viewport-host').motionnet, ...b), fn.toString(), ...a)
  const lineText = () => page.$eval('[data-line="weights"]', (e) => e.textContent.trim())
  await wait(800)
  const first = await lineText()
  if (!/^no weights loaded\. the procedural gait is running\..*17\.7 mb\.$/.test(first)) fail(`the empty line is wrong: ${first}`)

  const press = (label) => page.evaluate((l) => {
    const b = [...document.querySelectorAll('.hb-loader-actions button')].find((x) => x.textContent.trim().startsWith(l))
    b?.click(); return !!b
  }, label)
  const until = async (fn, what) => {
    for (let i = 0; i < 100; i++) { if (await h(fn)) return; await wait(50) }
    fail(`timed out waiting for ${what}: ${JSON.stringify(await h((m) => m.w))}`)
  }

  const pad = async (ms) => {
    await page.evaluate(() => document.querySelector('.hb-viewport').scrollIntoView({ block: 'start' }))
    const r = await page.$eval('.hb-pad-base', (e) => { const x = e.getBoundingClientRect(); return { x: x.x + x.width / 2, y: x.y + x.height / 2, h: x.height } })
    if (!r.h) fail('the pad is not shown on a coarse pointer')
    const before = await h((m) => m.root())
    await page.touchscreen.touchStart(r.x, r.y)
    for (let i = 1; i <= 5; i++) { await page.touchscreen.touchMove(r.x, r.y - r.h * 0.1 * i); await wait(16) }
    await wait(ms)
    const live = await h((m) => JSON.parse(JSON.stringify(m.live)))
    await page.touchscreen.touchEnd()
    const after = await h((m) => m.root())
    return { walked: Math.hypot(after.x - before.x, after.z - before.z), live }
  }

  // forced weights failure: the procedural gait walks and the line says so
  await h((m) => m.failNext())
  if (!(await press('load'))) fail('no load button')
  await until((m) => m.w.state === 'failed', 'the forced failure')
  const failed = await lineText()
  if (!/^the weights did not load: .+\. the procedural gait is running\.$/.test(failed)) fail(`the failure line is wrong: ${failed}`)
  const fall = await pad(1500)
  if (fall.walked < 0.4 || fall.live.source !== 'procedural') fail(`the fallback did not walk: ${JSON.stringify(fall)}`)

  // the stub network
  if (!(await press('load'))) fail('no load button after the failure')
  await until((m) => m.w.state === 'ready', 'the stub network')
  const ready = await lineText()
  if (!/^the stub network is running/.test(ready)) fail(`the ready line is wrong: ${ready}`)
  await wait(500)
  const pose0 = await h((m) => m.pose())
  const run = await pad(2500)
  const pose1 = await h((m) => m.pose())
  if (pose0.length !== 81 || pose1.length !== 81) fail(`no network pose: ${pose0.length}`)
  // the pose relative to the root changes under the pad: the paws swing
  const rel = (p) => p.map((v, i) => v - p[i % 3])
  const moved = Math.max(...rel(pose1).map((v, i) => Math.abs(v - rel(pose0)[i])))
  if (run.walked < 0.5 || run.live.source !== 'neural' || moved < 0.02) fail(`the pad did not drive the network: ${JSON.stringify({ walked: run.walked, moved, live: run.live })}`)
  const infer = await page.$eval('[data-infer]', (e) => e.textContent)
  if (!/\d+\.\d+ ms \(measured\)/.test(infer) || !(run.live.evalMs >= 0) || !(run.live.received > 5)) fail(`no inference time: ${infer}`)

  // export
  await page.evaluate(() => [...document.querySelectorAll('.hb-fold summary, .hb-fold > button')].find((b) => /export/.test(b.textContent))?.click())
  await wait(200)
  await page.evaluate(() => [...document.querySelectorAll('.hb-export-formats button')].find((b) => b.textContent.trim() === 'clip')?.click())
  await wait(100)
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.hb-export button')].find((x) => x.textContent.trim().startsWith('export') && x.textContent.trim().endsWith('.clip.json') && !x.disabled)
    b?.click(); return !!b
  })
  if (!clicked) fail('no export .clip.json button')
  let got = ''
  for (let i = 0; i < 50 && !got; i++) { got = readdirSync(downloads).find((n) => n.endsWith('.clip.json')) ?? ''; if (!got) await wait(100) }
  if (!got) fail('no .clip.json download')
  const clip = JSON.parse(readFileSync(join(downloads, got), 'utf8'))
  if (clip.format !== 'hackbuild.clip' || clip.source !== 'motion-net' || clip.bones.length !== 27 || clip.frames < 10 || clip.rotations.length !== clip.frames * 27 * 4 || clip.contacts.length !== clip.frames * 4) {
    fail(`the clip is not whole: ${JSON.stringify({ format: clip.format, source: clip.source, frames: clip.frames, bones: clip.bones?.length, rot: clip.rotations?.length, contacts: clip.contacts?.length })}`)
  }
  await page.close()

  if (errors.length) fail('console errors')
  if (off.length) fail(`requests off file://: ${off.slice(0, 5).join(', ')}`)
  console.log(`smoke-motionnet: ok. the forced failure said "${failed}" and the procedural dog walked ${fall.walked.toFixed(2)} m; the stub network walked ${run.walked.toFixed(2)} m at ${run.live.speed.toFixed(2)} m/s, style ${run.live.style}, a bone moved ${(moved * 1000).toFixed(0)} mm against the hips, inference ${run.live.evalMs.toFixed(2)} ms on the page; the clip exported ${clip.frames} frames of ${clip.bones.length} bones; 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
