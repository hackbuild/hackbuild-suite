// roundtrip-workspace: the workspace survives a wiped browser (design 2.5).
// In a fresh Chrome profile it opens four tools of the single file build
// from file://, each of which makes a document, exports the workspace zip,
// deletes the profile, imports the zip into a second fresh profile and
// compares every document byte for byte. Import stamps a new id, project
// and times by design (nothing is replaced), so those four fields are left
// out; everything else must match, and so must every stored blob. One
// document gets a 64 kB attachment so the binary path is in the trip.
// Usage:
//   npm run build:single && node tools/roundtrip-workspace.mjs
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const url = pathToFileURL(file).href
const TOOLS = [['vision', '#/image/vision'], ['masks', '#/image/masks'], ['relief', '#/image/relief'], ['generate', '#/image/generate']]
const STAMPED = ['id', 'project', 'created', 'updated']
const keep = mkdtempSync(join(tmpdir(), 'suite-roundtrip-'))
const errors = []

// Every stored document as canonical bytes: keys sorted, binary as base64.
const snapshot = (page) => page.evaluate(async (stamped) => {
  const all = await new Promise((res, rej) => {
    const r = indexedDB.open('hackbuild-suite')
    r.onsuccess = () => {
      const q = r.result.transaction('docs').objectStore('docs').getAll()
      q.onsuccess = () => { r.result.close(); res(q.result) }; q.onerror = () => rej(q.error)
    }
    r.onerror = () => rej(r.error)
  })
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s) }
  const canon = async (v) => {
    if (v instanceof Blob) return { $blob: v.type, b64: b64(new Uint8Array(await v.arrayBuffer())) }
    if (v instanceof ArrayBuffer) return { $bytes: 'ArrayBuffer', b64: b64(new Uint8Array(v)) }
    if (ArrayBuffer.isView(v)) return { $bytes: v.constructor.name, b64: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) }
    if (Array.isArray(v)) return Promise.all(v.map(canon))
    if (v && typeof v === 'object') {
      const o = {}
      for (const k of Object.keys(v).sort()) o[k] = await canon(v[k])
      return o
    }
    return v
  }
  const blobs = await new Promise((res, rej) => {
    const r = indexedDB.open('hackbuild-suite')
    r.onsuccess = () => {
      const q = r.result.transaction('blobs').objectStore('blobs').getAll()
      q.onsuccess = () => { r.result.close(); res(q.result) }; q.onerror = () => rej(q.error)
    }
    r.onerror = () => rej(r.error)
  })
  const out = {}
  for (const b of blobs) out[`blob/${b.hash}`] = JSON.stringify(await canon(b))
  for (const d of all) {
    const rest = Object.fromEntries(Object.entries(d).filter(([k]) => !stamped.includes(k)))
    out[`${d.tool}/${d.name}`] = JSON.stringify(await canon(rest))
  }
  return out
}, STAMPED)

async function session(run) {
  const profile = mkdtempSync(join(tmpdir(), 'suite-roundtrip-profile-'))
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args: ['--no-first-run', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  try {
    const page = await browser.newPage()
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.setViewport({ width: 1440, height: 900 })
    const cdp = await page.createCDPSession()
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: keep })
    await page.goto(url, { waitUntil: 'load' })
    await page.waitForSelector('.hb-tabs')
    const mod = (await page.evaluate(() => /Mac/.test(navigator.platform))) ? 'Meta' : 'Control'
    const ctrl = async (key, shift = false) => {
      await page.keyboard.down(mod); if (shift) await page.keyboard.down('Shift')
      await page.keyboard.press(key)
      if (shift) await page.keyboard.up('Shift'); await page.keyboard.up(mod)
    }
    const clickText = async (sel, text) => {
      const ok = await page.evaluate((s, x) => {
        const el = [...document.querySelectorAll(s)].find((e) => e.checkVisibility() && e.textContent.trim().startsWith(x))
        el?.click(); return !!el
      }, sel, text)
      if (!ok) throw new Error(`no visible ${sel} reading "${text}"`)
    }
    return await run({ page, ctrl, clickText })
  } finally {
    await browser.close()
    rmSync(profile, { recursive: true, force: true })
  }
}

