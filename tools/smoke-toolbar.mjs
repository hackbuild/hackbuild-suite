// smoke-toolbar: the shared stage toolbar of the motion and agents tools on
// its fixture route (#/motion/avatar) from the single file build on
// file://, as a phone (touch, coarse pointer). The transport moves time
// while playing, holds it on pause, and the scrub and the period key move
// it; a seed puts the body on the same spot every time it is chosen and
// another seed elsewhere; the camera chips switch the view; the pad walks
// the body; a stand in glb dropped on the page lands on the stage, not in
// the import ring; the tune drawer edits a value that survives a reload.
// Any request off file:// or console error fails the run.
//   npm run build:single && node tools/smoke-toolbar.mjs
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'
import { standInGlb } from './stand-in-glb.mjs'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const url = `${pathToFileURL(file).href}#/motion/avatar`
const GLB = standInGlb()
const BODY = 'stand-in-body.glb'

const profile = mkdtempSync(join(tmpdir(), 'suite-toolbar-'))
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, userDataDir: profile,
  args: ['--no-first-run', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const errors = []
const off = []
const fail = (why) => { throw new Error(errors.length ? `${why}\nconsole errors:\n${errors.join('\n')}` : why) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e

try {
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) off.push(r.url()) })
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  const cdp = await page.createCDPSession()
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }, { name: 'any-pointer', value: 'coarse' }] })
  // Ready is more than the cover gone: the avatar view adopts the body
  // once its lazy inspect chunk lands, and that seeks the transport to 0;
  // the first frames also stall on shader compiles. Wait for the rig panel
  // to read the body and for the fps stat to show a measured rate.
  const ready = async () => {
    await page.waitForFunction(() => document.querySelector('.hb-viewport-host')?.stageTool && !document.querySelector('.hb-vp-cover'), { timeout: 15000 })
      .catch(async () => fail(`the stage did not start: ${await page.evaluate(() => document.querySelector('.hb-vp-cover')?.textContent ?? 'no cover')}`))
    await page.waitForFunction(() => {
      const hints = [...document.querySelectorAll('.hb-hint')].map((h) => h.textContent.trim())
      const fps = [...document.querySelectorAll('.hb-viewport b')].map((b) => b.textContent.trim())
      return !hints.includes('the stage is starting.') && fps.length && Number.isFinite(Number(fps[0]))
    }, { timeout: 15000 }).catch(() => fail('the avatar view did not read the body, or the stage drew no frames'))
  }
  await page.goto(url, { waitUntil: 'load' })
  await ready()
  const st = (fn, ...a) => page.evaluate(fn, ...a)
  const time = () => st(() => document.querySelector('.hb-viewport-host').stageTool.transport.time)

  // transport: playing moves time, pause holds it, the scrub and the period key move it
  const t0 = await time()
  await wait(800)
  const t1 = await time()
  if (!(t1 > t0 + 0.2)) fail(`time did not move while playing: ${t0} to ${t1}`)
  await page.click('.hb-transport .hb-tp-btn.is-play')
  const p0 = await time()
  await wait(500)
  if (!near(await time(), p0)) fail('time moved while paused')
  await st(() => { const s = document.querySelector('.hb-tp-scrub'); s.value = '4'; s.dispatchEvent(new Event('input', { bubbles: true })) })
  if (!near(await time(), 4)) fail(`the scrub did not seek: ${await time()}`)
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Period')
  if (!near(await time(), 4 + 1 / 30, 1e-4)) fail(`the period key did not step one frame: ${await time()}`)
  await page.keyboard.press('Space')
  await wait(400)
  if (!(await time() > 4.1)) fail('space did not play')

  // seed: the same seed starts the body on the same spot, another seed elsewhere
  const pos = () => st(() => document.querySelector('.hb-viewport-host').stageTool.walk.position())
  const setSeed = (n) => page.evaluate((v) => {
    const i = document.querySelector('.hb-seed-input')
    i.value = String(v)
    i.dispatchEvent(new Event('input', { bubbles: true }))
    i.dispatchEvent(new Event('change', { bubbles: true }))
  }, n)
  await setSeed(11); await wait(100)
  const a = await pos()
  await setSeed(12); await wait(100)
  const b = await pos()
  await setSeed(11); await wait(100)
  const a2 = await pos()
  if (!(near(a.x, a2.x) && near(a.z, a2.z))) fail(`seed 11 gave two spots: ${JSON.stringify({ a, a2 })}`)
  if (near(a.x, b.x) && near(a.z, b.z)) fail('seeds 11 and 12 gave the same spot')

  // camera chips: each switches the view, and the view holds
  const cam = () => st(() => {
    const s = document.querySelector('.hb-viewport-host').stageTool.walk.stage
    const p = s.camera.position.clone().sub(s.controls.target).normalize()
    return { x: p.x, y: p.y, z: p.z }
  })
  const chip = (label) => page.evaluate((l) => [...document.querySelectorAll('.hb-cams .hb-chip')].find((c) => c.textContent.trim().startsWith(l)).click(), label)
  await chip('side'); await wait(600)
  const side = await cam()
  if (Math.abs(side.x) < 0.8) fail(`the side chip did not view from the side: ${JSON.stringify(side)}`)
  await chip('top'); await wait(600)
  const top = await cam()
  if (top.y < 0.8) fail(`the top chip did not view from above: ${JSON.stringify(top)}`)
  const pressed = await page.evaluate(() => [...document.querySelectorAll('.hb-cams .hb-chip')].filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.textContent.trim()))
  if (pressed.length !== 1 || !pressed[0].startsWith('top')) fail(`the chips do not show one view on: ${pressed}`)
  await chip('front'); await wait(300)

  // pad: press up for a second; the body walks
  const before = await pos()
  const r = await page.$eval('.hb-pad-base', (e) => { const x = e.getBoundingClientRect(); return { x: x.x + x.width / 2, y: x.y + x.height / 2, h: x.height } })
  if (!r.h) fail('the pad is not shown on a coarse pointer')
  await page.touchscreen.touchStart(r.x, r.y)
  for (let i = 1; i <= 5; i++) { await page.touchscreen.touchMove(r.x, r.y - r.h * 0.1 * i); await wait(16) }
  await wait(1000)
  await page.touchscreen.touchEnd()
  const after = await pos()
  const walked = Math.hypot(after.x - before.x, after.z - before.z)
  if (walked < 0.3) fail(`the pad did not walk the body: ${JSON.stringify({ before, after })}`)

  // drop: a stand in glb dropped on the page lands on the stage
  await page.evaluate((b64, name) => {
    const dt = new DataTransfer()
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type: 'model/gltf-binary' }))
    for (const k of ['dragenter', 'dragover', 'drop']) document.body.dispatchEvent(new DragEvent(k, { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, GLB.toString('base64'), BODY)
  await page.waitForFunction(() => { const t = document.querySelector('.hb-viewport-host').stageTool; return !t.body.placeholder && !t.walk.stage.body?.placeholder }, { timeout: 15000 })
    .catch(async () => fail(`the dropped glb did not land on the stage: ${await st(() => document.querySelector('.hb-viewport-host').stageTool.body.line)}`))
  if (await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].some((d) => d.checkVisibility()))) fail('the drop opened an import dialog')
  if (await page.evaluate(() => !!document.querySelector('.hb-dropzone.is-cover.is-over'))) fail('the drop cover stayed up after the drop')
  const caption = await page.evaluate(() => document.querySelector('.hb-viewport').textContent)
  if (!caption.includes('stays in this tab')) fail('the caption does not say the body stays in this tab')

  // tune: the drawer edits a registry value; it survives a reload
  await page.evaluate(() => [...document.querySelectorAll('.hb-bar button')].find((b) => b.textContent.trim() === 'tune').click())
  await page.waitForSelector('.hb-drawer .hb-prow', { visible: true, timeout: 3000 }).catch(() => fail('the tune drawer did not open'))
  const rows = await page.evaluate(() => [...document.querySelectorAll('.hb-drawer .hb-prow-name')].map((n) => n.textContent.trim()))
  if (!rows.includes('speed') || !rows.includes('spread')) fail(`the drawer rows are not the registry: ${rows}`)
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.hb-drawer .hb-prow')].find((r) => r.querySelector('.hb-prow-name').textContent.trim() === 'speed')
    const i = row.querySelector('input[type="range"]')
    i.value = '2.5'
    i.dispatchEvent(new Event('input', { bubbles: true }))
    i.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const speed = await st(() => document.querySelector('.hb-viewport-host').stageTool.reg.get('walk.speed'))
  if (!near(speed, 2.5)) fail(`the drawer did not set the speed: ${speed}`)
  await page.reload({ waitUntil: 'load' })
  await ready()
  const kept = await st(() => document.querySelector('.hb-viewport-host').stageTool.reg.get('walk.speed'))
  if (!near(kept, 2.5)) fail(`the speed did not persist across a reload: ${kept}`)
  await page.close()

  if (errors.length) fail('console errors')
  if (off.length) fail(`requests off file://: ${off.slice(0, 5).join(', ')}`)
  console.log(`smoke-toolbar: ok. play moved time ${(t1 - t0).toFixed(2)} s in 0.8 s, pause held it, scrub and the period key moved it; seed 11 gave one spot twice and seed 12 another; side and top chips switched the view; the pad walked ${walked.toFixed(2)} m; a stand in glb (${GLB.length} bytes) dropped on the page landed on the stage; the drawer set speed 2.5 m/s and it survived a reload; 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
