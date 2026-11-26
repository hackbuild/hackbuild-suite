// smoke-models: the bar's model chip and the model manager (rebuild plan
// 2.1 and 6) from the single file build on file://, with ?stub so no weight
// and no runtime is fetched. On the chat tool the chip opens the sheet; a
// small row loads through the shared hub, the chip and the manager say so,
// and the manager unloads it. Any request off file:// fails the run.
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
  await page.goto(`${pathToFileURL(file).href}?stub#/chat/chat`, { waitUntil: 'load' })
  const text = (t, ms = 5000) => page.waitForFunction((x) => document.body.textContent.includes(x), { timeout: ms }, t)
  const must = async (t, why, ms) => { try { await text(t, ms) } catch { throw new Error(why) } }
  // the chip: one per tool, in the bar
  await page.waitForSelector('.hb-header .hb-msel-chip', { timeout: 8000 }).catch(() => { throw new Error('the chat tool has no model chip in the bar') })
  await page.click('.hb-header .hb-msel-chip')
  await page.waitForSelector('.hb-msheet', { visible: true, timeout: 5000 }).catch(() => { throw new Error('the chip did not open the sheet') })
  // pick the smallest row the sheet offers, then the sheet's one pink load
  const picked = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.hb-msheet-list .hb-mrow-pick')].filter((r) => !r.disabled)
    const r = rows.find((x) => /360m|135m|0\.5b/i.test(x.textContent)) ?? rows[0]
    r?.click(); return r?.dataset.pick ?? null
  })
  if (!picked) throw new Error('the sheet lists no row to pick')
  const go = await page.evaluate(() => { const b = document.querySelector('.hb-msheet-foot .hb-btn-go'); b?.click(); return b?.textContent.trim() ?? null })
  if (!go || !/^load, /.test(go)) throw new Error(`the sheet's load does not name the size: ${go}`)
  await page.waitForFunction(() => /is-(ready|loaded|ok)/.test(document.querySelector('.hb-header .hb-msel-chip')?.className ?? ''), { timeout: 10000 })
    .catch(async () => { throw new Error(`the chip did not turn ready: ${await page.evaluate(() => document.querySelector('.hb-header .hb-msel-chip')?.outerHTML)}`) })
  await page.keyboard.press('Escape')
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.type('m')
  await must('stored and loaded', 'm did not open the manager')
  const unloaded = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.hb-mm-item button')].find((x) => x.textContent.trim().startsWith('unload'))
    b?.click(); return !!b
  })
  if (!unloaded) throw new Error('the manager does not list the chip load in memory')
  await must('nothing loaded.', 'unload did not empty the memory list')
  await page.keyboard.press('Escape')
  if (off.length) throw new Error(`requests off file://:\n${off.join('\n')}`)
  if (errors.length) throw new Error(`console errors:\n${errors.join('\n')}`)
  console.log(`smoke-models: ok. the chat chip opens the sheet, ${picked} loads through the hub with its size on the button, the chip reads ready, the manager unloads it, 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