try {
  // profile one: four tools make their documents, the workspace goes out as a zip
  const before = await session(async ({ page, ctrl, clickText }) => {
    for (const [tool, hash] of TOOLS) {
      await page.evaluate((h) => { location.hash = h }, hash)
      await page.waitForFunction(async (t) => {
        const n = await new Promise((res) => {
          const r = indexedDB.open('hackbuild-suite')
          r.onsuccess = () => { const q = r.result.transaction('docs').objectStore('docs').getAll(); q.onsuccess = () => { r.result.close(); res(q.result.filter((d) => d.tool === t).length) } }
          r.onerror = () => res(0)
        })
        return n > 0
      }, { timeout: 15000 }, tool).catch(() => { throw new Error(`${tool} made no document`) })
    }
    // an attachment on the vision document: random bytes in the blob store, referenced from the body
    await page.evaluate(async () => {
      const data = crypto.getRandomValues(new Uint8Array(65536))
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((x) => x.toString(16).padStart(2, '0')).join('')
      const r = await new Promise((res, rej) => { const o = indexedDB.open('hackbuild-suite'); o.onsuccess = () => res(o.result); o.onerror = () => rej(o.error) })
      const tx = r.transaction(['blobs', 'docs'], 'readwrite')
      tx.objectStore('blobs').put({ hash, name: 'roundtrip.bin', type: 'application/octet-stream', size: data.length, local: false, data }, hash)
      const docs = tx.objectStore('docs')
      const q = docs.getAll()
      q.onsuccess = () => { const d = q.result.find((x) => x.tool === 'vision'); d.body.attachment = { $blob: hash }; docs.put(d, d.id) }
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
      r.close()
    })
    await page.click('.hb-statusbar'); await page.keyboard.press('Escape')
    await ctrl('KeyS')
    await new Promise((r) => setTimeout(r, 300))
    const snap = await snapshot(page)
    await ctrl('KeyE', true)
    await page.waitForSelector('.hb-export')
    await clickText('.hb-export button, .hb-export [role="radio"]', 'workspace')
    await clickText('.hb-export button', 'export .hbsuite.zip')
    for (let i = 0; i < 50 && !readdirSync(keep).some((n) => n.endsWith('.hbsuite.zip')); i++) await new Promise((r) => setTimeout(r, 100))
    return snap
  })
  const zip = readdirSync(keep).find((n) => n.endsWith('.hbsuite.zip'))
  if (!zip) throw new Error('no .hbsuite.zip download')
  const tools = new Set(Object.keys(before).map((k) => k.split('/')[0]).filter((t) => t !== 'blob'))
  if (!Object.keys(before).some((k) => k.startsWith('blob/'))) throw new Error('the attachment did not store')
  if (tools.size < 4) throw new Error(`documents from ${tools.size} tools, expected 4: ${[...tools].join(', ')}`)

  // profile two, fresh: nothing stored until the zip comes in
  const after = await session(async ({ page, ctrl, clickText }) => {
    if (Object.keys(await snapshot(page)).length) throw new Error('the second profile is not empty')
    await page.click('.hb-statusbar'); await page.keyboard.press('Escape')
    await ctrl('KeyO')
    const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 3000 }), clickText('button', 'import')])
    await chooser.accept([join(keep, zip)])
    await page.waitForFunction(() => document.body.innerText.includes('nothing is replaced'), { timeout: 3000 })
      .catch(() => { throw new Error('the workspace zip did not ask before import') })
    const ok = await page.evaluate(() => {
      const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => x.checkVisibility() && x.textContent.includes('nothing is replaced'))
      const b = d && [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === 'import')
      b?.click(); return !!b
    })
    if (!ok) throw new Error('the import confirm has no import button')
    await page.waitForFunction(async (n) => {
      const c = await new Promise((res) => {
        const r = indexedDB.open('hackbuild-suite')
        r.onsuccess = () => { const q = r.result.transaction('docs').objectStore('docs').count(); q.onsuccess = () => { r.result.close(); res(q.result) } }
        r.onerror = () => res(0)
      })
      return c >= n
    }, { timeout: 5000 }, Object.keys(before).filter((k) => !k.startsWith('blob/')).length).catch(() => { throw new Error('the import did not store every document') })
    return snapshot(page)
  })

  const diff = []
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(k in before)) diff.push(`${k}: appeared after import`)
    else if (!(k in after)) diff.push(`${k}: lost in the round trip`)
    else if (before[k] !== after[k]) diff.push(`${k}: ${before[k].length} B before, ${after[k].length} B after, bytes differ`)
  }
  if (diff.length) throw new Error(`round trip changed documents:\n${diff.join('\n')}`)
  if (errors.length) throw new Error(`console errors:\n${errors.join('\n')}`)
  const bytes = Object.values(before).reduce((n, s) => n + s.length, 0)
  const nb = Object.keys(before).filter((k) => k.startsWith('blob/')).length
  console.log(`roundtrip-workspace: ok. ${Object.keys(before).length - nb} documents and ${nb} blob from ${[...tools].join(', ')}, ${bytes} B canonical (measured), identical after export, profile wipe and import`)
} finally {
  rmSync(keep, { recursive: true, force: true })
}
