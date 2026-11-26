// type-audit: visits every component page, demo and layout of the built docs
// site and flags text set in a face at a size it was not drawn for: VT323
// under 15 px (it reads about 60 percent the size of Plex at the same px),
// IBM Plex Mono under 11 px, Permanent Marker under 20 px, Special Elite
// under 12 px; and icons whose rendered size is off the 14 to 24 px scale.
// Prints the offending selectors with the pages they are on.
//   node tools/type-audit.mjs <base url of site/dist> [--pages a,b]
import puppeteer from 'puppeteer-core'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = process.argv[2] ?? 'http://127.0.0.1:8733/'
const only = (process.argv.find((a) => a.startsWith('--pages=')) ?? '').slice(8).split(',').filter(Boolean)
const comps = readdirSync(process.env.UI_COMPONENTS ?? '../hackbuild-ui/src/components').filter((f) => /^Hb.*\.vue$/.test(f)).map((f) => `#/components/${f.slice(0, -4)}`)
const demos = ['bench', 'zine', 'settings', 'shell-rack', 'shell-bench', 'shell-transcript', 'phone-rack', 'stage-chat', 'stage-tool', 'suite-shell'].map((d) => `#/demos/${d}`)
const layouts = ['stage-rack', 'canvas-rail', 'drop-first', 'conversation', 'gate', 'form-frame'].map((d) => `#/layouts/${d}`)
const pages = only.length ? only : ['#/', ...demos, ...layouts, ...comps]
const MIN = { vt323: 15, 'ibm plex mono': 11, 'permanent marker': 20, 'special elite': 12 }
const profile = mkdtempSync(join(tmpdir(), 'type-audit-'))
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', userDataDir: profile })
const hits = new Map()
const add = (key, page) => { const s = hits.get(key) ?? new Set(); s.add(page.replace('#/', '')); hits.set(key, s) }
try {
  const p = await b.newPage()
  await p.setViewport({ width: 1440, height: 900 })
  for (const page of pages) {
    await p.goto(base + page, { waitUntil: 'load' }).catch(() => {})
    await new Promise((r) => setTimeout(r, 400))
    const found = await p.evaluate((MIN) => {
      const out = []
      const sel = (el) => { const c = String(el.className?.baseVal ?? el.className ?? '').trim().split(/\s+/).filter((x) => x.startsWith('hb-') || x.length <= 3).slice(0, 2); return el.tagName.toLowerCase() + (c.length ? '.' + c.join('.') : '') }
      const parentSel = (el) => { let e = el; while (e && !String(e.className?.baseVal ?? e.className ?? '').includes('hb-')) e = e.parentElement; return e ? sel(e) : sel(el) }
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect()
        if (!r.width || !r.height) continue
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || +cs.opacity === 0) continue
        if (el.tagName === 'svg' && el.closest('button, .hb-icon, [class*="icon"]')) {
          const w = Math.round(r.width)
          if (w < 14 || w > 24) out.push(`icon ${w}px in ${parentSel(el.parentElement)}`)
          continue
        }
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
        if (!own) continue
        const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim().toLowerCase()
        const px = parseFloat(cs.fontSize)
        if (MIN[fam] && px < MIN[fam]) out.push(`${fam} ${px}px ${parentSel(el)}`)
      }
      return out
    }, MIN)
    for (const f of found) add(f, page)
  }
} finally { await b.close(); rmSync(profile, { recursive: true, force: true }) }
const rows = [...hits.entries()].sort((a, b) => b[1].size - a[1].size)
for (const [k, v] of rows) console.log(`${String(v.size).padStart(3)}  ${k}   [${[...v].slice(0, 4).join(', ')}${v.size > 4 ? ', ...' : ''}]`)
console.log(`type-audit: ${rows.length} distinct problems over ${pages.length} pages`)
process.exitCode = rows.length ? 1 : 0
