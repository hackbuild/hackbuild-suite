// smoke-x-masks: the mask studio explorer (#/x/masks) on ?stub, from the
// hosted build, with model hosts and weight files blocked. The empty picture
// holds the one pink action and the rail carries the click cut and every
// hand tool; the sample loads; picking the click cut loads the model on its
// own; a press cuts the cube; undo and redo appear; find every object fills
// the list in the objects view; a press on a found object takes it in;
// merge, hide and delete work; the no model modes set a mask; the views
// switch; exports appear once there is a mask, one png per object included.
//   npm run build && node tools/smoke-x-masks.mjs [--shots <dir>]
import { existsSync, mkdirSync } from 'node:fs'
import { launch, serveDir } from './browse.mjs'

if (!existsSync('dist/hosted/index.html')) throw new Error('no hosted build: run npm run build first')
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null
if (shots) mkdirSync(shots, { recursive: true })
const server = await serveDir('dist/hosted')
const chrome = await launch({ prefix: 'smoke-x-masks-', blockModels: true })
const errors = []
const fail = (m) => { throw new Error(m) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  const page = await chrome.browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${server.base}?stub#/x/masks`, { waitUntil: 'load' })
  await page.waitForSelector('.hb-lay-empty .hb-btn-go', { timeout: 10000 }).catch(() => fail('no empty picture with its pink action'))
  await wait(400)
  if (shots) await page.screenshot({ path: `${shots}/x-masks-empty-1440.png` })
  const first = await page.evaluate(() => ({
    pink: [...document.querySelectorAll('.hb-btn-go')].filter((b) => b.checkVisibility()).map((b) => b.textContent.trim()),
    rail: document.querySelectorAll('.hb-lay-tools button').length,
    tabs: [...document.querySelectorAll('.hb-rack [role=tab]')].map((t) => t.textContent.trim()),
  }))
  if (first.pink.length !== 1 || first.pink[0] !== 'open an image') fail(`first view pink: ${first.pink.join(', ')}`)
  if (first.rail < 7) fail(`the rail holds ${first.rail} buttons`)
  if (first.tabs.join(' ') !== 'objects mask saved export') fail(`tabs: ${first.tabs.join(', ')}`)

  await page.evaluate(() => [...document.querySelectorAll('.hb-lay-empty button')].find((b) => b.textContent.trim() === 'try the sample').click())
  await page.waitForFunction(() => window.hbExplorer.studio()?.state().ready, { timeout: 8000 }).catch(() => fail('the sample did not load'))
  const S = (fn) => page.evaluate(fn)

  // the click cut loads its model when picked, then a press cuts the cube
  await S(() => window.hbExplorer.studio().setTool('point'))
  await page.waitForFunction(() => window.hbExplorer.studio().hasSegment, { timeout: 8000 }).catch(() => fail('picking the click cut did not load the model'))
  const box = await page.$eval('.hb-mask-canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })
  const at = (ix, iy) => ({ x: box.x + (ix / 1024) * box.w, y: box.y + (iy / 768) * box.h })
  let p = at(400, 520)
  await page.mouse.move(p.x, p.y)
  await wait(300)
  await page.mouse.click(p.x, p.y)
  await page.waitForFunction(() => window.hbExplorer.studio().state().coverage > 0.05, { timeout: 5000 }).catch(() => fail('the press cut nothing'))
  const cube = await S(() => window.hbExplorer.studio().state().coverage)
  if (!(await page.$('[data-v="undo"]'))) fail('no undo after a change')

  // find every object: the list fills and the view turns to objects
  await S(() => window.hbExplorer.findAll())
  await page.waitForFunction(() => window.hbExplorer.studio().state().found.length === 4, { timeout: 5000 }).catch(() => fail('find every object found no four'))
  if ((await S(() => window.hbExplorer.studio().state().view)) !== 'instances') fail('the view did not turn to objects')
  if (shots) await page.screenshot({ path: `${shots}/x-masks-found-1440.png` })
  p = at(692, 634)
  await page.mouse.move(p.x, p.y)
  await wait(200)
  if ((await S(() => window.hbExplorer.studio().state().hover)) !== 1) fail('the pointer did not light the pink ball')
  await page.mouse.click(p.x, p.y)
  await wait(200)
  if (!(await S(() => window.hbExplorer.studio().state().found[1].on))) fail('a press on a found object did not take it in')
  await page.click('[data-show="3"]')
  await page.click('[data-op="merge"]')
  const merged = await S(() => window.hbExplorer.studio().state().found.filter((f) => f.on).length)
  if (merged !== 3) fail(`merge took ${merged} objects, want 3 with one hidden`)
  await page.click('[data-drop="0"]')
  if ((await S(() => window.hbExplorer.studio().state().found.length)) !== 3) fail('delete left the list as it was')

  // views, no model modes, exports
  await page.click('[data-view="mask"]')
  if ((await S(() => window.hbExplorer.studio().state().view)) !== 'mask') fail('the mask view did not open')
  await S(() => window.hbExplorer.auto('threshold'))
  const thr = await S(() => window.hbExplorer.studio().state().coverage)
  await S(() => window.hbExplorer.auto('clusters'))
  const groups = await S(() => window.hbExplorer.studio().state().found.length)
  if (groups <= 3) fail('the colour groups added no objects')
  const tab = (name) => page.evaluate((n) => [...document.querySelectorAll('.hb-rack [role=tab]')].find((t) => t.textContent.trim() === n).click(), name)
  await tab('export')
  await wait(200)
  const ex = await page.$$eval('.hb-rack-pane:not([hidden]) button', (b) => b.map((x) => x.textContent.trim()))
  for (const want of ['cutout png', 'mask png', 'matte png', 'inverse png', 'one png per object']) if (!ex.includes(want)) fail(`no ${want} in export: ${ex.join(', ')}`)
  const inverse = await S(async () => (await window.hbExplorer.studio().exportAs('inverse'))?.size ?? 0)
  if (!inverse) fail('the inverse png is empty')
  await tab('saved')
  await page.evaluate(() => document.querySelector('.hb-rack-pane:not([hidden]) [data-op="save"]').click())
  if ((await S(() => window.hbExplorer.studio().state().saved.length)) !== 1) fail('save this mask kept nothing')
  if (errors.length) fail(`console errors:\n${errors.join('\n')}`)
  console.log(`smoke-x-masks: ok. one pink (${first.pink[0]}), ${first.rail} rail buttons, 4 tabs; the click cut loaded its model when picked and cut ${Math.round(cube * 100)} percent; 4 objects found, hover lit one, a press took it in, merge, hide and delete held; threshold kept ${Math.round(thr * 100)} percent, colours added ${groups - 3} objects; 5 exports and a saved mask (measured)`)
} finally {
  await chrome.close()
  server.close?.()
}
