// smoke-x-relief: the relief explorer (#/x/relief) on ?stub, from the hosted
// build, with model hosts and weight files blocked. The empty canvas holds
// the one pink action and the rail carries look, erase and restore; the
// sample builds a closed relief from brightness; depth loads its model from
// the chip and rebuilds from depth; the erase brush cuts cells and undo puts
// them back; three colours make three bodies; a posed glb becomes a relief;
// the 3d views open; the 3mf, stl zip and faces png come out non empty.
//   npm run build && node tools/smoke-x-relief.mjs [--shots <dir>]
import { existsSync, mkdirSync } from 'node:fs'
import { launch, serveDir } from './browse.mjs'

if (!existsSync('dist/hosted/index.html')) throw new Error('no hosted build: run npm run build first')
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null
if (shots) mkdirSync(shots, { recursive: true })

// a 20 mm cube as a glb, made here so no file ships
function cubeGlb() {
  const p = [], idx = []
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]
  for (const q of v) p.push(...q.map((c) => c * 20))
  for (const f of [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3]]) idx.push(...f)
  const pos = Buffer.from(new Float32Array(p).buffer), ind = Buffer.from(new Uint16Array(idx).buffer)
  const bin = Buffer.concat([pos, ind, Buffer.alloc((4 - ((pos.length + ind.length) % 4)) % 4)])
  const json = JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length }, { buffer: 0, byteOffset: pos.length, byteLength: ind.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [0, 0, 0], max: [20, 20, 20] }, { bufferView: 1, componentType: 5123, count: idx.length, type: 'SCALAR' }],
  })
  const j = Buffer.from(json + ' '.repeat((4 - (json.length % 4)) % 4))
  const head = Buffer.alloc(12)
  head.writeUInt32LE(0x46546c67, 0), head.writeUInt32LE(2, 4), head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8)
  const ch = (b, t) => { const h = Buffer.alloc(8); h.writeUInt32LE(b.length, 0); h.writeUInt32LE(t, 4); return Buffer.concat([h, b]) }
  return [...Buffer.concat([head, ch(j, 0x4e4f534a), ch(bin, 0x004e4942)])]
}

const server = await serveDir('dist/hosted')
const chrome = await launch({ prefix: 'smoke-x-relief-', blockModels: true })
const errors = []
const fail = (m) => { throw new Error(m) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  const page = await chrome.browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${server.base}?stub#/x/relief`, { waitUntil: 'load' })
  await page.waitForSelector('.hb-lay-drop .hb-btn-go', { timeout: 10000 }).catch(() => fail('no empty canvas with its pink action'))
  await page.waitForFunction(() => [...document.querySelectorAll('.hb-btn-go')].some((b) => b.checkVisibility()), { timeout: 10000 }).catch(() => fail('the pink action is not visible'))
  await wait(300)
  const first = await page.evaluate(() => ({
    pink: [...document.querySelectorAll('.hb-btn-go')].filter((b) => b.checkVisibility()).map((b) => b.textContent.trim()),
    rail: document.querySelectorAll('.hb-lay-tools button').length,
    tabs: [...document.querySelectorAll('.hb-rack [role=tab]')].map((t) => t.textContent.trim()),
  }))
  if (first.pink.length !== 1 || first.pink[0] !== 'open a photo or model') fail(`first view pink: ${first.pink.join(', ')}`)
  if (first.rail !== 3) fail(`the rail holds ${first.rail} buttons`)
  if (first.tabs.join(' ') !== 'art relief colour print') fail(`tabs: ${first.tabs.join(', ')}`)
  const S = (fn, a) => page.evaluate(fn, a)
  const settle = () => wait(700)

  await page.evaluate(() => [...document.querySelectorAll('.hb-lay-empty button')].find((b) => b.textContent.trim() === 'try the sample').click())
  await page.waitForFunction(() => window.hbExplorer.state().tris > 0, { timeout: 10000 }).catch(() => fail('the sample built no relief'))
  let st = await S(() => window.hbExplorer.state())
  if (st.source !== 'brightness') fail(`with no depth model the relief came from ${st.source}`)
  if (st.open !== 0) fail(`${st.open} open edges`)

  await S(() => window.hbExplorer.pick.load())
  await page.waitForFunction(() => window.hbExplorer.state().source === 'depth', { timeout: 8000 }).catch(() => fail('the depth model loaded but the relief did not rebuild from depth'))
  if (shots) await page.screenshot({ path: `${shots}/x-relief-face-1440.png` })

  // the erase brush cuts, undo puts it back
  await page.click('.hb-lay-tools button:nth-child(2)').catch(() => S(() => document.querySelectorAll('.hb-lay-tools button')[1].click()))
  const box = await page.$eval('.hb-lay-subject', (c) => { const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
  await page.mouse.move(box.x - 40, box.y)
  await page.mouse.down()
  for (let i = 0; i < 8; i++) await page.mouse.move(box.x - 40 + i * 10, box.y + i * 3)
  await page.mouse.up()
  await settle()
  st = await S(() => window.hbExplorer.state())
  if (!st.erased) fail('the erase brush cut nothing')
  await page.evaluate(() => [...document.querySelectorAll('.hb-lay-verbs button')].find((b) => b.textContent.trim() === 'undo').click())
  await settle()
  if ((await S(() => window.hbExplorer.state())).erased) fail('undo left the erase')

  // three colours, by height then by photo colour
  await S(() => window.hbExplorer.set({ colours: 3, split: 'height' }))
  await settle()
  const bands = (await S(() => window.hbExplorer.state())).parts
  if (bands < 2) fail(`three terraces made ${bands} bodies`)
  await S(() => window.hbExplorer.set({ split: 'colours' }))
  await settle()
  const groups = (await S(() => window.hbExplorer.state())).parts
  if (groups < 2) fail(`photo colours made ${groups} bodies`)

  // exports
  const size = (k) => S(async (k) => (await window.hbExplorer.exportAs(k))?.size ?? 0, k)
  const out = { '3mf': await size('3mf'), zip: await size('zip'), stl: await size('stl'), face: await size('face'), depth: await size('depth') }
  for (const [k, v] of Object.entries(out)) if (!v) fail(`the ${k} export is empty`)

  // the 3d views
  await page.select('.hb-lay-verbs select', 'iso')
  await wait(800)
  if (!(await page.$('.xr-stage canvas'))) fail('the iso view drew no canvas')
  if (shots) await page.screenshot({ path: `${shots}/x-relief-iso-1440.png` })

  // a posed model
  await S((b) => window.hbExplorer.openModel(new Uint8Array(b).buffer, 'cube'), cubeGlb())
  await page.waitForFunction(() => window.hbExplorer.state().kind === 'model' && window.hbExplorer.state().tris > 0, { timeout: 8000 }).catch(() => fail('the glb built no relief'))
  st = await S(() => window.hbExplorer.state())
  if (errors.length) fail(`console errors:\n${errors.join('\n')}`)
  console.log(`smoke-x-relief: ok. one pink (${first.pink[0]}), 3 rail tools, 4 tabs; sample from brightness then depth, closed; erase and undo held; ${bands} terrace bodies, ${groups} colour bodies; 3mf ${out['3mf']} b, stl zip ${out.zip} b, stl ${out.stl} b, faces ${out.face} b, depth ${out.depth} b; the iso view drew; a glb cube built ${st.tris} triangles (measured)`)
} finally {
  await chrome.close()
  server.close?.()
}
