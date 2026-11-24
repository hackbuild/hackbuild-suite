// smoke-generate: the image generation tool (design 3.7) from the single
// file build on file://, with ?stub so the weightless model paints the
// seeded latent and no weight is fetched. The load button names the size
// with its source word; a prompt runs with the step named on the stage
// and four timing cells; a long run stops on esc; the same locked seed
// gives the same pixels and a reroll gives other pixels; the compare wipe
// shows two runs; history puts a run's settings back on the form; the png
// carries its settings in a text chunk, the sidecar restores them, and the
// session exports and imports back with its runs. Any request off file://
// or console error fails the run.
//   npm run build:single && node tools/smoke-generate.mjs
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'
import { pngText, PNG_KEY, readSettings } from '../src/generate/kind.ts'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const url = `${pathToFileURL(file).href}?stub#/image/generate`
const profile = mkdtempSync(join(tmpdir(), 'suite-generate-'))
const downloads = join(profile, 'downloads')
mkdirSync(downloads)
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args: ['--no-first-run'] })
const errors = []
const off = []
const fail = (why) => { throw new Error(why) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function download(end) {
  for (let i = 0; i < 60; i++) {
    const f = readdirSync(downloads).find((n) => n.endsWith(end) && !n.endsWith('.crdownload'))
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
  const text = () => page.evaluate(() => document.body.textContent)
  // the send to menu: open it, then pick the row "<what> to <tool>"
  const sendTo = (label) => page.evaluate(async (x) => {
    document.querySelector('[data-sendto]')?.click()
    await new Promise((r) => setTimeout(r, 60))
    const b = [...document.querySelectorAll('.hb-menu-item')].find((e) => e.textContent.trim() === x && !e.disabled)
    b?.click(); return !!b
  }, label)
  const click = (re) => page.evaluate((s) => {
    const b = [...document.querySelectorAll('.hb-toolpage button')].find((e) => new RegExp(s).test(e.textContent.trim()) && !e.disabled)
    b?.click(); return !!b
  }, re)
  const shown = () => page.evaluate(() => document.querySelector('.hb-viewport img')?.getAttribute('src') ?? null)
  const setSeed = (n) => page.evaluate((v) => {
    const i = document.querySelector('.hb-seed input[type="number"], .hb-seed-input')
    i.value = String(v)
    i.dispatchEvent(new Event('input', { bubbles: true }))
    i.dispatchEvent(new Event('change', { bubbles: true }))
  }, n)
  const seedNow = () => page.evaluate(() => Number(document.querySelector('.hb-seed input[type="number"], .hb-seed-input').value))

  // empty: no model, the stage says so, and the load button names the size with its source word
  await page.waitForFunction(() => document.body.textContent.includes('webgpu ready, model not loaded'), { timeout: 8000 }).catch(async () => fail(`no ready line: ${(await text()).slice(0, 300)}`))
  if (!(await text()).includes('no signal')) fail('the empty stage is missing')
  if (!(await click('^generate$'))) fail('no generate button')
  await page.waitForFunction(() => document.body.textContent.includes('press load first'), { timeout: 3000 }).catch(() => fail('generate ran with no model'))
  const cards = await page.$$eval('.hb-methods > *', (els) => els.map((e) => e.textContent.trim()))
  if (cards.length !== 2) fail(`expected 2 model cards, found ${cards.length}`)
  // sd 1.5: the form grows a negative prompt and guidance; its repo and size are inferred
  await page.evaluate(() => [...document.querySelectorAll('.hb-methods > *')].find((e) => /stable diffusion 1\.5/.test(e.textContent))?.click())
  await page.waitForFunction(() => document.querySelector('#gen-neg') && document.body.textContent.includes('guidance'), { timeout: 3000 }).catch(() => fail('the form did not reshape for sd 1.5'))
  if (!/microsoft\/stable-diffusion-v1\.5-webnn, about 2\.0 gb \(inferred\)/.test(await text())) fail('sd 1.5 source and size lack the inferred word')
  await page.evaluate(() => [...document.querySelectorAll('.hb-methods > *')].find((e) => /sd-turbo/.test(e.textContent))?.click())
  await page.waitForFunction(() => !document.querySelector('#gen-neg'), { timeout: 3000 }).catch(() => fail('the form did not reshape for sd-turbo'))
  const load = await page.evaluate(() => [...document.querySelectorAll('.is-side button')].map((b) => b.textContent.trim()).find((t) => t.startsWith('load ')))
  if (!/^load sd-turbo 512, about 2\.6 gb \(inferred\)$/.test(load ?? '')) fail(`the load button does not name its size: ${load}`)
  if (!(await click('^load sd-turbo'))) fail('no load button')
  await page.waitForFunction(() => document.body.textContent.includes('sd-turbo 512 loaded'), { timeout: 8000 }).catch(async () => fail(`the model did not load: ${(await text()).match(/(fail|stopped)[^.]*\./)?.[0]}`))

  // run: the step is named on the stage, then the image and four timing cells
  await setSeed(4242)
  await page.$eval('#gen-prompt', (t) => { t.value = 'a brass ferrule on a bench'; t.dispatchEvent(new Event('input', { bubbles: true })) })
  const mod = (await page.evaluate(() => /Mac/.test(navigator.platform))) ? 'Meta' : 'Control'
  await page.keyboard.down(mod); await page.keyboard.press('Enter'); await page.keyboard.up(mod)
  await page.waitForFunction(() => /denoising, step \d of \d|encoding prompt/.test(document.querySelector('.hb-vp-cover')?.textContent ?? ''), { timeout: 3000 }).catch(() => fail('the stage did not name the step'))
  await page.waitForFunction(() => document.body.textContent.includes('done in'), { timeout: 10000 }).catch(() => fail('the run did not finish'))
  const first = await shown()
  if (!first?.startsWith('data:image/png')) fail('no image on the stage')
  const cells = await page.$$eval('.hb-readout, .hb-readouts > *', (els) => els.length)
  if (cells < 4) fail(`expected 4 timing cells, found ${cells}`)
  if (!(await text()).includes('sd-turbo, seed 4242, 2 steps')) fail('no log line with model, seed and steps')

  // same locked seed: same pixels
  if (await seedNow() !== 4242) fail('the locked seed moved')
  if (!(await click('^generate$'))) fail('no generate button')
  await page.waitForFunction(() => document.querySelectorAll('.hb-hist-item').length === 2 && !document.querySelector('.hb-vp-cover'), { timeout: 10000 }).catch(() => fail('the second run did not land'))
  if ((await shown()) !== first) fail('the same seed gave other pixels')

  // stop: sd 1.5 runs 22 guided steps, esc stops it and nothing is kept
  await page.evaluate(() => [...document.querySelectorAll('.hb-methods > *')].find((e) => /stable diffusion 1\.5/.test(e.textContent))?.click())
  if (!(await click('^load stable diffusion 1\\.5'))) fail('no sd 1.5 load button')
  await page.waitForFunction(() => document.body.textContent.includes('stable diffusion 1.5 loaded'), { timeout: 8000 }).catch(() => fail('sd 1.5 did not load'))
  if (!(await click('^generate$'))) fail('no generate button')
  await page.waitForFunction(() => /denoising, step [3-9] of 22/.test(document.querySelector('.hb-vp-cover')?.textContent ?? ''), { timeout: 8000 }).catch(() => fail('sd 1.5 did not step'))
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => /stopped at denoising, step \d+ of 22\. nothing was kept\./.test(document.body.textContent), { timeout: 4000 }).catch(async () => fail(`esc did not stop the run: ${(await text()).match(/(stopped|done|failed)[^.]*\./)?.[0]}`))
  if (await page.$$eval('.hb-hist-item', (e) => e.length) !== 2) fail('a stopped run was kept')

  // reroll on sd-turbo: other pixels, and the compare wipe shows two runs
  await page.evaluate(() => [...document.querySelectorAll('.hb-methods > *')].find((e) => /sd-turbo/.test(e.textContent))?.click())
  await page.keyboard.press('r')
  if (await seedNow() === 4242) fail('r did not reroll the seed')
  if (!(await click('^generate$'))) fail('no generate button')
  await page.waitForFunction(() => document.querySelectorAll('.hb-hist-item').length === 3 && !document.querySelector('.hb-vp-cover'), { timeout: 10000 }).catch(() => fail('the rerolled run did not land'))
  if ((await shown()) === first) fail('a new seed gave the same pixels')
  const split = await page.$$eval('.hb-split img', (els) => els.map((e) => e.getAttribute('src')))
  if (split.length !== 2 || split[0] === split[1]) fail('the compare wipe does not show two runs')

  // history: the oldest run puts seed 4242 back on the form
  await page.evaluate(() => [...document.querySelectorAll('.hb-hist-item')].at(-1).querySelector('button')?.click())
  await page.waitForFunction(() => document.body.textContent.includes('settings of seed 4242 are back'), { timeout: 3000 }).catch(() => fail('history did not restore the settings'))
  if (await seedNow() !== 4242 || (await shown()) !== first) fail('history did not bring back seed 4242')

  // save png with settings inside, the sidecar, the session export and import
  if (!(await click('^save png$'))) fail('no save png button')
  const png = readFileSync(await download('.png'))
  const inPng = readSettings(pngText(new Uint8Array(png))[PNG_KEY] ?? 'x')
  if (inPng.seed !== 4242 || inPng.prompt !== 'a brass ferrule on a bench' || inPng.model !== 'sd-turbo') fail('the png lacks its settings')
  if (!/generate_sd-turbo_4242_/.test(readdirSync(downloads).find((n) => n.endsWith('.png')))) fail('the png name does not carry the run')
  if (!(await click('^settings json$'))) fail('no settings json button')
  const side = await download('.imagegen.json')
  await wait(900)
  if (!(await click('^export$'))) fail('no export button')
  const saved = await download('.hbimagegen.json')
  const before = await page.evaluate(() => location.hash)
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 3000 }), click('^import$')])
  await chooser.accept([saved])
  await page.waitForFunction((h) => location.hash !== h && location.hash.includes('doc='), { timeout: 5000 }, before).catch(() => fail('the import did not open a session'))
  await page.waitForFunction(() => document.querySelectorAll('.hb-hist-item').length === 3, { timeout: 4000 }).catch(() => fail('the imported session lost its runs'))
  const hash = await page.evaluate(() => location.hash)
  const [ch2] = await Promise.all([page.waitForFileChooser({ timeout: 3000 }), click('^import$')])
  await ch2.accept([side])
  // chat and memory read json too: the chooser names each taker
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'restore the run settings'), { timeout: 4000 }).catch(() => fail('no chooser for the sidecar'))
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'restore the run settings').click())
  await page.waitForFunction((h) => location.hash !== h, { timeout: 5000 }, hash).catch(() => fail('the sidecar did not open'))
  await page.waitForFunction(() => document.querySelectorAll('.hb-hist-item').length === 0, { timeout: 4000 }).catch(() => fail('the sidecar did not open a fresh session'))
  if (await seedNow() !== 4242) fail('the sidecar did not restore the seed')

  // send to vision: generate on the restored settings, then the run opens as a vision capture
  if (!(await click('^generate$'))) fail('no generate button')
  await page.waitForFunction(() => document.querySelectorAll('.hb-hist-item').length === 1 && !document.querySelector('.hb-vp-cover'), { timeout: 10000 }).catch(() => fail('the restored run did not land'))
  if ((await shown()) !== first) fail('the restored settings gave other pixels')
  if (!(await sendTo('image to vision'))) fail('no image to vision in send to')
  await page.waitForFunction(() => location.hash.startsWith('#/image/vision') && document.querySelectorAll('.hb-hist-item').length === 1, { timeout: 6000 }).catch(() => fail('the run did not open in vision'))

  if (off.length) fail(`requests off file://:\n${off.join('\n')}`)
  if (errors.length) fail(`console errors:\n${errors.join('\n')}`)
  console.log('smoke-generate: ok. the load button names 2.6 gb (inferred) and sd 1.5 shows its inferred repo and size, the form reshapes per model, a prompt runs with the step on the stage and 4 timing cells, the locked seed repeats the pixels, esc stops a 22 step run and keeps nothing, a reroll gives other pixels, the wipe compares two runs, history restores seed 4242, the png carries its settings, the sidecar restores them, the session exports and imports with 3 runs, a run opens in vision, 0 requests off file:// (measured)')
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
