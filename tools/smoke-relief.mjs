// smoke-relief: the relief tool (design 3.5) from the single file build on
// file://, with ?stub so depth is the weightless radial stub and no weight
// is fetched. The sample goes in from brightness, the depth model loads
// from its size button and depth runs with no second click; the height
// range moves the top and undo takes it back; the depth png and the stl
// export; the design exports and imports back with its depth map.
// Any request off file:// or console error fails the run.
//   npm run build:single && node tools/smoke-relief.mjs
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const url = `${pathToFileURL(file).href}?stub#/image/relief`
const profile = mkdtempSync(join(tmpdir(), 'suite-relief-'))
const downloads = join(profile, 'downloads')
mkdirSync(downloads)
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args: ['--no-first-run'] })
const errors = []
const off = []
const fail = (why) => { throw new Error(errors.length ? `${why}\nconsole errors:\n${errors.join('\n')}` : why) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function download(end) {
  for (let i = 0; i < 60; i++) {
    const f = readdirSync(downloads).find((n) => n.endsWith(end))
    if (f) return join(downloads, f)
    await wait(100)
  }
  fail(`no ${end} download`)
}
try {
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) off.push(r.url()) })
  const cdp = await page.createCDPSession()
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
  await page.setViewport({ width: 1024, height: 900 })
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction(() => document.body.textContent.includes('drop a photo and it becomes a relief'), { timeout: 8000 }).catch(() => fail('the empty state is missing'))
  const click = (re, root = '.hb-toolpage') => page.evaluate((s, r) => {
    const b = [...document.querySelectorAll(`${r} button`)].find((e) => new RegExp(s).test(e.textContent.trim()) && !e.disabled)
    b?.click(); return !!b
  }, re, root)
  const text = () => page.evaluate(() => document.body.textContent)
  const rows = () => page.$$eval('.hb-inst-row', (els) => els.map((e) => e.textContent.trim()))
  const rowCount = (n) => page.waitForFunction((k) => document.querySelectorAll('.hb-inst-row').length === k, { timeout: 5000 }, n)
  const at = async (sel, fx, fy) => {
    const r = await page.$eval(sel, (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } })
    return { x: r.x + r.w * fx, y: r.y + r.h * fy }
  }

  const size = () => page.evaluate(() => [...document.querySelectorAll('.hb-export-readout div')].find((d) => d.querySelector('dt')?.textContent === 'size')?.querySelector('dd')?.textContent ?? '')
  const dims = async () => (await size()).match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? []
  const settle = () => page.waitForFunction(() => !document.querySelector('.hb-export-busy'), { timeout: 8000 })
  const exportAs = async (chip, ext) => {
    await page.evaluate((c) => [...document.querySelectorAll('.hb-export-formats button')].find((b) => b.textContent.trim() === c)?.click(), chip)
    await settle()
    if (!(await click(`^export ${ext.replace(/\./g, '\\.')}$`, '.hb-export'))) fail(`no export ${ext} button`)
    return download(ext)
  }

  // the sample goes in from brightness; the depth model loads from a button that names its size and runs with no second click
  await page.waitForFunction(() => [...document.querySelectorAll('.hb-islot button')].some((b) => b.textContent.trim() === 'sample'), { timeout: 8000 }).catch(() => fail('no sample button'))
  await page.evaluate(() => [...document.querySelectorAll('.hb-islot button')].find((b) => b.textContent.trim() === 'sample').click())
  await page.waitForFunction(() => /depth needs .*, \d+ mb \((inferred|vendor|measured)\), once/.test(document.body.textContent), { timeout: 8000 }).catch(() => fail('no consent line that names the size'))
  await page.waitForFunction(() => /mm \(computed\)/.test(document.querySelector('.hb-export-readout')?.textContent ?? ''), { timeout: 10000 }).catch(() => fail('no relief from brightness'))
  const load = await page.evaluate(() => [...document.querySelectorAll('.is-side button')].map((b) => b.textContent.trim()).find((t) => t.startsWith('load the depth model')))
  if (!/^load the depth model, \d+ mb \((inferred|vendor|measured)\)$/.test(load ?? '')) fail(`the load button does not name the size: ${load}`)
  await click('^load the depth model', '.is-side')
  await page.waitForFunction(() => /depth took \d+ ms \(measured\)/.test(document.body.textContent), { timeout: 10000 }).catch(async () => fail(`depth did not run: ${(await text()).match(/(depth|loading)[^.]*\./)?.[0]}`))
  const took = (await text()).match(/depth took (\d+) ms/)?.[1]
  await page.waitForFunction(() => /^depth, \d+ by \d+$/.test(document.querySelector('.hb-viewport .hb-tag')?.textContent.trim() ?? ''), { timeout: 8000 }).catch(() => fail('the relief is not from depth'))
  await page.waitForFunction(() => document.querySelector('.hb-split') && document.querySelector('.hb-islot')?.textContent.includes('depth stored'), { timeout: 4000 }).catch(() => fail('no compare wipe or the depth map is not stored'))
  await page.waitForSelector('.hb-viewport canvas', { timeout: 8000 }).catch(() => fail('no 3d canvas'))
  await settle()
  const d0 = await dims()
  if (!(d0[0] > 20 && d0[0] <= 30.01 && d0[2] > 2 && d0[2] <= 2.41)) fail(`the default relief is not within 30 mm wide and 2.4 high: ${await size()}`)
  const checks = await page.$eval('.hb-export-checks', (e) => e.textContent)
  if (!/0 open edges/.test(checks)) fail(`the solid is not closed: ${checks}`)

  // depth runs: each run lands in the strip; a press on the older one puts its map back
  await page.waitForFunction(() => document.querySelectorAll('.hb-hist-item').length === 1, { timeout: 3000 }).catch(() => fail('the depth run is not in the strip'))
  if (!(await click('^run depth$'))) fail('no run depth button')
  await page.waitForFunction(() => document.querySelectorAll('.hb-hist-item').length === 2, { timeout: 8000 }).catch(() => fail('a second depth run did not join the strip'))
  await page.evaluate(() => [...document.querySelectorAll('.hb-hist-item')].at(-1).querySelector('button')?.click())
  await page.waitForFunction(() => /the depth map of .* is back/.test(document.body.textContent), { timeout: 3000 }).catch(() => fail('a press on the strip did not restore the depth map'))
  await settle()

  // the height range: top to 6 mm, then undo and redo
  await page.evaluate(() => { const i = document.querySelector('.hb-r2-in.is-hi'); i.value = '6'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })) })
  await wait(400)
  await settle()
  const d1 = await dims()
  if (!(d1[2] > 5 && d1[2] <= 6.01)) fail(`the top did not move to 6 mm: ${await size()}`)
  if (!(await click('^undo$'))) fail('no undo')
  await wait(400)
  await settle()
  if (!((await dims())[2] <= 2.41)) fail('undo did not bring the top back')
  if (!(await click('^redo$'))) fail('no redo')
  await wait(400)
  await settle()

  // exports: the depth png, the stl, then the design
  const pngPath = await exportAs('depth png', '.depth.png')
  const png = readFileSync(pngPath)
  if (png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(16) !== 640 || png.readUInt32BE(20) !== 480) fail('the depth png is not 640 by 480')
  const stlPath = await exportAs('stl', '.stl')
  const stl = readFileSync(stlPath)
  const tris = stl.readUInt32LE(80)
  if (stl.length !== 84 + tris * 50 || tris < 1000) fail(`the stl is malformed: ${stl.length} bytes, ${tris} triangles`)
  await wait(900)
  const saved = await exportAs('design', '.hbrelief.json')
  const design = JSON.parse(readFileSync(saved, 'utf8'))
  const db = design.body ?? design
  if (!String(db.depth ?? '').startsWith('data:image/png') || Math.abs((db.params?.height ?? 0) - 6) > 0.01) fail('the design file lost its depth map or its range')

  // the design imports back with its depth and range, and the model does not rerun
  const before = await page.evaluate(() => location.hash)
  const [c1] = await Promise.all([page.waitForFileChooser({ timeout: 3000 }), click('^import$')])
  await c1.accept([saved])
  await page.waitForFunction((h) => location.hash !== h && location.hash.includes('doc='), { timeout: 5000 }, before).catch(() => fail('the import did not open a relief document'))
  await page.waitForFunction(() => document.querySelector('.hb-islot')?.textContent.includes('depth stored'), { timeout: 5000 }).catch(() => fail('the imported design lost its depth map'))
  await settle()
  await wait(400)
  const d2 = await dims()
  if (!(d2[2] > 5 && d2[2] <= 6.01)) fail(`the imported design lost its range: ${await size()}`)

  // a png imported here offers relief in the chooser beside vision and masks, and opens here
  const shot = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 96; c.height = 64; c.getContext('2d').fillRect(10, 10, 40, 30); return c.toDataURL('image/png').split(',')[1] })
  const pngIn = join(profile, 'desk.png')
  writeFileSync(pngIn, Buffer.from(shot, 'base64'))
  const hash = await page.evaluate(() => location.hash)
  const [c2] = await Promise.all([page.waitForFileChooser({ timeout: 3000 }), click('^import$')])
  await c2.accept([pngIn])
  const takers = await page.waitForFunction(() => { const bs = [...document.querySelectorAll('[role="dialog"] button')].map((e) => e.textContent.trim()); return bs.includes('make a relief') && bs }, { timeout: 4000 }).then((h) => h.jsonValue()).catch(() => fail('no chooser with relief for the png'))
  await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find((e) => e.textContent.trim() === 'make a relief').click())
  await page.waitForFunction((h) => location.hash !== h && location.hash.startsWith('#/image/relief'), { timeout: 5000 }, hash).catch(() => fail('the png did not open in relief'))
  await page.waitForFunction(() => document.querySelector('.hb-islot')?.textContent.includes('96 by 64'), { timeout: 4000 }).catch(() => fail('the png did not land as the relief photo'))

  if (off.length) fail(`requests off file://:\n${off.join('\n')}`)
  if (errors.length) fail(`console errors:\n${errors.join('\n')}`)
  console.log(`smoke-relief: ok. the sample goes in from brightness with the consent line, "${load}" loads the stub and depth runs with no second click (${took} ms, measured), a second run joins the depth strip and a press restores the older map, the 3d part, the compare wipe and a closed ${d0[0].toFixed(1)} by ${d0[1].toFixed(1)} by ${d0[2].toFixed(2)} mm solid show, the top moves to 6 mm and undo and redo take it, the 640 by 480 depth png and a ${tris} triangle stl export, the design exports and imports back with its depth map and range, a png imported here offers ${takers.filter((t) => /^(open|cut|make)/.test(t)).length} tools in the chooser and opens in relief, 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
