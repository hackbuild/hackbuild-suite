// smoke-twin: twin mode of the character tool (design 3.9, section 5 item
// 5) from the single file build on file://, with ?stub. Stand in files are
// made here: a procedural glb (a bone tree and one skinned triangle) and the generated
// test wav; no likeness file is read. Run 1 keeps them on this device: the
// gate shows the empty slot copy and no url field, the files dropped on the
// page fill the slots, wake swaps the body and clones the voice on the stub Pocket, both
// blobs are stored flagged local, a workspace export leaves them out by
// default and holds them only when "include local only files" is ticked.
// Run 2 leaves keep off: nothing is stored and the export has no blob. Any
// request off file:// or console error fails the run.
//   npm run build:single && node tools/smoke-twin.mjs [--shots <dir>]
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'
import { unzipStore } from '@hackbuild/audio-dsp'
import { testWav } from './test-wav.mjs'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const base = pathToFileURL(file).href
const shotsAt = process.argv.indexOf('--shots')
const shots = shotsAt > 0 ? resolve(process.argv[shotsAt + 1]) : ''
if (shots) mkdirSync(shots, { recursive: true })

/** A stand in body: a humanoid bone tree with the vrm bone names and one
 * triangle skinned to the hips. Made here, so no model file is read. */
function standInGlb() {
  const bones = [
    ['hips', -1, [0, 1, 0]], ['spine', 0, [0, 0.2, 0]], ['head', 1, [0, 0.45, 0]],
    ['leftUpperArm', 1, [0.2, 0.3, 0]], ['leftLowerArm', 3, [0.28, 0, 0]], ['leftHand', 4, [0.25, 0, 0]],
    ['rightUpperArm', 1, [-0.2, 0.3, 0]], ['rightLowerArm', 6, [-0.28, 0, 0]], ['rightHand', 7, [-0.25, 0, 0]],
    ['leftUpperLeg', 0, [0.1, -0.05, 0]], ['leftLowerLeg', 9, [0, -0.45, 0]], ['leftFoot', 10, [0, -0.45, 0]],
    ['rightUpperLeg', 0, [-0.1, -0.05, 0]], ['rightLowerLeg', 12, [0, -0.45, 0]], ['rightFoot', 13, [0, -0.45, 0]],
  ]
  const pos = new Float32Array([-0.3, 0, 0, 0.3, 0, 0, 0, 1.6, 0])
  const joints = new Uint16Array(12)
  const weights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(joints.buffer), Buffer.from(weights.buffer)])
  const nodes = bones.map(([name, , t]) => ({ name, translation: t }))
  bones.forEach(([, parent], i) => { if (parent >= 0) (nodes[parent].children ??= []).push(i) })
  nodes.push({ name: 'stand in', mesh: 0, skin: 0 })
  const json = JSON.stringify({
    asset: { version: '2.0', generator: 'smoke-twin' },
    scene: 0, scenes: [{ nodes: [0, bones.length] }], nodes,
    skins: [{ joints: bones.map((_, i) => i), skeleton: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.3, 0, 0], max: [0.3, 1.6, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'VEC4' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
    ],
    bufferViews: [{ buffer: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }, { buffer: 0, byteOffset: 60, byteLength: 48 }],
    buffers: [{ byteLength: bin.length }],
  })
  const j = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4, ' '))
  const head = Buffer.alloc(12)
  head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8)
  const chunk = (data, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.write(type, 4); return Buffer.concat([h, data]) }
  return Buffer.concat([head, chunk(j, 'JSON'), chunk(bin, 'BIN\0')])
}
const GLB = standInGlb()
const WAV = Buffer.from(testWav(8))
const BODY = 'stand-in-body.glb'
const CLIP = 'stand-in-clip.wav'

