// ux-probe: the measuring half of tools/ux-gate.mjs. Pure helpers (word scan,
// rect overlap, the verdicts) run in node and in the page; the page scripts
// return raw numbers. See ux-gate.mjs for the marker convention.

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

export const LAYOUTS = ['stage-rack', 'canvas-rail', 'drop-first', 'conversation', 'gate', 'form-frame', 'home']
export const CHECKS = ['modal', 'bar', 'controls', 'disabled', 'pink', 'subject', 'rack', 'hscroll', 'overlap', 'words']
export const LIMITS = { bar: 52, controls: 15, subjectShare: 0.6, phoneSubjectTop: 0.5, rack: 380, rackTabs: [3, 5], rackControls: 20 }

/**
 * Turns raw probe numbers into verdicts: { pass, value } each, pass null when
 * a check does not apply (the rack on a phone, or on a gate or home layout).
 */
export function judge(m, width, layout = 'stage-rack') {
  const wide = width >= 1000
  const v = {}
  v.modal = m.modal ? { pass: false, value: `${m.modal.label} (${m.modal.dismissed})` } : { pass: true, value: 'none' }
  v.bar = !m.bar
    ? { pass: false, value: 'no bar' }
    : { pass: m.bar.height <= LIMITS.bar && m.bars === 1, value: `${Math.round(m.bar.height)} px, ${m.bars} bar${m.bars === 1 ? '' : 's'}` }
  v.controls = { pass: m.controls.length <= LIMITS.controls, value: m.controls.length }
  v.disabled = { pass: m.disabled.length === 0, value: m.disabled.length }
  v.pink = !m.pinkVar
    ? { pass: false, value: 'no pink variable' }
    : { pass: m.pink.length === 1, value: m.pink.length }
  if (!m.subject) v.subject = { pass: false, value: layout === 'home' ? 'no yard tile' : 'no subject' }
  else if (wide) v.subject = { pass: m.subject.share >= LIMITS.subjectShare, value: `${Math.round(m.subject.share * 100)} %` }
  else v.subject = { pass: m.subject.top <= m.viewport.height * LIMITS.phoneSubjectTop, value: `top ${Math.round(m.subject.top)} px` }
  if (!wide || layout === 'gate' || layout === 'home') v.rack = { pass: null, value: 'n/a' }
  else if (!m.rack) v.rack = { pass: false, value: 'no rack' }
  else {
    const ws = m.rack.widths.map(Math.round)
    const spread = Math.max(...ws) - Math.min(...ws)
    const [lo, hi] = LIMITS.rackTabs
    const width = spread ? `${Math.min(...ws)} to ${Math.max(...ws)} px` : `${ws[0]} px`
    v.rack = {
      pass: Math.abs(ws[0] - LIMITS.rack) <= 1 && spread <= 1 && m.rack.tabs >= lo && m.rack.tabs <= hi && m.rack.controls <= LIMITS.rackControls,
      value: `${width}, ${m.rack.tabs} tabs, ${m.rack.controls} controls`,
    }
  }
  v.hscroll = { pass: m.hscroll <= 0, value: `${m.hscroll} px` }
  v.overlap = { pass: m.overlaps.length === 0, value: m.overlaps.length }
  v.words = { pass: m.words.length === 0, value: m.words.length ? [...new Set(m.words.map((w) => w.word))].join(' ') : 0 }
  return v
}

// Shared in page helpers, inlined into each page script.
function helpers() {
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
  const modals = () => [...document.querySelectorAll('dialog[open],[aria-modal="true"],[role=dialog],[role=alertdialog],[class*="modal"],[class*="welcome"]')]
    .filter((el) => shown(el) && inView(rectOf(el)) && (el.matches('dialog,[aria-modal="true"],[role=dialog],[role=alertdialog]') || ['fixed', 'absolute'].includes(getComputedStyle(el).position)))
    .filter((el, i, all) => !all.some((o) => o !== el && o.contains(el)))
  return { W, H, view, rectOf, label, folded, shown, inView, modals }
}

/** Finds the entry modal; with close true, presses its close button. */
function modalProbe(close) {
  const { label, modals, shown } = helpers()
  const m = modals()[0]
  if (!m) return null
  if (close) {
    const btn = [...m.querySelectorAll('button,[role=button]')].filter(shown).find((b) => /^(x|\u00d7|close|dismiss|skip|not now)$/i.test(label(b)) || /close|dismiss/i.test(b.getAttribute('aria-label') || ''))
    btn?.click()
  }
  return label(m.querySelector('h1,h2,h3,[class*="title"]') ?? m)
}

