// smoke-character: the character tool (design 3.9, F-1 steps 1 to 8)
// from the single file build on file://, with ?stub so the brain, the
// voices and the memory model are stubs and no weight is fetched. The
// gate shows four rows; wake closes it; the greeting appears in boxes
// and is spoken; a typed message gets a boxed reply; the mouth value
// moves while the reply is spoken. A second run with ?stub&fail=voice
// shows the voice pill as voice* with its reason and still speaks on the
// browser voice. Steps 7 to 14: every sheet tab switches; the mind tab
// shows the last prompt, reply and plan; the length dial changes the next
// prompt; "new" makes a character with setup rows, which is exported with
// its conversation and imported back; hands free on a stub mic stream (a
// tone over a noise floor, no device) is heard, transcribed by the stub
// and answered. A third run with ?stub&fail=brain shows the brain error
// with its fixes while the other rows still come up, and the no model tier
// then wakes. Any request off file:// or console error fails the run.
//   npm run build:single && node tools/smoke-character.mjs [--shots <dir>]
// --shots saves the gate, awake, reply and voice failure states at 390 px.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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
const profile = mkdtempSync(join(tmpdir(), 'suite-character-'))
const downloads = join(profile, 'downloads')
mkdirSync(downloads)
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, userDataDir: profile,
  args: ['--no-first-run', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const errors = []
const off = []
const fail = (why) => { throw new Error(errors.length ? `${why}\nconsole errors:\n${errors.join('\n')}` : why) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const phone = { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true }

async function open(query) {
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) off.push(r.url()) })
  // the stub mic: a 220 hz tone from 1 s to 2.4 s over a quiet noise floor
  await page.evaluateOnNewDocument(() => {
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
  await page.setViewport(shots ? phone : { width: 1024, height: 900 })
  await page.goto(`${base}?${query}#/character`, { waitUntil: 'load' })
  await page.waitForFunction(() => !!document.querySelector('.hb-wake'), { timeout: 10000 })
    .catch(() => fail('the wake gate did not show'))
  return page
}
const pressWake = (page, label) => page.evaluate((l) => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().toLowerCase() === l && !x.disabled)
  if (!b) return false
  b.click()
  return true
}, label)
const pillText = (page) => page.evaluate(() => [...document.querySelectorAll('.hb-toolpage .hb-pill')].map((p) => `${p.textContent.trim().toLowerCase()}|${p.className}|${p.getAttribute('title') ?? ''}`))
const boxes = (page) => page.evaluate(() => [...document.querySelectorAll('.hb-chat-log .hb-msg-text')].filter((b) => b.textContent.trim()).length)
const clickText = (page, sel, text) => page.evaluate((s, t) => {
  const b = [...document.querySelectorAll(s)].find((x) => x.textContent.trim().toLowerCase() === t && !x.disabled)
  if (!b) return false
  b.click()
  return true
}, sel, text)
const logText = (page) => page.evaluate(() => document.querySelector('.hb-chat-log')?.textContent ?? '')
async function download(end) {
  for (let i = 0; i < 60; i++) {
    const f = readdirSync(downloads).find((n) => n.endsWith(end))
    if (f) return join(downloads, f)
    await wait(100)
  }
  fail(`no ${end} download`)
}
const handle = (page) => page.evaluate(() => !!document.querySelector('.hb-viewport-host')?.characterStage)

