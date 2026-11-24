// smoke-memory: the memory tool (design 3.8) and chat recall from the
// single file build on file://, with ?stub so the embedder is the hash
// stub and nothing downloads. The embedder loads through the hub; chat
// saves two facts with "remember that"; a later reply shows "memory used"
// and its recall trace; in the memory tool one memory is edited, one is
// forgotten, ctrl+z brings it back; export, erase and import restore both.
// Any request off file:// or console error fails the run.
//   npm run build:single && node tools/smoke-memory.mjs
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const base = `${pathToFileURL(file).href}?stub`
const profile = mkdtempSync(join(tmpdir(), 'suite-memory-'))
const downloads = join(profile, 'downloads')
mkdirSync(downloads)
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args: ['--no-first-run'] })
const errors = []
const off = []
const fail = (why) => { throw new Error(why) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) off.push(r.url()) })
  const cdp = await page.createCDPSession()
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
  await page.setViewport({ width: 1024, height: 900 })
  const click = (sel, w) => page.evaluate((s, x) => {
    const b = [...document.querySelectorAll(s)].find((e) => e.textContent.trim().startsWith(x) && !e.disabled)
    b?.click(); return !!b
  }, sel, w)
  const text = () => page.evaluate(() => document.body.innerText)

  // the embedder loads through the hub: the stub gives hash vectors
  await page.goto(`${base}#/chat/memory`, { waitUntil: 'load' })
  await page.waitForSelector('.hb-mempanel', { timeout: 6000 }).catch(() => fail('the memory route shows no panel'))
  await page.waitForFunction(() => document.body.innerText.includes('no embedder loaded'), { timeout: 6000 }).catch(() => fail('the keyword only line is missing'))
  if (!(await click('button', 'load embedder'))) fail('no load embedder button')
  await page.waitForFunction(() => document.body.innerText.includes('stub embedder: hash vectors'), { timeout: 8000 }).catch(() => fail('the stub embedder did not load through the hub'))

  // chat saves two facts, then a later reply recalls one
  await page.evaluate(() => { location.hash = '#/chat' })
  await page.waitForSelector('.hb-chat .hb-composer textarea', { timeout: 5000 })
  const settled = (n) => page.waitForFunction((k) => {
    const ms = document.querySelectorAll('.hb-chat-log .hb-msg')
    return ms.length === k && !document.querySelector('.hb-msg.is-streaming') && [...ms].every((m) => m.classList.contains('is-user') || m.querySelector('.hb-msg-acts'))
  }, { timeout: 8000 }, n)
  const say = async (t, n) => {
    await page.focus('.hb-composer textarea')
    await page.keyboard.type(t)
    await page.keyboard.press('Enter')
    await settled(n).catch(() => fail(`"${t}" did not get a reply`))
  }
  await say('remember that the mug goes on the shelf', 2)
  await say('remember that the cat sleeps on the red chair', 4)
  await say('where does the mug go', 6)
  const used = await page.evaluate(() => {
    const m = [...document.querySelectorAll('.hb-chat-log .hb-msg')].at(-1)
    return { sum: m?.querySelector('.hb-msg-used summary')?.textContent ?? '', items: [...(m?.querySelectorAll('.hb-msg-used-item') ?? [])].map((b) => b.textContent) }
  })
  if (!/memory used \(\d\)/.test(used.sum) || !used.items.some((t) => t.includes('mug goes on the shelf'))) fail(`the reply has no memory used fold with the mug: ${JSON.stringify(used)}`)
  await page.evaluate(() => {
    const m = [...document.querySelectorAll('.hb-chat-log .hb-msg')].at(-1)
    m.querySelector('.hb-msg-used').open = true
    m.querySelector('.hb-msg-used-item').click()
  })
  await page.waitForFunction(() => [...document.querySelectorAll('.hb-recall-hit.is-used')].some((h) => h.textContent.includes('mug goes on the shelf')), { timeout: 5000 })
    .catch(() => fail('the recall trace does not mark the mug as used'))
  const rows = await page.$$eval('.hb-recall-hit', (h) => h.length)
  if (!(await click('.hb-drawer button', 'open in memory'))) fail('no open in memory in the trace drawer')
  await page.waitForFunction(() => location.hash.includes('/chat/memory') && location.hash.includes('q='), { timeout: 4000 }).catch(() => fail('open in memory did not route with the query'))
  await page.waitForFunction(() => document.querySelectorAll('.hb-recall-hit').length > 0 && document.querySelector('.hb-mem-score'), { timeout: 5000 })
    .catch(() => fail('the memory tool did not run the query with scores and the trace'))

  // the whole list: clear the search
  await page.$eval('.hb-mempanel input[type=search]', (e) => { e.value = ''; e.dispatchEvent(new Event('input')) })
  const listed = () => page.evaluate(() => [...[...document.querySelectorAll('.hb-mempanel-sec')].at(-1).querySelectorAll('.hb-mem-text')].map((x) => x.textContent))
  const count = (n) => page.waitForFunction((k) => {
    const sec = [...document.querySelectorAll('.hb-mempanel-sec')].at(-1)
    return sec?.querySelectorAll('.hb-mem').length === k
  }, { timeout: 5000 }, n)
  await count(2).catch(async () => fail(`want 2 memories, list shows ${JSON.stringify(await listed())}`))

  // edit one
  await page.evaluate(() => [...[...document.querySelectorAll('.hb-mempanel-sec')].at(-1).querySelectorAll('.hb-mem')].find((m) => m.textContent.includes('mug'))?.querySelector('button[aria-label="edit memory"]')?.click())
  await page.waitForSelector('.hb-mem-edit textarea', { timeout: 3000 }).catch(() => fail('edit opened no box'))
  await page.$eval('.hb-mem-edit textarea', (e) => { e.value = 'the mug goes on the top shelf'; e.dispatchEvent(new Event('input')) })
  await click('.hb-mem-edit button', 'save')
  await page.waitForFunction(() => document.body.innerText.includes('the mug goes on the top shelf') && !document.querySelector('.hb-mem-edit'), { timeout: 4000 }).catch(() => fail('the edit did not land'))

  // forget one (press twice), then undo
  const forgetCat = () => page.evaluate(() => [...[...document.querySelectorAll('.hb-mempanel-sec')].at(-1).querySelectorAll('.hb-mem')].find((m) => m.textContent.includes('cat sleeps'))?.querySelector('.is-forget')?.click())
  await forgetCat(); await forgetCat()
  await count(1).catch(() => fail('forget did not remove the memory'))
  await wait(300)
  await page.evaluate(() => document.activeElement?.blur())
  const mod = (await page.evaluate(() => /Mac/.test(navigator.platform))) ? 'Meta' : 'Control'
  await page.keyboard.down(mod); await page.keyboard.press('z'); await page.keyboard.up(mod)
  await count(2).catch(() => fail('ctrl+z did not bring the forgotten memory back'))
  if (!(await text()).includes('the mug goes on the top shelf')) fail('undo of the forget also undid the edit')

  // export, erase all, import back
  if (!(await click('.hb-mempanel-foot button', 'export'))) fail('no export')
  let saved = null
  for (let i = 0; i < 40 && !saved; i++) {
    saved = readdirSync(downloads).find((n) => n.endsWith('.memory.json'))
    if (!saved) await wait(100)
  }
  if (!saved) fail('export wrote no .memory.json')
  const data = JSON.parse(readFileSync(join(downloads, saved), 'utf8'))
  if (data.format !== 'hackbuild-memory' || data.items.length !== 2) fail(`the export holds ${data.items?.length} memories, want 2`)
  await click('.hb-mempanel-foot button', 'erase all')
  await click('.hb-mempanel-foot button', 'erase everything?')
  await count(0).catch(() => fail('erase all left memories'))
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 3000 }), click('.hb-mempanel-foot button', 'import')])
  await chooser.accept([join(downloads, saved)])
  await count(2).catch(() => fail('import did not bring both memories back'))
  const back = (await listed()).sort().join('|')
  if (back !== data.items.map((x) => x.text).sort().join('|')) fail(`the imported memories differ: ${back}`)

  if (off.length) fail(`requests off file://:\n${off.join('\n')}`)
  if (errors.length) fail(`console errors:\n${errors.join('\n')}`)
  console.log(`smoke-memory: ok. the stub embedder loads through the hub, chat saves 2 facts, a later reply shows "${used.sum}" and a ${rows} row recall trace with the mug used, open in memory runs the query with scores, one memory edited, one forgotten and brought back by ctrl+z, ${saved} exports 2 memories, erase and import restore them, 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
