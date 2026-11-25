// smoke-room: the room tool (design 3.10, items 4.8 and 4.9) from the
// single file build on file://, with ?stub so the brain and the memory
// embedder are stubs and no weight is fetched. 4.8: the rack is the first
// screen with organ rows, presets and the opened from a file warning; a
// preset loads the brain row; wake builds the room; an order runs through
// the model tier of the planner chain, a question through the scripted
// tier; "open rack" shows the rack with "resume", which returns to the
// same run. A second run with ?stub&fail=brain steps down the chain with
// the reason written in the log and the reflex brain acts. 4.9: the seven
// rack tabs switch; a thing on the stage opens a menu whose entry sends a
// sentence; the bubble stays inside the stage; mind shows the prompt,
// drives and the plan; eyes shows the readout; memory keeps a line taught
// by talking. 4.10: the body tab takes a pmx and names a bad one; who
// decides "reflexes first" plans with no model call; the persona addition
// reaches the prompt; the voice tab speaks a test line on the stub voice
// and draws the mouth; the depth model loads through the hub's stub and
// reads out; an injected event is logged and answered; free run has its own
// idea; the stub mic is heard and the words are sent; the room json, log
// csv and trace export with the seed in their names, and a room json
// dropped on a fresh page opens with its name, seed and layout. Any
// request off file:// or console error fails the run.
//   npm run build:single && node tools/smoke-room.mjs [--shots <dir>]
// --shots saves the rack, the awake room, the mind, brain and voice tabs at 390 px.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const base = pathToFileURL(file).href
const shotsAt = process.argv.indexOf('--shots')
const shots = shotsAt > 0 ? resolve(process.argv[shotsAt + 1]) : ''
if (shots) mkdirSync(shots, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'suite-room-'))
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, userDataDir: profile,
  args: ['--no-first-run', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const errors = []
const off = []
const fail = (why) => { throw new Error(errors.length ? `${why}\nconsole errors:\n${errors.join('\n')}` : why) }
const phone = { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true }
const downloads = join(profile, 'downloads')
mkdirSync(downloads)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function open(query) {
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) off.push(r.url()) })
  // the stub mic: a 220 hz tone from 1 s to 2.4 s over a quiet noise floor
  await page.evaluateOnNewDocument(() => {
    if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true })
    navigator.mediaDevices.getUserMedia = async () => {
      const ac = new AudioContext()
      await ac.resume()
      const dest = ac.createMediaStreamDestination()
      const noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate)
      const d = noise.getChannelData(0)
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.002
      const ns = ac.createBufferSource()
      ns.buffer = noise
      ns.loop = true
      ns.connect(dest)
      const osc = ac.createOscillator()
      osc.frequency.value = 220
      const g = ac.createGain()
      const t = ac.currentTime
      g.gain.setValueAtTime(0, t)
      g.gain.setValueAtTime(0.4, t + 1)
      g.gain.setValueAtTime(0, t + 2.4)
      osc.connect(g).connect(dest)
      osc.start()
      ns.start()
      return dest.stream
    }
  })
  const cdp = await page.createCDPSession()
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
  await page.setViewport(shots ? phone : { width: 1280, height: 900 })
  await page.goto(`${base}?${query}#/rooms`, { waitUntil: 'load' })
  await page.waitForFunction(() => !!document.querySelector('[data-rack] .hb-slot'), { timeout: 10000 }).catch(() => fail('the rack did not show first'))
  return page
}
const click = (page, sel, text) => page.evaluate((s, t) => {
  const b = [...document.querySelectorAll(s)].find((x) => x.textContent.trim().toLowerCase() === t && !x.disabled && x.offsetParent)
  if (!b) return false
  b.click()
  return true
}, sel, text)
const setBrain = (page, v) => page.evaluate((v) => {
  const sel = [...document.querySelectorAll('[data-rack] select')].find((s) => [...s.options].some((o) => o.value === v))
  sel.value = v
  sel.dispatchEvent(new Event('change', { bubbles: true }))
}, v)
const room = (page, fn, ...a) => page.evaluate((f, ...a) => {
  const r = document.querySelector('.hb-viewport-host')?.room
  return r ? new Function('r', '...a', `return (${f})(r, ...a)`)(r, ...a) : null
}, fn.toString(), ...a)
const logText = (page) => page.evaluate(() => (document.querySelector('.hb-viewport-host')?.room?.live.log ?? []).map((e) => `${e.kind} ${e.text}`).join('\n'))
// a rack tab by name: the strip, or the select it turns into on a phone
const pickTab = (page, t) => page.evaluate((t) => {
  const b = [...document.querySelectorAll('.is-side [role="tab"]')].find((x) => x.textContent.trim().toLowerCase() === t && x.offsetParent)
  if (b) { b.click(); return true }
  const sel = document.querySelector('.is-side .hb-tabs-select select, .is-side select.hb-tabs-select')
  if (!sel || ![...sel.options].some((o) => o.textContent.trim().toLowerCase() === t)) return false
  sel.value = [...sel.options].find((o) => o.textContent.trim().toLowerCase() === t).value
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}, t)
const tabNames = (page) => page.evaluate(() => {
  const strip = [...document.querySelectorAll('.is-side [role="tab"]')]
  const sel = document.querySelector('.is-side .hb-tabs-select select, .is-side select.hb-tabs-select')
  return (strip.length ? strip : sel ? [...sel.options] : []).map((t) => t.textContent.trim().toLowerCase())
})
async function wake(page) {
  if (!(await click(page, '[data-gate] button', 'wake the agent'))) fail('no wake the agent button')
  await page.waitForFunction(() => !!document.querySelector('.hb-viewport-host')?.room?.mind(), { timeout: 20000 }).catch(() => fail('the room did not build on wake'))
}
async function exportAs(page, label, ext) {
  await page.evaluate((l) => [...document.querySelectorAll('[data-under] .hb-export-formats button')].find((b) => b.textContent.trim() === l)?.click(), label)
  await wait(100)
  const clicked = await page.evaluate((e) => {
    const b = [...document.querySelectorAll('[data-under] .hb-export button')].find((x) => x.textContent.trim().startsWith('export') && x.textContent.trim().endsWith(e) && !x.disabled)
    b?.click(); return !!b
  }, ext)
  if (!clicked) fail(`no export ${ext} button`)
  for (let i = 0; i < 80; i++) {
    const f = readdirSync(downloads).find((n) => n.endsWith(ext) && !n.endsWith('.crdownload'))
    if (f) { const keep = join(profile, `got-${Date.now()}-${f}`); renameSync(join(downloads, f), keep); return { path: keep, name: f } }
    await wait(100)
  }
  fail(`no ${ext} download`)
}
const pickFile = (page, sel, bytes, name, type) => page.evaluate((s, b, n, t) => {
  const input = document.querySelector(s)
  const dt = new DataTransfer()
  dt.items.add(new File([Uint8Array.from(b)], n, { type: t }))
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}, sel, bytes, name, type)
const bodyLine = (page) => page.evaluate(() => document.querySelector('.hb-viewport-host')?.stageTool?.body.line ?? '')
async function waitMind(page, test, why, ms = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await room(page, test)) return
    await new Promise((r) => setTimeout(r, 200))
  }
  fail(`${why}\nlog:\n${await logText(page)}`)
}

