// ux-probe: the measuring half of tools/ux-gate.mjs. Pure helpers (word scan,
// rect overlap, the verdicts) run in node and in the page; `probe` runs in the
// page and returns raw numbers. See ux-gate.mjs for the marker convention.

/** Banned internal words in `text`, whole words, case insensitive, plural s allowed. */
export function bannedWords(text) {
  const re = /\b(organ|tier|provider|rung|phase|inferred|measured|computed|unverified)s?\b/gi
  const out = []
  let m
  while ((m = re.exec(text))) out.push(m[1].toLowerCase())
  return out
}

/** Overlap area of two rects ({left, top, right, bottom}), 0 when apart or touching. */
export function overlapArea(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return w > 0 && h > 0 ? w * h : 0
}

/** True when two rects share more than `min` square px (anti-aliasing slack). */
export function intersects(a, b, min = 4) {
  return overlapArea(a, b) > min
}

/** File name part for a route: '#/chat/chat' is 'chat-chat', '#/' is 'home'. */
export const slug = (route) => route.replace(/^#\/?/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'

export const CHECKS = ['bar', 'controls', 'disabled', 'pink', 'subject', 'rack', 'hscroll', 'overlap', 'words']

/** Turns raw probe numbers into nine verdicts: { pass, value } each (pass null when not applicable). */
export function judge(m, width) {
  const wide = width >= 1000
  const v = {}
  v.bar = !m.bar
    ? { pass: false, value: 'no bar' }
    : { pass: m.bar.height <= 52 && m.bars === 1, value: `${Math.round(m.bar.height)} px, ${m.bars} bar${m.bars === 1 ? '' : 's'}` }
  v.controls = { pass: m.controls.length <= 15, value: m.controls.length }
  v.disabled = { pass: m.disabled.length === 0, value: m.disabled.length }
  v.pink = !m.pinkVar
    ? { pass: false, value: 'no --hb-pink' }
    : { pass: m.pink.length === 1, value: m.pink.length }
  if (!m.subject) v.subject = { pass: false, value: 'no subject' }
  else if (wide) v.subject = { pass: m.subject.share >= 0.6, value: `${Math.round(m.subject.share * 100)} %` }
  else v.subject = { pass: m.subject.top < m.viewport.height, value: `top ${Math.round(m.subject.top)} px` }
  if (!wide) v.rack = { pass: null, value: 'n/a' }
  else if (!m.rack) v.rack = { pass: false, value: 'no rack' }
  else {
    const ws = m.rack.widths.map(Math.round)
    const spread = Math.max(...ws) - Math.min(...ws)
    v.rack = { pass: Math.abs(ws[0] - 380) <= 1 && spread <= 1, value: spread ? `${Math.min(...ws)} to ${Math.max(...ws)} px over ${ws.length - 1} tabs` : `${ws[0]} px` }
  }
  v.hscroll = { pass: m.hscroll <= 0, value: `${m.hscroll} px` }
  v.overlap = { pass: m.overlaps.length === 0, value: m.overlaps.length }
  v.words = { pass: m.words.length === 0, value: m.words.length ? [...new Set(m.words.map((w) => w.word))].join(' ') : 0 }
  return v
}

/**
 * Runs in the page (or frame). Measures, then clicks each rack tab and
 * remeasures the rack, then clicks the first tab again.
 * Helpers are passed in by name through `pageScript`.
 */
async function probe() {
  const W = innerWidth
  const H = innerHeight
  const view = { left: 0, top: 0, right: W, bottom: H }
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
  const label = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40)
  const folded = (el) => {
    if (el.closest('[hidden],[aria-hidden="true"],[inert]')) return true
    const d = el.closest('details:not([open])')
    return !!d && !(el.closest('summary') && el.closest('summary').parentElement === d)
  }
  const shown = (el) => {
    if (folded(el)) return false
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  }
  const inView = (r) => overlapArea(r, view) > 0
  // what sits on top at the centre of a rect (clipped to the viewport)
  const hitAt = (r) => {
    const x = (Math.max(r.left, 0) + Math.min(r.right, W)) / 2
    const y = (Math.max(r.top, 0) + Math.min(r.bottom, H)) / 2
    return document.elementFromPoint(x, y)
  }
  // reachable: nothing else (a modal, a popover) covers the element's centre
  const reachable = (el, r = el.getBoundingClientRect()) => { const hit = hitAt(r); return !!hit && (el.contains(hit) || hit.contains(el)) }
  // a full screen layer (a modal backdrop), not an item that crosses the bar
  const isLayer = (el) => {
    if (el.closest('dialog[open],[aria-modal="true"]')) return true
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const r = p.getBoundingClientRect()
      if (getComputedStyle(p).position === 'fixed' && r.width * r.height >= W * H * 0.5) return true
    }
    return false
  }
  const marked = (k) => [...document.querySelectorAll(`[data-ux~="${k}"]`)].filter(shown)
  const detectors = {}

  // bar: marker, else the topmost full width header or banner
  const barLike = [...document.querySelectorAll('header,[role=banner],nav,[role=toolbar],[data-ux~="bar"]')].filter(shown).filter((el) => {
    const r = rectOf(el)
    return r.width >= W * 0.9 && r.top < H * 0.25 && r.bottom > 0 && r.height < H * 0.3
  })
  let bar = marked('bar')[0]
  detectors.bar = bar ? 'marker' : 'heuristic'
  if (!bar) bar = barLike.filter((el) => el.matches('header,[role=banner]')).sort((a, b) => rectOf(a).top - rectOf(b).top)[0]
  const outer = barLike.filter((el) => !barLike.some((o) => o !== el && o.contains(el)))
  const bars = bar ? 1 + outer.filter((el) => !el.contains(bar) && !bar.contains(el)).length : outer.length

  // rack: marker, else an aside or *rack* class on the right (or a bottom sheet on a phone)
  let rack = marked('rack')[0]
  detectors.rack = rack ? 'marker' : 'heuristic'
  if (!rack) {
    rack = [...document.querySelectorAll('aside,[class*="rack"]')].filter(shown).filter((el) => !(bar && bar.contains(el))).map((el) => [el, rectOf(el)])
      .filter(([, r]) => (r.left >= W * 0.45 && r.width < W * 0.6 && r.height > H * 0.3) || (W < 500 && r.width >= W * 0.9 && r.top > H * 0.4))
      .sort((a, b) => b[1].width * b[1].height - a[1].width * a[1].height).map((x) => x[0])[0]
  }

  // subject: marker, else the largest visible canvas, video, img, iframe, main
  // child, or *stage*, *drop*, *frame*, *viewport* class element
  const clipArea = (r) => overlapArea(r, view)
  let subject = marked('subject')[0]
  detectors.subject = subject ? 'marker' : 'heuristic'
  if (!subject) {
    subject = [...document.querySelectorAll('canvas,video,img,iframe,[role=main] > *,main > *,[class*="stage"],[class*="drop"],[class*="frame"],[class*="viewport"]')].filter(shown)
      .filter((el) => !(rack && (rack.contains(el) || el.contains(rack))) && !(bar && (bar.contains(el) || el.contains(bar))))
      .map((el) => [el, clipArea(rectOf(el))])
    // a wrapper yields to a candidate inside it that holds a quarter of its area or more
    subject = subject.filter(([el, a]) => !subject.some(([o, b]) => o !== el && el.contains(o) && b >= a * 0.25))
      .sort((a, b) => b[1] - a[1]).map((x) => x[0])[0]
  }
  const sr = subject && rectOf(subject)

  // controls in first view
  const ctl = [...new Set(document.querySelectorAll('button,input:not([type=hidden]),select,textarea,[role=button],[role=tab]'))].filter(shown).filter((el) => inView(rectOf(el)) && reachable(el))
  const off = (el) => el.disabled || el.getAttribute('aria-disabled') === 'true' || !!el.closest('fieldset[disabled]')
  const controls = ctl.filter((el) => !off(el) && !(rack && rack.contains(el))).map(label)
  const disabled = ctl.filter(off).map(label)

  // the one pink control: computed background equal to the resolved --hb-pink
  const pinkVar = getComputedStyle(document.documentElement).getPropertyValue('--hb-pink').trim()
  const tmp = document.createElement('i')
  tmp.style.color = 'var(--hb-pink)'
  document.body.append(tmp)
  const pinkRgb = getComputedStyle(tmp).color
  tmp.remove()
  const pink = pinkVar ? ctl.filter((el) => getComputedStyle(el).backgroundColor === pinkRgb).map(label) : []

  const hscroll = document.documentElement.scrollWidth - document.documentElement.clientWidth

  // header items that cross each other (ancestor pairs excepted)
  const overlaps = []
  if (bar) {
    const items = [...bar.querySelectorAll('*')].filter((el) => shown(el) && (el.matches('button,a,img,svg,input,select,canvas,meter,progress,[role=button],[role=tab],[role=meter]') || [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())))
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]
        const b = items[j]
        if (a.contains(b) || b.contains(a)) continue
        if (intersects(rectOf(a), rectOf(b))) overlaps.push(`${label(a)} x ${label(b)}`)
      }
    }
    // an element from outside the bar drawn over a bar item (a popover on the logo)
    for (const el of items) {
      const hit = hitAt(rectOf(el))
      if (hit && !bar.contains(hit) && !hit.contains(el) && !isLayer(hit)) overlaps.push(`${label(el)} under ${label(hit)}`)
    }
  }

  // banned words in first view text outside folds and detail panes
  const words = []
  const skip = (el) => el.closest('script,style,noscript,template,[data-ux~="detail"],[class*="detail"]')
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const t = n.textContent
    const el = n.parentElement
    if (!t.trim() || !el || skip(el) || !shown(el)) continue
    range.selectNodeContents(n)
    const tr = range.getBoundingClientRect()
    if (!inView(tr) || !reachable(el, tr)) continue
    for (const word of bannedWords(t)) words.push({ word, text: t.trim().replace(/\s+/g, ' ').slice(0, 60) })
  }
  for (const el of ctl) {
    const p = el.getAttribute('placeholder')
    if (p && !skip(el)) for (const word of bannedWords(p)) words.push({ word, text: p.slice(0, 60) })
  }

  // rack width across its tabs
  let rackOut = null
  if (rack) {
    const widths = [rectOf(rack).width]
    let tabs = [...rack.querySelectorAll('[role=tab]')].filter(shown)
    if (!tabs.length) { const list = rack.querySelector('[role=tablist],[class*="tabs"]'); if (list) tabs = [...list.querySelectorAll('button')].filter(shown) }
    for (const t of tabs) {
      t.click()
      await new Promise((r) => setTimeout(r, 200))
      const again = marked('rack')[0] ?? (rack.isConnected ? rack : null)
      widths.push(again ? again.getBoundingClientRect().width : 0)
    }
    if (tabs[0]) { tabs[0].click(); await new Promise((r) => setTimeout(r, 200)) }
    rackOut = { ...rectOf(rack), widths, tabs: tabs.length }
  }

  return {
    viewport: { width: W, height: H },
    detectors,
    bar: bar ? rectOf(bar) : null,
    bars,
    subject: sr ? { ...sr, tag: subject.tagName.toLowerCase(), share: clipArea(sr) / (W * H) } : null,
    rack: rackOut,
    controls, disabled, pinkVar, pink, hscroll, overlaps, words,
  }
}

/** The probe as one expression for page.evaluate, with its helpers inlined. */
export const pageScript = `(async () => {
  ${bannedWords.toString()}
  ${overlapArea.toString()}
  ${intersects.toString()}
  return (${probe.toString()})()
})()`
