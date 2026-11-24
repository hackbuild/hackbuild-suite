// smoke-speak: the speech tool (design 3.3) from the single file build on
// file://, with ?stub so every voice is the tone voice and no weight is
// fetched. A line is typed and said, the lit word advances through it,
// save wav writes a riff file with samples, the word timing exports, and
// the script exports and imports back with the same text. Any request off
// file:// or console error fails the run.
//   npm run build:single && node tools/smoke-speak.mjs
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'
import { writeFileSync } from 'node:fs'
import { testWav } from './test-wav.mjs'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const url = `${pathToFileURL(file).href}?stub#/voice/speak`
const profile = mkdtempSync(join(tmpdir(), 'suite-speak-'))
const downloads = join(profile, 'downloads')
mkdirSync(downloads)
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args: ['--no-first-run', '--autoplay-policy=no-user-gesture-required'] })
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
const LINE = 'the tone voice says one short tone for every word here'
try {
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) off.push(r.url()) })
  const cdp = await page.createCDPSession()
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
  await page.setViewport({ width: 1024, height: 900 })
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction(() => document.body.textContent.includes('the system voice needs no download'), { timeout: 8000 }).catch(() => fail('the empty state is missing'))
  await page.waitForFunction(() => document.querySelectorAll('.hb-methods .hb-method').length === 4, { timeout: 8000 }).catch(() => fail('the four engine cards are missing'))
  const kokoro = await page.evaluate(() => [...document.querySelectorAll('.hb-method')].find((m) => /kokoro/.test(m.textContent))?.textContent ?? '')
  if (!/gpl/.test(kokoro)) fail(`the kokoro card does not say it is off: ${kokoro}`)
  const clickText = (sel, w) => page.evaluate((s, x) => {
    const b = [...document.querySelectorAll(s)].find((e) => e.textContent.trim() === x && !e.disabled)
    b?.click(); return !!b
  }, sel, w)

  // type, then say: the lit word walks forward
  await page.click('textarea')
  await page.keyboard.type(LINE)
  await page.evaluate(() => document.activeElement?.blur())
  if (!(await clickText('.hb-toolpage button', 'say'))) fail('no say button')
  const seen = []
  for (let i = 0; i < 80; i++) {
    const at = await page.evaluate(() => [...document.querySelectorAll('.hb-spoken-w')].findIndex((w) => w.classList.contains('is-on')))
    if (at >= 0 && seen.at(-1) !== at) seen.push(at)
    if (await page.evaluate(() => document.body.textContent.includes('said on'))) break
    await wait(50)
  }
  const words = LINE.split(' ').length
  if (seen.length < 4 || seen.some((v, i) => i && v < seen[i - 1])) fail(`the lit word did not advance: ${seen.join(',')}`)
  await page.waitForFunction(() => document.body.textContent.includes('said on'), { timeout: 8000 }).catch(() => fail('say did not finish'))

  // save wav: a riff header and samples
  if (!(await clickText('.hb-toolpage button', 'save wav'))) fail('no save wav button')
  const wav = readFileSync(await download('.wav'))
  const riff = wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE'
  const dataAt = wav.indexOf(Buffer.from('data'))
  const dataLen = dataAt > 0 ? wav.readUInt32LE(dataAt + 4) : 0
  if (!riff || dataLen <= 0 || wav.length < 44 + dataLen) fail(`the wav is not valid: riff ${riff}, data ${dataLen} B, file ${wav.length} B`)
  await page.waitForFunction(() => document.body.textContent.includes('saved '), { timeout: 4000 }).catch(() => fail('save wav said nothing'))

  // word timing for the lipsync tool
  await wait(200)
  if (!(await clickText('.hb-toolpage button', 'word timing'))) fail('no word timing button after the wav')
  const timing = JSON.parse(readFileSync(await download('.timing.json'), 'utf8'))
  if (timing.words.length !== words || timing.words[1].text !== 'tone') fail(`the timing is wrong: ${timing.words.length} words`)

  // the script exports and imports back
  await wait(900)
  if (!(await clickText('.hb-toolpage button', 'export'))) fail('no export button')
  const saved = await download('.hbspeech.json')
  const before = await page.evaluate(() => location.hash)
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 3000 }), clickText('.hb-toolpage button', 'import')])
  await chooser.accept([saved])
  await page.waitForFunction((h) => location.hash !== h && location.hash.includes('doc='), { timeout: 5000 }, before).catch(() => fail('the import did not open a script'))
  await page.waitForFunction((t) => document.querySelector('textarea')?.value === t, { timeout: 4000 }, LINE).catch(() => fail('the imported script has other text'))
  const runs = await page.$$eval('.hb-hist-item', (els) => els.length)
  if (runs < 2) fail(`the imported script carries ${runs} runs, want 2`)

  // pocket: picking it fetches nothing; load is a separate press that names the size
  await page.evaluate(() => [...document.querySelectorAll('.hb-method')].find((m) => /pocket/.test(m.textContent))?.click())
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /^load pocket tts, size unknown/.test(b.textContent.trim())), { timeout: 3000 }).catch(() => fail('pocket has no load button with its size'))
  if (await page.$('.is-side .hb-dropzone')) fail('the clone slot shows before pocket loads')
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /^load pocket tts/.test(b.textContent.trim()))?.click())
  await page.waitForSelector('.is-side .hb-dropzone input[type=file]', { timeout: 6000 }).catch(() => fail('pocket did not load'))
  const licence = await page.evaluate(() => document.body.textContent.includes('CC-BY-4.0'))
  if (!licence) fail('the pocket licence is not shown as recorded')
  await page.waitForFunction(() => [...document.querySelectorAll('select option')].some((o) => o.textContent.trim() === 'stub one'), { timeout: 3000 }).catch(() => fail('the pocket voice list is missing'))

  // clone from a generated wav: the custom voice is picked
  const clip = join(profile, 'clip.wav')
  writeFileSync(clip, Buffer.from(testWav()))
  const input = await page.$('.is-side .hb-dropzone input[type=file]')
  await input.uploadFile(clip)
  await input.evaluate((e) => e.dispatchEvent(new Event('change', { bubbles: true })))
  await page.waitForFunction(() => document.body.textContent.includes('cloned voice active'), { timeout: 6000 }).catch(async () => fail(`the clone did not land: ${await page.evaluate(() => document.querySelector('.is-side .hb-dropzone')?.parentElement?.textContent)}`))
  const picked = await page.evaluate(() => [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'custom'))?.value)
  if (picked !== 'custom') fail(`the custom voice is not picked: ${picked}`)

  // stream: the first sentence sounds before the last word has arrived
  await page.evaluate(() => { const t = document.querySelector('textarea'); t.focus(); t.value = ''; t.dispatchEvent(new Event('input')) })
  await page.keyboard.type('the first sentence speaks right away. the second one is still arriving word by word while the first plays.')
  await page.evaluate(() => document.activeElement?.blur())
  if (!(await clickText('.hb-toolpage button', 'stream'))) fail('no stream button')
  await page.waitForFunction(() => /streamed: first sound at \d+ ms, before the last word/.test(document.body.textContent), { timeout: 15000 })
    .catch(async () => fail(`the stream did not start before the text finished: ${await page.evaluate(() => document.querySelector('.hb-statusline, .hb-status')?.textContent ?? document.body.textContent.match(/streamed[^.]*\./)?.[0])}`))
  const streamed = await page.evaluate(() => document.body.textContent.match(/first sound at (\d+) ms, before the last word arrived at (\d+) ms/).slice(1).join(' of '))

  if (off.length) fail(`requests off file://:\n${off.join('\n')}`)
  if (errors.length) fail(`console errors:\n${errors.join('\n')}`)
  console.log(`smoke-speak: ok. a typed line is said on the tone voice and the lit word advances through ${seen.length} of ${words} words, save wav writes a riff file with ${dataLen} B of samples (measured), the word timing has ${timing.words.length} words, the script exports and imports back with its text and ${runs} runs; pocket loads only on its load press, lists its voices, clones from a generated wav, and a streamed line sounds at ${streamed} ms (measured), 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
