// smoke-lipsync: the lipsync tool on #/motion/lipsync from the single file
// build on file://, as a phone (touch, coarse pointer). A generated wav
// (tools/test-wav.mjs, no real voice) is dropped on the window; the track
// fills with visemes, the strip paints, the mannequin's mouth morph weight
// changes as the transport scrubs, a typed line makes a text track, and the
// viseme track exports as json. Any request off file:// or console error
// fails the run.
//   npm run build:single && node tools/smoke-lipsync.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'
import { testWav } from './test-wav.mjs'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const url = `${pathToFileURL(file).href}#/motion/lipsync`

const profile = mkdtempSync(join(tmpdir(), 'suite-lipsync-'))
const downloads = join(profile, 'downloads')
mkdirSync(downloads)
const WAV = Buffer.from(testWav())
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, userDataDir: profile,
  args: ['--no-first-run', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
})
const errors = []
const off = []
const fail = (why) => { throw new Error(errors.length ? `${why}\nconsole errors:\n${errors.join('\n')}` : why) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) off.push(r.url()) })
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  const cdp = await page.createCDPSession()
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }, { name: 'any-pointer', value: 'coarse' }] })
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction(() => document.querySelector('.hb-viewport-host')?.lipsync?.track.value, { timeout: 20000 })
    .catch(async () => fail(`the tool did not start: ${await page.evaluate(() => document.querySelector('.hb-viewport')?.textContent ?? 'no stage')}`))
  const st = (fn, ...a) => page.evaluate(fn, ...a)
  const morphs = await st(() => [...document.querySelector('.hb-viewport-host').lipsync.morphs.value])
  if (!['aa', 'ih', 'ou', 'ee', 'oh'].every((m) => morphs.includes(m))) fail(`the mannequin has no mouth morphs: ${morphs}`)
  const drawn = async () => {
    const f0 = await st(() => document.querySelector('.hb-viewport-host').stageTool.walk.stage.loop.frames)
    await page.waitForFunction((f) => document.querySelector('.hb-viewport-host').stageTool.walk.stage.loop.frames > f + 1, { timeout: 10000 }, f0)
  }

  // drop the generated wav
  await page.evaluate((b64) => {
    const dt = new DataTransfer()
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'smoke-line.wav', { type: 'audio/wav' }))
    for (const k of ['dragenter', 'dragover', 'drop']) document.body.dispatchEvent(new DragEvent(k, { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, WAV.toString('base64'))
  await page.waitForFunction(() => document.querySelector('.hb-viewport-host').lipsync.track.value?.kind === 'audio', { timeout: 10000 })
    .catch(async () => fail(`the wav did not become the source: ${await st(() => document.querySelector('.hb-status, .hb-statusline')?.textContent)}`))
  const info = await st(() => {
    const t = document.querySelector('.hb-viewport-host').lipsync.track.value
    let voiced = 0
    for (let i = 0; i < t.sources.length; i++) {
      let m = 0
      for (let k = 1; k < 15; k++) m = Math.max(m, t.frames[i * 15 + k])
      if (m >= 0.05) voiced++
    }
    return { n: t.sources.length, voiced, fps: t.fps }
  })
  if (Math.abs(info.n / info.fps - 8) > 0.1) fail(`the track is ${info.n / info.fps} s, the wav 8 s`)
  if (info.voiced / info.n < 0.4) fail(`only ${info.voiced} of ${info.n} frames carry a viseme`)
  await wait(200)
  const painted = await st(() => {
    const c = document.querySelector('[data-strip="visemes"]')
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++
    return n / (c.width * c.height)
  })
  if (!(painted > 0.01)) fail(`the viseme strip is empty: ${painted}`)

  // pause, then scrub through quiet and voiced parts and read the mouth
  if (await st(() => document.querySelector('.hb-viewport-host').stageTool.transport.playing)) await page.click('.hb-transport .hb-tp-btn.is-play')
  const seekTo = async (v) => {
    await st((t) => { const s = document.querySelector('.hb-tp-scrub'); s.value = String(t); s.dispatchEvent(new Event('input', { bubbles: true })) }, v)
    await drawn()
  }
  const weights = []
  for (const t of [0.2, 1.0, 1.55, 2.9, 3.6, 5.4, 6.3]) {
    await seekTo(t)
    weights.push(await st(() => { const h = document.querySelector('.hb-viewport-host').lipsync; return Math.max(...['aa', 'ih', 'ou', 'ee', 'oh'].map((m) => h.read(m))) }))
  }
  const spread = Math.max(...weights) - Math.min(...weights)
  if (!(spread > 0.2)) fail(`the mouth did not move over time: ${weights.map((w) => w.toFixed(2)).join(', ')}`)
  if (!(weights[0] < 0.05)) fail(`the mouth is open in the quiet lead in: ${weights[0]}`)

  // a typed line makes a text track
  await page.evaluate(() => {
    const i = document.querySelector('input[aria-label="line to say"]')
    i.value = 'peter piper picked a peck of pickled peppers'
    i.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'say')?.click())
  await page.waitForFunction(() => document.querySelector('.hb-viewport-host').lipsync.track.value?.kind === 'text', { timeout: 5000 }).catch(() => fail('the line did not make a track'))
  const pp = await st(() => {
    const t = document.querySelector('.hb-viewport-host').lipsync.track.value
    let m = 0
    for (let i = 0; i < t.sources.length; i++) m = Math.max(m, t.frames[i * 15 + 1])
    return m
  })
  if (!(pp > 0.5)) fail(`the p sounds never close the lips: PP peaks at ${pp}`)

  // export the viseme track
  await page.evaluate(() => [...document.querySelectorAll('.hb-export-formats button')].find((b) => b.textContent.trim() === 'viseme track')?.click())
  await wait(100)
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.hb-export button')].find((e) => /^export .*\.visemes\.json$/.test(e.textContent.trim()) && !e.disabled)
    b?.click(); return !!b
  })
  if (!clicked) fail('no export viseme track button')
  let out = null
  for (let i = 0; i < 50 && !out; i++) {
    const f = readdirSync(downloads).find((n) => n.endsWith('.visemes.json'))
    if (f) out = join(downloads, f)
    else await wait(100)
  }
  if (!out) fail('no .visemes.json download')
  const j = JSON.parse(readFileSync(out, 'utf8'))
  if (j.format !== 'hackbuild.visemes' || j.visemes.length !== 15 || !j.frames.length || j.frames[0].length !== 15) fail(`the export is not a viseme track: ${Object.keys(j)}`)
  if (!j.keys.some((k) => k.viseme === 'PP')) fail('the exported keys hold no PP')
  await page.close()

  if (errors.length) fail('console errors')
  if (off.length) fail(`requests off file://: ${off.slice(0, 5).join(', ')}`)
  console.log(`smoke-lipsync: ok. the mannequin carries mouth morphs ${morphs.join(', ')}; a generated ${WAV.length} byte 8 s wav made ${info.n} frames at ${info.fps} fps, ${info.voiced} with a viseme; the strip painted ${(painted * 100).toFixed(1)} percent of its pixels; scrubbing moved the mouth morph between ${Math.min(...weights).toFixed(2)} and ${Math.max(...weights).toFixed(2)}; a typed line closed the lips to PP ${pp.toFixed(2)}; the track exported as json with ${j.frames.length} frames and ${j.keys.length} keys; 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
