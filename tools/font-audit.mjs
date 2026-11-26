// Lists the font families a page actually renders: every visible element
// that holds text, grouped by the first family in its computed font-family,
// with the resolved face (document.fonts) and example selectors.
// node tools/font-audit.mjs <url> [<url> ...]
import puppeteer from 'puppeteer-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const ALLOWED = ['ibm plex mono', 'vt323', 'permanent marker', 'special elite']
const profile = mkdtempSync(join(tmpdir(), 'font-audit-'))
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', userDataDir: profile })
let bad = 0
try {
  for (const url of process.argv.slice(2)) {
    const p = await b.newPage()
    await p.setViewport({ width: 1440, height: 900 })
    if (process.env.ALL) await p.evaluateOnNewDocument(() => { window.__ALL = 1 })
    await p.goto(url, { waitUntil: 'load' })
    await new Promise((r) => setTimeout(r, 3500))
    const rows = await p.evaluate(() => {
      const out = {}
      const sel = (el) => {
        let s = el.tagName.toLowerCase()
        if (el.id) s += '#' + el.id
        const c = String(el.className?.baseVal ?? el.className ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2)
        if (c.length) s += '.' + c.join('.')
        return s
      }
      for (const el of document.querySelectorAll('body *')) {
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.tagName)
        if (!own) continue
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue
        const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim().toLowerCase()
        const key = `${fam} | ${cs.fontSize} | ${cs.textTransform !== 'none' ? cs.textTransform : ''}`
        ;(out[fam] ??= { n: 0, sizes: {}, ex: [] }).n++
        out[fam].sizes[cs.fontSize] = (out[fam].sizes[cs.fontSize] ?? 0) + 1
        if (out[fam].ex.length < (window.__ALL ? 60 : 6)) out[fam].ex.push(`${cs.fontSize} ${sel(el)} "${String(typeof el.value === "string" ? el.value : el.textContent).trim().slice(0, 30)}"`)
      }
      const loaded = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, '').toLowerCase())
      return { out, loaded: [...new Set(loaded)] }
    })
    console.log(`\n== ${url}\nloaded faces: ${rows.loaded.join(', ') || 'none'}`)
    for (const [fam, v] of Object.entries(rows.out).sort((a, b) => b[1].n - a[1].n)) {
      const ok = ALLOWED.includes(fam) && rows.loaded.includes(fam)
      if (!ok) bad += v.n
      console.log(`${ok ? '  ok ' : '  BAD'} ${fam} x${v.n} sizes ${Object.entries(v.sizes).map(([s, n]) => `${s}:${n}`).join(' ')}`)
      if (!ok || process.env.ALL) for (const e of v.ex) console.log(`        ${e}`)
    }
    await p.close()
  }
} finally { await b.close(); rmSync(profile, { recursive: true, force: true }) }
console.log(`\nfont-audit: ${bad} text elements off the type set`)
process.exitCode = bad ? 1 : 0
