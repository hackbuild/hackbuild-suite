// smoke-isolation: the cross origin isolation worker (design 5 item 10) on
// the hosted build, served the way Pages serves it (vite preview, no COOP
// or COEP headers). The first load registers public/coi-sw.js and reloads
// once; then the page is cross origin isolated, SharedArrayBuffer exists,
// the machine line reports the thread count from @hackbuild/devices and the
// transcribe copy names it. The settings switch turns it off (one reload,
// not isolated, the copy says why) and on again. The worker keeps no cache
// and never sees a cross origin request. The single file builds carry no
// worker. With ?stub nothing fetches a weight. Any console error fails.
//   npm run build:all && node tools/smoke-isolation.mjs [--net] [--shots <dir>]
// --net adds HEAD only checks, from the isolated page, of every cross origin
// host the suite fetches from (no weight is downloaded).
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const fail = (why) => { throw new Error(why) }
if (!existsSync('dist/hosted/coi-sw.js')) fail('no dist/hosted/coi-sw.js: run npm run build first')
for (const dir of ['dist/single', 'dist/groups']) {
  if (!existsSync(dir)) continue
  for (const f of readdirSync(dir, { recursive: true })) {
    const p = join(dir, String(f))
    if (String(f).endsWith('coi-sw.js')) fail(`${p} ships the isolation worker`)
    if (p.endsWith('.html') && readFileSync(p, 'utf8').includes('coi-sw.js')) fail(`${p} registers the isolation worker`)
  }
}
const net = process.argv.includes('--net')
const shotsAt = process.argv.indexOf('--shots')
const shots = shotsAt > 0 ? resolve(process.argv[shotsAt + 1]) : null
if (shots) mkdirSync(shots, { recursive: true })

const PORT = 4300 + Math.floor(Math.random() * 400)
const srv = spawn('npx', ['vite', 'preview', '--outDir', 'dist/hosted', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' })
await new Promise((res, rej) => {
  srv.stdout.on('data', (d) => { if (String(d).includes(String(PORT))) res() })
  setTimeout(() => rej(new Error('vite preview did not start')), 20000)
})
const BASE = `http://localhost:${PORT}/`
const profile = mkdtempSync(join(tmpdir(), 'suite-isolation-'))
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args: ['--no-first-run'] })
const errors = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// poll across the reloads the worker makes
async function until(page, fn, what, ms = 15000) {
  const t0 = Date.now()
  for (;;) {
    try { if (await page.evaluate(fn)) return } catch { /* navigating */ }
    if (Date.now() - t0 > ms) fail(`timed out waiting for ${what}`)
    await sleep(50)
  }
}
const facts = (page) => page.evaluate(() => ({ iso: self.crossOriginIsolated, sab: typeof SharedArrayBuffer !== 'undefined', sw: !!navigator.serviceWorker.controller }))
const hint = (page) => page.evaluate(() => [...document.querySelectorAll('.hb-hint')].map((e) => e.textContent).find((t) => /selected|chose/.test(t)) ?? '')
async function machine(page, shot) {
  await page.click('body')
  await page.keyboard.type('m')
  await until(page, () => /wasm threads|threads: off here/.test(document.body.innerText), 'the machine line')
  const line = await page.evaluate(() => document.body.innerText.match(/[^\n,]*(wasm threads[^\n]*|threads: off here[^\n]*)/)?.[0].trim() ?? '')
  if (shot) await page.screenshot({ path: shot })
  await page.keyboard.press('Escape')
  return line
}
// the settings switch, by its label; returns the time origin of the page it left
const SWITCH = () => [...document.querySelectorAll('[role="switch"]')].find((x) => x.getAttribute('aria-label') === 'wasm threads' || x.closest('.hb-param, .hb-paramrow, label')?.textContent.includes('wasm threads'))
async function flip(page, shot) {
  await page.click('body')
  await page.keyboard.type(',')
  await until(page, `!!(${SWITCH})()`, 'the wasm threads switch')
  const was = await page.evaluate(() => performance.timeOrigin)
  if (shot) {
    await page.evaluate(`(${SWITCH})().scrollIntoView({ block: 'center' })`)
    await sleep(600)
    await page.screenshot({ path: shot })
  }
  await page.evaluate(`(${SWITCH})().click()`)
  return was
}
const reloaded = async (page, origin) => until(page, `performance.timeOrigin !== ${origin} && document.readyState === 'complete'`, 'the reload')

