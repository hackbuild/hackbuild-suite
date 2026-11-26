// smoke-x-vision: the vision lab explorer (#/x/vision) on ?stub, from the
// hosted build, with model hosts and weight files blocked. The empty frame
// holds the one pink action and the rail carries seven looks; the sample
// opens; the pink names the detector and its size and loads it; boxes land;
// the medium size finds more; face points, a gesture and a caption land; a
// question is answered; the frame is kept and comes back; exports appear.
//   npm run build && node tools/smoke-x-vision.mjs [--shots <dir>]
import { existsSync, mkdirSync } from 'node:fs'
import { launch, serveDir } from './browse.mjs'

if (!existsSync('dist/hosted/index.html')) throw new Error('no hosted build: run npm run build first')
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null
if (shots) mkdirSync(shots, { recursive: true })
const server = await serveDir('dist/hosted')
const chrome = await launch({ prefix: 'smoke-x-vision-', blockModels: true })
const errors = []
const fail = (m) => { throw new Error(m) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  const page = await chrome.browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${server.base}?stub#/x/vision`, { waitUntil: 'load' })
  await page.waitForSelector('.hb-lay-empty .hb-btn-go', { timeout: 10000 }).catch(() => fail('no empty frame with its pink action'))
  await wait(400)
  const pinks = () => page.evaluate(() => [...document.querySelectorAll('.hb-btn-go')].filter((b) => b.checkVisibility()).map((b) => b.textContent.trim()))
  const first = await page.evaluate(() => ({
    rail: document.querySelectorAll('.hb-lay-tools button').length,
    tabs: [...document.querySelectorAll('.hb-rack [role=tab]')].map((t) => t.textContent.trim()),
  }))
  const p0 = await pinks()
  if (p0.length !== 1 || p0[0] !== 'open an image') fail(`first view pink: ${p0.join(', ')}`)
  if (first.rail < 7) fail(`the rail holds ${first.rail} buttons`)
  if (first.tabs.join(' ') !== 'found ask kept export') fail(`tabs: ${first.tabs.join(', ')}`)

  const S = (fn, a) => page.evaluate(fn, a)
  await page.evaluate(() => [...document.querySelectorAll('.hb-lay-empty button')].find((b) => b.textContent.trim() === 'try the sample').click())
  await wait(300)
  const p1 = await pinks()
  if (p1.length !== 1 || !/^load yolov10 ?n/i.test(p1[0]) || !/mb/.test(p1[0])) fail(`the pink does not name the detector and its size: ${p1.join(', ')}`)
  await page.evaluate(() => document.querySelector('.hb-lay-verbs .hb-btn-go').click())
  await page.waitForFunction(() => window.hbExplorer.state().found.boxes.length === 2, { timeout: 8000 }).catch(() => fail('the nano detector found no boxes'))
  if ((await pinks())[0] !== 'look again') fail('the pink did not turn to look again')
  // the medium size: load it and it finds the cup too
  await page.evaluate(() => [...document.querySelectorAll('.hb-lay-verbs button')].find((b) => b.textContent.trim().startsWith('medium')).click())
  await wait(200)
  await page.evaluate(() => document.querySelector('.hb-lay-verbs .hb-btn-go').click())
  await page.waitForFunction(() => window.hbExplorer.state().found.boxes.length === 3, { timeout: 8000 }).catch(() => fail('the medium detector did not find three'))
  if (shots) await page.screenshot({ path: `${shots}/x-vision-found-1440.png` })
  // face points, a gesture, a caption: each loads its own model
  // each look replaces the last one's marks: face points, then a gesture, then a caption
  const after = {}
  for (const t of ['face', 'gesture', 'caption']) {
    await S((x) => window.hbExplorer.setTool(x), t)
    await S(() => window.hbExplorer.load())
    after[t] = await S(() => window.hbExplorer.state())
  }
  if (!after.face.found.marks.face?.[0]?.points.length) fail('no face points')
  if (after.face.found.boxes.length) fail('the face look kept the boxes of the last look')
  if (!after.gesture.found.gestures?.includes('open palm')) fail(`no gesture: ${after.gesture.found.gestures}`)
  if (after.gesture.found.marks.face) fail('the gesture look kept the face points')
  if (!after.caption.found.caption) fail('no caption')
  // one clear empties the frame
  const cleared = await S(() => { const b = [...document.querySelectorAll('.hb-lay-verbs button')].find((x) => x.textContent.trim() === 'clear'); b?.click(); return !!b })
  if (!cleared) fail('no clear button with results on the frame')
  await S(() => new Promise((r) => setTimeout(r, 100)))
  if (await S(() => { const f = window.hbExplorer.state().found; return f.boxes.length + Object.keys(f.marks).length + (f.caption ? 1 : 0) })) fail('clear left results on the frame')
  // ask
  await S(() => window.hbExplorer.ask('what is on the desk'))
  if (!(await S(() => window.hbExplorer.state().answers.length))) fail('the question got no answer')
  // keep and restore
  await S(() => window.hbExplorer.remember())
  const tab = (name) => page.evaluate((n) => [...document.querySelectorAll('.hb-rack [role=tab]')].find((t) => t.textContent.trim() === n).click(), name)
  await tab('kept')
  await wait(200)
  if ((await S(() => window.hbExplorer.state().kept)) !== 1) fail('keep this frame kept nothing')
  await tab('export')
  await wait(200)
  const ex = await page.$$eval('.hb-rack-pane:not([hidden]) button', (b) => b.map((x) => x.textContent.trim()))
  for (const want of ['picture with marks, png', 'results, json']) if (!ex.includes(want)) fail(`no ${want} in export: ${ex.join(', ')}`)
  if ((await pinks()).length !== 1) fail(`more than one pink: ${(await pinks()).join(', ')}`)
  if (errors.length) fail(`console errors:\n${errors.join('\n')}`)
  console.log(`smoke-x-vision: ok. one pink (${p0[0]}), ${first.rail} rail buttons, 4 tabs; the pink named ${p1[0]}; nano found 2, medium found 3; each look replaced the last; clear emptied the frame; a question answered; a frame kept; 2 exports (measured)`)
} finally {
  await chrome.close()
  server.close?.()
}
