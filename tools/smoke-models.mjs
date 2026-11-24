// smoke-models: the model manager and the capability panel (design 2.2,
// 2.4) from the single file build on file://, with ?stub so no weight and no
// runtime is fetched. Home shows the welcome with the capability rows; a row
// loads through the hub and the pill, the status strip and the manager say
// so; the manager unloads it; the mic row fails with a named reason under a
// denied permission. Any request off file:// fails the run.
//   npm run build:single && node tools/smoke-models.mjs
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const profile = mkdtempSync(join(tmpdir(), 'suite-models-'))
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args: ['--no-first-run', '--use-fake-ui-for-media-stream=deny'] })
const errors = []
const off = []
try {
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) off.push(r.url()) })
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${pathToFileURL(file).href}?stub#/`, { waitUntil: 'load' })
  const text = (t, ms = 5000) => page.waitForFunction((x) => document.body.textContent.includes(x), { timeout: ms }, t)
  const must = async (t, why, ms) => { try { await text(t, ms) } catch { throw new Error(why) } }
  await page.waitForSelector('.hb-welcome .hb-caps-list .hb-cap', { timeout: 5000 }).catch(() => { throw new Error('home has no capability panel') })
  await page.waitForFunction(() => document.querySelectorAll('.hb-welcome-steps .is-done').length >= 1, { timeout: 5000 })
    .catch(() => { throw new Error('the welcome list did not tick the machine step') })
  const press = (row, start) => page.evaluate((r, s) => {
    const li = [...document.querySelectorAll('.hb-cap')].find((x) => x.querySelector('.hb-cap-name')?.textContent.startsWith(r))
    const b = li && [...li.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(s))
    b?.click(); return !!b
  }, row, start)
  if (!(await press('chat on cpu', 'download'))) throw new Error('the cpu chat row has no download button naming the size')
  await page.waitForFunction(() => [...document.querySelectorAll('.hb-pill')].some((p) => p.textContent.trim() === 'brain' && /ok|on|ready/.test(p.className)), { timeout: 5000 })
    .catch(() => { throw new Error('the brain pill did not turn on after the load') })
  const cell = await page.$eval('.hb-statusbar', (e) => e.textContent)
  if (/model\s*none/.test(cell)) throw new Error('the status strip still reads model none')
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.type('m')
  await must('stored and loaded', 'm did not open the manager')
  const unloaded = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.hb-mm-item button')].find((x) => x.textContent.trim().startsWith('unload'))
    b?.click(); return !!b
  })
  if (!unloaded) throw new Error('the manager lists nothing in memory')
  await must('nothing loaded.', 'unload did not empty the memory list')
  await page.keyboard.press('Escape')
  if (!(await press('microphone', 'allow'))) throw new Error('the mic row has no allow button')
  await page.waitForFunction(() => /mic is blocked|no microphone found|mic is in use/.test(document.body.innerText), { timeout: 5000 })
    .catch(() => { throw new Error('a denied mic did not show a named reason') })
  if (off.length) throw new Error(`requests off file://:\n${off.join('\n')}`)
  if (errors.length) throw new Error(`console errors:\n${errors.join('\n')}`)
  console.log('smoke-models: ok. welcome ticks from the probe, a stub load turns the brain pill and the status strip on, the manager unloads it, a denied mic names the failure, 0 requests off file:// (measured)')
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
