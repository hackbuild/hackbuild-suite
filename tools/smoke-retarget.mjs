// smoke-retarget: the retarget tool on #/motion/retarget from the single
// file build on file://, as a phone (touch, coarse pointer). Fixtures made
// here: a target glb with game engine bone names, a source bvh with other
// names and one joint no mapper reads, and a vmd. The target lands, the
// source is picked and the auto map fills, the unread joint is mapped by
// hand, the clip plays and scrubs and the target shin follows the source
// shin, the motion exports as hbm and opens back as the source with the
// same pose, and a vmd plays on the rig. Any request off file:// or console
// error fails the run.
//   npm run build:single && node tools/smoke-retarget.mjs
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'
import { REMAP, SOURCE_SECONDS, TARGET_NAMES, sourceBvh, sourceVmd, targetGlb } from './retarget-fixtures.mjs'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const url = `${pathToFileURL(file).href}#/motion/retarget`

const profile = mkdtempSync(join(tmpdir(), 'suite-retarget-'))
const downloads = join(profile, 'downloads')
mkdirSync(downloads)
const bvhPath = join(profile, 'kick.bvh')
writeFileSync(bvhPath, sourceBvh())
const GLB = targetGlb()
const VMD = sourceVmd()
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, userDataDir: profile,
  args: ['--no-first-run', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const errors = []
const off = []
const fail = (why) => { throw new Error(errors.length ? `${why}\nconsole errors:\n${errors.join('\n')}` : why) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const angle = (a, b) => (a && b ? (Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI : NaN)

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
  await page.waitForFunction(() => document.querySelector('.hb-viewport-host')?.retarget?.result.value, { timeout: 20000 })
    .catch(async () => fail(`the built in walk did not retarget: ${await page.evaluate(() => document.querySelector('.hb-viewport')?.textContent ?? 'no stage')}`))
  const st = (fn, ...a) => page.evaluate(fn, ...a)
  const drawn = async () => {
    const f0 = await st(() => document.querySelector('.hb-viewport-host').stageTool.walk.stage.loop.frames)
    await page.waitForFunction((f) => document.querySelector('.hb-viewport-host').stageTool.walk.stage.loop.frames > f + 1, { timeout: 10000 }, f0)
  }
  const dir = (w, b) => st((x, y) => document.querySelector('.hb-viewport-host').retarget.dir(x, y), w, b)
  const seekTo = async (v) => {
    await st((t) => { const s = document.querySelector('.hb-tp-scrub'); s.value = String(t); s.dispatchEvent(new Event('input', { bubbles: true })) }, v)
    await drawn()
  }
  const mapText = () => st(() => document.querySelector('[data-pane="map"]').textContent)
  const sourceOf = (bone) => st((b) => {
    const cell = document.querySelector(`[data-pane="map"] [data-bone="${b}"]`)?.closest('tr')
    return cell?.querySelector('select')?.value ?? null
  }, bone)

  // the target lands
  await page.evaluate((b64) => {
    const dt = new DataTransfer()
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'smoke-target.glb', { type: 'model/gltf-binary' }))
    for (const k of ['dragenter', 'dragover', 'drop']) document.body.dispatchEvent(new DragEvent(k, { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, GLB.toString('base64'))
  await page.waitForFunction((n) => document.querySelector('[data-pane="map"]')?.textContent.includes(n), { timeout: 15000 }, TARGET_NAMES.leftUpperLeg)
    .catch(async () => fail(`the target did not land: ${await st(() => document.querySelector('.hb-viewport-host').stageTool.body.line)}`))

  // the source is picked and the auto map fills, the unread joint left out
  const input = await page.$('input[data-import="source"]')
  await input.uploadFile(bvhPath)
  await page.waitForFunction(() => /kick, bvh/.test(document.querySelector('.is-side').textContent), { timeout: 8000 }).catch(() => fail('the bvh did not become the source'))
  await wait(200)
  const found = Number(/(\d+) of \d+ body bones found on the source/.exec(await mapText())?.[1] ?? 0)
  if (found < 14) fail(`the auto map found ${found} bones: ${await mapText()}`)
  if (await sourceOf('leftUpperLeg') !== 'LeftUpLeg') fail(`leftUpperLeg is not on LeftUpLeg: ${await sourceOf('leftUpperLeg')}`)
  if (await sourceOf(REMAP.bone) !== '') fail(`${REMAP.bone} should be unmapped before the edit: ${await sourceOf(REMAP.bone)}`)
  const missingLine = await st(() => document.querySelector('.hb-viewport-host').stageTool.body.line)

  // one manual remap
  await page.evaluate((b, j) => {
    const sel = document.querySelector(`[data-pane="map"] [data-bone="${b}"]`).closest('tr').querySelector('select')
    sel.value = j
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  }, REMAP.bone, REMAP.joint)
  await page.waitForFunction((b) => document.querySelector(`[data-pane="map"] [data-bone="${b}"]`)?.textContent.includes('*'), { timeout: 5000 }, REMAP.bone)
    .catch(() => fail('the hand edit did not show in the map'))
  if (!(await st(() => document.querySelector('.hb-viewport-host').retarget.result.value))) fail('no retarget after the hand edit')
  const dur = await st(() => document.querySelector('.hb-viewport-host').stageTool.transport.duration)
  if (Math.abs(dur - (SOURCE_SECONDS - 1 / 30)) > 0.05) fail(`the transport length is not the clip's: ${dur}`)

  // play and scrub
  if (!(await st(() => document.querySelector('.hb-viewport-host').stageTool.transport.playing))) await page.click('.hb-transport .hb-tp-btn.is-play')
  const t0 = await st(() => document.querySelector('.hb-viewport-host').stageTool.transport.time)
  await drawn(); await drawn()
  if (!((await st(() => document.querySelector('.hb-viewport-host').stageTool.transport.time)) !== t0)) fail('the clip did not play')
  await page.click('.hb-transport .hb-tp-btn.is-play')
  const follow = []
  for (const t of [0.1, 0.5]) {
    await seekTo(t)
    for (const b of ['leftUpperLeg', REMAP.bone]) follow.push({ t, b, src: await dir('source', b), dst: await dir('target', b) })
  }
  for (const f of follow) if (!(angle(f.src, f.dst) < 15)) fail(`the target ${f.b} does not follow the source at ${f.t} s: ${angle(f.src, f.dst).toFixed(1)} degrees apart`)
  const swing = angle(follow[1].dst, follow[3].dst)
  if (!(swing > 20)) fail(`the target shin did not move between 0.1 s and 0.5 s: ${swing}`)
  const before = await dir('target', REMAP.bone)

  // export the motion and open it back as the source
  await page.evaluate(() => [...document.querySelectorAll('.hb-export-formats button')].find((b) => b.textContent.trim() === 'motion')?.click())
  await wait(100)
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.hb-export button')].find((e) => /^export .*\.hbm$/.test(e.textContent.trim()) && !e.disabled)
    b?.click(); return !!b
  })
  if (!clicked) fail('no export motion button')
  let hbm = null
  for (let i = 0; i < 50 && !hbm; i++) {
    const f = readdirSync(downloads).find((n) => n.endsWith('.hbm'))
    if (f) hbm = join(downloads, f)
    else await wait(100)
  }
  if (!hbm) fail('no .hbm download')
  await input.uploadFile(hbm)
  await page.waitForFunction(() => /, hbm/.test(document.querySelector('.is-side').textContent), { timeout: 8000 }).catch(() => fail('the hbm did not open as the source'))
  await seekTo(0.5)
  const back = await dir('target', REMAP.bone)
  const drift = angle(before, back)
  if (!(drift < 3)) fail(`the motion read back is not the one exported: ${drift} degrees apart`)

  // a vmd plays on the rig
  await page.evaluate((b64) => {
    const dt = new DataTransfer()
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'arm.vmd'))
    for (const k of ['dragenter', 'dragover', 'drop']) document.body.dispatchEvent(new DragEvent(k, { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, VMD.toString('base64'))
  await page.waitForFunction(() => /arm, vmd/.test(document.querySelector('.is-side').textContent), { timeout: 8000 }).catch(() => fail('the vmd did not become the source'))
  await seekTo(0); const v0 = await dir('target', 'leftUpperArm')
  await seekTo(0.9); const v1 = await dir('target', 'leftUpperArm')
  const vmdSwing = angle(v0, v1)
  if (!(vmdSwing > 20)) fail(`the vmd did not move the target arm: ${vmdSwing}`)
  await page.close()

  if (errors.length) fail('console errors')
  if (off.length) fail(`requests off file://: ${off.slice(0, 5).join(', ')}`)
  const worst = Math.max(...follow.map((f) => angle(f.src, f.dst)))
  console.log(`smoke-retarget: ok. a ${GLB.length} byte target glb with engine bone names landed; the bvh source auto mapped ${found} of 25 body bones and left ${REMAP.joint} out ("${missingLine}"); ${REMAP.joint} mapped by hand to ${REMAP.bone}; the clip played and scrubbed; at 0.1 s and 0.5 s the target thigh and shin point within ${worst.toFixed(1)} degrees of the source, the shin swinging ${swing.toFixed(0)} degrees; the motion exported as hbm and read back within ${drift.toFixed(2)} degrees; a ${VMD.length} byte vmd turned the target arm ${vmdSwing.toFixed(0)} degrees; 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
