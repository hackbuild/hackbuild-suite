// smoke-x-character: the character explorer (#/x/character) on ?stub, from
// the hosted build, with model hosts and weight files blocked. The gate opens
// over the live stage with one pink action that names the download; waking
// loads the stand in brain and voice; a message gets a streamed reply that the
// voice speaks (the corner plate moves off idle); a note added to memory is
// found by search and recalled under the next reply; the five tabs hold the
// body drop, the brain settings and the voice.
//   npm run build && node tools/smoke-x-character.mjs
import { existsSync } from 'node:fs'
import { launch, serveDir } from './browse.mjs'

if (!existsSync('dist/hosted/index.html')) throw new Error('no hosted build: run npm run build first')
const server = await serveDir('dist/hosted')
const chrome = await launch({ prefix: 'smoke-x-character-', blockModels: true })
const errors = []
const fail = (m) => { throw new Error(m) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  const page = await chrome.browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${server.base}?stub#/x/character`, { waitUntil: 'load' })
  await page.waitForSelector('.hb-gate-card', { timeout: 10000 }).catch(() => fail('no gate card'))
  const gate = await page.evaluate(() => ({
    pink: [...document.querySelectorAll('.hb-btn-go')].filter((b) => b.checkVisibility()).map((b) => b.textContent.trim()),
    checks: [...document.querySelectorAll('.hb-gatecheck b')].map((b) => b.textContent.trim()),
    canvas: !!document.querySelector('.hb-lay-subject canvas'),
  }))
  if (gate.pink.length !== 1 || !/^wake him up, \d/.test(gate.pink[0])) fail(`gate pink: ${gate.pink.join(', ')}`)
  if (gate.checks.join(' ') !== 'brain voice memory body') fail(`gate checks: ${gate.checks.join(', ')}`)
  if (!gate.canvas) fail('no live stage under the gate')

  // pressed at once: a press before the isolation reload used to be lost
  await page.click('.hb-gate-go')
  await page.waitForSelector('.hb-rack [role=tab]', { timeout: 8000 }).catch(async () => fail(`waking did not open the rack: ${await page.$eval('.hb-gate-card', (c) => c.textContent)}`))
  const tabs = await page.$$eval('.hb-rack [role=tab]', (t) => t.map((x) => x.textContent.trim()))
  if (tabs.join(' ') !== 'talk memory voice body brain') fail(`tabs: ${tabs.join(', ')}`)

  // memory: add a note, find it
  const tab = (name) => page.evaluate((n) => [...document.querySelectorAll('.hb-rack [role=tab]')].find((t) => t.textContent.trim() === n).click(), name)
  await tab('memory')
  await page.type('.hb-rack-pane:not([hidden]) .hb-mempanel textarea', 'the laser cutter is booked on tuesdays')
  await page.click('.hb-rack-pane:not([hidden]) .hb-mempanel [data-add]')
  await page.waitForFunction(() => document.querySelectorAll('.hb-rack-pane:not([hidden]) .hb-mem').length === 1, { timeout: 4000 }).catch(() => fail('the note was not added'))
  await page.type('.hb-rack-pane:not([hidden]) .hb-mempanel input[type=search]', 'laser cutter')
  await page.waitForFunction(() => /matches \(1\)/.test(document.querySelector('.hb-rack-pane:not([hidden]) .hb-mempanel').textContent), { timeout: 4000 }).catch(() => fail('search did not find the note'))
  if (!(await page.$('.hb-rack-pane:not([hidden]) .hb-dropzone'))) fail('memory has no sources drop')

  // talk: a message gets a reply, recalled memory under it, and the voice speaks it
  await tab('talk')
  await page.type('.hb-rack-pane:not([hidden]) textarea', 'when is the laser cutter booked')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => /stand in reply/.test(document.querySelector('.hb-rack-pane:not([hidden])').textContent), { timeout: 8000 }).catch(() => fail('no reply streamed'))
  const spoke = await page.waitForFunction(() => {
    const plate = [...document.querySelectorAll('.hb-lay-subject *')].find((e) => /^(talking|speaking|saying)/.test(e.textContent.trim()))
    return !!plate || !!document.querySelector('.sx-x-caption')
  }, { timeout: 8000 }).then(() => true, () => false)
  if (!spoke) fail('the reply was not spoken on the stage')
  const used = await page.$eval('.hb-rack-pane:not([hidden])', (p) => p.textContent)
  if (!/laser cutter is booked/.test(used)) fail('the reply does not show the memory it used')
  if (!(await page.$('.hb-rack-pane:not([hidden]) .sx-x-compose button[aria-label], .hb-rack-pane:not([hidden]) .sx-x-compose .hb-mic'))) fail('talk has no mic')
  await tab('memory')
  if (!(await page.$('.hb-rack-pane:not([hidden]) .hb-mem.is-used'))) fail('memory does not mark what the last reply used')

  // the brain and body tabs carry their controls
  await tab('brain')
  const brain = await page.$eval('.hb-rack-pane:not([hidden])', (p) => p.textContent)
  for (const w of ['temperature', 'who is he talking to', 'reply length', 'typos and flaws', 'forget everything cached here', 'shop hand', 'import chats', 'save as markdown']) if (!brain.includes(w)) fail(`brain tab lacks ${w}`)
  // a preset loads in one press
  await page.evaluate(() => [...document.querySelectorAll('.hb-rack-pane:not([hidden]) [data-load]')].find((b) => b.textContent.trim() === 'shop hand').click())
  const name = await page.$eval('.hb-rack-pane:not([hidden]) #pr-name', (i) => i.value)
  if (name !== 'shop hand') fail(`preset did not load: ${name}`)
  await tab('body')
  if (!(await page.$('.hb-rack-pane:not([hidden]) input[type=file], .hb-rack-pane:not([hidden]) .hb-btn'))) fail('body tab has no drop')
  await tab('voice')
  const v = await page.$eval('.hb-rack-pane:not([hidden])', (p) => p.textContent)
  for (const w of ['speak replies', 'start speaking while it writes', 'clone a voice']) if (!v.includes(w)) fail(`voice tab lacks ${w}`)
  if (errors.length) fail(`console errors:\n${errors.join('\n')}`)
  console.log(`smoke-x-character: ok. gate with ${gate.checks.length} checks and one pink (${gate.pink[0]}), woken on stand ins, ${tabs.length} tabs, a note added and found by the memory pane, a preset loaded, the session menu, a streamed reply with the memory it used, spoken on the stage (measured)`)
} finally {
  await chrome.close()
  server.close?.()
}