const profile = mkdtempSync(join(tmpdir(), 'suite-twin-'))
const downloads = join(profile, 'downloads')
mkdirSync(downloads)
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, userDataDir: profile,
  args: ['--no-first-run', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const errors = []
const off = []
const fail = (why) => { throw new Error(errors.length ? `${why}\nconsole errors:\n${errors.join('\n')}` : why) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const phone = { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true }

async function open() {
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) off.push(r.url()) })
  const cdp = await page.createCDPSession()
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
  await page.setViewport(shots ? phone : { width: 1024, height: 900 })
  await page.goto(`${base}?stub#/character`, { waitUntil: 'load' })
  await page.waitForFunction(() => !!document.querySelector('.hb-wake'), { timeout: 10000 }).catch(() => fail('the wake gate did not show'))
  return page
}
const clickText = (page, sel, text) => page.evaluate((s, t) => {
  const b = [...document.querySelectorAll(s)].find((x) => x.textContent.trim().toLowerCase() === t && !x.disabled && x.checkVisibility())
  if (!b) return false
  b.click()
  return true
}, sel, text)
const gateText = (page) => page.evaluate(() => document.querySelector('.hb-wake').textContent.toLowerCase())
const drop = (page, files) => page.evaluate((list) => {
  const dt = new DataTransfer()
  for (const f of list) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }))
  // dropped on the page, as a real drag lands on the window cover
  for (const k of ['dragenter', 'dragover', 'drop']) document.body.dispatchEvent(new DragEvent(k, { dataTransfer: dt, bubbles: true, cancelable: true }))
}, files.map((f) => ({ ...f, b64: f.data.toString('base64') })))
const blobs = (page) => page.evaluate(() => new Promise((res, rej) => {
  const r = indexedDB.open('hackbuild-suite')
  r.onerror = () => rej(r.error)
  r.onsuccess = () => {
    const db = r.result
    if (![...db.objectStoreNames].includes('blobs')) return res([])
    const q = db.transaction('blobs').objectStore('blobs').getAll()
    q.onsuccess = () => res(q.result.map((b) => ({ name: b.name, local: b.local, size: b.size })))
    q.onerror = () => rej(q.error)
  }
}))
async function exportZip(page, include) {
  for (const f of readdirSync(downloads)) rmSync(join(downloads, f))
  const mod = (await page.evaluate(() => /Mac/.test(navigator.platform))) ? 'Meta' : 'Control'
  await page.keyboard.down(mod); await page.keyboard.down('Shift'); await page.keyboard.press('KeyE')
  await page.keyboard.up('Shift'); await page.keyboard.up(mod)
  await page.waitForSelector('.hb-export', { visible: true, timeout: 5000 }).catch(() => fail('no export panel'))
  await clickText(page, '.hb-export button, .hb-export [role="radio"]', 'workspace')
  if (include !== null) await page.waitForFunction(() => /include local only files/.test(document.querySelector('.hb-export').textContent), { timeout: 3000 }).catch(() => undefined)
  else await wait(500)
  const row = await page.evaluate(() => document.querySelector('.hb-export')?.textContent.toLowerCase() ?? '')
  if (include === null && /include local only files/.test(row)) fail('keep was off and the export panel lists local files')
  if (include !== null) {
    if (!/include local only files/.test(row)) fail(`the export panel offers no local only choice: ${row.slice(0, 300)}`)
    if (!row.includes(BODY_NAME) || !row.includes(CLIP_NAME)) fail('the local only choice does not name the twin files')
    if (include) {
      await page.evaluate(() => [...document.querySelectorAll('.hb-export .hb-togrow')].find((b) => /include local only files/.test(b.textContent)).click())
      await page.waitForFunction(() => /these go in the file/.test(document.querySelector('.hb-export').textContent), { timeout: 3000 }).catch(() => fail('the include tick did not take'))
    }
  }
  if (!(await clickText(page, '.hb-export button', 'export .hbsuite.zip'))) fail('no workspace export button')
  let path = ''
  for (let i = 0; i < 60 && !path; i++) {
    await wait(100)
    const f = readdirSync(downloads).find((n) => n.endsWith('.hbsuite.zip'))
    if (f) path = join(downloads, f)
  }
  if (!path) fail('no .hbsuite.zip download')
  await page.keyboard.press('Escape')
  const entries = unzipStore(new Uint8Array(readFileSync(path)))
  const manifest = JSON.parse(new TextDecoder().decode(entries.find((e) => e.name === 'manifest.json').data))
  return { manifest, blobs: entries.filter((e) => e.name.startsWith('blobs/')) }
}
const BODY_NAME = BODY
const CLIP_NAME = CLIP

