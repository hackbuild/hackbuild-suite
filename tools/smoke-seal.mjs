// smoke-seal: sealed exports and a sealed memory (design 2.5b) in the
// single file build on file:// with ?stub. Chat saves a fact; the memory
// tool seals the chat memory with a password, after which neither the
// memory database nor the workspace documents hold its text; a reload asks
// for the password, a wrong one is refused, the right one shows the memory.
// The workspace exports sealed; the file holds no plain text; a fresh
// profile imports it, refusing a wrong password and taking the right one;
// a file with one changed byte (zip checksums redone) is refused.
// Any request off file:// or console error fails the run.
//   npm run build:single && node tools/smoke-seal.mjs
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'
import { unzipStore, zipStore } from '@hackbuild/audio-dsp'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const base = `${pathToFileURL(file).href}?stub`
const shots = process.env.SHOTS
const profile = mkdtempSync(join(tmpdir(), 'suite-seal-'))
const downloads = join(profile, 'downloads')
mkdirSync(downloads)
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: join(profile, 'chrome'), args: ['--no-first-run'] })
const errors = []
const off = []
const fail = (why) => { throw new Error(why) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const PW = 'blue kettle'
const FACT = 'the mug goes on the shelf'

async function newPage(ctx) {
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) off.push(r.url()) })
  const cdp = await page.createCDPSession()
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
  await page.setViewport({ width: 1024, height: 900 })
  return page
}
const click = (page, sel, w) => page.evaluate((s, x) => {
  const b = [...document.querySelectorAll(s)].find((e) => e.checkVisibility() && e.textContent.trim().startsWith(x) && !e.disabled)
  b?.click(); return !!b
}, sel, w)
const has = (page, t, ms = 6000) => page.waitForFunction((x) => document.body.innerText.includes(x), { timeout: ms }, t)
const fill = async (page, sel, v) => {
  await page.$eval(sel, (e) => { e.focus(); e.value = '' })
  await page.type(sel, v)
}
/** Every row of an IndexedDB database as one string, binary as latin1. */
const dump = (page, name) => page.evaluate((n) => new Promise((res) => {
  const q = indexedDB.open(n)
  q.onsuccess = async () => {
    const db = q.result
    let out = ''
    for (const s of db.objectStoreNames) {
      const rows = await new Promise((r) => { const g = db.transaction(s).objectStore(s).getAll(); g.onsuccess = () => r(g.result) })
      out += JSON.stringify(rows, (_, v) => (v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? String.fromCharCode(...new Uint8Array(v.buffer ?? v)) : v))
    }
    db.close()
    res(out)
  }
  q.onerror = () => res('')
}), name)
const waitFile = async (end) => {
  for (let i = 0; i < 60; i++) {
    const f = readdirSync(downloads).find((n) => n.endsWith(end))
    if (f) return join(downloads, f)
    await wait(100)
  }
  fail(`no ${end} download`)
}
const dialogWith = (page, t) => page.waitForFunction((x) => [...document.querySelectorAll('[role="dialog"]')].some((d) => d.checkVisibility() && d.textContent.includes(x)), { timeout: 6000 }, t)
const inDialog = (page, t, label) => page.evaluate((x, l) => {
  const d = [...document.querySelectorAll('[role="dialog"]')].find((e) => e.checkVisibility() && e.textContent.includes(x))
  const b = d && [...d.querySelectorAll('button')].find((e) => e.textContent.trim() === l && !e.disabled)
  b?.click(); return !!b
}, t, label)

