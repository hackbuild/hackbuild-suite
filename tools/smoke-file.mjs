// smoke-file: opens the single file build from file:// in headless Chrome,
// changes route twice, and reads back the IndexedDB write the router makes.
// Then the workspace (design 2.5): a saved document is renamed, saved with
// ctrl+s, exported as a document file and as a workspace zip, deleted, and
// imported back from both files through ctrl+o.
// Then each group single file (design D11) from disk: one group tab, every
// tool of the group opens, a tool of another group does not, rooms holds
// the room tool and the lab stage page.
// Fails on any console error or a missing control. Usage:
//   npm run build:single && npm run build:groups && node tools/smoke-file.mjs [--shots <dir>]
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const page_ = resolve('dist/single/index.html')
if (!existsSync(page_)) throw new Error('no single build: run npm run build:single first')
// The groups and their tool routes, read from the registry text (one tool
// alone in its group routes to the group).
const registry = readFileSync('src/tools/registry.ts', 'utf8')
const GROUPS = ['chat', 'voice', 'image', 'character', 'rooms', 'motion', 'agents']
const toolsOf = (g) => [...registry.matchAll(new RegExp(`defineTool\\(\\{ id: '([a-z-]+)', group: '${g}'`, 'g'))].map((m) => m[1])
const routeOf = (g, id) => (toolsOf(g).length === 1 ? `/${g}` : `/${g}/${id}`)
for (const g of GROUPS) if (!existsSync(resolve(`dist/groups/${g}.html`))) throw new Error(`no dist/groups/${g}.html: run npm run build:groups first`)
const shotsAt = process.argv.indexOf('--shots')
const shots = shotsAt > 0 ? resolve(process.argv[shotsAt + 1]) : null
if (shots) mkdirSync(shots, { recursive: true })

