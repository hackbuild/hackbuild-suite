// smoke-examples: every built example of one job (rebuild plan 4) from the
// single file build on file://. Each opens under the one bar with its layout
// and no modal, runs its built in sample (stub providers, never weights),
// and its source toggle shows the example's own file, byte for byte, with a
// copy button, the install line and the readme link. Any console error or
// request off file:// fails the run.
//   npm run build:single && node tools/smoke-examples.mjs <job> [--file dist/single/index.html]
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launch } from './browse.mjs'

const argv = process.argv.slice(2)
const job = argv[0]
const fileArg = argv.indexOf('--file')
const file = resolve(fileArg > 0 ? argv[fileArg + 1] : 'dist/single/index.html')
if (!existsSync(file)) throw new Error(`no single build at ${file}: run npm run build:single first`)
const index = JSON.parse(readFileSync('examples/index.json', 'utf8'))
if (!index.jobs.some((j) => j.id === job)) throw new Error(`smoke-examples: name a job: ${index.jobs.map((j) => j.id).join(' ')}`)
const list = index.examples.filter((e) => e.job === job && existsSync(`examples/${e.job}/${e.id}/example.ts`))
if (!list.length) throw new Error(`smoke-examples: no ${job} example is built yet`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const chrome = await launch({ prefix: `smoke-ex-${job}-`, blockModels: true })
const done = []
try {
  for (const e of list) {
    const page = await chrome.browser.newPage()
    const errors = []
    const off = []
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    page.on('pageerror', (x) => errors.push(String(x)))
    page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) off.push(r.url()) })
    await page.setViewport({ width: 1440, height: 900 })
    const fail = (m) => { throw new Error(`${e.job}/${e.id}: ${m}`) }
    await page.goto(`${pathToFileURL(file).href}#/examples/${e.job}/${e.id}`, { waitUntil: 'load' })
    await page.waitForSelector(`.sx-ex-live .hb-lay.is-${e.layout}`, { timeout: 10000 }).catch(() => fail(`no ${e.layout} layout drawn`))
    await page.waitForFunction(() => !!window.hbExample, { timeout: 5000 }).catch(() => fail('the example did not mount'))
    const first = await page.evaluate(() => ({
      bars: document.querySelectorAll('[data-ux~="bar"]').length,
      modal: [...document.querySelectorAll('[role=dialog],[aria-modal="true"]')].filter((d) => d.checkVisibility()).length,
      name: document.querySelector('.sx-name')?.textContent.trim(),
    }))
    if (first.bars !== 1) fail(`${first.bars} bars`)
    if (first.modal) fail('a dialog is open on entry')
    const sampled = await page.evaluate(async () => { if (!window.hbExample.sample) return false; await window.hbExample.sample(); return true })
    await wait(600)
    // the source is the file itself
    await page.click('.sx-ex-foot .hb-btn')
    await page.waitForSelector('.sx-ex-src .hb-codeblock pre, .sx-ex-src .hb-codeblock code', { timeout: 5000 }).catch(() => fail('source did not open'))
    await page.waitForFunction(() => document.querySelectorAll('.sx-ex-src .hb-codeblock').length === 2, { timeout: 5000 }).catch(() => fail('the source block did not load'))
    const src = await page.evaluate(() => {
      const blocks = [...document.querySelectorAll('.sx-ex-src .hb-codeblock')]
      return { install: blocks[0].querySelector('pre,code').textContent, code: blocks[1].querySelector('pre,code').textContent, copy: blocks[1].querySelectorAll('.hb-codeblock-btn').length, readme: document.querySelector('.sx-ex-foot a').href }
    })
    const want = readFileSync(`examples/${e.job}/${e.id}/example.ts`, 'utf8')
    if (src.code.trim() !== want.trim()) fail('the source on screen is not the example file')
    if (!src.copy) fail('the source has no copy button')
    if (!src.install.startsWith('npm install ') || !e.packages.every((p) => src.install.includes(p))) fail(`install line: ${src.install}`)
    if (src.readme !== `https://www.npmjs.com/package/${e.readme}`) fail(`readme link: ${src.readme}`)
    await page.click('.sx-ex-foot .hb-btn')
    if (off.length) fail(`requests off file://: ${off.join(' ')}`)
    if (errors.length) fail(`console errors: ${errors.join(' | ')}`)
    done.push(`${e.id}${sampled ? ' (sample ran)' : ''}`)
    await page.close()
  }
  console.log(`smoke-examples: ok. ${job}: ${done.join(', ')}; one bar, no modal, the source is the file with copy, install and readme, 0 requests off file:// (measured)`)
} finally {
  await chrome.close()
}