try {
  // run 1: keep on this device
  const page = await open()
  if (!(await clickText(page, '.hb-wake .hb-seg button', 'twin'))) fail('no twin mode on the gate')
  await page.waitForFunction(() => !!document.querySelector('.hb-wake .hb-dropzone'), { timeout: 3000 }).catch(() => fail('twin mode shows no drop zone'))
  const empty = await gateText(page)
  if (!empty.includes('drop your own model and a clip of your voice. they stay in this browser and are left out of exports.')) fail('the empty twin copy is missing')
  const urlFields = await page.evaluate(() => [...document.querySelectorAll('.hb-wake input')].filter((i) => i.type === 'url' || /url|http/i.test(i.placeholder + i.id + i.name)).length)
  if (urlFields) fail(`the twin slots have a url field: ${urlFields}`)
  if (!/held in this tab only, in memory/.test(empty)) fail('the gate does not say where the files live')
  if (shots) await page.screenshot({ path: join(shots, 'twin-gate-empty-390.png') })
  await drop(page, [{ name: BODY, type: 'model/gltf-binary', data: GLB }, { name: CLIP, type: 'audio/wav', data: WAV }])
  await page.waitForFunction((b, c) => { const t = document.querySelector('.hb-wake').textContent; return t.includes(b) && t.includes(c) }, { timeout: 5000 }, BODY, CLIP)
    .catch(() => fail('the dropped files did not fill the body and voice slots'))
  if (await page.evaluate(() => !!document.querySelector('.hb-dropzone.is-cover.is-over'))) fail('the drop cover stayed up after the drop')
  if (await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].some((d) => d.checkVisibility()))) fail('the drop opened an import dialog instead of filling the slots')
  if ((await blobs(page)).length) fail('a file was stored before keep was ticked')
  await page.evaluate(() => [...document.querySelectorAll('.hb-wake .hb-togrow')].find((b) => /keep on this device/.test(b.textContent)).click())
  await page.waitForFunction(() => /kept in this browser \(indexeddb\)/.test(document.querySelector('.hb-wake').textContent), { timeout: 3000 }).catch(() => fail('keep did not change the where line'))
  for (let i = 0; i < 30 && (await blobs(page)).length < 2; i++) await wait(100)
  const kept = await blobs(page)
  if (kept.length !== 2 || !kept.every((b) => b.local)) fail(`keep did not store two local blobs: ${JSON.stringify(kept)}`)
  if (shots) await page.screenshot({ path: join(shots, 'twin-gate-filled-390.png') })

  await clickText(page, 'button', 'wake')
  await page.waitForFunction(() => document.querySelector('.hb-chat-log')?.offsetParent, { timeout: 15000 }).catch(() => fail('the gate did not close'))
  await page.waitForFunction((b) => [...document.querySelectorAll('.hb-toolpage .hb-pill')].some((p) => (p.getAttribute('title') ?? '').includes(`ready, ${b.replace(/\.glb$/, '')}`) || (p.getAttribute('title') ?? '').includes(b)), { timeout: 15000 }, BODY)
    .catch(async () => fail(`the body did not swap to the dropped glb: ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.hb-toolpage .hb-pill')].map((p) => p.getAttribute('title'))))}`))
  const placeholder = await page.evaluate(() => document.querySelector('.hb-viewport-host').characterStage.stage.body?.placeholder ?? null)
  if (placeholder === true) fail('the stage still shows the placeholder')
  await page.waitForFunction((c) => [...document.querySelectorAll('.hb-toolpage .hb-pill')].some((p) => (p.getAttribute('title') ?? '').includes(`cloned from ${c}`)), { timeout: 15000 }, CLIP)
    .catch(async () => fail(`the voice was not cloned: ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.hb-toolpage .hb-pill')].map((p) => p.getAttribute('title'))))}`))
  const tag = await page.evaluate(() => [...document.querySelectorAll('.hb-tag')].some((t) => t.textContent.trim() === 'local only' && t.checkVisibility()))
  if (!tag) fail('no local only tag after wake')
  await page.waitForFunction(() => /talking/.test(document.querySelector('.hb-viewport')?.textContent ?? ''), { timeout: 8000 }).catch(() => fail('the cloned voice did not speak the greeting'))
  if (shots) await page.screenshot({ path: join(shots, 'twin-awake-390.png') })

  const left = await exportZip(page, false)
  if (left.blobs.length || !left.manifest.left.includes(BODY) || !left.manifest.left.includes(CLIP)) fail(`the default export did not leave the twin files out: ${JSON.stringify(left.manifest.left)}, ${left.blobs.length} blobs`)
  const inc = await exportZip(page, true)
  const sizes = inc.blobs.map((b) => b.data.length).sort((a, b) => a - b)
  if (inc.manifest.left.length || sizes.join() !== [GLB.length, WAV.length].sort((a, b) => a - b).join()) fail(`the ticked export does not hold both files: ${sizes.join()}`)
  await page.close()

  // run 2: keep off, a fresh profile store: nothing is stored, nothing exported
  const p2 = await browser.newPage()
  await p2.goto('about:blank')
  await p2.close()
  const page2 = await open()
  await page2.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('hackbuild-suite'); q.onsuccess = q.onerror = q.onblocked = () => r() }))
  await page2.reload({ waitUntil: 'load' })
  await page2.waitForFunction(() => !!document.querySelector('.hb-wake'), { timeout: 10000 })
  await clickText(page2, '.hb-wake .hb-seg button', 'twin')
  await page2.waitForFunction(() => !!document.querySelector('.hb-wake .hb-dropzone'), { timeout: 3000 })
  await drop(page2, [{ name: BODY, type: 'model/gltf-binary', data: GLB }, { name: CLIP, type: 'audio/wav', data: WAV }])
  await page2.waitForFunction((b) => document.querySelector('.hb-wake').textContent.includes(b), { timeout: 5000 }, BODY)
  await clickText(page2, 'button', 'wake')
  await page2.waitForFunction((c) => [...document.querySelectorAll('.hb-toolpage .hb-pill')].some((p) => (p.getAttribute('title') ?? '').includes(`cloned from ${c}`)), { timeout: 15000 }, CLIP)
    .catch(() => fail('run 2: the voice was not cloned'))
  const none = await blobs(page2)
  if (none.length) fail(`keep was off and files were stored: ${JSON.stringify(none)}`)
  const bare = await exportZip(page2, null)
  if (bare.blobs.length || bare.manifest.left.length) fail('keep was off and the export names or holds a twin file')
  await page2.close()

  if (errors.length) fail('console errors')
  if (off.length) fail(`requests off file://: ${off.slice(0, 5).join(', ')}`)
  console.log(`smoke-twin: ok. the gate shows the empty twin copy, no url field and where the files live; a stand in glb (${GLB.length} bytes) and wav (${WAV.length} bytes) fill the slots, keep stores 2 local blobs, wake swaps the body and clones the voice on the stub, the default export leaves both out and the ticked export holds both; with keep off nothing is stored or exported, 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
