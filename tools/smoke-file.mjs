// smoke-file: opens the single file build from file:// in headless Chrome,
// changes route twice, and reads back the IndexedDB write the router makes.
// Fails on any console error or a missing control. Usage:
//   npm run build:single && node tools/smoke-file.mjs [--shots <dir>]
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const page_ = resolve('dist/single/index.html')
if (!existsSync(page_)) throw new Error('no single build: run npm run build:single first')
const shotsAt = process.argv.indexOf('--shots')
const shots = shotsAt > 0 ? resolve(process.argv[shotsAt + 1]) : null
if (shots) mkdirSync(shots, { recursive: true })

const profile = mkdtempSync(join(tmpdir(), 'suite-smoke-'))
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args: ['--no-first-run'] })
const errors = []
try {
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setViewport({ width: 1440, height: 900 })
  const url = pathToFileURL(page_).href
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForSelector('.hb-tabs [role="tab"]', { timeout: 10000 })
  const tabs = await page.$$eval('.hb-tabs [role="tab"]', (els) => els.map((e) => e.textContent.trim()))
  if (tabs.length !== 7) throw new Error(`expected 7 group tabs, found ${tabs.length}: ${tabs.join(', ')}`)
  if (shots) await page.screenshot({ path: join(shots, 'home-1440.png') })

  for (const [hash, expect] of [['#/voice/transcribe', 'transcribe is not built yet'], ['#/rooms', 'room is not built yet']]) {
    await page.evaluate((h) => { location.hash = h }, hash)
    await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 5000 }, expect)
    const stored = await page.evaluate(() => new Promise((res, rej) => {
      const r = indexedDB.open('hackbuild-suite', 1)
      r.onsuccess = () => {
        const q = r.result.transaction('kv').objectStore('kv').get('last-route')
        q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error)
      }
      r.onerror = () => rej(r.error)
    }))
    const want = hash.slice(1)
    if (stored !== want) throw new Error(`indexeddb last-route is ${stored}, expected ${want}`)
  }
  if (shots) {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('.hb-tabs')
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    if (wide > 0) errors.push(`sideways scroll of ${wide} px at 390`)
    await page.screenshot({ path: join(shots, 'room-390.png') })
  }
  if (errors.length) throw new Error(`console errors:\n${errors.join('\n')}`)
  console.log(`smoke-file: ok. 7 tabs, two route changes, indexeddb write read back, from ${url}`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
