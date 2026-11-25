// smoke-agents: the senses and drives tools from the single file build on
// file://, as a phone (touch, coarse pointer).
//   senses: a tap on a thing chip and a tap on the floor in front of the
//   agent puts the ball in view, listed with a bearing and a distance; a
//   tap behind the agent moves it out of view and into "seen earlier".
//   drives: with the transport paused, a restart and 1500 steps twice give
//   the same trace hash; the needs change over the run; an injected event
//   lands; the run exports as csv and as a trace whose hash matches.
//   cameras: each rig chip switches the rig and moves the camera; a drag
//   on the stage turns the orbit; split draws two viewports and says why
//   it cannot with no second target; a shake kicks and decays to rest.
//   mover: on a cleared world a wall placed by tap stands between the body
//   and a tapped goal; the body walks round it to the goal with no step
//   inside the wall; a goal tapped on the wall says so; the world is saved,
//   and after a reload the wall is back where it stood.
//   scenario: the built in mover scenario runs to a pass; paused, the step
//   button lets one chunk through; a golden kept and a new seed give a
//   failing verdict and differing rows; a dropped scenario json runs and
//   passes; the report exports.
// Any request off file:// or console error fails the run.
//   npm run build:single && node tools/smoke-agents.mjs senses|drives|cameras|mover
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const mode = process.argv[2]
if (!['senses', 'drives', 'cameras', 'mover', 'scenario'].includes(mode)) throw new Error('usage: smoke-agents.mjs senses|drives|cameras|mover|scenario')
const name = `smoke-${mode}`
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const url = `${pathToFileURL(file).href}#/agents/${mode}`