try {
  // run 1, 4.8: the rack first, a preset, wake on the stub model
  const page = await open('stub')
  const rack = await page.evaluate(() => ({
    rows: document.querySelectorAll('[data-rack] .hb-slot').length,
    presets: document.querySelectorAll('[data-rack] .hb-rack-presets button').length,
    file: /opened from a file/.test(document.querySelector('[data-rack]').textContent),
    persona: !!document.querySelector('#room-persona'),
  }))
  if (rack.rows < 3) fail(`the rack shows ${rack.rows} organ rows`)
  if (rack.presets < 2) fail('the rack has no presets with totals')
  if (!rack.file) fail('the opened from a file warning is missing on file://')
  if (!rack.persona) fail('no persona card on the rack')
  // the no webgpu warning shows only when the probe finds no adapter
  const adapter = await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter().catch(() => null)))
  const gpuWarn = await page.waitForFunction((a) => /no webgpu adapter/.test(document.querySelector('[data-rack]').textContent) === !a, { timeout: 5000 }, adapter).then(() => true, () => false)
  if (!gpuWarn) fail(`the no webgpu warning does not match the probe: adapter ${adapter}`)
  rack.gpu = !adapter
  if (shots) await page.screenshot({ path: join(shots, 'room-rack-390.png') })
  await setBrain(page, 'in tab')
  const presetBtn = await page.evaluate(() => { const b = [...document.querySelectorAll('[data-rack] button')].find((x) => /^phone/.test(x.textContent.trim().toLowerCase())); b?.click(); return !!b })
  if (!presetBtn) fail('no phone preset')
  await page.waitForFunction(() => /ready\. .* plans every turn/.test(document.querySelector('[data-gate]')?.textContent ?? ''), { timeout: 10000 })
    .catch(async () => fail(`the brain row did not load from the preset: ${await page.evaluate(() => document.querySelector('[data-gate]').textContent)}`))
  await wake(page)
  await pickTab(page, 'talk')
  const tabs = await tabNames(page)
  if (tabs.join(',') !== 'talk,mind,eyes,memory,body,brain,voice') fail(`the rack tabs are ${tabs.join(',')}`)
  const pill = await page.evaluate(() => document.querySelector('[data-pill="brain"]')?.textContent.trim())
  if (pill !== 'brain in tab') fail(`the brain pill reads ${pill}`)

  // an order through the model tier: the mug ends on the shelf
  await click(page, '[data-pane="talk"] .hb-chip', 'mug to the shelf')
  await waitMind(page, (r) => r.world().thing('mug').on === 'shelf', 'the mug did not reach the shelf', 40000)
  const tier1 = await room(page, (r) => r.mind().last.tier)
  if (tier1 !== 'model') fail(`the order ran on ${tier1}, not the model tier`)
  // a question through the scripted tier, said in the bubble
  await click(page, '[data-pane="talk"] .hb-chip', 'what are you doing')
  await waitMind(page, (r) => r.mind().last.tier === 'scripted' && r.bubble.show, 'the question did not go to the scripted planner')
  // the bubble is placed on the next frame: inside the stage within a second
  await page.waitForFunction(() => {
    const b = document.querySelector('.hb-bubble:not([hidden])')?.getBoundingClientRect()
    const v = document.querySelector('.hb-viewport')?.getBoundingClientRect()
    return b && v && b.width > 0 && b.left >= v.left - 1 && b.right <= v.right + 1 && b.top >= v.top - 1
  }, { timeout: 3000 }).catch(async () => fail(`the speech bubble leaves the stage: ${await page.evaluate(() => JSON.stringify([document.querySelector('.hb-bubble')?.getBoundingClientRect(), document.querySelector('.hb-viewport')?.getBoundingClientRect()]))}`))
  if (shots) await page.screenshot({ path: join(shots, 'room-awake-390.png') })

  // 4.9: the stage menu sends a sentence
  const spot = await room(page, (r) => { const t = r.world().thing('ball'); return r.screenOf(t.x, t.z) })
  await page.mouse.click(spot.x, spot.y - 4, { button: 'right' })
  await new Promise((r) => setTimeout(r, 250))
  const menu = await page.evaluate(() => {
    const m = document.querySelector('.hb-ctx:not([hidden])')
    const b = m && [...m.querySelectorAll('button')].find((x) => x.textContent.trim() === 'pick it up')
    b?.click()
    return m ? { title: m.querySelector('.hb-ctx-title')?.textContent.trim() ?? '', items: [...m.querySelectorAll('button')].map((x) => x.textContent.trim()) } : null
  })
  if (!menu || menu.title !== 'ball' || !menu.items.includes('pick it up')) fail(`the stage menu did not open over the ball: ${JSON.stringify(menu)}`)
  await waitMind(page, (r) => r.world().thing('ball').held, 'the ball was not picked up from the menu sentence', 30000)
  if (!/you pick up the ball/.test(await logText(page))) fail('the menu sentence is not in the log as said')

  // teach by talking
  await room(page, (r) => r.send('remember that the mug lives on the shelf'))
  await pickTab(page, 'memory')
  await page.waitForFunction(() => /the mug lives on the shelf/.test(document.querySelector('[data-pane="memory"]')?.textContent ?? ''), { timeout: 8000 }).catch(() => fail('the taught line is not in memory'))

  // every tab shows its pane
  const marks = { talk: 'mug to the shelf', mind: 'drives', eyes: 'clear ahead', memory: 'teach by talking', body: 'walk_to', brain: 'fallback chain', voice: 'speak replies' }
  for (const [t, m] of Object.entries(marks)) {
    if (!(await pickTab(page, t))) fail(`no ${t} tab`)
    await page.waitForFunction((t, m) => document.querySelector(`[data-pane="${t}"]`)?.textContent.toLowerCase().includes(m), { timeout: 3000 }, t, m).catch(() => fail(`the ${t} tab did not show its pane`))
  }
  await pickTab(page, 'mind')
  const mind = await page.evaluate(() => document.querySelector('[data-pane="mind"]').textContent)
  if (!/heard: what are you doing|heard: pick up the ball/.test(mind) && !/reflex rules on/.test(mind)) fail('the mind tab does not show the last prompt')
  if (!/curiosity/.test(mind)) fail('the mind tab does not show drives')
  if (shots) await page.screenshot({ path: join(shots, 'room-mind-390.png') })

  // 4.10, body: the pick takes pmx and pmd; a file that is not one is named, the mannequin stays
  await pickTab(page, 'body')
  const accept = await page.evaluate(() => document.querySelector('[data-body-pick]')?.accept ?? '')
  if (!/\.pmx/.test(accept) || !/\.pmd/.test(accept)) fail(`the body pick does not take pmx and pmd: ${accept}`)
  await pickFile(page, '[data-body-pick]', [1, 2, 3, 4, 5, 6, 7, 8], 'fake.pmx', 'application/octet-stream')
  await page.waitForFunction(() => /fake\.pmx is named pmx but is not one/.test(document.querySelector('.hb-viewport-host')?.stageTool?.body.line ?? ''), { timeout: 10000 })
    .catch(async () => fail(`a bad pmx is not named: ${await bodyLine(page)}`))
  await pickFile(page, '[data-body-pick]', [80, 77, 88, 32, 0, 0, 0, 0, 1, 2], 'broken.pmx', 'application/octet-stream')
  await page.waitForFunction(() => /could not read broken\.pmx: the mmd file did not parse/.test(document.querySelector('.hb-viewport-host')?.stageTool?.body.line ?? ''), { timeout: 15000 })
    .catch(async () => fail(`a broken pmx did not fail through the mmd loader: ${await bodyLine(page)}`))
  if (!(await page.evaluate(() => document.querySelector('.hb-viewport-host').stageTool.body.placeholder))) fail('a failed pmx replaced the mannequin')

  // brain: three options for who decides; reflexes first plans with no model call
  await pickTab(page, 'brain')
  const radios = await page.$$eval('[data-pane="brain"] input[type="radio"]', (r) => r.map((x) => x.value))
  if (radios.join(',') !== 'the model,with hints,reflexes first') fail(`who decides reads ${radios.join(',')}`)
  await page.evaluate(() => document.querySelector('[data-pane="brain"] input[value="reflexes first"]').click())
  await waitMind(page, (r) => !r.mind().running && !r.world().busy, 'the body did not settle')
  const modelTurns = await room(page, (r) => r.mind().cost.model)
  await room(page, (r) => r.send('come here'))
  await waitMind(page, (r) => r.mind().last.tier === 'reflex' && /reflex rules on: come here/.test(r.mind().last.prompt), 'reflexes first did not plan the order')
  if ((await room(page, (r) => r.mind().cost.model)) !== modelTurns) fail('reflexes first still called the model')
  await page.evaluate(() => document.querySelector('[data-pane="brain"] input[value="the model"]').click())
  await page.type('#room-extra', 'the lamp is broken.')
  await waitMind(page, (r) => /the lamp is broken\./.test(r.mind().system()), 'the persona addition is not in the prompt', 3000)
  if (shots) await page.screenshot({ path: join(shots, 'room-brain-390.png'), fullPage: true })

  // voice: a test line on the stub bellows voice, the mouth canvas drawn
  await pickTab(page, 'voice')
  await page.evaluate(() => {
    const sel = [...document.querySelectorAll('[data-pane="voice"] select')].find((s) => [...s.options].some((o) => o.value === 'bellows-voice'))
    sel.value = 'bellows-voice'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
  if (!(await click(page, '[data-pane="voice"] button', 'test line'))) fail('no test line button')
  await page.waitForFunction(() => /ready, bellows-voice/.test(document.querySelector('[data-voice-status]')?.textContent ?? ''), { timeout: 15000 })
    .catch(async () => fail(`the voice did not start: ${await page.evaluate(() => document.querySelector('[data-voice-status]')?.textContent)}`))
  const mouth = await page.evaluate(() => { const c = document.querySelector('[data-mouth]'); return c ? { w: c.width, h: c.height } : null })
  if (!mouth || mouth.w < 50) fail(`the mouth canvas is not drawn: ${JSON.stringify(mouth)}`)
  const presets = await page.evaluate(() => [...document.querySelectorAll('[data-pane="voice"] select')].map((s) => s.options.length))
  if (!presets.some((n) => n === 14)) fail(`the bellows presets are not 14: ${presets}`)
  if (shots) await page.screenshot({ path: join(shots, 'room-voice-390.png'), fullPage: true })

  // eyes: the depth model through the hub's stub
  await pickTab(page, 'eyes')
  await page.evaluate(() => {
    const sel = [...document.querySelectorAll('[data-pane="eyes"] select')].find((s) => [...s.options].some((o) => o.value === 'depth model'))
    sel.value = 'depth model'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.waitForFunction(() => /model depth ahead/.test(document.querySelector('[data-pane="eyes"]')?.textContent ?? ''), { timeout: 20000 })
    .catch(async () => fail(`the depth model did not read out: ${await page.evaluate(() => document.querySelector('[data-pane="eyes"]')?.textContent.slice(0, 600))}`))

  // inject an event under the stage
  await page.type('[data-inject] input', 'a ball rolls in')
  if (!(await click(page, '[data-inject] button', 'inject'))) fail('no inject button')
  await waitMind(page, (r) => r.live.log.some((e) => e.text === 'event: a ball rolls in') && r.injected.length === 1, 'the event is not in the log')
  await waitMind(page, (r) => r.live.log.some((e) => e.kind === 'me' && /what was that/.test(e.text)), 'the body did not react to the event')

  // free run: an own idea once the body idles past the interval
  await waitMind(page, (r) => !r.mind().running && !r.world().busy, 'the body did not settle before free run', 30000)
  await page.evaluate(() => document.querySelector('.hb-viewport-host').stageTool.reg.set('run.every', 2))
  await room(page, (r) => { r.run.value = 'free run' })
  await waitMind(page, (r) => r.live.log.some((e) => e.kind === 'think' && /^own idea: /.test(e.text)), 'free run had no own idea', 20000)
  await room(page, (r) => { r.run.value = 'prompted'; r.mind().stop() })

  // the mic: hands free on the stub stream, the stub words sent as an order
  await pickTab(page, 'talk')
  await page.click('[data-pane="talk"] .hb-mic-btn')
  await waitMind(page, (r) => r.live.log.some((e) => e.kind === 'you' && /the level rail/.test(e.text)), 'the mic heard nothing from the stub stream', 30000)
  await page.click('[data-pane="talk"] .hb-mic-btn')

  // exports: room json, log csv and trace, each named with the seed
  const seed = await page.evaluate(() => document.querySelector('.hb-viewport-host').stageTool.seed.value)
  const doc = await exportAs(page, 'room', '.hbroom.json')
  const csv = await exportAs(page, 'log', '.csv')
  const trace = await exportAs(page, 'trace', '.trace.json')
  for (const f of [doc, csv, trace]) if (!f.name.includes(`seed-${seed}`)) fail(`the export ${f.name} lacks the seed ${seed}`)
  const roomJson = readFileSync(doc.path, 'utf8')
  const rows = readFileSync(csv.path, 'utf8').trim().split('\n')
  if (rows[0] !== 't,agent,kind,text' || rows.length < 10) fail(`the log csv has ${rows.length} rows`)
  const tr = JSON.parse(readFileSync(trace.path, 'utf8'))
  if (tr.seed !== seed || tr.events.length !== 1 || !tr.log.length) fail('the trace lacks the seed, the event or the log')
  const saved = JSON.parse(roomJson)
  const body = saved.body ?? saved
  if (body.seed !== seed || body.layout.length < 5 || body.cast[0].extra !== 'the lamp is broken.') fail(`the room json lacks the seed, the layout or the cast: ${roomJson.slice(0, 300)}`)

  // open rack, resume returns to the same run
  const lines = await room(page, (r) => r.live.log.length)
  if (!(await click(page, 'button', 'open rack'))) fail('no open rack button')
  await page.waitForFunction(() => document.querySelector('[data-rack]')?.offsetParent && /resume/.test(document.querySelector('[data-gate]').textContent), { timeout: 3000 }).catch(() => fail('the rack did not reopen with resume'))
  await click(page, '[data-gate] button', 'resume')
  await page.waitForFunction(() => !document.querySelector('[data-rack]')?.offsetParent && document.querySelector('.hb-viewport')?.offsetParent, { timeout: 3000 }).catch(() => fail('resume did not return to the room'))
  if ((await room(page, (r) => r.live.log.length)) < lines) fail('resume lost the run')
  const stageW = await page.evaluate(() => {
    const h = document.querySelector('.hb-viewport-host')
    return { host: Math.round(h.getBoundingClientRect().width), canvas: Math.round(h.querySelector('canvas').getBoundingClientRect().width) }
  })
  if (Math.abs(stageW.host - stageW.canvas) > 1) fail(`the canvas is ${stageW.canvas} px in a ${stageW.host} px host`)
  await page.close()

  // run 2, the chain steps down: the brain fails, reflexes act
  const p2 = await open('stub&fail=brain')
  await setBrain(p2, 'in tab')
  await p2.evaluate(() => { [...document.querySelectorAll('[data-rack] button')].find((x) => /^phone/.test(x.textContent.trim().toLowerCase()))?.click() })
  await p2.waitForFunction(() => /plans every turn/.test(document.querySelector('[data-gate]')?.textContent ?? ''), { timeout: 10000 }).catch(() => fail('run 2: the brain row did not load'))
  await wake(p2)
  await room(p2, (r) => r.send('come here'))
  await waitMind(p2, (r) => r.mind().last.tier === 'reflex', 'run 2: the reflex tier did not take the order')
  const log2 = await logText(p2)
  if (!/the brain failed: out of gpu memory/.test(log2)) fail(`run 2: the drop reason is not in the log:\n${log2}`)
  await p2.close()

  // run 3: a room json dropped on a fresh page opens with its name, seed and layout
  const p3 = await open('stub')
  const edited = JSON.parse(roomJson)
  const b3 = edited.body ?? edited
  b3.seed = 4242
  b3.cast[0].name = 'bo'
  b3.layout = b3.layout.map((t) => (t.label === 'ball' ? { ...t, x: 1.5, z: -1.25, on: null } : t))
  await p3.evaluate((t, n) => {
    const dt = new DataTransfer()
    dt.items.add(new File([t], n, { type: 'application/json' }))
    for (const k of ['dragenter', 'dragover', 'drop']) document.body.dispatchEvent(new DragEvent(k, { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, JSON.stringify(edited), 'take.hbroom.json')
  await p3.waitForFunction(() => document.querySelector('#room-name')?.value === 'bo', { timeout: 8000 }).catch(() => fail('the dropped room json did not open its cast'))
  await wake(p3)
  await waitMind(p3, (r) => { const b = r.world().thing('ball'); return Math.abs(b.x - 1.5) < 0.01 && Math.abs(b.z + 1.25) < 0.01 }, 'the dropped layout did not place the ball')
  const seed3 = await p3.evaluate(() => document.querySelector('.hb-viewport-host').stageTool.seed.value)
  if (seed3 !== 4242) fail(`the dropped room opened on seed ${seed3}`)
  await p3.close()

  if (off.length) fail(`requests left file://: ${off.slice(0, 5).join(', ')}`)
  if (errors.length) fail('console errors')
  console.log(`smoke-room: rack ${rack.rows} rows, ${rack.presets} presets, file warning shown, webgpu warning ${rack.gpu ? 'shown' : 'hidden'}; model, scripted and reflex tiers each planned; menu sentence, taught memory, 7 tabs; a bad and a broken pmx named; reflexes first with no model call; persona addition, stub voice and mouth, stub depth model, injected event, free run idea and stub mic heard; room json, ${rows.length - 1} csv rows and trace named with seed ${seed}; a dropped room json reopened on seed ${seed3}; resume kept ${lines} log lines; canvas ${stageW.canvas} px in ${stageW.host} px host; 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