const profile = mkdtempSync(join(tmpdir(), 'suite-smoke-'))
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args: ['--no-first-run'] })
const errors = []
// One IndexedDB call in the page, on whatever version the app opened.
const idb = (page, store, op, key, value) => page.evaluate((s, o, k, v) => new Promise((res, rej) => {
  const r = indexedDB.open('hackbuild-suite')
  r.onsuccess = () => {
    const os = r.result.transaction(s, o === 'put' ? 'readwrite' : 'readonly').objectStore(s)
    const q = o === 'put' ? os.put(v, k) : o === 'all' ? os.getAll() : os.get(k)
    q.onsuccess = () => { r.result.close(); res(q.result) }; q.onerror = () => rej(q.error)
  }
  r.onerror = () => rej(r.error)
}), store, op, key ?? null, value ?? null)
try {
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setViewport({ width: 1440, height: 900 })
  const url = pathToFileURL(page_).href
  await page.goto(url, { waitUntil: 'load' })
  // home: the yard first, then the eight explorers
  await page.waitForSelector('.sx-yard img', { timeout: 10000 })
  const tiles = await page.$$eval('.sx-home .hb-tile', (els) => els.length)
  if (tiles !== 8) throw new Error(`expected 8 explorer tiles, found ${tiles}`)
  if (shots) await page.screenshot({ path: join(shots, 'home-1440.png') })

  for (const [hash, expect] of [['#/character', 'wake mannequin up.'], ['#/rooms', 'wake the agent']]) {
    await page.evaluate((h) => { location.hash = h }, hash)
    await page.waitForFunction((t) => document.body.textContent.includes(t), { timeout: 5000 }, expect)
    const stored = await idb(page, 'kv', 'get', 'last-route')
    const want = hash.slice(1)
    if (stored !== want) throw new Error(`indexeddb last-route is ${stored}, expected ${want}`)
  }
  // The shell key map (design 2.7): each key opens its overlay, esc closes it.
  const dialog = (t) => page.waitForFunction((x) => [...document.querySelectorAll('[role="dialog"]')].some((d) => d.checkVisibility() && d.textContent.includes(x)), { timeout: 3000 }, t)
  const closed = () => page.waitForFunction(() => ![...document.querySelectorAll('[role="dialog"]')].some((d) => d.checkVisibility()), { timeout: 3000 })
  await page.evaluate(() => document.activeElement?.blur())
  for (const [key, expect] of [[',', 'reduce motion'], ['?', 'focus the composer'], ['m', 'this machine'], ['/', 'explorers']]) {
    await page.keyboard.type(key)
    try { await dialog(expect) } catch { throw new Error(`key ${key} did not open the overlay with "${expect}": ${await page.evaluate(() => [...document.querySelectorAll(`[role="dialog"]`)].filter((d) => d.checkVisibility()).map((d) => d.textContent.slice(0, 120)).join(" | "))}`) }
    await page.keyboard.press('Escape')
    try { await closed() } catch { throw new Error(`esc did not close the overlay opened by ${key}`) }
  }
  // the bar's menu opens the event log
  await page.click('.hb-header button[aria-label="menu"]')
  await page.evaluate(() => [...document.querySelectorAll('.hb-menu-item')].find((b) => b.textContent.trim() === 'log')?.click())
  try { await dialog('shell ready') } catch { throw new Error('the menu did not open the event log') }
  await page.keyboard.press('Escape')
  // the switcher opens the character explorer: every image tool makes a document on mount; character makes one at wake
  await page.click('.sx-name')
  await page.keyboard.type('character')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => location.hash.startsWith('#/character'), { timeout: 3000 }).catch(() => { throw new Error('the switcher did not open character') })
  if (shots) {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('.hb-header')
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    if (wide > 0) errors.push(`sideways scroll of ${wide} px at 390`)
    await page.screenshot({ path: join(shots, 'room-390.png') })
  }
  // Workspace round trip from file://.
  const downloads = join(profile, 'downloads')
  mkdirSync(downloads)
  const cdp = await page.createCDPSession()
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
  const t = Date.now()
  await idb(page, 'docs', 'put', 'smoke1', { id: 'smoke1', project: 'scratch', tool: 'chat', kind: 'chat.session', name: 'smoke doc', version: 1, created: t, updated: t, body: { turns: ['hello'] } })
  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('.hb-header')
  await page.evaluate(() => document.activeElement?.blur())
  // ctrl in the key map reads cmd on a Mac, as the page sees it.
  const mod = (await page.evaluate(() => /Mac/.test(navigator.platform))) ? 'Meta' : 'Control'
  const ctrl = async (key, shift = false) => {
    await page.keyboard.down(mod); if (shift) await page.keyboard.down('Shift')
    await page.keyboard.press(key)
    if (shift) await page.keyboard.up('Shift'); await page.keyboard.up(mod)
  }
  await ctrl('KeyO')
  try { await dialog('smoke doc') } catch { throw new Error('ctrl+o did not open the documents drawer with the saved document') }
  const clickText = async (sel, text) => {
    const ok = await page.evaluate((s, x) => {
      const el = [...document.querySelectorAll(s)].find((e) => e.checkVisibility() && e.textContent.trim().startsWith(x))
      el?.click(); return !!el
    }, sel, text)
    if (!ok) throw new Error(`no visible ${sel} reading "${text}"`)
  }
  await clickText('.hb-convs-open', 'smoke doc')
  await page.$eval('button[aria-label="rename smoke doc"]', (b) => b.click())
  await page.waitForSelector('.hb-convs-rename input')
  await page.$eval('.hb-convs-rename input', (el) => { el.focus(); el.select() })
  await page.keyboard.type('smoke renamed')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => [...document.querySelectorAll('.hb-convs-item')].some((r) => r.textContent.includes('smoke renamed')), { timeout: 3000 })
    .catch(() => { throw new Error('the rename did not show in the list') })
  await ctrl('KeyS')
  await page.waitForFunction(() => /every change is saved|saved 1 document/.test(document.body.textContent ?? ''), { timeout: 3000 })
    .catch(() => { throw new Error('ctrl+s said nothing') })
  const saved = await idb(page, 'docs', 'get', 'smoke1')
  if (saved?.name !== 'smoke renamed') throw new Error(`the rename did not save: ${saved?.name}`)

  const waitFile = async (end) => {
    for (let i = 0; i < 50; i++) {
      const f = readdirSync(downloads).find((n) => n.endsWith(end))
      if (f) return join(downloads, f)
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`no ${end} download`)
  }
  await clickText('button', 'export')
  await page.waitForSelector('.hb-export')
  await clickText('.hb-export button, .hb-export [role="radio"]', 'document')
  await clickText('.hb-export button', 'export .hbdoc.json')
  const docFile = await waitFile('.hbdoc.json')
  await page.keyboard.press('Escape')
  await ctrl('KeyE', true)
  await page.waitForSelector('.hb-export')
  await clickText('.hb-export button, .hb-export [role="radio"]', 'workspace')
  await clickText('.hb-export button', 'export .hbsuite.zip')
  const zipFile = await waitFile('.hbsuite.zip')
  await page.keyboard.press('Escape')

  await ctrl('KeyO')
  await dialog('smoke renamed')
  await page.$eval('button[aria-label="delete smoke renamed"]', (b) => b.click())
  await clickText('button', 'delete?')
  await page.waitForFunction(() => document.body.innerText.includes('no documents yet'), { timeout: 3000 }).catch(() => { throw new Error('delete did not empty the list') })
  if ((await idb(page, 'docs', 'all')).length) throw new Error('the deleted document is still stored')

  const pick = async (file) => {
    const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 3000 }), clickText('button', 'import')])
    await chooser.accept([file])
  }
  await pick(docFile)
  await page.waitForFunction(() => [...document.querySelectorAll('.hb-convs-item')].some((r) => r.textContent.includes('smoke renamed')), { timeout: 3000 })
    .catch(() => { throw new Error('the document file did not import back') })
  await pick(zipFile)
  await page.waitForFunction(() => document.body.innerText.includes('import 1 document into this project. nothing is replaced.'), { timeout: 3000 })
    .catch(() => { throw new Error('the workspace zip did not ask before import') })
  const okd = await page.evaluate(() => {
    const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => x.checkVisibility() && x.textContent.includes('nothing is replaced'))
    const b = d && [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === 'import')
    b?.click(); return !!b
  })
  if (!okd) throw new Error('the import confirm has no import button')
  await page.waitForFunction(() => [...document.querySelectorAll('.hb-convs-item')].filter((r) => r.textContent.includes('smoke renamed')).length === 2, { timeout: 3000 })
    .catch(() => { throw new Error('the workspace zip did not import back') })
  const back = await idb(page, 'docs', 'all')
  if (back.length !== 2 || back.some((d) => JSON.stringify(d.body) !== '{"turns":["hello"]}')) throw new Error('imported documents lost their body')
  if (shots) await page.screenshot({ path: join(shots, 'docs-1440.png') })

  if (errors.length) throw new Error(`console errors:\n${errors.join('\n')}`)
  await page.close()

  for (const g of GROUPS) {
    // its own context: file:// is one origin, so the documents above would open in chat
    const ctx = await browser.createBrowserContext()
    const gp = await ctx.newPage()
    gp.on('console', (m) => { if (m.type() === 'error') errors.push(`${g}.html: ${m.text()}`) })
    gp.on('pageerror', (e) => errors.push(`${g}.html: ${e}`))
    await gp.setViewport({ width: 1440, height: 900 })
    await gp.goto(pathToFileURL(resolve(`dist/groups/${g}.html`)).href, { waitUntil: 'load' })
    await gp.waitForSelector('.sx-yard img', { timeout: 10000 })
    const shelf = await gp.$$eval('.sx-home .hb-tile, .sx-parts a', (els) => els.length)
    if (shelf !== toolsOf(g).length) throw new Error(`${g}.html: home offers ${shelf} tools, the group has ${toolsOf(g).length}`)
    for (const id of toolsOf(g)) {
      const r = routeOf(g, id)
      await gp.evaluate((h) => { location.hash = h }, '#' + r)
      await gp.waitForFunction(async (want) => {
        const v = await new Promise((res) => {
          const q = indexedDB.open('hackbuild-suite')
          q.onsuccess = () => { try { const x = q.result.transaction('kv').objectStore('kv').get('last-route'); x.onsuccess = () => { q.result.close(); res(x.result) } } catch { res(null) } }
          q.onerror = () => res(null)
        })
        return v === want && !document.body.innerText.includes('no tool at this address')
      }, { timeout: 10000 }, r).catch(() => { throw new Error(`${g}.html: ${id} did not open at #${r}`) })
    }
    const other = GROUPS.find((x) => x !== g)
    await gp.evaluate((h) => { location.hash = h }, '#' + routeOf(other, toolsOf(other)[0]))
    await gp.waitForFunction(() => document.body.innerText.includes('no tool at this address'), { timeout: 5000 })
      .catch(() => { throw new Error(`${g}.html: a ${other} tool opened in the ${g} file`) })
    const lab = async () => {
      await gp.evaluate(() => { location.hash = '#/lab/phone-stage' })
      return gp.waitForFunction(() => !!document.querySelector('.hb-viewport-host') || document.body.innerText.includes('no tool at this address'), { timeout: 10000 })
        .then(() => gp.evaluate(() => !!document.querySelector('.hb-viewport-host')))
    }
    if (g === 'rooms') {
      await gp.evaluate(() => { location.hash = '#/rooms' })
      await gp.waitForFunction(() => document.body.textContent.includes('wake the agent'), { timeout: 5000 })
        .catch(() => { throw new Error('rooms.html does not open the room rack') })
      if (!(await lab())) throw new Error('rooms.html: the lab stage page did not open')
    } else if (await lab()) throw new Error(`${g}.html carries the lab stage page`)
    if (shots && (g === 'chat' || g === 'rooms')) await gp.screenshot({ path: join(shots, `group-${g}-1440.png`) })
    await ctx.close()
  }
  if (errors.length) throw new Error(`console errors:\n${errors.join('\n')}`)
  console.log(`smoke-file: ok. 7 group files from disk, each home offering its own tools only, rooms with the room tool and the lab stage page.`)
  console.log(`smoke-file: ok. home with the yard and 8 explorers, two route changes, indexeddb write read back, keys , ? m / esc, the switcher and the log from the menu; a document renamed, saved with ctrl+s, exported as .hbdoc.json and .hbsuite.zip, deleted and imported back from both, from ${url}`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
