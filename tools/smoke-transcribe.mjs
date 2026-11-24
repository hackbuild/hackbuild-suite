// smoke-transcribe: the transcription tool (design 3.2) from the single file
// build on file://, with ?stub so the transcriber returns canned segments
// and no weight is fetched. A generated wav is dropped on the window, routes
// to the tool as a queued file, one press runs the queue (the dsp core is
// real), segments land, one is edited, ctrl+z undoes the edit, the srt is
// exported and imported back as a second transcript with the same lines,
// and the zip of every file carries its manifest. Any request off file://
// or console error fails the run.
//   npm run build:single && node tools/smoke-transcribe.mjs
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'
import { testWav } from './test-wav.mjs'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const url = `${pathToFileURL(file).href}?stub#/voice/transcribe`
const profile = mkdtempSync(join(tmpdir(), 'suite-transcribe-'))
const downloads = join(profile, 'downloads')
mkdirSync(downloads)
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args: ['--no-first-run'] })
const errors = []
const off = []
const fail = (why) => { throw new Error(why) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function download(end) {
  for (let i = 0; i < 50; i++) {
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
  await page.waitForFunction(() => document.body.textContent.includes('nothing leaves this tab'), { timeout: 5000 }).catch(() => fail('the empty state is missing'))
  await page.waitForFunction(() => document.body.textContent.includes('ready.'), { timeout: 8000 }).catch(() => fail('the tool did not log ready'))

  // drop a wav on the window: the drop router makes it a queued transcript
  const wav = Buffer.from(testWav()).toString('base64')
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'take one.wav', { type: 'audio/wav' }))
    for (const t of ['dragenter', 'dragover', 'drop']) document.body.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, wav)
  await page.waitForFunction(() => /take one/.test(document.querySelector('.hb-qstrips')?.textContent ?? '') && /queued/.test(document.querySelector('.hb-qstrips')?.textContent ?? ''), { timeout: 6000 })
    .catch(async () => fail(`the dropped wav is not a queued strip: ${await page.evaluate(() => document.querySelector('.hb-qstrips')?.textContent)}`))

  // one press runs the queue: the stub model loads, the dsp core runs, segments land
  const clickText = (sel, w) => page.evaluate((s, x) => {
    const b = [...document.querySelectorAll(s)].find((e) => e.textContent.trim().startsWith(x) && !e.disabled)
    b?.click(); return !!b
  }, sel, w)
  if (!(await clickText('button', 'load'))) {
    if (!(await clickText('button', 'transcribe 1'))) fail('no transcribe button names the queue')
  }
  await page.waitForFunction(() => document.querySelectorAll('.hb-transcript .hb-tseg:not(.is-dropped) .hb-tseg-text[contenteditable]').length >= 2, { timeout: 20000 })
    .catch(async () => fail(`no segments after the run. log: ${await page.evaluate(() => document.querySelector('.hb-console')?.textContent)}`))
  const texts = () => page.$$eval('.hb-transcript .hb-tseg:not(.is-dropped) .hb-tseg-text', (els) => els.map((e) => e.textContent.trim()))
  const first = await texts()
  if (!first[0].includes('level rail')) fail(`unexpected first line: ${first[0]}`)
  const rail = await page.$('.hb-rail, .hb-levelrail, [aria-label="level rail"]')
  if (!rail) fail('no level rail after the run')

  // edit one line, then ctrl+z brings the text back
  await page.evaluate(() => {
    const el = document.querySelector('.hb-transcript .hb-tseg:not(.is-dropped) .hb-tseg-text[contenteditable]')
    el.focus(); el.textContent = 'edited by the smoke'; el.blur()
  })
  await page.waitForFunction(() => document.querySelector('.hb-transcript .hb-tseg-text')?.textContent.includes('edited by the smoke'), { timeout: 3000 }).catch(() => fail('the edit did not land'))
  await wait(300)
  const mod = (await page.evaluate(() => /Mac/.test(navigator.platform))) ? 'Meta' : 'Control'
  await page.keyboard.down(mod); await page.keyboard.press('z'); await page.keyboard.up(mod)
  await page.waitForFunction((t) => document.querySelector('.hb-transcript .hb-tseg-text')?.textContent.trim() === t, { timeout: 3000 }, first[0]).catch(() => fail('ctrl+z did not undo the edit'))

  // export the srt, then import it back as a second transcript
  await wait(900)
  if (!(await clickText('.hb-export-formats .hb-chip', 'srt'))) fail('no srt format chip')
  await wait(100)
  if (!(await clickText('.hb-export-btns .hb-btn', 'export'))) fail('no export button')
  const srtPath = await download('.srt')
  const srt = readFileSync(srtPath, 'utf8')
  if (!srt.includes('-->') || !srt.includes(first[0])) fail(`the srt is wrong:\n${srt}`)
  const before = await page.evaluate(() => location.hash)
  await page.evaluate((text) => {
    const dt = new DataTransfer()
    dt.items.add(new File([text], 'take one back.srt', { type: 'application/x-subrip' }))
    for (const t of ['dragenter', 'dragover', 'drop']) document.body.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, srt)
  await page.waitForFunction((h) => location.hash !== h && location.hash.includes('doc='), { timeout: 5000 }, before).catch(() => fail('the srt import did not open a document'))
  await page.waitForFunction(() => document.querySelectorAll('.hb-qstrip-main, .hb-qstrip').length >= 2, { timeout: 4000 }).catch(() => fail('the queue list does not show both transcripts'))
  await page.waitForFunction((n) => document.querySelectorAll('.hb-transcript .hb-tseg:not(.is-dropped) .hb-tseg-text').length === n, { timeout: 4000 }, first.length).catch(() => fail('the imported transcript has a different line count'))
  const back = await texts()
  if (back.join('|') !== first.join('|')) fail(`the imported lines differ:\n${back.join('\n')}\nwant\n${first.join('\n')}`)

  // every file as one zip with a manifest
  if (!(await clickText('.hb-export-formats .hb-chip', 'zip'))) fail('no zip format chip')
  await wait(100)
  await clickText('.hb-export-btns .hb-btn', 'export')
  const zip = readFileSync(await download('.zip'))
  if (!zip.includes(Buffer.from('manifest.json'))) fail('the zip has no manifest.json')

  if (off.length) fail(`requests off file://:\n${off.join('\n')}`)
  if (errors.length) fail(`console errors:\n${errors.join('\n')}`)
  console.log(`smoke-transcribe: ok. a dropped wav queues, one press loads the stub model and runs the real dsp core, ${first.length} segments land, an edit is undone with ctrl+z, the srt exports and imports back with the same ${first.length} lines, the zip carries manifest.json, 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
