// smoke-avatar: the avatar tool on #/motion/avatar from the single file
// build on file://, as a phone (touch, coarse pointer). A procedural glb
// made here (a humanoid bone tree, two blendshapes, one clip) is dropped on
// the page; the rig tree lists its bones; a blendshape slider sets the
// morph weight on the mesh; the file's clip plays and scrubs, and the same
// time gives the same pose; a pose exports as json and imports back to the
// same bones. Any request off file:// or console error fails the run.
//   npm run build:single && node tools/smoke-avatar.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'
import { avatarGlb, CLIP, MORPHS } from './avatar-glb.mjs'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const url = `${pathToFileURL(file).href}#/motion/avatar`
const GLB = avatarGlb()
const BODY = 'smoke-body.glb'

const profile = mkdtempSync(join(tmpdir(), 'suite-avatar-'))
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
const same = (a, b, e = 1e-4) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < e)

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
  await page.waitForFunction(() => document.querySelector('.hb-viewport-host')?.stageTool && !document.querySelector('.hb-vp-cover'), { timeout: 15000 })
    .catch(async () => fail(`the stage did not start: ${await page.evaluate(() => document.querySelector('.hb-vp-cover')?.textContent ?? 'no cover')}`))
  await page.waitForFunction(() => /bones mapped by name/.test(document.querySelector('[data-pane="rig"]')?.textContent ?? ''), { timeout: 8000 })
    .catch(() => fail('the rack did not fill from the mannequin'))
  const st = (fn, ...a) => page.evaluate(fn, ...a)
  // swiftshader draws a few frames a second: wait for two new frames, not a fixed time
  const drawn = async () => {
    const f0 = await st(() => document.querySelector('.hb-viewport-host').stageTool.walk.stage.loop.frames)
    await page.waitForFunction((f) => document.querySelector('.hb-viewport-host').stageTool.walk.stage.loop.frames > f + 1, { timeout: 10000 }, f0)
  }
  const builtin = await page.$$eval('[aria-label="clips"] .hb-chip', (c) => c.map((x) => x.textContent.trim()))
  if (!['wave', 'nod', 'look around', 'bow'].every((n) => builtin.includes(n))) fail(`the mannequin lacks the built in clips: ${builtin}`)
  const handQ = () => st(() => document.querySelector('.hb-viewport-host').stageTool.walk.stage.body.avatar.bones.rightUpperArm.quaternion.toArray())
  const seekTo = (v) => st((t) => { const s = document.querySelector('.hb-tp-scrub'); s.value = String(t); s.dispatchEvent(new Event('input', { bubbles: true })) }, v)
  await page.evaluate(() => [...document.querySelectorAll('[aria-label="clips"] .hb-chip')].find((c) => c.textContent.trim() === 'wave').click())
  await page.click('.hb-transport .hb-tp-btn.is-play')
  await seekTo(0); await drawn()
  const w0 = await handQ()
  await seekTo(1.2); await drawn()
  const w1 = await handQ()
  if (same(w0, w1, 1e-2)) fail(`the built in wave did not move the mannequin arm: ${w0} and ${w1}`)
  await page.click('.hb-transport .hb-tp-btn.is-play')

  // drop the generated glb
  await page.evaluate((b64, name) => {
    const dt = new DataTransfer()
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type: 'model/gltf-binary' }))
    for (const k of ['dragenter', 'dragover', 'drop']) document.body.dispatchEvent(new DragEvent(k, { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, GLB.toString('base64'), BODY)
  await page.waitForFunction(() => !document.querySelector('.hb-viewport-host').stageTool.body.placeholder, { timeout: 15000 })
    .catch(async () => fail(`the glb did not land: ${await st(() => document.querySelector('.hb-viewport-host').stageTool.body.line)}`))

  // the rig tree lists the bones
  await page.waitForFunction(() => /rightUpperArm/.test(document.querySelector('[data-pane="rig"] .hb-tree')?.textContent ?? ''), { timeout: 5000 })
    .catch(() => fail('the rig tree does not list the bones of the glb'))
  const tree = await page.$$eval('[data-pane="rig"] .hb-tree-item', (es) => es.map((e) => e.querySelector('.hb-tree-row')?.textContent ?? '').join('\n'))
  const listed = ['hips', 'spine', 'head', 'leftFoot', 'rightHand'].filter((b) => tree.includes(b))
  if (listed.length !== 5) fail(`the rig tree misses bones: ${tree}`)
  const bonesLine = await page.$eval('[data-pane="rig"] .hb-hint', (e) => e.textContent)

  // a blendshape slider sets the morph weight
  const rows = await page.$$eval('[data-pane="shapes"] .hb-prow-name', (n) => n.map((x) => x.textContent.trim()))
  if (!MORPHS.every((m) => rows.includes(m))) fail(`the blendshape rows are not the glb's: ${rows}`)
  await page.evaluate((m) => {
    const row = [...document.querySelectorAll('[data-pane="shapes"] .hb-prow')].find((r) => r.querySelector('.hb-prow-name').textContent.trim() === m)
    const i = row.querySelector('input[type="range"]')
    i.value = '0.8'
    i.dispatchEvent(new Event('input', { bubbles: true }))
    i.dispatchEvent(new Event('change', { bubbles: true }))
  }, MORPHS[0])
  await drawn()
  const morph = (m) => page.evaluate((name) => {
    let w = null
    document.querySelector('.hb-viewport-host').stageTool.walk.stage.body.avatar.root.traverse((o) => {
      if (w === null && o.morphTargetDictionary && name in o.morphTargetDictionary) w = o.morphTargetInfluences[o.morphTargetDictionary[name]]
    })
    return w
  }, m)
  const w = await morph(MORPHS[0])
  if (w === null || Math.abs(w - 0.8) > 1e-3) fail(`the slider did not set ${MORPHS[0]}: ${w}`)

  // the file's clip plays and scrubs
  const chip = (label) => page.evaluate((l) => [...document.querySelectorAll('[aria-label="clips"] .hb-chip')].find((c) => c.textContent.trim() === l)?.click(), label)
  await chip(CLIP.name)
  await wait(100)
  const dur = await st(() => document.querySelector('.hb-viewport-host').stageTool.transport.duration)
  if (Math.abs(dur - CLIP.seconds) > 0.05) fail(`the transport length is not the clip's: ${dur}`)
  const time = () => st(() => document.querySelector('.hb-viewport-host').stageTool.transport.time)
  if (!(await st(() => document.querySelector('.hb-viewport-host').stageTool.transport.playing))) await page.click('.hb-transport .hb-tp-btn.is-play')
  const t0 = await time()
  await drawn(); await drawn()
  if (!(await time() > t0)) fail(`the clip did not play: ${t0}, ${await time()}`)
  await page.click('.hb-transport .hb-tp-btn.is-play')
  const arm = () => st(() => document.querySelector('.hb-viewport-host').stageTool.walk.stage.body.avatar.bones.rightUpperArm.quaternion.toArray())
  const scrub = async (t) => {
    await st((v) => { const s = document.querySelector('.hb-tp-scrub'); s.value = String(v); s.dispatchEvent(new Event('input', { bubbles: true })) }, t)
    await drawn()
    return arm()
  }
  const a0 = await scrub(0)
  const a1 = await scrub(1)
  const a0b = await scrub(0)
  if (same(a0, a1, 1e-3)) fail(`scrubbing did not move the arm: ${a0} and ${a1}`)
  if (!same(a0, a0b)) fail(`the same time gave two poses: ${a0} and ${a0b}`)

  // export a pose at t = 1, go back to rest, import the pose back
  const held = await scrub(1)
  await page.evaluate(() => [...document.querySelectorAll('.hb-export-formats button')].find((b) => b.textContent.trim() === 'pose')?.click())
  await wait(100)
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.hb-export button')].find((e) => /^export .*\.pose\.json$/.test(e.textContent.trim()) && !e.disabled)
    b?.click(); return !!b
  })
  if (!clicked) fail('no export pose button')
  let posePath = null
  for (let i = 0; i < 50 && !posePath; i++) {
    const f = readdirSync(downloads).find((n) => n.endsWith('.pose.json'))
    if (f) posePath = join(downloads, f)
    else await wait(100)
  }
  if (!posePath) fail('no .pose.json download')
  const pose = JSON.parse(readFileSync(posePath, 'utf8'))
  if (pose.format !== 'hackbuild.pose' || !pose.bones.rightUpperArm) fail(`the pose file is wrong: ${JSON.stringify(pose).slice(0, 200)}`)
  if (!same(pose.bones.rightUpperArm, held, 1e-4)) fail(`the pose file is not the drawn arm: ${pose.bones.rightUpperArm} and ${held}`)
  if (Math.abs((pose.morphs[MORPHS[0]] ?? 0) - 0.8) > 1e-3) fail('the pose file lost the held blendshape')
  await chip('rest')
  await drawn()
  const rest = await arm()
  if (same(rest, held, 1e-3)) fail('rest did not move the arm off the pose')
  const input = await page.$('input[data-import="pose-clip"]')
  await input.uploadFile(posePath)
  await page.waitForFunction(() => /bones matched by name/.test(document.querySelector('.hb-viewport').textContent), { timeout: 5000 }).catch(() => fail('the pose did not import'))
  await drawn()
  const back = await arm()
  if (!same(back, held, 1e-3)) fail(`the imported pose is not the exported one: ${back} and ${held}`)
  const selected = await page.evaluate(() => [...document.querySelectorAll('[aria-label="clips"] .hb-chip')].filter((c) => c.classList.contains("is-on")).map((c) => c.textContent.trim()))
  if (!selected[0]?.startsWith("pose")) fail(`the imported pose is not the chosen clip: ${selected}`)
  await page.close()

  if (errors.length) fail('console errors')
  if (off.length) fail(`requests off file://: ${off.slice(0, 5).join(', ')}`)
  console.log(`smoke-avatar: ok. a ${GLB.length} byte procedural glb dropped on the page landed; the rig tree lists ${tree.split('\n').length} nodes ("${bonesLine.trim()}"); the ${MORPHS[0]} slider set the morph weight to ${w.toFixed(2)}; the ${CLIP.name} clip set the transport to ${dur.toFixed(2)} s and played; the built in wave moved the mannequin arm; scrubbing to 0 s twice gave one pose; a pose exported at 1 s and imported back to the same arm; 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