const HOSTS = [
  ['jsdelivr, transformers.js 4.3.2', 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js'],
  ['jsdelivr, onnxruntime-web 1.27.0 module', 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort.webgpu.min.mjs'],
  ['jsdelivr, onnxruntime-web 1.27.0 threaded wasm', 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort-wasm-simd-threaded.jsep.wasm'],
  ['jsdelivr, web-llm 0.2.84', 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.84/+esm'],
  ['esm.run, web-llm 0.2.84', 'https://esm.run/@mlc-ai/web-llm@0.2.84'],
  ['jsdelivr, wllama 3.8.1', 'https://cdn.jsdelivr.net/npm/@wllama/wllama@3.8.1/esm/index.js'],
  ['jsdelivr, tasks-vision 1.2.3', 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/vision_bundle.mjs'],
  ['jsdelivr, kokoro-js 1.2.1', 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm'],
  ['jsdelivr, bellows-voice 0.8.0', 'https://cdn.jsdelivr.net/npm/bellows-voice@0.8.0/engine/+esm'],
  ['esm.sh, transformers.js 4.3.2', 'https://esm.sh/@huggingface/transformers@4.3.2'],
  ['hugging face, model file (redirects to the cdn)', 'https://huggingface.co/onnx-community/whisper-tiny.en/resolve/main/config.json'],
  ['hugging face, tree api', 'https://huggingface.co/api/models/onnx-community/whisper-tiny.en/tree/main/onnx'],
  ['hugging face, space file', 'https://huggingface.co/spaces/KevinAHM/pocket-tts-web/resolve/d0c0c79b7712256a32d691c67f20b8ae2e020d00/README.md'],
  ['raw github, silero vad', 'https://raw.githubusercontent.com/snakers4/silero-vad/63d4a2a7bfce8cd9bb39ed8fa0afcb5236d73e01/src/silero_vad/data/silero_vad.onnx'],
  ['raw github, quadruped net', 'https://raw.githubusercontent.com/sweriko/ai4anim-webgpu/b539455f849f284a1e814eb11ab649eb594319dc/public/quadruped.json'],
  ['google storage, mediapipe models', 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'],
  ['poly haven, hdri', 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/lythwood_room_1k.hdr'],
]

try {
  const page = await browser.newPage()
  // the build links no icon, so the browser asks for /favicon.ico; any host 404s it
  page.on('console', (m) => { if (m.type() === 'error' && !/net::ERR_ABORTED|status of 404/.test(m.text())) errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`${r.status()} ${r.url()}`) })
  const crossSeen = []
  page.on('request', (r) => { if (!r.url().startsWith(BASE) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) crossSeen.push(r.url()) })
  await page.setViewport({ width: 1024, height: 800 })

  // first load: one reload, then isolated
  await page.goto(`${BASE}?stub#/voice/transcribe`)
  await until(page, () => self.crossOriginIsolated === true, 'cross origin isolation after the first install')
  let f = await facts(page)
  if (!f.sab || !f.sw) fail(`isolated but sab ${f.sab}, worker ${f.sw}`)
  await until(page, () => [...document.querySelectorAll('.hb-hint')].some((e) => /selected|chose/.test(e.textContent)), 'the transcribe preset')
  const onLine = await machine(page, shots && join(shots, 'isolated-machine-1024.png'))
  const n = Number(/(\d+) wasm threads/.exec(onLine)?.[1] ?? 0)
  if (n < 2) fail(`isolated, the machine line reads "${onLine}"`)
  const onHint = await hint(page)
  if (/threads: off here/.test(onHint)) fail(`isolated, the transcribe copy still reads "${onHint}"`)
  const cacheNames = await page.evaluate(() => caches.keys())
  if (cacheNames.length) fail(`the page holds caches: ${cacheNames.join(', ')}`)
  const swSrc = await page.evaluate(() => fetch('./coi-sw.js').then((r) => r.text()))
  if (/caches\s*\.|cache\.put/.test(swSrc)) fail('the worker touches the cache api')
  if (crossSeen.length) fail(`requests left the origin under ?stub: ${crossSeen.slice(0, 3).join(', ')}`)

  // cross origin hosts, HEAD only, from the isolated page
  const results = []
  if (net) {
    for (const [what, url] of HOSTS) {
      const r = await page.evaluate(async (u) => {
        try {
          const res = await fetch(u, { method: 'HEAD', mode: 'cors', credentials: 'omit' })
          return { ok: res.ok, status: res.status, redirected: res.redirected }
        } catch (e) { return { ok: false, status: 0, error: String(e) } }
      }, url)
      results.push({ what, url, ...r })
    }
    for (const r of results) console.log(`smoke-isolation: ${r.ok ? 'ok  ' : 'FAIL'} ${r.status}${r.redirected ? ' after redirect' : ''} ${r.what} (measured, HEAD, cors, credentialless page)`)
  }

  // the switch off: one reload, not isolated, the copy says why
  const origin = await flip(page)
  await reloaded(page, origin)
  await until(page, () => self.crossOriginIsolated === false && !navigator.serviceWorker.controller, 'isolation off after the switch')
  await until(page, () => [...document.querySelectorAll('.hb-hint')].some((e) => /selected|chose/.test(e.textContent)), 'the transcribe preset with isolation off')
  const offHint = await hint(page)
  if (!offHint.includes('threads: off here, isolation is off in settings')) fail(`isolation off, the transcribe copy reads "${offHint}"`)
  const offLine = await machine(page)
  if (!offLine.includes('threads: off here, isolation is off in settings')) fail(`isolation off, the machine line reads "${offLine}"`)
  if ((await page.evaluate(() => navigator.serviceWorker.getRegistrations())).length) fail('the worker is still registered with the switch off')
  // a fresh load stays off
  await page.reload()
  await until(page, () => document.readyState === 'complete', 'the page')
  await sleep(500)
  f = await facts(page)
  if (f.iso || f.sw) fail('a reload with the switch off brought the worker back')

  // and on again, from the settings drawer
  await flip(page, shots && join(shots, 'settings-switch-off-1024.png'))
  await until(page, () => self.crossOriginIsolated === true, 'isolation back on after the switch')
  if (errors.length) fail(`console errors: ${errors.slice(0, 3).join(' | ')}`)
  if (results.some((r) => !r.ok)) fail(`cross origin checks failed: ${results.filter((r) => !r.ok).map((r) => r.what).join(', ')}`)
  console.log(`smoke-isolation: ok. isolated after one reload, ${n} wasm threads (measured), switch off and on, no cache, single files carry no worker`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
  srv.kill()
}
