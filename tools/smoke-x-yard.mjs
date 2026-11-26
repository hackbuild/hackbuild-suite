// smoke-x-yard: the yard explorer (#/x/yard) on ?stub, from the hosted
// build. The still of the dog and his person fills the page under the bar
// with one pink action and the link out; a press mounts the dog simulator in
// a frame (the request is aborted here). With --dog <dog-simulator public
// html> and its coi-sw.js beside it, it also serves both sites on one origin,
// as pages does, and checks the frame runs cross origin isolated under the
// suite's own isolation, through the dog site's worker.
//   npm run build && node tools/smoke-x-yard.mjs [--dog ../dog-simulator/dist/dog-simulator-public.html --sw <coi-sw.js>]
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, serveDir } from './browse.mjs'

if (!existsSync('dist/hosted/index.html')) throw new Error('no hosted build: run npm run build first')
const arg = (k) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : null)
const dog = arg('dog')
const server = await serveDir('dist/hosted')
const chrome = await launch({ prefix: 'smoke-x-yard-', blockModels: true })
const errors = []
const fail = (m) => { throw new Error(m) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let site = null
try {
  const page = await chrome.browser.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${server.base}?stub#/x/yard`, { waitUntil: 'load' })
  await page.waitForFunction(() => document.querySelector('.sx-yard img')?.naturalWidth > 0, { timeout: 10000 }).catch(() => fail('the yard still did not load'))
  const first = await page.evaluate(() => ({
    pink: [...document.querySelectorAll('.hb-btn-go')].filter((b) => b.checkVisibility()).map((b) => b.textContent.trim()),
    link: document.querySelector('.sx-yard a')?.textContent.trim(),
    share: (() => { const r = document.querySelector('.sx-yard').getBoundingClientRect(); return (r.width * (Math.min(r.bottom, innerHeight) - r.top)) / (innerWidth * innerHeight) })(),
  }))
  if (first.pink.length !== 1 || first.pink[0] !== 'play the dog simulator') fail(`pink: ${first.pink.join(', ')}`)
  if (first.link !== 'open the dog simulator') fail(`link: ${first.link}`)
  if (first.share < 0.9) fail(`the yard takes ${Math.round(first.share * 100)} percent of the page`)
  await page.setRequestInterception(true)
  page.on('request', (r) => (r.url().startsWith('https://hackbuild.github.io/dog-simulator') ? r.abort() : r.continue()))
  await page.click('.sx-yard .hb-btn-go')
  const src = await page.waitForSelector('.sx-yard iframe', { timeout: 5000 }).then((f) => f.evaluate((x) => x.src)).catch(() => fail('the press mounted no frame'))
  if (src !== 'https://hackbuild.github.io/dog-simulator/') fail(`the frame plays ${src}`)
  let embed = 'not checked (no --dog)'
  if (dog) {
    // both sites on one origin, as on pages: the suite under /hackbuild-suite/, the dog under /dog-simulator/
    site = mkdtempSync(join(tmpdir(), 'x-yard-'))
    cpSync('dist/hosted', join(site, 'hackbuild-suite'), { recursive: true })
    mkdirSync(join(site, 'dog-simulator'))
    cpSync(dog, join(site, 'dog-simulator', 'index.html'))
    cpSync(arg('sw') ?? join(dog, '..', 'coi-sw.js'), join(site, 'dog-simulator', 'coi-sw.js'))
    const both = await serveDir(site)
    const p2 = await chrome.browser.newPage()
    await p2.setViewport({ width: 1440, height: 900 })
    await p2.goto(`${both.base}hackbuild-suite/#/x/yard`, { waitUntil: 'load' })
    await p2.waitForFunction(() => self.crossOriginIsolated, { timeout: 15000 }).catch(() => fail('the suite did not isolate'))
    await p2.waitForSelector('.sx-yard .hb-btn-go', { timeout: 8000 })
    await p2.click('.sx-yard .hb-btn-go')
    await p2.waitForSelector('.sx-yard iframe', { timeout: 8000 })
    let inner = null
    for (let i = 0; i < 40 && !inner?.canvas; i++) {
      await wait(500)
      const f = p2.frames().find((x) => x.url().includes('/dog-simulator/'))
      inner = await f?.evaluate(() => ({ iso: self.crossOriginIsolated, sw: !!navigator.serviceWorker?.controller, canvas: document.querySelectorAll('canvas').length })).catch(() => null)
    }
    const cl = await p2.$eval('.sx-yard iframe', (f) => f.hasAttribute('credentialless'))
    if (!inner?.canvas) fail('the dog simulator did not draw in the frame under isolation')
    if (!inner.iso || !inner.sw || cl) fail(`the frame ran without the dog site's worker: ${JSON.stringify({ ...inner, credentialless: cl })}`)
    embed = `the dog drew ${inner.canvas} canvases in a frame that is cross origin isolated through his own worker`
    both.close()
  }
  if (errors.length) fail(`page errors:\n${errors.join('\n')}`)
  console.log(`smoke-x-yard: ok. the still takes ${Math.round(first.share * 100)} percent of the page with one pink and the link out, the press mounted the dog simulator; ${embed} (measured)`)
} finally {
  await chrome.close()
  server.close?.()
  if (site) rmSync(site, { recursive: true, force: true })
}
