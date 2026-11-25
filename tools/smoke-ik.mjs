// smoke-ik: the ik tool on #/motion/ik from the single file build on
// file://, as a phone (touch, coarse pointer). The left hand target is
// dragged by touch and the hand reaches it within tolerance; the hips are
// dragged down by mouse and both planted feet stay where they stood; a
// target dragged past the arm's reach shows the reach copy; the pose
// exports as json. Any request off file:// or console error fails the run.
//   npm run build:single && node tools/smoke-ik.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const url = `${pathToFileURL(file).href}#/motion/ik`
/** Hand to target, meters (proposed: a solved two bone chain lands within microns; this leaves room for a frame of lag). */
const TOLERANCE = 0.005

const profile = mkdtempSync(join(tmpdir(), 'suite-ik-'))
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
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

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
  await page.waitForFunction(() => document.querySelector('.hb-viewport-host')?.ik, { timeout: 20000 })
    .catch(async () => fail(`the tool did not start: ${await page.evaluate(() => document.querySelector('.hb-viewport')?.textContent ?? 'no stage')}`))
  const st = (fn, ...a) => page.evaluate(fn, ...a)
  const ik = (fn, ...a) => page.evaluate((src, ...b) => (0, eval)(src)(document.querySelector('.hb-viewport-host').ik, ...b), fn.toString(), ...a)
  const drawn = async (k = 3) => {
    for (let i = 0; i < k; i++) {
      const f0 = await st(() => document.querySelector('.hb-viewport-host').stageTool.walk.stage.loop.frames)
      await page.waitForFunction((f) => document.querySelector('.hb-viewport-host').stageTool.walk.stage.loop.frames > f, { timeout: 10000 }, f0)
    }
  }
  await drawn(5)
  await page.evaluate(() => document.querySelector('.hb-viewport').scrollIntoView({ block: 'start' }))
  await drawn(2)

  const footL0 = await ik((h) => h.where('leftFoot'))
  const footR0 = await ik((h) => h.where('rightFoot'))
  const hips0 = await ik((h) => h.where('hips'))

  // drag the left hand target by touch
  const handT0 = await ik((h) => h.target('leftHand'))
  const s = await ik((h) => h.screenOf('leftHand'))
  const to = { x: s.x - 20, y: s.y - 70 }
  await page.touchscreen.touchStart(s.x, s.y)
  for (let i = 1; i <= 8; i++) await page.touchscreen.touchMove(s.x + ((to.x - s.x) * i) / 8, s.y + ((to.y - s.y) * i) / 8)
  await page.touchscreen.touchEnd()
  await drawn(3)
  const handT = await ik((h) => h.target('leftHand'))
  const hand = await ik((h) => h.where('leftHand'))
  const live = await ik((h) => ({ pinned: h.live.pinned, chain: h.opts.chain }))
  const moved = dist(handT, handT0)
  if (!live.pinned) fail('the dragged hand target is not pinned')
  const handErr = dist(hand, handT)
  if (!(handErr < TOLERANCE)) fail(`the hand is ${(handErr * 1000).toFixed(1)} mm from its target`)
  if (!(moved > 0.05)) fail(`the hand target barely moved: ${moved.toFixed(3)} m`)

  // drag the hips down by mouse: the feet stay planted
  const hs = await ik((h) => h.screenOf('hips'))
  await page.mouse.move(hs.x, hs.y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(hs.x, hs.y + (60 * i) / 8)
  await page.mouse.up()
  await drawn(4)
  const hips1 = await ik((h) => h.where('hips'))
  const drop = hips0[1] - hips1[1]
  if (!(drop > 0.08)) fail(`the hips did not go down: ${drop.toFixed(3)} m`)
  const slipL = dist(footL0, await ik((h) => h.where('leftFoot')))
  const slipR = dist(footR0, await ik((h) => h.where('rightFoot')))
  if (!(Math.max(slipL, slipR) < TOLERANCE)) fail(`a planted foot slid: left ${(slipL * 1000).toFixed(1)} mm, right ${(slipR * 1000).toFixed(1)} mm`)
  const hand2 = dist(await ik((h) => h.where('leftHand')), handT)
  if (!(hand2 < TOLERANCE)) fail(`the pinned hand let go when the hips moved: ${(hand2 * 1000).toFixed(1)} mm`)

  // past the reach of the arm: the copy says by how much
  await page.evaluate(() => [...document.querySelectorAll('[data-pane="chain"] button')].find((b) => b.textContent.trim() === 'right arm')?.click())
  const rs = await ik((h) => h.screenOf('rightHand'))
  await page.touchscreen.touchStart(rs.x, rs.y)
  for (let i = 1; i <= 6; i++) await page.touchscreen.touchMove(rs.x - (150 * i) / 6, rs.y - (40 * i) / 6)
  await page.touchscreen.touchEnd()
  await drawn(3)
  await page.waitForFunction(() => /out of reach by \d\.\d\d m\. the chain is fully extended\./.test(document.querySelector('[data-reach="over"]')?.textContent ?? ''), { timeout: 4000 })
    .catch(async () => fail(`no reach copy: ${await ik((h) => JSON.stringify(h.live))}`))
  const reachCopy = await st(() => document.querySelector('[data-reach="over"]').textContent.trim())

  // export the pose
  await page.evaluate(() => [...document.querySelectorAll('.hb-export-formats button')].find((b) => b.textContent.trim() === 'pose')?.click())
  await wait(100)
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.hb-export button')].find((e) => /^export .*\.pose\.json$/.test(e.textContent.trim()) && !e.disabled)
    b?.click(); return !!b
  })
  if (!clicked) fail('no export pose button')
  let out = null
  for (let i = 0; i < 50 && !out; i++) {
    const f = readdirSync(downloads).find((n) => n.endsWith('.pose.json'))
    if (f) out = join(downloads, f)
    else await wait(100)
  }
  if (!out) fail('no .pose.json download')
  const j = JSON.parse(readFileSync(out, 'utf8'))
  if (j.format !== 'hackbuild.pose' || !j.rotations.leftUpperArm || !j.rotations.leftLowerLeg || !j.targets.leftHand || !j.targets.hips) fail(`the export is not the pose: ${JSON.stringify(j).slice(0, 200)}`)
  await page.close()

  if (errors.length) fail('console errors')
  if (off.length) fail(`requests off file://: ${off.slice(0, 5).join(', ')}`)
  console.log(`smoke-ik: ok. a touch drag moved the left hand target ${(moved * 100).toFixed(1)} cm and the hand reached it within ${(handErr * 1000).toFixed(3)} mm; a mouse drag lowered the hips ${(drop * 100).toFixed(1)} cm while the planted feet moved ${(Math.max(slipL, slipR) * 1000).toFixed(3)} mm and the hand held within ${(hand2 * 1000).toFixed(3)} mm; a far drag said "${reachCopy}"; the pose exported with ${Object.keys(j.rotations).length} bone rotations; 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
