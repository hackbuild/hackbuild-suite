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
// by talking. Any request off file:// or console error fails the run.
//   npm run build:single && node tools/smoke-room.mjs [--shots <dir>]
// --shots saves the rack, the awake room and the mind tab at 390 px.
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
const profile = mkdtempSync(join(tmpdir(), 'suite-room-'))
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, userDataDir: profile,
  args: ['--no-first-run', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const errors = []
const off = []
const fail = (why) => { throw new Error(errors.length ? `${why}\nconsole errors:\n${errors.join('\n')}` : why) }
const phone = { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true }

async function open(query) {
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) off.push(r.url()) })
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

  if (off.length) fail(`requests left file://: ${off.slice(0, 5).join(', ')}`)
  if (errors.length) fail('console errors')
  console.log(`smoke-room: rack ${rack.rows} rows, ${rack.presets} presets, file warning shown, webgpu warning ${rack.gpu ? 'shown' : 'hidden'}; model, scripted and reflex tiers each planned; menu sentence, taught memory, 7 tabs, resume kept ${lines} log lines; canvas ${stageW.canvas} px in ${stageW.host} px host; 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