try {
  const page = await newPage(browser)
  // chat saves a fact into the chat memory
  await page.goto(`${base}#/chat`, { waitUntil: 'load' })
  await page.waitForSelector('.hb-chat .hb-composer textarea', { timeout: 8000 })
  await page.focus('.hb-composer textarea')
  await page.keyboard.type(`remember that ${FACT}`)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.hb-chat-log .hb-msg-acts').length >= 1, { timeout: 8000 }).catch(() => fail('chat did not reply'))

  // the memory tool seals it
  await page.evaluate(() => { location.hash = '#/chat/memory' })
  await page.waitForSelector('#mem-seal-pw', { timeout: 8000 }).catch(() => fail('the memory tool shows no seal box'))
  await has(page, FACT).catch(() => fail('the memory tool does not list the fact'))
  await fill(page, '#mem-seal-pw', PW)
  if (await click(page, '#mem-seal-pw ~ * button, .hb-panel button', 'seal with a password')) fail('seal ran with one password typed')
  await fill(page, '#mem-seal-pw2', PW)
  if (!(await click(page, 'button', 'seal with a password'))) fail('no seal button')
  await has(page, 'sealed with a password and open on this visit', 10000).catch(() => fail('the seal did not land'))
  await has(page, FACT).catch(() => fail('the sealed memory does not list the fact'))
  await wait(400)
  const memRows = await dump(page, 'hackbuild-memory:chat')
  if (!memRows.includes('pbkdf2-sha256')) fail('the memory database has no lock record')
  if (memRows.includes('shelf')) fail('the sealed memory database still holds the text')
  // the chat document keeps its own conversation; memory documents must hold none of the text
  const memDocs = await page.evaluate(() => new Promise((res) => {
    const q = indexedDB.open('hackbuild-suite')
    q.onsuccess = () => { const g = q.result.transaction('docs').objectStore('docs').getAll(); g.onsuccess = () => { q.result.close(); res(g.result.filter((d) => d.kind === 'memory.store')) } }
  }))
  if (!memDocs.length || memDocs.some((d) => JSON.stringify(d).includes('shelf') || !d.body.sealed || !d.body.lock)) fail(`a memory document is not sealed: ${JSON.stringify(memDocs).slice(0, 300)}`)
  if (shots) await page.screenshot({ path: join(shots, 'memory-sealed-1024.png') })

  // a reload asks for the password
  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('#mem-seal-pw', { timeout: 8000 }).catch(() => fail('a reload did not ask for the password'))
  await has(page, 'this memory is sealed. give its password').catch(() => fail('the sealed line is missing'))
  if ((await page.evaluate(() => document.body.innerText)).includes(FACT)) fail('the sealed memory shows before the password')
  await fill(page, '#mem-seal-pw', 'wrong')
  await click(page, 'button', 'open')
  await has(page, 'wrong password', 10000).catch(() => fail('a wrong password was not refused'))
  if (shots) await page.screenshot({ path: join(shots, 'memory-wrong-1024.png') })
  await fill(page, '#mem-seal-pw', PW)
  await click(page, 'button', 'open')
  await has(page, FACT, 10000).catch(() => fail('the right password did not open the memory'))

  // the workspace exports sealed
  await page.evaluate(() => document.activeElement?.blur())
  const mod = (await page.evaluate(() => /Mac/.test(navigator.platform))) ? 'Meta' : 'Control'
  await page.keyboard.down(mod); await page.keyboard.down('Shift'); await page.keyboard.press('KeyE'); await page.keyboard.up('Shift'); await page.keyboard.up(mod)
  await page.waitForSelector('.hb-export', { timeout: 4000 }).catch(() => fail('ctrl+shift+e opened no export panel'))
  await click(page, '.hb-export button, .hb-export [role="radio"]', 'workspace')
  if (!(await click(page, '.hb-export label, .hb-export .hb-togglerow, .hb-export [role="switch"]', 'seal with a password'))) {
    if (!(await page.evaluate(() => { const s = [...document.querySelectorAll('.hb-export input[type=checkbox], .hb-export [role=switch]')].find((e) => e.closest('*')?.parentElement?.textContent.includes('seal with')); s?.click(); return !!s }))) fail('no seal toggle in the export panel')
  }
  await page.waitForSelector('#ws-seal-pw', { timeout: 3000 }).catch(() => fail('the seal toggle shows no password box'))
  await has(page, 'there is no recovery').catch(() => fail('the export panel does not say there is no recovery'))
  await fill(page, '#ws-seal-pw', PW)
  await fill(page, '#ws-seal-pw2', PW)
  if (shots) await page.screenshot({ path: join(shots, 'export-sealed-1024.png') })
  await click(page, '.hb-export button', 'export .hbsuite.zip')
  const zipPath = await waitFile('.hbsuite.zip')
  const zip = readFileSync(zipPath)
  const names = unzipStore(new Uint8Array(zip)).map((e) => e.name)
  if (names.join(',') !== 'sealed.json,sealed.bin') fail(`the sealed zip holds ${names.join(', ')}`)
  if (zip.toString('latin1').includes('shelf') || zip.toString('latin1').includes('remember') || zip.toString('latin1').includes('manifest')) fail('the sealed zip holds plain text')
  await page.close()

  // a fresh profile imports it: wrong password, then the right one
  const ctx = await browser.createBrowserContext()
  const fresh = await newPage(ctx)
  await fresh.goto(`${base}#/chat/memory`, { waitUntil: 'load' })
  await fresh.waitForSelector('.hb-mempanel', { timeout: 8000 })
  const pick = async (p, f) => {
    const input = await p.$('input[type=file][multiple][aria-hidden="true"]')
    if (!input) fail('no shell file input')
    await input.uploadFile(f)
  }
  await pick(fresh, zipPath)
  await dialogWith(fresh, 'is sealed').catch(() => fail('import did not ask for the password'))
  await fill(fresh, '#ws-unseal-pw', 'nope')
  await inDialog(fresh, 'is sealed', 'open')
  await dialogWith(fresh, 'wrong password').catch(() => fail('the import took a wrong password'))
  await fill(fresh, '#ws-unseal-pw', PW)
  await inDialog(fresh, 'is sealed', 'open')
  await dialogWith(fresh, 'nothing is replaced').catch(() => fail('the right password did not reach the import confirm'))
  await inDialog(fresh, 'nothing is replaced', 'import')
  let docs = 0
  for (let i = 0; i < 40 && !docs; i++) {
    const rows = await dump(fresh, 'hackbuild-suite')
    docs = (rows.match(/"kind":"memory.store"/g) ?? []).length
    if (!docs) await wait(150)
  }
  if (docs < 2) fail(`the import added no memory document (found ${docs})`)

  // one changed byte, checksums redone, is refused after the password
  const entries = unzipStore(new Uint8Array(zip))
  const bin = entries.find((e) => e.name === 'sealed.bin').data.slice()
  bin[bin.length - 20] ^= 1
  const tampered = join(profile, 'tampered.hbsuite.zip')
  writeFileSync(tampered, zipStore([entries[0], { name: 'sealed.bin', data: bin }]))
  await pick(fresh, tampered)
  await dialogWith(fresh, 'is sealed').catch(() => fail('the tampered file did not ask for the password'))
  await fill(fresh, '#ws-unseal-pw', PW)
  await inDialog(fresh, 'is sealed', 'open')
  await dialogWith(fresh, 'file was changed').catch(() => fail('the tampered file was not refused'))
  await inDialog(fresh, 'is sealed', 'cancel')
  await ctx.close()

  if (off.length) fail(`requests off file://:\n${off.join('\n')}`)
  if (errors.length) fail(`console errors:\n${errors.join('\n')}`)
  console.log(`smoke-seal: ok. the chat memory sealed in place with no plain text in ${memRows.length} chars of memory rows or in ${memDocs.length} memory documents; a reload asks, a wrong password is refused, the right one opens it; the sealed workspace zip (${zip.length} bytes, measured) holds only sealed.json and sealed.bin; a fresh profile refuses a wrong password and imports with the right one; one changed byte is refused, 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
