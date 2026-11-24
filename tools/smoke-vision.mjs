// smoke-vision: the vision tool (design 3.4) from the single file build on
// file://, with ?stub so every task answers from a stub and no weight is
// fetched; the detector returns canned boxes on the generated sample scene
// and the camera is Chrome's fake device. The sample goes in, the detector
// and caption models load from their size buttons, the boxes are drawn over
// the frame, a question gets a step card, the live camera runs the loop and
// a kept frame lands in history; the png, the results and the session
// export, the session imports back, and a dropped png routes to vision.
// Any request off file:// or console error fails the run.
//   npm run build:single && node tools/smoke-vision.mjs
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const url = `${pathToFileURL(file).href}?stub#/image/vision`
const profile = mkdtempSync(join(tmpdir(), 'suite-vision-'))
const downloads = join(profile, 'downloads')
mkdirSync(downloads)
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, userDataDir: profile,
  args: ['--no-first-run', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
})
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
  await page.waitForFunction(() => document.body.textContent.includes('the sample scene needs neither'), { timeout: 8000 }).catch(() => fail('the empty state is missing'))
  const click = (re) => page.evaluate((s) => {
    const b = [...document.querySelectorAll('.hb-toolpage button')].find((e) => new RegExp(s).test(e.textContent.trim()) && !e.disabled)
    b?.click(); return !!b
  }, re)
  const text = () => page.evaluate(() => document.body.textContent)

  // the sample goes in; nothing runs before a model is loaded from its size button
  await page.waitForFunction(() => [...document.querySelectorAll('.hb-islot button')].some((b) => b.textContent.trim() === 'sample'), { timeout: 8000 }).catch(() => fail('no sample button'))
  await page.evaluate(() => [...document.querySelectorAll('.hb-islot button')].find((b) => b.textContent.trim() === 'sample').click())
  await page.waitForFunction(() => document.body.textContent.includes('load a model first'), { timeout: 5000 }).catch(() => fail('the tool ran with no model loaded'))
  const loads = await page.evaluate(() => [...document.querySelectorAll('.is-side button')].map((b) => b.textContent.trim()).filter((t) => t.startsWith('load ')))
  if (loads.length !== 2 || !loads.every((l) => /\d+ mb \((inferred|vendor|measured)\)$/.test(l))) fail(`the load buttons do not name their size: ${loads.join(' | ')}`)
  for (const l of loads) {
    if (!(await page.evaluate((x) => { const b = [...document.querySelectorAll('.is-side button')].find((e) => e.textContent.trim() === x); b?.click(); return !!b }, l))) fail(`no button ${l}`)
    await wait(50)
  }
  await page.waitForFunction(() => /3 found on sample scene: a stub caption\./.test(document.body.textContent), { timeout: 10000 }).catch(async () => fail(`the run did not land: ${(await text()).match(/(\d+ found|load a model|failed)[^.]*\./)?.[0]}`))

  // the boxes are drawn: the first box edge carries the first instance colour
  const rows = await page.$$eval('.hb-inst-row', (els) => els.map((e) => e.textContent.trim()))
  if (rows.length !== 3 || !/person, \d+ deg left/.test(rows[0])) fail(`the found list is wrong: ${rows.join(' | ')}`)
  const drawn = await page.evaluate(() => {
    const c = document.querySelector('.hb-mdock canvas')
    const x = c.getContext('2d')
    const [r, g, b] = x.getImageData(Math.round(c.width * 0.08), Math.round(c.height * 0.5), 1, 1).data
    return { w: c.width, h: c.height, rgb: [r, g, b] }
  })
  const [r, g, b] = drawn.rgb
  if (!(r > 200 && g < 60 && b > 90 && b < 170)) fail(`no box drawn at the first edge: rgb ${drawn.rgb.join(',')}`)

  // ask: the step card shows the frame the model saw
  await page.type('.hb-toolpage input[aria-label="a question about the frame"]', 'what is on the desk')
  if (!(await click('^ask$'))) fail('no ask button')
  await page.waitForFunction(() => document.body.textContent.includes('stub answer to: what is on the desk') && document.querySelector('.hb-inset img[alt="the frame the model saw"]'), { timeout: 6000 }).catch(() => fail('no step card with the frame'))

  // live: the fake camera runs through the loop with a cadence readout, and a kept frame lands in history
  if (!(await click('^live camera$'))) fail('no live camera button')
  await page.waitForFunction(() => /\d+ hz, \d+ ms a step/.test(document.body.textContent), { timeout: 8000 }).catch(async () => fail(`no cadence readout: ${(await text()).match(/camera[^.]*\./)?.[0]}`))
  const cadence = await page.evaluate(() => document.body.textContent.match(/\d+ hz, \d+ ms a step/)[0])
  if (!(await page.evaluate(() => document.body.textContent.includes('camera on')))) fail('the camera chip is not lit')
  if (!(await click('^keep frame$'))) fail('no keep frame button')
  await page.waitForFunction(() => document.querySelectorAll('.hb-hist-item').length === 2, { timeout: 4000 }).catch(() => fail('the kept frame is not in history'))
  if (!(await click('^camera off$'))) fail('no camera off button')

  // history restores the sample
  await page.evaluate(() => [...document.querySelectorAll('.hb-hist-item')].at(-1).querySelector('button')?.click())
  await page.waitForFunction(() => document.querySelector('.hb-islot')?.textContent.includes('3 found'), { timeout: 3000 }).catch(() => fail('history did not restore the sample'))

  // exports: the seen png, the results, the session
  if (!(await click('^seen png$'))) fail('no seen png button')
  const png = readFileSync(await download('.seen.png'))
  if (png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(16) !== drawn.w) fail('the seen png is not the drawn frame')
  if (!(await click('^results$'))) fail('no results button')
  const res = JSON.parse(readFileSync(await download('.vision.json'), 'utf8'))
  const sampleRes = res.captures.find((c) => c.from === 'sample')
  if (!sampleRes || sampleRes.found.length !== 3 || sampleRes.caption !== 'a stub caption.' || 'image' in sampleRes) fail('the results json is wrong')
  await wait(900)
  if (!(await click('^export$'))) fail('no export button')
  const saved = await download('.hbvision.json')
  const before = await page.evaluate(() => location.hash)
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 3000 }), click('^import$')])
  await chooser.accept([saved])
  await page.waitForFunction((h) => location.hash !== h && location.hash.includes('doc='), { timeout: 5000 }, before).catch(() => fail('the import did not open a session'))
  await page.waitForFunction(() => document.querySelectorAll('.hb-hist-item').length === 2 && document.querySelectorAll('.hb-inst-row').length > 0, { timeout: 4000 }).catch(() => fail('the imported session lost its captures'))

  // a png routes to vision as a new session
  const shot = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 96; c.height = 64; c.getContext('2d').fillRect(10, 10, 40, 30); return c.toDataURL('image/png').split(',')[1] })
  const pngIn = join(profile, 'desk.png')
  writeFileSync(pngIn, Buffer.from(shot, 'base64'))
  const hash = await page.evaluate(() => location.hash)
  const [ch2] = await Promise.all([page.waitForFileChooser({ timeout: 3000 }), click('^import$')])
  await ch2.accept([pngIn])
  // masks reads images too: the chooser names each taker
  await page.waitForFunction(() => { const b = [...document.querySelectorAll('[role="dialog"] button')].find((e) => e.textContent.trim() === 'open in vision'); b?.click(); return !!b }, { timeout: 4000 }).catch(() => fail('no chooser for the png'))
  await page.waitForFunction((h) => location.hash !== h, { timeout: 5000 }, hash).catch(() => fail('the png did not open in vision'))
  await page.waitForFunction(() => document.querySelectorAll('.hb-hist-item').length === 1 && location.hash.startsWith('#/image/vision'), { timeout: 4000 }).catch(() => fail('the png did not land as one capture'))

  if (off.length) fail(`requests off file://:\n${off.join('\n')}`)
  if (errors.length) fail(`console errors:\n${errors.join('\n')}`)
  console.log(`smoke-vision: ok. the sample scene goes in, two models load from buttons that name their size, 3 canned boxes are drawn over the ${drawn.w} by ${drawn.h} frame with bearings, a question gets a step card with its frame, the fake camera runs at ${cadence} (measured) and a kept frame lands in history, the seen png, results json and session export, the session imports back with 2 captures, a png routes to vision, 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
