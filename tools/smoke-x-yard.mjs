// smoke-x-yard: the yard explorer (#/x/yard) from the hosted build. On ?stub
// the still of the dog and his person fills the page under the bar with one
// pink action and the link out; the press mounts the dog simulator live, as
// @hackbuild/agents-views Yard, with no frame: the dog and his person stand in
// the yard, the verb row has one pink (throw ball), the rack its seven tabs.
// Without ?stub the yard mounts at once with the setup panel of a first visit.
// Leaving the route disposes it. The dog site's plain files under assets/ (the dog,
// his person, the voice clip, the clip pack and the physics core) are served from a local build
// of the dog site, as pages serves them, with access-control-allow-origin.
//   npm run build && node tools/smoke-x-yard.mjs [--site ../dog-simulator/dist/site]
// Build the dog site first: npm run build:site in dog-simulator.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DOG, launch, serveDir, serveDogSite } from './browse.mjs'

if (!existsSync('dist/hosted/index.html')) throw new Error('no hosted build: run npm run build first')
const arg = (k, d) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : d)
const site = resolve(arg('site', '../dog-simulator/dist/site'))
if (!existsSync(join(site, 'assets/dog.glb'))) throw new Error(`no dog site at ${site}: run npm run build:site in dog-simulator`)
{
  const server = await serveDir('dist/hosted')
  const chrome = await launch({ prefix: 'smoke-x-yard-', blockModels: true })
  const errors = []
  const fail = (m) => { throw new Error(m) }
  // the suite's isolation worker reloads the page once on a first visit; wait it out
  const open = async (p, url) => {
    await p.goto(url, { waitUntil: 'load' })
    await p.waitForFunction(() => self.crossOriginIsolated, { timeout: 15000 }).catch(() => {})
    await p.waitForFunction(() => document.readyState === 'complete', { timeout: 15000 })
  }
  const ready = (p) => p.waitForFunction(() => !!(window.__hackle && window.__hackle.dog.ready && window.__hackle.HUM.ready), { timeout: 120000 }).catch(() => fail('the dog and his person did not stand in the yard'))
  try {
    const page = await chrome.browser.newPage()
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    const served = await serveDogSite(page, site)
    await page.setViewport({ width: 1440, height: 900 })
    await open(page, `${server.base}?stub#/x/yard`)
    await page.waitForFunction(() => document.querySelector('.sx-yard img')?.naturalWidth > 0, { timeout: 10000 }).catch(() => fail('the yard still did not load'))
    const first = await page.evaluate(() => ({
      pink: [...document.querySelectorAll('.hb-btn-go')].filter((b) => b.checkVisibility()).map((b) => b.textContent.trim()),
      link: document.querySelector('.sx-yard a')?.textContent.trim(),
      share: (() => { const r = document.querySelector('.sx-yard').getBoundingClientRect(); return (r.width * (Math.min(r.bottom, innerHeight) - r.top)) / (innerWidth * innerHeight) })(),
    }))
    if (first.pink.length !== 1 || first.pink[0] !== 'play here') fail(`pink: ${first.pink.join(', ')}`)
    if (first.link !== 'open in its own tab') fail(`link: ${first.link}`)
    if (first.share < 0.9) fail(`the yard takes ${Math.round(first.share * 100)} percent of the page`)
    await page.click('.sx-yard .hb-btn-go')
    await page.waitForSelector('.sx-yard .hb-yard #stage canvas', { timeout: 30000 }).catch(() => fail('the press did not mount the yard'))
    await ready(page)
    const live = await page.evaluate(() => ({
      frames: document.querySelectorAll('iframe').length,
      pink: [...document.querySelectorAll('.hb-btn-go')].filter((b) => b.checkVisibility()).map((b) => b.textContent.trim()),
      tabs: [...document.querySelectorAll('.hb-yard [role=tab]')].map((t) => t.textContent.trim()),
      setup: !document.getElementById('setup')?.hidden,
      share: (() => { const r = document.querySelector('.hb-yard #stage').getBoundingClientRect(); return (r.width * r.height) / (innerWidth * innerHeight) })(),
      rack: Math.round(document.querySelector('.hb-yard #side').getBoundingClientRect().width),
    }))
    if (live.frames) fail('a frame is on the page')
    if (live.pink.length !== 1 || !/throw ball/i.test(live.pink[0])) fail(`live pink: ${live.pink.join(', ')}`)
    if (live.tabs.join(' ') !== 'brain body sense train human tune how') fail(`tabs: ${live.tabs.join(' ')}`)
    if (live.setup) fail('the press opened the setup panel on ?stub')
    if (live.rack !== 380) fail(`the rack is ${live.rack} px`)
    for (const f of ['dog.glb', 'human.glb', 'anims.json', 'rapier.mjs']) if (!served.includes(`assets/${f}`)) fail(`the yard did not load assets/${f} from the dog site`)
    // a fetch: the person throws, the dog runs off
    await page.evaluate(() => window.__hackle.throwBall())
    // leaving disposes the yard: no root, no stylesheet, no handle
    await page.evaluate(() => { location.hash = '#/' })
    await page.waitForFunction(() => !document.querySelector('.hb-yard') && !document.getElementById('hb-yard-style') && !window.__hackle, { timeout: 5000 }).catch(() => fail('leaving the yard left it mounted'))
    // a visitor (no ?stub) gets the yard at once, no still and no press, with the setup panel of a first visit
    const p0 = await chrome.browser.newPage()
    p0.on('pageerror', (e) => errors.push(String(e)))
    await serveDogSite(p0, site)
    await p0.setViewport({ width: 1440, height: 900 })
    await open(p0, `${server.base}#/x/yard`)
    await p0.waitForSelector('.hb-yard #stage', { timeout: 15000 }).catch(() => fail('without ?stub the yard did not mount at once'))
    if (await p0.$('.sx-yard img')) fail('without ?stub the yard still shows')
    await ready(p0)
    const setup = await p0.evaluate(() => !document.getElementById('setup').hidden)
    if (!setup) fail('a first visit to the yard explorer has no setup panel')
    await p0.close()
    // the dog site unreachable: the still stands in again with the reason
    const p1 = await chrome.browser.newPage()
    await p1.setRequestInterception(true)
    p1.on('request', (r) => (r.url().startsWith(DOG) || r.url().includes('rapier3d-compat') ? r.abort() : r.continue()))
    await open(p1, `${server.base}?stub#/x/yard`)
    await p1.waitForSelector('.sx-yard .hb-btn-go', { timeout: 10000 })
    await p1.click('.sx-yard .hb-btn-go')
    const fault = await p1.waitForSelector('.sx-yard-fault', { timeout: 30000 }).then((e) => e.evaluate((x) => x.textContent.trim())).catch(() => fail('an unreachable dog site gave no reason'))
    if (!(await p1.$('.sx-yard img'))) fail('an unreachable dog site left no still')
    await p1.close()
    const real = errors.filter((e) => !/ERR_FAILED|net::|Failed to load resource/.test(e))
    if (real.length) fail(`page errors:\n${real.join('\n')}`)
    console.log(`smoke-x-yard: ok. the still takes ${Math.round(first.share * 100)} percent of the page with one pink and the link out; the press mounted the yard live with no frame, the dog and his person standing, one pink (${live.pink[0].toLowerCase()}), seven tabs, a ${live.rack} px rack and a stage of ${Math.round(live.share * 100)} percent; leaving disposed it; a visitor gets it at once with the setup panel; an unreachable site shows the still and "${fault}" (measured)`)
  } finally {
    await chrome.close()
    server.close?.()
  }
}
