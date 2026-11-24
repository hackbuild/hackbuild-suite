// smoke-masks: the masks tool (design 3.6) from the single file build on
// file://, with ?stub so the segmenter is the weightless disc stub: a
// deterministic disc around each kept point or inside each box, and no
// weight is fetched. The sample goes in, the mask model loads from its size
// button, a point and a box each make an instance in the list, an erase
// stroke edits the first one and undo takes it back; the mask png and the
// instances json export and both import back as instances; the document
// exports and imports back, and a png picks masks in the chooser.
// Any request off file:// or console error fails the run.
//   npm run build:single && node tools/smoke-masks.mjs
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const url = `${pathToFileURL(file).href}?stub#/image/masks`
const profile = mkdtempSync(join(tmpdir(), 'suite-masks-'))
const downloads = join(profile, 'downloads')
mkdirSync(downloads)
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args: ['--no-first-run'] })
const errors = []
const off = []
const fail = (why) => { throw new Error(why) }
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
  await page.waitForFunction(() => document.body.textContent.includes('drop or paste an image, or take the sample scene'), { timeout: 8000 }).catch(() => fail('the empty state is missing'))
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

  // the sample goes in; the model loads from a button that names its size
  await page.waitForFunction(() => [...document.querySelectorAll('.hb-islot button')].some((b) => b.textContent.trim() === 'sample'), { timeout: 8000 }).catch(() => fail('no sample button'))
  await page.evaluate(() => [...document.querySelectorAll('.hb-islot button')].find((b) => b.textContent.trim() === 'sample').click())
  await page.waitForSelector('.hb-pc-frame', { timeout: 5000 }).catch(() => fail('no prompt canvas after the sample'))
  await page.waitForFunction(() => [...document.querySelectorAll('.is-side button')].some((b) => /^load the mask model, \d+ mb \((inferred|vendor|measured)\)$/.test(b.textContent.trim())), { timeout: 8000 }).catch(() => fail('no load button that names the size'))
  const load = await page.evaluate(() => [...document.querySelectorAll('.is-side button')].map((b) => b.textContent.trim()).find((t) => t.startsWith('load the mask model')))
  await click('^load the mask model', '.is-side')
  await page.waitForFunction(() => /one pass over sample scene took \d+ ms \(measured\)/.test(document.body.textContent), { timeout: 10000 }).catch(async () => fail(`the model did not load: ${(await text()).match(/(loading|the mask model)[^.]*\./)?.[0]}`))

  // a keep point on the figure makes instance 1
  let p = await at('.hb-pc-frame', 0.23, 0.6)
  await page.mouse.click(p.x, p.y)
  await rowCount(1).catch(async () => fail(`the point made no instance: ${(await text()).match(/(nothing|load|failed)[^.]*\./)?.[0]}`))
  const decoded = (await text()).match(/decoded in (\d+) ms/)?.[1]
  // the next instance from a box around the laptop
  await click('^next instance$')
  await click('^box', '.is-side')
  const a = await at('.hb-pc-frame', 0.48, 0.52)
  const b = await at('.hb-pc-frame', 0.8, 0.8)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 })
  await page.mouse.move(b.x, b.y, { steps: 4 })
  await page.mouse.up()
  await rowCount(2).catch(() => fail('the box made no instance'))
  const listed = await rows()
  if (!/instance 1.*\d+%/.test(listed[0]) || !/instance 2/.test(listed[1])) fail(`the instance list is wrong: ${listed.join(' | ')}`)
  const tinted = await page.$$eval('.hb-pc-mask', (els) => els.filter((e) => !e.classList.contains('is-preview')).length)
  if (tinted !== 2) fail(`the canvas shows ${tinted} masks, not 2`)

  // an erase stroke on instance 1, then undo
  await page.evaluate(() => document.querySelector('.hb-inst-row button').click())
  await click('^erase', '.is-side')
  await page.waitForSelector('.hb-ab-vp.is-paint', { timeout: 3000 }).catch(() => fail('the board is not painting with an instance selected'))
  p = await at('.hb-ab-vp', 0.15, 0.6)
  const q = await at('.hb-ab-vp', 0.3, 0.6)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(q.x, q.y, { steps: 8 })
  await page.mouse.up()
  await page.waitForFunction(() => document.querySelector('.hb-inst-row')?.textContent.includes('edited'), { timeout: 3000 }).catch(() => fail('the erase stroke did not edit instance 1'))
  if (!(await click('^undo$'))) fail('no undo')
  await page.waitForFunction(() => !document.querySelector('.hb-inst-row')?.textContent.includes('edited'), { timeout: 3000 }).catch(() => fail('undo did not take the stroke back'))
  await click('^keep', '.is-side')

  // exports: the mask png and the instances json
  if (!(await click('^mask png$'))) fail('no mask png button')
  const pngPath = await download('.mask.png')
  const png = readFileSync(pngPath)
  if (png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(16) !== 640 || png.readUInt32BE(20) !== 480) fail('the mask png is not 640 by 480')
  if (!(await click('^instances json$'))) fail('no instances json button')
  const jsonPath = await download('.masks.json')
  const inst = JSON.parse(readFileSync(jsonPath, 'utf8'))
  if (inst.instances?.length !== 2 || inst.image?.width !== 640 || !inst.instances[0].rle?.counts?.length) fail('the instances json is wrong')

  // both import back as instances
  for (const [f, n] of [[pngPath, 3], [jsonPath, 5]]) {
    const [ch] = await Promise.all([page.waitForFileChooser({ timeout: 3000 }), click('^add mask$')])
    await ch.accept([f])
    await rowCount(n).catch(async () => fail(`${f} did not import back: ${(await text()).match(/(\d+ masks? added|the masks)[^.]*\./)?.[0]}`))
  }

  // the document exports and imports back
  await wait(900)
  if (!(await click('^export$'))) fail('no export button')
  const saved = await download('.hbmasks.json')
  const before = await page.evaluate(() => location.hash)
  const [c1] = await Promise.all([page.waitForFileChooser({ timeout: 3000 }), click('^import$')])
  await c1.accept([saved])
  await page.waitForFunction((h) => location.hash !== h && location.hash.includes('doc='), { timeout: 5000 }, before).catch(() => fail('the import did not open a masks document'))
  await rowCount(5).catch(() => fail('the imported document lost its instances'))

  // a png picks masks in the chooser and opens there
  const shot = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 96; c.height = 64; c.getContext('2d').fillRect(10, 10, 40, 30); return c.toDataURL('image/png').split(',')[1] })
  const pngIn = join(profile, 'desk.png')
  writeFileSync(pngIn, Buffer.from(shot, 'base64'))
  const hash = await page.evaluate(() => location.hash)
  const [c2] = await Promise.all([page.waitForFileChooser({ timeout: 3000 }), click('^import$')])
  await c2.accept([pngIn])
  // vision reads images too: the chooser names each taker
  await page.waitForFunction(() => { const b = [...document.querySelectorAll('[role="dialog"] button')].find((e) => e.textContent.trim() === 'cut out in masks'); b?.click(); return !!b }, { timeout: 4000 }).catch(() => fail('no chooser for the png'))
  await page.waitForFunction((h) => location.hash !== h && location.hash.startsWith('#/image/masks'), { timeout: 5000 }, hash).catch(() => fail('the png did not open in masks'))
  await page.waitForFunction(() => document.querySelector('.hb-islot')?.textContent.includes('96 by 64, 0 instances'), { timeout: 4000 }).catch(() => fail('the png did not land as the masks image'))

  if (off.length) fail(`requests off file://:\n${off.join('\n')}`)
  if (errors.length) fail(`console errors:\n${errors.join('\n')}`)
  console.log(`smoke-masks: ok. the sample goes in, "${load}" loads the stub, a keep point and a box make 2 instances (decode ${decoded} ms, measured), an erase stroke edits instance 1 and undo takes it back, the 640 by 480 mask png and the instances json export and import back as 3 more instances, the document exports and imports back with 5, a png imported here offers masks in the chooser and opens there, 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
