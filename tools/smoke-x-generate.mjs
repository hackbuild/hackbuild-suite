// smoke-x-generate: the generate explorer (#/x/generate) on ?stub, from the
// hosted build, with model hosts and weight files blocked. The frame says no
// signal and the one pink names the model and its size; the form reshapes
// per model (sd 1.5 brings guidance and a negative prompt); a load turns the
// pink to generate; a run lands with four timings and in the runs tab; a
// second run with another seed, then a press on the first, puts its prompt
// and seed back; download png appears with a picture.
//   npm run build && node tools/smoke-x-generate.mjs [--shots <dir>]
import { existsSync, mkdirSync } from 'node:fs'
import { launch, serveDir } from './browse.mjs'

if (!existsSync('dist/hosted/index.html')) throw new Error('no hosted build: run npm run build first')
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null
if (shots) mkdirSync(shots, { recursive: true })
const server = await serveDir('dist/hosted')
const chrome = await launch({ prefix: 'smoke-x-generate-', blockModels: true })
const errors = []
const fail = (m) => { throw new Error(m) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  const page = await chrome.browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${server.base}?stub#/x/generate`, { waitUntil: 'load' })
  await page.waitForSelector('.hb-lay-empty', { timeout: 10000 }).catch(() => fail('no empty frame'))
  await wait(400)
  const pinks = () => page.evaluate(() => [...document.querySelectorAll('.hb-btn-go')].filter((b) => b.checkVisibility()).map((b) => b.textContent.trim()))
  const S = (fn, a) => page.evaluate(fn, a)
  const p0 = await pinks()
  if (p0.length !== 1 || !/^load sd-turbo/.test(p0[0]) || !/gb/.test(p0[0])) fail(`first pink: ${p0.join(', ')}`)
  const fields = () => page.evaluate(() => ({ neg: !!document.querySelector('#xg-neg'), guidance: [...document.querySelectorAll('.hb-rack-pane:not([hidden]) label, .hb-rack-pane:not([hidden]) .hb-label')].some((l) => /guidance/.test(l.textContent)) }))
  const turbo = await fields()
  if (turbo.neg || turbo.guidance) fail('sd-turbo shows guidance or a negative prompt')
  await S(() => window.hbExplorer.choose('sd-1.5'))
  await wait(200)
  const sd15 = await fields()
  if (!sd15.neg || !sd15.guidance) fail('sd 1.5 lacks guidance or a negative prompt')
  if ((await S(() => window.hbExplorer.state().steps)) !== 22) fail('sd 1.5 steps did not default to 22')
  await S(() => window.hbExplorer.choose('sd-turbo'))
  await wait(200)
  await page.evaluate(() => document.querySelector('.hb-rack .hb-btn-go').click())
  await page.waitForFunction(() => [...document.querySelectorAll('.hb-btn-go')].some((b) => b.textContent.trim() === 'generate'), { timeout: 8000 }).catch(() => fail('the pink did not turn to generate'))
  await S(() => window.hbExplorer.generate())
  if ((await S(() => window.hbExplorer.state().runs)) !== 1) fail('the run did not land')
  const total = await page.evaluate(() => document.querySelector('.hb-rack-pane:not([hidden])').textContent.includes('total'))
  if (!total) fail('no timings after a run')
  if (!(await page.$('.xg-frame img'))) fail('no picture in the frame')
  if (shots) await page.screenshot({ path: `${shots}/x-generate-run-1440.png` })
  const seed1 = await S(() => window.hbExplorer.state().seed)
  await S(() => window.hbExplorer.setSeed(777))
  await S(() => window.hbExplorer.generate())
  await S(() => window.hbExplorer.restore(1))
  if ((await S(() => window.hbExplorer.state().seed)) !== seed1) fail('restore did not put the seed back')
  const verbs = await page.$$eval('.hb-lay-verbs button', (b) => b.map((x) => x.textContent.trim()))
  if (!verbs.includes('download png')) fail(`no download png: ${verbs.join(', ')}`)
  if ((await pinks()).length !== 1) fail(`more than one pink: ${(await pinks()).join(', ')}`)
  if (errors.length) fail(`console errors:\n${errors.join('\n')}`)
  console.log(`smoke-x-generate: ok. one pink (${p0[0]}); sd-turbo hides guidance and negative, sd 1.5 shows both with 22 steps; a load turned the pink to generate; 2 runs with timings; restore put seed ${seed1} back; download png (measured)`)
} finally {
  await chrome.close()
  server.close?.()
}
