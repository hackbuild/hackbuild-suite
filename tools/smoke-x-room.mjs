// smoke-x-room: the room explorer (#/x/room) on ?stub, from the hosted
// build, with model hosts and weight files blocked. The gate opens over the
// live room with a preset select whose totals come from the catalogue and one
// pink action; rules only wakes with no download; an order runs through the
// agent's rules (walk, pick up) and its steps show in the mind tab; the eye
// inset draws, the map inset opens from its verb, memory takes a rule, and
// waking on a preset loads its stand ins so the brain decides in json.
//   npm run build && node tools/smoke-x-room.mjs
import { existsSync } from 'node:fs'
import { launch, serveDir } from './browse.mjs'

if (!existsSync('dist/hosted/index.html')) throw new Error('no hosted build: run npm run build first')
const server = await serveDir('dist/hosted')
const chrome = await launch({ prefix: 'smoke-x-room-', blockModels: true })
const errors = []
const fail = (m) => { throw new Error(m) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  const page = await chrome.browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setViewport({ width: 1440, height: 900 })
  const open = async (n) => {
    await page.goto('about:blank')
    await page.goto(`${server.base}?stub#/x/room`, { waitUntil: 'load' })
    await page.waitForSelector('.hb-gate-card select', { timeout: 10000 }).catch(() => fail(`no gate with a preset select on open ${n}`))
  }
  await open(1)
  const gate = await page.evaluate(() => ({
    pink: [...document.querySelectorAll('.hb-btn-go')].filter((b) => b.checkVisibility()).map((b) => b.textContent.trim()),
    presets: [...document.querySelectorAll('.hb-gate-card option')].map((o) => o.textContent.trim()),
  }))
  if (gate.pink.length !== 1 || !/^wake him up, about \d/.test(gate.pink[0])) fail(`gate pink: ${gate.pink.join(', ')}`)
  if (gate.presets.length !== 4 || !/^feather, about/.test(gate.presets[0]) || gate.presets[3] !== 'rules only, no download') fail(`presets: ${gate.presets.join(' | ')}`)

  // rules only: no download, the agent runs on rules
  await page.select('.hb-gate-card select', 'rules')
  await page.click('.hb-gate-go')
  await page.waitForSelector('.hb-rack [role=tab]', { timeout: 8000 }).catch(() => fail('waking on rules did not open the rack'))
  const tabs = await page.$$eval('.hb-rack [role=tab]', (t) => t.map((x) => x.textContent.trim()))
  if (tabs.join(' ') !== 'talk mind eyes memory setup') fail(`tabs: ${tabs.join(', ')}`)
  await page.evaluate(() => [...document.querySelectorAll('.hb-rack button')].find((b) => b.textContent.trim() === 'find the coin').click())
  await page.waitForFunction(() => /walk_to|look_around/.test(document.body.textContent) || /goal find/.test(document.body.textContent), { timeout: 15000 }).catch(() => fail('the order ran no steps'))
  await page.type('.sx-x-compose input', 'pick up the ball')
  await page.click('.sx-x-compose .hb-btn-go')
  const tab = (name) => page.evaluate((n) => [...document.querySelectorAll('.hb-rack [role=tab]')].find((t) => t.textContent.trim() === n).click(), name)
  await tab('mind')
  await page.waitForFunction(() => /pick_up\(ball\)/.test(document.querySelector('.hb-rack-pane:not([hidden])').textContent), { timeout: 20000 }).catch(() => fail('pick up the ball did not reach the steps log'))

  // the eye draws, the map opens from its verb
  const eye = await page.evaluate(() => { const c = document.querySelector('.hb-lay-inset canvas, [data-ux~="inset"] canvas, figure canvas'); if (!c) return 0; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) n += d[i] + d[i + 1] + d[i + 2] > 0 ? 1 : 0; return n })
  if (!eye) fail('the eye inset drew nothing')
  await page.evaluate(() => [...document.querySelectorAll('[data-verb]')].find((b) => b.textContent.trim() === 'map').click())
  await wait(500)
  if ((await page.$$('figure canvas')).length < 2) fail('the map verb did not open the map inset')
  const mapTitle = await page.$$eval('.hb-inset-title', (t) => t.map((x) => x.textContent))
  if (!mapTitle.includes('map')) fail(`no map inset title: ${mapTitle.join(', ')}`)
  const mind = await page.$eval('.hb-rack-pane:not([hidden])', (p) => p.textContent)
  for (const w of ['last plan', 'rules', 'mutters']) if (!mind.includes(w)) fail(`mind tab lacks ${w}`)
  if (!(await page.$('.sx-x-compose button[aria-label]'))) fail('talk has no mic')

  // memory takes a rule
  await tab('memory')
  await page.type('.hb-rack-pane:not([hidden]) input[type=text]', 'rule: mugs live on the shelf')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => /mugs live on the shelf/.test(document.querySelector('.hb-rack-pane:not([hidden]) .hb-mempanel').textContent), { timeout: 4000 }).catch(() => fail('the rule did not land in memory'))
  const mem = await page.$eval('.hb-rack-pane:not([hidden])', (p) => p.textContent)
  for (const w of ['rules', 'consolidate', 'bake into a file']) if (!mem.includes(w)) fail(`memory tab lacks ${w}`)
  await tab('setup')
  if (!/voice clone/.test(await page.$eval('.hb-rack-pane:not([hidden])', (p) => p.textContent))) fail('setup has no voice clone')

  // a preset wakes with its stand ins; the brain decides in json
  await open(2)
  await page.select('.hb-gate-card select', 'standard')
  await page.click('.hb-gate-go')
  await page.waitForSelector('.hb-rack [role=tab]', { timeout: 15000 }).catch(() => fail('waking on standard did not open the rack'))
  await page.type('.sx-x-compose input', 'where are you')
  await page.click('.sx-x-compose .hb-btn-go')
  await page.waitForFunction(() => /stand in reply/.test(document.body.textContent), { timeout: 15000 }).catch(() => fail('the brain did not answer in json'))
  if (errors.length) fail(`console errors:\n${errors.join('\n')}`)
  console.log(`smoke-x-room: ok. gate with ${gate.presets.length} choices (${gate.presets[0]}) and one pink, rules only woke with no download, ${tabs.length} tabs, orders ran through the rules to the steps log, the eye drew ${eye} lit pixels, the map opened, the plan log and mic are there, a rule landed in memory by kind, standard woke and the brain answered in json (measured)`)
} finally {
  await chrome.close()
  server.close?.()
}