/** Measures the screen. Clicks each rack tab last and clicks the first again. */
async function probe(layout) {
  const { W, H, view, rectOf, label, shown, inView } = helpers()
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
  const SEL = 'button,input:not([type=hidden]),select,textarea,[role=button],[role=tab]'
  const controlsIn = (el) => [...el.querySelectorAll(SEL)].filter(shown).length
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

  // subject: marker, else the candidate with the most unoccluded area. A
  // subject holding more than 3 controls is a panel, not a subject, marker or not.
  // Unoccluded: an N by N grid of hit tests over the clipped rect; a verb row
  // or an inset (data-ux="inset", like an eye view card) on it counts as subject, and an ancestor hit (a pointer-events: none
  // canvas) means nothing covers it.
  const seenShare = (el, N) => {
    const r = rectOf(el)
    const c = { left: Math.max(r.left, 0), top: Math.max(r.top, 0), right: Math.min(r.right, W), bottom: Math.min(r.bottom, H) }
    if (c.right <= c.left || c.bottom <= c.top) return 0
    let seen = 0
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const hit = document.elementFromPoint(c.left + ((i + 0.5) * (c.right - c.left)) / N, c.top + ((j + 0.5) * (c.bottom - c.top)) / N)
        if (hit && (el.contains(hit) || hit.contains(el) || hit.closest('[data-ux~="verbs"],[data-ux~="inset"]'))) seen++
      }
    }
    return seen / (N * N)
  }
  const outside = (el) => !(rack && (rack.contains(el) || el.contains(rack))) && !(bar && (bar.contains(el) || el.contains(bar)))
  let subject = marked('subject')[0]
  detectors.subject = subject ? 'marker' : 'heuristic'
  if (subject && controlsIn(subject) > 3) { subject = null; detectors.subject = 'marker rejected, heuristic' }
  if (!subject) {
    const sel = layout === 'home'
      ? '[class*="yard"]'
      : 'canvas,video,img,iframe,[role=main] > *,main > *,[class*="stage"],[class*="drop"],[class*="frame"],[class*="viewport"]'
    const cands = [...document.querySelectorAll(sel)].filter(shown).filter(outside).filter((el) => controlsIn(el) <= 3)
      .map((el) => [el, overlapArea(rectOf(el), view) * seenShare(el, 8)])
      .filter(([, a]) => a > 0)
    // a wrapper yields to a candidate inside it that holds a quarter of its area or more
    subject = cands.filter(([el, a]) => !cands.some(([o, b]) => o !== el && el.contains(o) && b >= a * 0.25))
      .sort((a, b) => b[1] - a[1]).map((x) => x[0])[0]
    // nothing in first view: the largest candidate below the fold, for its top
    subject ??= [...document.querySelectorAll(sel)].filter(shown).filter(outside).filter((el) => controlsIn(el) <= 3)
      .sort((a, b) => rectOf(b).width * rectOf(b).height - rectOf(a).width * rectOf(a).height)[0]
  }
  let subjectOut = null
  if (subject) {
    const r = rectOf(subject)
    const seen = seenShare(subject, 24)
    subjectOut = { ...r, tag: subject.tagName.toLowerCase(), cls: String(subject.className?.baseVal ?? subject.className).slice(0, 60), share: (overlapArea(r, view) * seen) / (W * H), unoccluded: seen }
  }

  // controls in first view (the first H px, so 844 on a phone)
  const ctl = [...new Set(document.querySelectorAll(SEL))].filter(shown)
    .filter((el) => { const r = rectOf(el); return inView(r) && r.top < H && reachable(el) })
  const off = (el) => el.disabled || el.getAttribute('aria-disabled') === 'true' || !!el.closest('fieldset[disabled]')
  const controls = ctl.filter((el) => !off(el) && !(rack && rack.contains(el))).map(label)
  const disabled = ctl.filter(off).map(label)

  // the one pink action: a button at rest whose background is the resolved
  // --hb-pink (or --pink in an original). Selected tabs, pressed toggles,
  // active tools and chips are state, not a call to act.
  const root = getComputedStyle(document.documentElement)
  const pinkName = root.getPropertyValue('--hb-pink').trim() ? '--hb-pink' : root.getPropertyValue('--pink').trim() ? '--pink' : ''
  const tmp = document.createElement('i')
  tmp.style.color = `var(${pinkName || '--hb-pink'})`
  document.body.append(tmp)
  const pinkRgb = getComputedStyle(tmp).color
  tmp.remove()
  const isState = (el) => el.matches('[role=tab],[aria-pressed="true"],[aria-selected="true"],[aria-checked="true"],[aria-current]:not([aria-current="false"]),.is-active,.active,.on,.selected,[class*="chip"]')
  const pink = pinkName ? ctl.filter((el) => el.matches('button,[role=button]') && !isState(el) && getComputedStyle(el).backgroundColor === pinkRgb).map(label) : []

  const hscroll = document.documentElement.scrollWidth - document.documentElement.clientWidth

  // header items that cross each other (ancestor pairs excepted), and items
  // an element from outside the bar is drawn over (a popover on the logo)
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
    for (const el of items) {
      const hit = hitAt(rectOf(el))
      if (hit && !bar.contains(hit) && !hit.contains(el) && !isLayer(hit)) overlaps.push(`${label(el)} under ${label(hit)}`)
    }
  }

  // internal words in first view text; allowed only in closed details
  // (folded) and an explicit data-ux="detail" pane
  const words = []
  const skip = (el) => el.closest('script,style,noscript,template,[data-ux~="detail"]')
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

  // rack width across its tabs, its tab count and its first view controls
  let rackOut = null
  if (rack) {
    const rackControls = ctl.filter((el) => !off(el) && rack.contains(el)).length
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
    rackOut = { ...rectOf(rack), widths, tabs: tabs.length, controls: rackControls }
  }

  return {
    viewport: { width: W, height: H },
    detectors,
    bar: bar ? rectOf(bar) : null,
    bars,
    subject: subjectOut,
    rack: rackOut,
    controls, disabled, pinkVar: pinkName, pink, hscroll, overlaps, words,
  }
}

const inline = `${bannedWords.toString()}
  ${overlapArea.toString()}
  ${intersects.toString()}
  ${helpers.toString()}`

/** The probe as one expression for page.evaluate, with its helpers inlined. */
export const pageScript = (layout) => `(async () => {
  ${inline}
  return (${probe.toString()})(${JSON.stringify(layout)})
})()`

/** Finds the entry modal (and with close, presses its close button); returns its title or null. */
export const modalScript = (close) => `(() => {
  ${inline}
  return (${modalProbe.toString()})(${close})
})()`
