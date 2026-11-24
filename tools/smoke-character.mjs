// smoke-character: the character tool (design 3.9, F-1 steps 1 to 8)
// from the single file build on file://, with ?stub so the brain, the
// voices and the memory model are stubs and no weight is fetched. The
// gate shows four rows; wake closes it; the greeting appears in boxes
// and is spoken; a typed message gets a boxed reply; the mouth value
// moves while the reply is spoken. A second run with ?stub&fail=voice
// shows the voice pill as voice* with its reason and still speaks on the
// browser voice. Any request off file:// or console error fails the run.
//   npm run build:single && node tools/smoke-character.mjs [--shots <dir>]
// --shots saves the gate, awake, reply and voice failure states at 390 px.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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

  if (errors.length) fail('console errors')
  if (off.length) fail(`requests off file://: ${off.slice(0, 5).join(', ')}`)
  console.log(`smoke-character: ok. the gate names 4 subsystems, wake greets in ${greetBoxes} boxes and speaks, a typed message gets ${after - before} reply boxes, the mouth peaks at ${peak.toFixed(2)} with ${moves} changes in 6 s, a forced voice failure reads voice* with its reason and the browser voice speaks, 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
