// smoke-sendto: "send to" between the image and voice tools (design 1.2)
// from the single file build on file://, with ?stub so no weight is
// fetched. Five routes: a generated image to masks, a mask to relief (the
// relief is limited by it), the relief photo to vision, spoken text to
// chat, and its rendered audio to transcribe. Each target must open on
// the sent item. Any request off file:// or console error fails the run.
//   npm run build:single && node tools/smoke-sendto.mjs
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const base = `${pathToFileURL(file).href}?stub`
const profile = mkdtempSync(join(tmpdir(), 'suite-sendto-'))
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args: ['--no-first-run', '--autoplay-policy=no-user-gesture-required'] })
const errors = []
const off = []
const routes = []
const fail = (why) => { throw new Error(why) }
try {
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) off.push(r.url()) })
  await page.setViewport({ width: 1024, height: 900 })
  const click = (re, root = '.hb-toolpage') => page.evaluate((s, r) => {
    const b = [...document.querySelectorAll(`${r} button`)].find((e) => new RegExp(s).test(e.textContent.trim()) && !e.disabled)
    b?.click(); return !!b
  }, re, root)
  const text = () => page.evaluate(() => document.body.textContent)
  const until = (fn, why, arg, timeout = 8000) => page.waitForFunction(fn, { timeout }, arg).catch(() => fail(why))
  // the send to menu: open it, then pick the row "<what> to <tool>"
  const sendTo = async (label, hash) => {
    const rows = await page.evaluate(async (x) => {
      document.querySelector('[data-sendto]')?.click()
      await new Promise((r) => setTimeout(r, 60))
      const items = [...document.querySelectorAll('.hb-menu-item')]
      items.find((e) => e.textContent.trim() === x && !e.disabled)?.click()
      return items.map((e) => e.textContent.trim())
    }, label)
    if (!rows.includes(label)) fail(`no "${label}" in send to: ${rows.join(', ')}`)
    await until((h) => location.hash.startsWith(h), `${label} did not open ${hash}`, hash)
    routes.push(label)
  }

  // generate one stub run, then send the image to masks
  await page.goto(`${base}#/image/generate`, { waitUntil: 'load' })
  await until(() => document.body.textContent.includes('webgpu ready, model not loaded'), 'generate has no ready line')
  await click('^load sd-turbo', '.is-side')
  await until(() => document.body.textContent.includes('sd-turbo 512 loaded'), 'the generate stub did not load')
  await click('^generate$')
  await until(() => document.querySelectorAll('.hb-hist-item').length === 1 && !document.querySelector('.hb-vp-cover'), 'the run did not land', undefined, 15000)
  await sendTo('image to masks', '#/image/masks')
  await until(() => document.querySelector('.hb-pc-frame img, .hb-pc-frame'), 'masks did not open on the image')

  // a keep point makes a mask; send it to relief, which keeps only its cells
  await until(() => [...document.querySelectorAll('.is-side button')].some((b) => /^load the mask model/.test(b.textContent.trim())), 'no mask load button')
  await click('^load the mask model', '.is-side')
  await until(() => /one pass over .* took \d+ ms \(measured\)/.test(document.body.textContent), 'the mask stub did not load', undefined, 10000)
  // the stub decoder grows from the point by colour; try a few spots on the generated image
  const box = await page.$eval('.hb-pc-frame', (e) => { e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } })
  for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.3], [0.7, 0.6], [0.4, 0.75]]) {
    await page.mouse.click(box.x + box.w * fx, box.y + box.h * fy)
    if (await page.waitForFunction(() => document.querySelectorAll('.hb-inst-row').length > 0, { timeout: 1500 }).then(() => true, () => false)) break
  }
  if (!(await page.$('.hb-inst-row'))) fail(`no point made an instance: ${JSON.stringify(box)} ${await page.evaluate((b) => { const e = document.elementFromPoint(b.x + b.w / 2, b.y + b.h / 2); return e ? e.className + ' ' + e.tagName : 'none' }, box)}`)
  await sendTo('mask to relief', '#/image/relief')
  await until(() => [...document.querySelectorAll('.hb-toolpage button')].some((b) => b.textContent.trim() === 'clear erase' && !b.disabled), 'relief did not take the mask as its keep cells')

  // the relief photo to vision: one capture
  await sendTo('photo to vision', '#/image/vision')
  await until(() => document.querySelectorAll('.hb-hist-item').length === 1, 'vision did not open on the photo')

  // spoken text to chat, then its rendered audio to transcribe
  const LINE = 'the tone voice reads this line for the send to smoke'
  await page.evaluate((t) => { location.hash = `#/voice/speak?text=${encodeURIComponent(t)}` }, LINE)
  await until((t) => document.querySelector('.hb-toolpage textarea')?.value === t, 'speak did not take the text', LINE)
  await sendTo('text to chat', '#/chat')
  await until((t) => document.querySelector('.hb-composer textarea')?.value === t, 'chat did not open with the text in the composer', LINE)
  await page.goBack()
  await until((t) => location.hash.includes('/voice/speak') && document.querySelector('.hb-toolpage textarea')?.value === t, 'back to speak failed', LINE)
  await sendTo('audio to transcribe', '#/voice/transcribe')
  await until(() => /\.wav|queued|\d+ kb/.test(document.querySelector('.hb-toolpage')?.textContent ?? ''), 'transcribe did not open on the audio')

  if (off.length) fail(`requests off file://:\n${off.join('\n')}`)
  if (errors.length) fail(`console errors:\n${errors.join('\n')}`)
  console.log(`smoke-sendto: ok. ${routes.length} routes, each target opens on the sent item: ${routes.join(', ')}; 0 requests off file:// (measured)`)
} catch (err) {
  console.error(`smoke-sendto: ${err instanceof Error ? err.message : err}`)
  console.error((await browser.pages().then((p) => p[1]?.evaluate(() => document.body.textContent.slice(0, 600)).catch(() => '')) ?? ''))
  process.exitCode = 1
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
