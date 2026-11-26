// smoke-home: home and the shell bar (rebuild plan 2.1 and 4) from the
// single file build on file://. Home opens with no modal on the line on what
// this is, the yard still and its one pink action that mounts it live in place, eight explorer tiles
// that open their explorers or, until rebuilt, their tools, every example grouped by job and the parts. The
// bar holds the mark, the name, the menu and nothing else; the name opens
// the switcher with explorers first, then the jobs, then the parts. Any
// request off file:// fails the run.
//   npm run build:single && node tools/smoke-home.mjs [--site ../dog-simulator/dist/site]
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launch, serveDogSite } from './browse.mjs'

const file = resolve('dist/single/index.html')
const arg = (k, d) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : d)
const site = resolve(arg('site', '../dog-simulator/dist/site'))
if (!existsSync(join(site, 'assets/dog.glb'))) throw new Error(`no dog site at ${site}: run npm run build:site in dog-simulator`)
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const index = JSON.parse(readFileSync('examples/index.json', 'utf8'))
const built = index.examples.filter((e) => existsSync(`examples/${e.job}/${e.id}/example.ts`))
const chrome = await launch({ prefix: 'smoke-home-' })
const errors = []
const off = []
const fail = (m) => { throw new Error(m) }
try {
  const page = await chrome.browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) off.push(r.url()) })
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${pathToFileURL(file).href}#/`, { waitUntil: 'load' })
  await page.waitForSelector('.sx-yard img', { timeout: 10000 })
  await page.waitForFunction(() => document.querySelector('.sx-yard img').naturalWidth > 0, { timeout: 5000 }).catch(() => fail('the yard still did not load'))
  const home = await page.evaluate(() => {
    const vis = (e) => e.checkVisibility()
    const bar = document.querySelector('[data-ux~="bar"]')
    return {
      modal: [...document.querySelectorAll('[role=dialog],[aria-modal="true"]')].filter(vis).length,
      barControls: [...bar.querySelectorAll('button,a,input,select')].filter(vis).map((b) => b.getAttribute('aria-label') ?? b.textContent.trim()),
      barHeight: bar.getBoundingClientRect().height,
      pink: [...document.querySelectorAll('.hb-btn-go')].filter(vis).map((b) => b.textContent.trim()),
      yardShare: (() => { const r = document.querySelector('.sx-yard').getBoundingClientRect(); return (r.width * Math.min(r.bottom, innerHeight) - r.width * r.top) / (innerWidth * innerHeight) })(),
      line: document.querySelector('.sx-home-line')?.textContent.trim() ?? '',
      tilesTop: document.querySelector('.sx-home .hb-tile')?.getBoundingClientRect().top ?? 9999,
      tiles: [...document.querySelectorAll('.sx-home .hb-tile .n')].map((n) => n.textContent.trim()),
      examples: [...document.querySelectorAll('.sx-cards a')].map((a) => a.getAttribute('href')),
      parts: document.querySelectorAll('.sx-parts a').length,
      words: ['phase', 'guided', 'expert', 'local only'].filter((w) => document.body.innerText.toLowerCase().includes(w)),
    }
  })
  if (home.modal) fail(`home opens with ${home.modal} dialog`)
  if (home.barHeight > 52) fail(`the bar is ${home.barHeight} px`)
  if (home.barControls.length !== 2) fail(`the bar on home should hold the name and the menu: ${home.barControls.join(', ')}`)
  if (home.pink.length !== 1 || home.pink[0] !== 'play here') fail(`home pink: ${home.pink.join(', ')}`)
  if (home.yardShare < 0.6) fail(`the yard takes ${Math.round(home.yardShare * 100)} percent of the first view`)
  if (!/^ai that runs in your browser\./.test(home.line)) fail(`the line under the bar says: ${home.line}`)
  if (home.tilesTop >= 900) fail(`the explorer tiles start at ${home.tilesTop} px, under the fold`)
  if (home.tiles.length !== 8) fail(`explorer tiles: ${home.tiles.join(', ')}`)
  if (home.examples.length !== built.length) fail(`home lists ${home.examples.length} examples, ${built.length} are built`)
  if (!home.parts) fail('home lists no parts')
  if (home.words.length) fail(`home still says ${home.words.join(', ')}`)

  // the name opens the switcher: explorers, then the jobs, then the parts
  await page.click('.sx-name')
  await page.waitForSelector('.hb-palette:not([hidden])', { timeout: 3000 }).catch(() => fail('the name did not open the switcher'))
  const heads = await page.evaluate(() => [...document.querySelectorAll('.hb-palette .hb-palette-head')].map((e) => e.textContent.trim().toLowerCase()))
  const order = ['explorers', ...index.jobs.map((j) => j.id).filter((j) => built.some((e) => e.job === j)), 'parts']
  const at = order.map((h) => heads.indexOf(h))
  if (at.some((i) => i < 0) || at.some((i, k) => k && i < at[k - 1])) fail(`switcher sections ${heads.join(', ')}, expected ${order.join(', ')} in order`)
  await page.keyboard.press('Escape')

  // the press plays the dog simulator here, live, as the yard view over the dog site's plain files
  // (served from a local dog site build, as pages serves them); the open link stays
  const link = await page.$eval('.sx-yard a', (a) => a.href)
  if (link !== 'https://hackbuild.github.io/dog-simulator/') fail(`the open link goes to ${link}`)
  const served = await serveDogSite(page, site)
  await page.click('.sx-yard .hb-btn-go')
  await page.waitForSelector('.sx-yard .hb-yard #stage canvas', { timeout: 30000 }).catch(() => fail('the press did not mount the yard'))
  await page.waitForFunction(() => !!(window.__hackle && window.__hackle.dog.ready), { timeout: 120000 }).catch(() => fail('the dog did not stand in the yard'))
  const live = await page.evaluate(() => ({ frames: document.querySelectorAll('iframe').length, setup: !document.getElementById('setup').hidden }))
  if (live.frames) fail('a frame is on home')
  if (live.setup) fail('the press on home opened the setup panel')
  if (!served.includes('assets/dog.glb')) fail('the yard did not load its dog from the dog site')
  const dog = (u) => u.startsWith('https://hackbuild.github.io/dog-simulator')
  off.splice(0, off.length, ...off.filter((u) => !dog(u)))
  errors.splice(0, errors.length, ...errors.filter((e) => !/ERR_FAILED|net::|webgpu|WebGPU/.test(e)))
  await page.goto(`${pathToFileURL(file).href}#/`, { waitUntil: 'load' })
  await page.waitForSelector('.sx-home .hb-tile', { timeout: 5000 })
  // a rebuilt explorer's tile opens its own route
  await page.evaluate(() => [...document.querySelectorAll('.sx-home .hb-tile')].find((t) => t.textContent.includes('transcribe')).click())
  await page.waitForFunction(() => location.hash === '#/x/transcribe', { timeout: 3000 }).catch(() => fail('the transcribe tile did not open the transcribe explorer'))
  if (off.length) fail(`requests off file://:\n${off.join('\n')}`)
  if (errors.length) fail(`console errors:\n${errors.join('\n')}`)
  console.log(`smoke-home: ok. no modal, a ${home.barHeight} px bar with the name and the menu, the line on what this is, the yard ${Math.round(home.yardShare * 100)} percent of the first view with one pink that mounts it live, no frame, from the dog site's files, tiles from ${Math.round(home.tilesTop)} px, 8 explorers, ${home.examples.length} examples by job, ${home.parts} parts, the switcher in order, 0 requests off file:// (measured)`)
} finally {
  await chrome.close()
}