const profile = mkdtempSync(join(tmpdir(), `suite-${mode}-`))
const downloads = join(profile, 'downloads')
mkdirSync(downloads)
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, userDataDir: profile,
  args: ['--no-first-run', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const errors = []
const off = []
const fail = (why) => { throw new Error(errors.length ? `${why}\nconsole errors:\n${errors.join('\n')}` : why) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const NODE_HASH = '50663d28'

try {
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) off.push(r.url()) })
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  const cdp = await page.createCDPSession()
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }, { name: 'any-pointer', value: 'coarse' }] })
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction((h) => document.querySelector('.hb-viewport-host')?.[h], { timeout: 20000 }, mode)
    .catch(async () => fail(`the tool did not start: ${await page.evaluate(() => document.querySelector('.hb-viewport')?.textContent ?? 'no stage')}`))
  const h = (fn, ...a) => page.evaluate((src, key, ...b) => (0, eval)(src)(document.querySelector('.hb-viewport-host')[key], ...b), fn.toString(), mode, ...a)
  await wait(1200)
  await page.evaluate(() => document.querySelector('.hb-viewport').scrollIntoView({ block: 'start' }))
  const pane = (p) => page.$$eval(`[data-pane="${p}"] .hb-row`, (rows) => rows.map((r) => r.textContent.trim()))
  const until = async (what, test, ms = 6000) => {
    for (let i = 0; i < ms / 100; i++) { if (await test()) return; await wait(100) }
    fail(`${what}: pixels ${JSON.stringify(await h((s) => s.pixels?.()))}; in view ${JSON.stringify(await pane('in-view'))}, seen earlier ${JSON.stringify(await pane('seen-earlier'))}`)
  }

  let detail = ''
  const caption = () => page.$eval('.hb-viewport', (e) => e.textContent)
  // the stage menu (P-ROOM-2): a right click over a thing, then an item by its words
  const menuPick = async (pt, item) => {
    await page.mouse.click(pt.x, pt.y, { button: 'right' })
    await wait(250)
    const got = await page.evaluate((t) => {
      const m = document.querySelector('.hb-ctx:not([hidden])')
      const b = m && [...m.querySelectorAll('button')].find((x) => x.textContent.trim() === t)
      b?.click()
      return m ? { title: m.querySelector('.hb-ctx-title')?.textContent ?? '', items: [...m.querySelectorAll('button')].map((x) => x.textContent.trim()) } : null
    }, item)
    if (!got || !got.items.includes(item)) fail(`the stage menu did not open with ${item}: ${JSON.stringify(got)}`)
    await wait(250)
    return got
  }
  const chip = (sel, text) => page.evaluate((s, t) => [...document.querySelectorAll(`${s} button`)].find((b) => b.textContent.trim().replace(/\d$/, '') === t)?.click(), sel, text)
  if (mode === 'scenario') {
    const res = () => h((s) => { const r = s.result(); return r ? { pass: r.pass, hash: r.hash, diff: r.diff, text: r.text, name: s.live && s.body.picked } : null })
    const done = async (what, ms = 20000) => {
      for (let i = 0; i < ms / 100; i++) { const r = await res(); if (r) return r; await wait(100) }
      fail(`${what}: no result; state ${await h((s) => s.live.state)} at step ${await h((s) => s.live.step)}; caption ${await caption()}`)
    }
    const a = await done('the built in scenario did not finish')
    const tag = await page.$eval('[data-pane="verdict"]', (e) => e.textContent)
    if (!a.pass || !/pass: 3 of 3 checks/.test(tag)) fail(`the built in scenario did not pass: ${tag}\n${a.text}`)
    // paused, a restart holds at step 0 and the step button lets one chunk through
    await page.click('.hb-transport button[aria-label="pause"]')
    await page.evaluate(() => [...document.querySelectorAll('button[aria-keyshortcuts="r"]')].find((b) => b.textContent.trim() === 'restart')?.click())
    await wait(500)
    const held = await h((s) => s.live.step)
    await page.click('.hb-transport button[aria-label="step on"]')
    await wait(400)
    const stepped = await h((s) => s.live.step)
    if (held !== 0 || stepped !== 30) fail(`paused, the run went to step ${held}, then ${stepped} after a step`)
    await page.click('.hb-transport button[aria-label="play"]')
    const again = await done('the replay did not finish')
    if (again.hash !== a.hash) fail(`the same seed gave two hashes: ${a.hash} and ${again.hash}`)
    await page.click('[data-golden]')
    await wait(200)
    await h((s) => { s.seed.value = 8 })
    await wait(300)
    const b = await done('the run at seed 8 did not finish')
    const rows = await page.$$eval('[data-diff-rows] tbody tr', (r) => r.length)
    const said = await page.$eval('[data-diff]', (e) => e.textContent)
    if (b.pass || !/^trace differs at row \d+: /.test(b.diff) || rows < 1 || !/rows differ from golden, seed 7/.test(said)) fail(`seed 8 against the golden: pass ${b.pass}, ${b.diff}, ${rows} rows shown, "${said}"`)
    // drop a scenario json on the window
    const dropped = { name: 'dropped walk', sim: 'mover', seed: 3, seconds: 6, actions: [{ at: 0, js: 'h.goal(1.5, 1.5)' }], probes: [{ every: 0.5, js: 'h.gap()' }], checks: [{ what: 'gap at the end', js: 't.probes[t.probes.length - 1][1]', unit: 'm', legal: { max: 0.5 }, constraint: 'set by the arrival radius, inferred' }] }
    await page.evaluate((text) => {
      const dt = new DataTransfer()
      dt.items.add(new File([text], 'walk.json', { type: 'application/json' }))
      for (const type of ['dragenter', 'dragover', 'drop']) window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
    }, JSON.stringify(dropped))
    await wait(400)
    if ((await h((s) => s.body.picked)) !== 'dropped walk') fail(`the dropped scenario was not picked: ${await caption()}`)
    const c = await done('the dropped scenario did not finish')
    if (!c.pass) fail(`the dropped scenario did not pass: ${c.text}`)
    const report = readFileSync(await exportAs(page, 'report', '.txt'), 'utf8')
    if (!report.startsWith('scenario report ') || !report.includes('dropped walk (seed 3): checks pass')) fail(`the report is not whole: ${report.slice(0, 200)}`)
    detail = `mover round a wall passed 3 of 3 at seed 7, hash ${a.hash} twice; paused it held at 0 and stepped to ${stepped}; seed 8 "${b.diff}", ${rows} rows shown; the dropped scenario passed; report ${report.trim().split('\n').length} lines`
  } else if (mode === 'cameras') {
    const pos = () => h((c) => ({ ...c.live, ...c.rig() }))
    const seen = []
    for (const r of ['follow', 'orbit', 'first person', 'group']) {
      await chip('[data-rigs]', r)
      await wait(700)
      const p = await pos()
      if (p.rig !== r || p.drawn !== 1) fail(`the ${r} chip gave rig ${p.rig}, ${p.drawn} viewports`)
      if (seen.some((q) => Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) < 0.3)) fail(`the ${r} camera stands where another rig put it: ${JSON.stringify(p)} after ${JSON.stringify(seen)}`)
      seen.push(p)
    }
    if (!(seen[2].y > 1 && seen[2].y < 2)) fail(`first person is not at eye height: ${seen[2].y}`)
    // touch orbit: a drag across the stage turns it
    await chip('[data-rigs]', 'orbit')
    await wait(300)
    const y0 = await h((c) => c.rig().yaw)
    const box = await page.$eval('.hb-viewport-host', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width * 0.3, y: r.y + r.height * 0.3, w: r.width } })
    await page.touchscreen.touchStart(box.x, box.y)
    for (let i = 1; i <= 6; i++) { await page.touchscreen.touchMove(box.x + i * 15, box.y); await wait(16) }
    await page.touchscreen.touchEnd()
    const y1 = await h((c) => c.rig().yaw)
    if (!(Math.abs(y1 - y0) > 0.2)) fail(`a drag did not turn the orbit: yaw ${y0} then ${y1}`)
    // split with two targets, then without
    await page.click('[data-split]')
    await wait(500)
    const sp = await pos()
    if (!sp.split || sp.drawn !== 2) fail(`split drew ${sp.drawn} viewports`)
    await page.click('[data-second]')
    await wait(400)
    await page.click('[data-split]')
    await wait(400)
    const one = await pos()
    if (one.split || one.drawn !== 1 || !(await caption()).includes('no second target. split view needs two.')) fail(`split with one target: ${one.drawn} viewports, caption ${await caption()}`)
    await page.click('[data-second]')
    // shake: a kick, then the amplitude decays to rest
    await page.click('[data-shake]')
    await wait(60)
    const a0 = await h((c) => c.rig().amp)
    let a1 = a0
    for (let i = 0; i < 40 && a1 > 0; i++) { await wait(100); a1 = await h((c) => c.rig().amp) }
    if (!(a0 > 0.05) || a1 !== 0) fail(`the shake did not kick and decay: ${a0} then ${a1}`)
    detail = `four rigs at four camera spots, first person at ${seen[2].y.toFixed(2)} m; a drag turned the orbit by ${(y1 - y0).toFixed(2)} rad; split drew 2 viewports, 1 with no second target; shake ${a0.toFixed(3)} m decayed to 0`
  } else if (mode === 'mover') {
    const st = () => h((m) => m.state())
    const tap = async (x, z) => {
      const p = await h((m, a, b) => m.screenOf(a, b), x, z)
      const ok = await page.evaluate((a, b) => !!document.elementFromPoint(a, b)?.closest('.hb-viewport-host'), p.x, p.y)
      if (!ok) fail(`the floor at ${x}, ${z} is not on the stage at ${p.x}, ${p.y}: ${await page.evaluate((a, b) => { const e = document.elementFromPoint(a, b); return (e?.className ?? 'none') + ' ' + JSON.stringify(document.querySelector('.hb-viewport-host').getBoundingClientRect()) }, p.x, p.y)}`)
      await page.touchscreen.tap(p.x, p.y)
      await wait(200)
    }
    await page.evaluate(() => [...document.querySelectorAll('[data-pane="world"] button')].find((b) => b.textContent.trim() === 'clear')?.click())
    // the view eases out to the whole room first; a touch anywhere shows the pad on a phone
    const tb = await page.$eval('[data-place]', (e) => { const r = e.getBoundingClientRect(); return { x: r.right - 4, y: r.top + 4 } })
    await page.touchscreen.tap(tb.x, tb.y)
    await wait(2500)
    // a direction where the wall and the goal both show on open stage, clear of the pad and the overlays
    const onStage = async (x, z) => {
      const p = await h((m, a, b) => m.screenOf(a, b), x, z)
      return page.evaluate((a, b) => !!document.elementFromPoint(a, b)?.closest('.hb-viewport-host'), p.x, p.y)
    }
    let dir = null
    for (const [dx, dz] of [[0, -1], [0, 1], [1, 0], [-1, 0]]) {
      const pts = [[0, 1.4], [0.1, 2.6], [0.5, 1.4], [-0.5, 1.4]].map(([l, d]) => [dx * d + dz * l, dz * d + dx * l])
      if ((await Promise.all(pts.map(([x, z]) => onStage(x, z)))).every(Boolean)) { dir = [dx, dz]; break }
    }
    if (!dir) fail(`no direction from the body shows both the wall and the goal on the stage: camera ${await h((m) => m.camera())}, ${JSON.stringify(await h((m) => [m.screenOf(0, 2.6), m.screenOf(0, -2.6), m.screenOf(2.6, 0), m.screenOf(-2.6, 0)]))}`)
    const [dx, dz] = dir
    const at = (l, d) => [dx * d + dz * l, dz * d + dx * l]
    if (dx) await page.click('[data-along]')
    await chip('[data-place]', 'wall')
    await tap(...at(0, 1.4))
    const items = await h((m) => JSON.parse(JSON.stringify(m.world.items)))
    const wall = items.find((t) => t.kind === 'wall')
    const want = at(0, 1.4)
    if (items.length !== 1 || !wall || Math.abs(wall.x - want[0]) > 0.25 || Math.abs(wall.z - want[1]) > 0.25) fail(`the tap did not place a wall at ${want}: ${JSON.stringify(items)}`)
    const ew = wall.turn ? wall.d : wall.w
    const ed = wall.turn ? wall.w : wall.d
    await chip('[data-place]', 'goal')
    await tap(wall.x, wall.z)
    if (!(await caption()).includes('the goal is inside a wall. click open floor.')) fail(`a goal on the wall did not say so: ${await caption()}`)
    const goal = at(0.1, 2.6)
    await tap(...goal)
    const s0 = await st()
    if (s0.waypoint === 'none') fail(`the goal was not taken: ${await caption()}`)
    for (let i = 0; i < 200; i++) { if ((await h((m) => m.live.arrived)) > 0) break; await wait(100) }
    const end = await st()
    if (Math.hypot(end.x - goal[0], end.z - goal[1]) > 0.5) fail(`the body did not reach the goal: it stands at ${end.x}, ${end.z}; ${end.mode}, ${end.why}`)
    const trace = await h((m) => m.trace())
    const inWall = trace.filter(([x, z]) => Math.abs(x - wall.x) < ew / 2 + 0.2 && Math.abs(z - wall.z) < ed / 2 + 0.2)
    if (inWall.length) fail(`${inWall.length} steps went through the wall, first ${inWall[0]}`)
    await page.click('[data-save]')
    await wait(400)
    if (!(await caption()).includes('world saved: 1 thing.')) fail(`save did not say so: ${await caption()}`)
    await page.reload({ waitUntil: 'load' })
    await page.waitForFunction(() => document.querySelector('.hb-viewport-host')?.mover, { timeout: 20000 })
    await wait(600)
    const back = await h((m) => JSON.parse(JSON.stringify(m.world.items)))
    if (back.length !== 1 || back[0].label !== wall.label || back[0].x !== wall.x || back[0].z !== wall.z) fail(`the reload did not bring the world back: ${JSON.stringify(back)}`)
    await page.evaluate(() => document.querySelector('.hb-viewport').scrollIntoView({ block: 'start' }))
    await wait(2500)
    const wp = await h((m, a, b) => m.screenOf(a, b), back[0].x, back[0].z)
    await menuPick(wp, 'turn it')
    const turned = await h((m) => m.world.items[0].turn)
    if (turned === back[0].turn) fail('"turn it" from the stage menu did not turn the wall')
    detail = `the body walked round ${wall.label} to the goal in ${trace.length} steps, none inside the wall; ends ${Math.hypot(end.x - goal[0], end.z - goal[1]).toFixed(2)} m from the goal; the world came back after a reload; the stage menu turned the wall`
  } else if (mode === 'senses') {
    // the top view puts the floor in front of and behind the agent on screen
    await page.evaluate(() => [...document.querySelectorAll('.hb-cams button')].find((b) => b.textContent.trim().startsWith('top'))?.click())
    await wait(300)
    await wait(300)
    // pick the ball by its chip, then tap open floor
    await page.evaluate(() => [...document.querySelectorAll('[data-place] button')].find((b) => b.textContent.trim() === 'ball')?.click())
    const things = await h((s) => JSON.parse(JSON.stringify(s.opts.things)))
    const open = (cands) => cands.find(([x, z]) => things.every((t) => t.label === 'ball' || (t.x - x) ** 2 + (t.z - z) ** 2 > 0.6))
    const tapFloor = async ([x, z]) => {
      const p = await h((s, a, b) => s.screenOf(a, b), x, z)
      await page.touchscreen.tap(p.x, p.y)
      await wait(150)
      const b = await h((s) => JSON.parse(JSON.stringify(s.opts.things.find((t) => t.label === 'ball'))))
      if (!(Math.hypot(b.x - x, b.z - z) < 0.25)) fail(`the tap at ${p.x}, ${p.y} (over ${await page.evaluate((a, b) => { const e = document.elementFromPoint(a, b); return e ? e.className + ' ' + e.tagName : 'none' }, p.x, p.y)}) did not move the ball to ${x}, ${z}: it stands at ${b.x}, ${b.z}; picked ${await h((s) => s.picked.value)}; caption ${await page.$eval('.hb-viewport', (e) => e.textContent.slice(0, 300))}`)
    }
    // since the compact inset (ui 0.9.5) the inset covers the stage's top left at 390: fold it to its header
    await page.evaluate(() => { const t = document.querySelector('.hb-inset-toggle'); if (t && t.getAttribute('aria-expanded') !== 'false') t.click() })
    await wait(300)
    // turn the agent to face screen right with the pad, so its front and back are clear of the overlays
    const pad = await page.$eval('.hb-pad-base', (e) => { const x = e.getBoundingClientRect(); return { x: x.x + x.width / 2, y: x.y + x.height / 2, w: x.width } })
    await page.touchscreen.touchStart(pad.x, pad.y)
    for (let i = 1; i <= 4; i++) { await page.touchscreen.touchMove(pad.x + pad.w * 0.1 * i, pad.y); await wait(16) }
    await wait(250)
    await page.touchscreen.touchEnd()
    await wait(300)
    const a = await h((s) => s.agent())
    const fx = Math.sin(a.yaw)
    const fz = Math.cos(a.yaw)
    const spots = (ds) => ds.flatMap((d) => [0, 0.25, -0.25, 0.5, -0.5].map((l) => [a.x + fx * d - fz * l, a.z + fz * d + fx * l]))
    // open floor that shows on the stage, clear of the overlay frame
    const shown = async (cands) => {
      for (const c of cands) {
        if (!open([c])) continue
        const p = await h((s, x, z) => s.screenOf(x, z), c[0], c[1])
        if (await page.evaluate((x, y) => !!document.elementFromPoint(x, y)?.closest('.hb-viewport-host'), p.x, p.y)) return c
      }
      return null
    }
    const front = await shown(spots([1.1, 1.25, 1, 1.4]))
    const back = await shown(spots([-1.1, -1.25, -0.9, -1.4]))
    if (!front || !back) fail(`no open floor in front of or behind the agent: ${JSON.stringify(things)}`)
    await tapFloor(front)
    const line = /^ball \((ahead|\d+ deg (left|right)), \d+\.\d m\)$/
    await until('the ball did not come into view with a bearing', async () => (await pane('in-view')).some((l) => line.test(l)))
    const seen = (await pane('in-view')).find((l) => line.test(l))
    await tapFloor(back)
    await until('the ball out of view did not move to seen earlier', async () => {
      const v = await pane('in-view')
      const e = await pane('seen-earlier')
      return !v.some((l) => l.startsWith('ball (')) && e.some((l) => /^ball \(last seen .+, \d+ s ago, confidence \d\.\d\d\)$/.test(l))
    })
    const earlier = (await pane('seen-earlier')).find((l) => l.startsWith('ball ('))
    const feed = await h((s) => s.live.feed.map((e) => e.kind))
    if (!feed.includes('see') || !feed.includes('lost')) fail(`the sense feed has no see and lost tags: ${feed.join(',')}`)
    const csv = readFileSync(await exportAs(page, 'sense feed', '.csv'), 'utf8').trim().split('\n')
    if (csv[0] !== 't,kind,text' || csv.length < 3) fail(`the feed csv is not whole: ${csv.slice(0, 2)}`)
    const bp = await h((s) => { const b = s.opts.things.find((t) => t.label === 'ball'); return s.screenOf(b.x, b.z) })
    const menu = await menuPick(bp, 'where is it?')
    const said = await h((s) => s.live.feed.filter((e) => e.kind === 'say').map((e) => e.text))
    if (menu.title !== 'ball' || !said.some((l) => l.startsWith('"where is the ball":'))) fail(`the menu sentence did not reach the feed: ${JSON.stringify(menu)} ${JSON.stringify(said)}`)
    detail = `in view "${seen}", then seen earlier "${earlier}"; feed ${feed.length} events, csv ${csv.length - 1} rows; the menu said ${said[0]}`
  } else {
    await page.click('.hb-transport button[aria-label="pause"]')
    await wait(200)
    const run = async () => {
      await page.evaluate(() => [...document.querySelectorAll('button[aria-keyshortcuts="r"]')].find((b) => b.textContent.trim() === 'restart')?.click())
      await wait(400)
      const before = await h((d) => ({ ...d.live.needs, step: d.step() }))
      const hash = await h((d) => d.steps(1500))
      const after = await h((d) => ({ ...d.live.needs }))
      return { before, after, hash }
    }
    const a = await run()
    const b = await run()
    if (a.before.step !== 0) fail(`the restart did not reset the run: step ${a.before.step}`)
    if (!a.hash || a.hash !== b.hash) fail(`the same seed gave two hashes: ${a.hash} and ${b.hash}`)
    // node gives the same for seed 7 and 1500 steps (tools/test/senses-drives.test.mjs)
    if (a.hash !== NODE_HASH) fail(`chrome gave ${a.hash}, node gives ${NODE_HASH}`)
    const moved = ['hunger', 'rest', 'play', 'social'].filter((k) => Math.abs(a.after[k] - a.before[k]) > 0.01)
    if (moved.length < 2) fail(`the drive bars did not change: ${JSON.stringify(a)}`)
    const shown = await page.$eval('[data-hash]', (e) => e.textContent)
    if (!shown.includes(a.hash)) fail(`the hash on the page ${shown} is not ${a.hash}`)
    // inject an event through the input
    await page.type('[data-pane="inject"] input', 'a friend knocks at the door')
    await page.evaluate(() => document.querySelector('[data-inject]').click())
    await wait(100)
    const note = await page.$eval('[data-note]', (e) => e.textContent)
    if (!/^a visitor lands at step \d+\.$/.test(note)) fail(`the event did not land: ${note}`)
    const c = await h((d) => d.steps(200))
    const csv = readFileSync(await exportAs(page, 'run', '.csv'), 'utf8').trim().split('\n')
    if (csv[0] !== 't,hour,hunger,rest,play,social,act,reason,probability,switched,sleep,pressure,why' || csv.length < 1700) fail(`the run csv is not whole: ${csv.length} rows, ${csv[0]}`)
    const trace = JSON.parse(readFileSync(await exportAs(page, 'trace', '.trace.json'), 'utf8'))
    if (trace.hash !== c || trace.events.length !== 1 || trace.rows.length !== 1700) fail(`the trace is not whole: hash ${trace.hash} for ${c}, ${trace.events?.length} events, ${trace.rows?.length} rows`)
    detail = `two runs of 1500 steps from seed 7 gave hash ${a.hash} both times, the same as node; ${moved.join(', ')} moved; "${note}"; csv ${csv.length - 1} rows, trace hash ${trace.hash}`
  }
  await page.close()
  if (errors.length) fail('console errors')
  if (off.length) fail(`requests off file://: ${off.slice(0, 5).join(', ')}`)
  console.log(`${name}: ok. ${detail}; 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}

async function exportAs(page, label, ext) {
  await page.evaluate((l) => [...document.querySelectorAll('.hb-export-formats button')].find((b) => b.textContent.trim() === l)?.click(), label)
  await wait(100)
  const clicked = await page.evaluate((e) => {
    const b = [...document.querySelectorAll('.hb-export button')].find((x) => x.textContent.trim().startsWith('export') && x.textContent.trim().endsWith(e) && !x.disabled)
    b?.click(); return !!b
  }, ext)
  if (!clicked) fail(`no export ${ext} button`)
  for (let i = 0; i < 50; i++) {
    const f = readdirSync(downloads).find((n) => n.endsWith(ext) && !n.endsWith('.crdownload'))
    // the file moves out of the folder, so the next export of the same extension is found
    if (f) { const keep = join(profile, `got-${Date.now()}${ext}`); renameSync(join(downloads, f), keep); return keep }
    await wait(100)
  }
  fail(`no ${ext} download`)
}