try {
  // run 1: every subsystem on stubs
  const page = await open('stub')
  const rows = await page.evaluate(() => ['brain', 'voice', 'memory', 'body'].filter((w) => document.querySelector('.hb-wake').textContent.toLowerCase().includes(w)).length)
  if (rows < 4) fail('the gate does not name brain, voice, memory and body')
  if (shots) await page.screenshot({ path: join(shots, 'character-gate-390.png') })
  if (!(await pressWake(page, 'wake'))) fail('no wake button')
  await page.waitForFunction(() => document.querySelector('.hb-chat-log')?.offsetParent && /stand in body/.test(document.querySelector('.hb-chat-log').textContent), { timeout: 15000 })
    .catch(() => fail('the gate did not close with a greeting'))
  const greetBoxes = await boxes(page)
  if (greetBoxes < 3) fail(`the greeting is not in boxes: ${greetBoxes}`)
  const caption = await page.evaluate(() => document.querySelector('.hb-viewport')?.textContent ?? '')
  if (!/stand in body/.test(caption)) fail('the greeting is not in the stage caption')
  await page.waitForFunction(() => !!document.querySelector('.hb-viewport-host')?.characterStage, { timeout: 15000 }).catch(() => fail('the 3d stage did not start'))
  // the greeting speaks: the hud reads talking at some point
  await page.waitForFunction(() => /talking/.test(document.querySelector('.hb-viewport')?.textContent ?? ''), { timeout: 8000 }).catch(() => fail('the greeting was not spoken'))
  const pills = await pillText(page)
  if (pills.length < 4 || !pills.slice(0, 4).every((p) => /is-ok/.test(p))) fail(`not every pill is ready: ${pills.join(', ')}`)
  if (shots) await page.screenshot({ path: join(shots, 'character-awake-390.png') })

  // a typed message gets a boxed reply, spoken, and the mouth moves
  await page.waitForFunction(() => !/talking/.test(document.querySelector('.hb-viewport')?.textContent ?? ''), { timeout: 15000 }).catch(() => fail('the greeting never ended'))
  const before = await boxes(page)
  await page.type('.hb-composer textarea', 'what are you')
  // the send button: on a touch pointer enter adds a line
  await page.click('.hb-composer button[type="submit"]')
  const mouth = []
  for (let i = 0; i < 60; i++) {
    await wait(100)
    mouth.push(await page.evaluate(() => document.querySelector('.hb-viewport-host').characterStage.mouth()))
  }
  await page.waitForFunction((n) => document.querySelectorAll('.hb-chat-log .hb-msg-text').length > n && /from a script/.test(document.querySelector('.hb-chat-log').textContent), { timeout: 10000 }, before)
    .catch(() => fail('no boxed reply'))
  const after = await boxes(page)
  const boxed = await page.evaluate(() => document.querySelectorAll('.hb-chat-log .hb-msg.is-boxed').length)
  if (boxed < 3) fail(`the turns are not boxed: ${boxed}`)
  if (after - before < 4) fail(`the reply is not split into boxes: ${after - before} new boxes`)
  const peak = Math.max(...mouth)
  const moves = mouth.filter((m, i) => i && Math.abs(m - mouth[i - 1]) > 0.01).length
  if (peak < 0.05 || moves < 3) fail(`the mouth did not move while speaking: peak ${peak.toFixed(3)}, ${moves} changes`)
  if (!(await handle(page))) fail('the stage handle is gone')
  if (shots) await page.screenshot({ path: join(shots, 'character-reply-390.png') })

  // step 7: every sheet tab switches and shows its own panel
  const tabs = ['persona', 'voice', 'brain', 'memory', 'moves', 'look', 'mind']
  const marks = { persona: 'system prompt', voice: 'pitch', brain: 'use this brain', memory: 'recall into each prompt', moves: 'full body', look: 'background', mind: 'tools the model sees' }
  for (const t of tabs) {
    if (!(await clickText(page, '[id^="char-sheet-tab-"]', t))) fail(`no ${t} tab`)
    await page.waitForFunction((t, m) => {
      const sel = [...document.querySelectorAll('[id^="char-sheet-tab-"]')].find((x) => x.getAttribute('aria-selected') === 'true')
      const panel = [...document.querySelectorAll('[role="tabpanel"]')].find((x) => x.offsetParent)
      return sel?.textContent.trim().toLowerCase() === t && panel?.textContent.toLowerCase().includes(m)
    }, { timeout: 3000 }, t, marks[t]).catch(() => fail(`the ${t} tab did not show its panel`))
  }
  // step 8: the mind tab shows the last prompt the model saw, the reply and the plan
  const mind = await page.evaluate(() => document.querySelector('.hb-instrument')?.textContent ?? '')
  if (!/plain jointed mannequin/.test(mind) || !/what are you/.test(mind)) fail('the inspector does not show the last prompt')
  if (!/"say"/.test(mind) || !/heard you/.test(mind)) fail('the inspector does not show the plan and the reply')
  const steps = await page.evaluate(() => document.querySelectorAll('.hb-instrument .hb-step').length)
  if (steps < 1) fail('no step card in the trace')
  // the length dial applies live: the next prompt carries it
  await clickText(page, '[id^="char-sheet-tab-"]', 'persona')
  await page.waitForFunction(() => [...document.querySelectorAll('.hb-seg button')].some((b) => b.textContent.trim().toLowerCase() === 'short'), { timeout: 3000 })
  await clickText(page, '.hb-seg button', 'short')
  await page.waitForFunction(() => !/talking/.test(document.querySelector('.hb-viewport')?.textContent ?? ''), { timeout: 15000 }).catch(() => fail('the reply never ended'))
  await page.type('.hb-composer textarea', 'and now')
  await page.click('.hb-composer button[type="submit"]')
  await page.waitForFunction(() => /heard you: and now/.test(document.querySelector('.hb-chat-log')?.textContent ?? ''), { timeout: 10000 }).catch(() => fail('no reply to the second message'))
  await clickText(page, '[id^="char-sheet-tab-"]', 'mind')
  await page.waitForFunction(() => /one short line/.test(document.querySelector('.hb-instrument')?.textContent ?? ''), { timeout: 3000 }).catch(() => fail('the length dial did not reach the next prompt'))

  // step 13: hands free on the stub mic; the stub transcript is sent and answered
  await page.waitForFunction(() => !/talking/.test(document.querySelector('.hb-viewport')?.textContent ?? ''), { timeout: 15000 }).catch(() => fail('the reply never ended'))
  await page.evaluate(() => [...document.querySelectorAll('.hb-togrow')].find((b) => b.querySelector('.hb-togrow-label')?.textContent.trim() === 'hands free').click())
  // live words: every composer value seen while the stub stream plays
  await page.evaluate(() => {
    window.__seen = new Set()
    const tick = () => { const v = document.querySelector('.hb-composer textarea')?.value; if (v) window.__seen.add(v); window.__tick = requestAnimationFrame(tick) }
    tick()
  })
  await page.click('.hb-mic-btn')
  await page.waitForFunction(() => /the level rail shows what the gate kept/.test(document.querySelector('.hb-chat-log')?.textContent ?? ''), { timeout: 20000 })
    .catch(() => fail('hands free heard nothing from the stub mic'))
  await page.waitForFunction(() => /heard you: the level rail/.test(document.querySelector('.hb-chat-log')?.textContent ?? ''), { timeout: 10000 }).catch(() => fail('no reply to the spoken turn'))
  const seen = await page.evaluate(() => { cancelAnimationFrame(window.__tick); return [...window.__seen] })
  if (!seen.some((v) => /the level rail/.test(v))) fail(`no live words in the composer while the stub stream played: ${JSON.stringify(seen)}`)
  await page.click('.hb-mic-btn')

  // step 10: a new character, its setup rows, a line, export with the talk, import back
  const nameNow = () => page.evaluate(() => document.querySelector('.hb-namehud, .hb-name-hud')?.textContent ?? document.querySelector('.hb-viewport')?.textContent ?? '')
  if (!(await clickText(page, '.hb-acts .hb-btn', 'new'))) fail('no new button')
  await page.waitForFunction(() => document.querySelectorAll('.hb-reasons .hb-reason').length >= 5, { timeout: 5000 }).catch(() => fail('no setup rows for the new character'))
  const setup = await page.evaluate(() => document.querySelector('.hb-reasons').textContent)
  if (!/character \d/.test(setup) || !/brain/.test(setup)) fail(`the setup rows miss the name or the brain: ${setup}`)
  await clickText(page, '.hb-acts .hb-btn', 'done')
  await page.waitForFunction(() => /stand in body/.test(document.querySelector('.hb-chat-log')?.textContent ?? '') && !/the level rail/.test(document.querySelector('.hb-chat-log').textContent), { timeout: 8000 }).catch(() => fail('the new character did not greet'))
  if (!/character \d/.test(await nameNow())) fail('the stage does not name the new character')
  await page.waitForFunction(() => !/talking/.test(document.querySelector('.hb-viewport')?.textContent ?? ''), { timeout: 15000 }).catch(async () => fail(`the new greeting never ended: ${await page.evaluate(() => document.querySelector('.hb-viewport')?.textContent + ' || ' + document.querySelector('.hb-chat-log')?.textContent)}`))
  await page.type('.hb-composer textarea', 'the blue door is mine')
  await page.click('.hb-composer button[type="submit"]')
  await page.waitForFunction(() => /heard you: the blue door/.test(document.querySelector('.hb-chat-log')?.textContent ?? ''), { timeout: 10000 }).catch(() => fail('the new character did not answer'))
  await wait(800)
  await clickText(page, '.hb-acts .hb-btn', 'export')
  const filePath = await download('.hbchar.json')
  const text = readFileSync(filePath, 'utf8')
  if (!/character \d/.test(text) || !/the blue door is mine/.test(text)) fail('the exported file lacks the name or the conversation')
  const hashBefore = await page.evaluate(() => location.hash)
  await page.evaluate((t, n) => {
    const dt = new DataTransfer()
    dt.items.add(new File([t], n, { type: 'application/json' }))
    for (const k of ['dragenter', 'dragover', 'drop']) document.body.dispatchEvent(new DragEvent(k, { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, text, 'back.hbchar.json')
  await wait(400)
  await clickText(page, '[role="dialog"] button', 'open as a character')
  await page.waitForFunction((h) => location.hash !== h && location.hash.includes('doc='), { timeout: 5000 }, hashBefore).catch(() => fail('the import did not open a document'))
  await page.waitForFunction(() => /the blue door is mine/.test(document.querySelector('.hb-chat-log')?.textContent ?? ''), { timeout: 8000 }).catch(() => fail('the imported character did not bring its conversation'))
  const docs = await page.evaluate(() => location.hash)
  await page.close()

  // run 2: the voice fails; the pill says so and the browser voice speaks
  const p2 = await open('stub&fail=voice')
  await pressWake(p2, 'wake')
  await p2.waitForFunction(() => /stand in body/.test(document.querySelector('.hb-chat-log')?.textContent ?? ''), { timeout: 15000 }).catch(() => fail('the gate did not close when only the voice failed'))
  await p2.waitForFunction(() => [...document.querySelectorAll('.hb-toolpage .hb-pill')].some((p) => /voice\*/i.test(p.textContent)), { timeout: 8000 }).catch(() => fail('no voice* pill'))
  const vp = (await pillText(p2)).find((p) => /voice\*/.test(p)) ?? ''
  if (!/pocket tts failed/.test(vp) || !/browser voice/.test(vp)) fail(`the voice* pill does not give its reason: ${vp}`)
  await p2.waitForFunction(() => /talking/.test(document.querySelector('.hb-viewport')?.textContent ?? ''), { timeout: 8000 }).catch(() => fail('the browser voice did not speak the greeting'))
  if (shots) await p2.screenshot({ path: join(shots, 'character-voice-failed-390.png') })
  await p2.close()

  // run 3: the brain fails; the gate says why with two fixes, the rest comes up, no model wakes
  const p3 = await open('stub&fail=brain')
  await pressWake(p3, 'wake')
  await p3.waitForFunction(() => /out of gpu memory/.test(document.querySelector('.hb-wake-err')?.textContent ?? ''), { timeout: 15000 }).catch(() => fail('no brain error on the gate'))
  const err = await p3.evaluate(() => document.querySelector('.hb-wake-err').textContent)
  if (!/no model/.test(err) || !/endpoint/.test(err)) fail(`the brain error gives no fixes: ${err}`)
  await p3.waitForFunction(() => document.querySelectorAll('.hb-wake-row.is-ready').length >= 3 && !!document.querySelector('.hb-wake-row.is-error'), { timeout: 15000 })
    .catch(() => fail('the other rows did not come up beside the failed brain'))
  if (shots) await p3.screenshot({ path: join(shots, 'character-brain-failed-390.png') })
  await p3.evaluate(() => document.querySelector('.hb-tier-pick[data-value="none"]').click())
  if (!(await pressWake(p3, 'wake'))) fail('the wake button stayed off after the brain failed')
  await p3.waitForFunction(() => /stand in body/.test(document.querySelector('.hb-chat-log')?.textContent ?? ''), { timeout: 15000 }).catch(() => fail('no model did not wake after the brain failed'))
  await p3.type('.hb-composer textarea', 'still there')
  await p3.click('.hb-composer button[type="submit"]')
  await p3.waitForFunction(() => /heard you: still there/.test(document.querySelector('.hb-chat-log')?.textContent ?? ''), { timeout: 10000 }).catch(() => fail('no reply after the fall to no model'))
  await p3.close()

  if (errors.length) fail('console errors')
  if (off.length) fail(`requests off file://: ${off.slice(0, 5).join(', ')}`)
  console.log(`smoke-character: ok. the gate names 4 subsystems, wake greets in ${greetBoxes} boxes and speaks, a typed message gets ${after - before} reply boxes, the mouth peaks at ${peak.toFixed(2)} with ${moves} changes in 6 s, a forced voice failure reads voice* with its reason and the browser voice speaks, 7 sheet tabs switch, the mind tab shows the last prompt, reply and plan with ${steps} step cards, the length dial reaches the next prompt, hands free on a stub mic shows live words in the composer, is heard and answered, a new character is exported with its talk (${text.length} bytes) and imported back (${docs}), a forced brain failure names two fixes while 3 rows come up and no model then wakes and answers, 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
