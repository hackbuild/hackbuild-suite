// smoke-chat: the chat tool (design 3.1) from the single file build on
// file://, with ?stub so the reply comes from the stub runtime and nothing
// downloads. "/" focuses the composer; a message is sent and its think text
// lands in the fold, apart from the answer; redo asks again; a turn is
// deleted; the chat document is exported and imported back as a second
// document with the same turns; on a touch pointer Enter adds a line and
// does not send. Any request off file:// or console error fails the run.
//   npm run build:single && node tools/smoke-chat.mjs
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const file = resolve('dist/single/index.html')
if (!existsSync(file)) throw new Error('no single build: run npm run build:single first')
const url = `${pathToFileURL(file).href}?stub#/chat`
const profile = mkdtempSync(join(tmpdir(), 'suite-chat-'))
const downloads = join(profile, 'downloads')
mkdirSync(downloads)
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args: ['--no-first-run'] })
const errors = []
const off = []
const watch = (page) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) off.push(r.url()) })
}
const fail = (why) => { throw new Error(why) }
try {
  const page = await browser.newPage()
  watch(page)
  const cdp = await page.createCDPSession()
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
  await page.setViewport({ width: 1024, height: 800 })
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForSelector('.hb-chat .hb-composer textarea', { timeout: 5000 }).catch(() => fail('the chat route shows no composer'))
  await page.waitForFunction(() => document.body.textContent.includes('answer from a script'), { timeout: 5000 }).catch(() => fail('the empty state does not say the script answers'))

  const turns = () => page.$$eval('.hb-chat-log .hb-msg', (ms) => ms.map((m) => ({ user: m.classList.contains('is-user'), text: [...m.querySelectorAll('.hb-msg-text')].map((t) => t.textContent).join('\n'), think: m.querySelector('.hb-think')?.textContent ?? '', acts: [...m.querySelectorAll('.hb-msg-act')].map((b) => b.textContent.trim()) })))
  const settled = (n) => page.waitForFunction((k) => {
    const ms = document.querySelectorAll('.hb-chat-log .hb-msg')
    return ms.length === k && !document.querySelector('.hb-msg.is-streaming') && [...ms].every((m) => m.classList.contains('is-user') || m.querySelector('.hb-msg-acts'))
  }, { timeout: 8000 }, n)
  const act = (i, word) => page.evaluate((k, w) => {
    const m = document.querySelectorAll('.hb-chat-log .hb-msg')[k]
    const b = m && [...m.querySelectorAll('.hb-msg-act')].find((x) => x.textContent.trim() === w)
    b?.click(); return !!b
  }, i, word)

  // "/" from the page focuses the composer
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('/')
  const focused = await page.evaluate(() => document.activeElement?.matches('.hb-composer textarea'))
  if (!focused) fail('"/" did not focus the composer')
  await page.keyboard.type('hello from the smoke')
  await page.keyboard.press('Enter')
  await settled(2).catch(async () => fail('enter did not send, or the reply did not finish: ' + JSON.stringify(await turns())))
  let t = await turns()
  if (!t[1].text.includes('this answer comes from a script')) fail(`the reply text is wrong: ${t[1].text}`)
  if (/<\/?think>|the person wrote/.test(t[1].text)) fail('think text leaked into the answer')
  if (!/reasoning|thinking/.test(t[1].think)) fail('the reply has no think fold')
  for (const w of ['speak', 'redo', 'copy', 'delete']) if (!t[1].acts.includes(w)) fail(`the reply has no ${w} action`)
  if (!t[0].acts.includes('edit')) fail('your turn has no edit action')
  if (!(await act(1, 'remember'))) fail('the reply has no remember action')
  await page.waitForFunction(() => document.querySelectorAll('.hb-chat-log .hb-msg')[1]?.textContent.includes('in memory'), { timeout: 5000 }).catch(() => fail('remember did not mark the reply in memory'))
  const stats = await page.$eval('.hb-chat-log .hb-msg:nth-child(2) .hb-msg-stats', (e) => e.textContent).catch(() => '')
  if (!/tok/.test(stats)) fail(`the reply has no stats strip: "${stats}"`)

  // redo: the reply is asked again in place
  if (!(await act(1, 'redo'))) fail('no redo on the last reply')
  await settled(2).catch(() => fail('redo did not answer again'))

  // a second turn, then delete the first user turn (press twice)
  await page.focus('.hb-composer textarea')
  await page.keyboard.type('a second turn')
  await page.keyboard.press('Enter')
  await settled(4).catch(() => fail('the second turn did not finish'))
  await act(0, 'delete')
  await act(0, 'delete?')
  await settled(3).catch(() => fail('delete did not remove the turn'))
  // undo and redo go through the chat document
  await new Promise((r) => setTimeout(r, 400))
  await page.evaluate(() => document.activeElement?.blur())
  // ctrl reads cmd on a mac, as the key map says
  const mod = (await page.evaluate(() => /Mac/.test(navigator.platform))) ? 'Meta' : 'Control'
  const chord = async (shift) => {
    await page.keyboard.down(mod); if (shift) await page.keyboard.down('Shift')
    await page.keyboard.press('z')
    if (shift) await page.keyboard.up('Shift'); await page.keyboard.up(mod)
  }
  await chord(false)
  await settled(4).catch(() => fail('ctrl+z did not bring the deleted turn back'))
  await chord(true)
  await settled(3).catch(async () => fail(`(${(await turns()).length} turns) ` + 'ctrl+shift+z did not delete the turn again'))
  const kept = await turns()

  // export the chat document, then import it back
  const clickText = (sel, w) => page.evaluate((s, x) => {
    const b = [...document.querySelectorAll(s)].find((e) => e.textContent.trim() === x && !e.disabled)
    b?.click(); return !!b
  }, sel, w)
  await new Promise((r) => setTimeout(r, 400))
  if (!(await clickText('.hb-chat-hd button', 'export'))) fail('no export in the chat header')
  let saved = null
  for (let i = 0; i < 40 && !saved; i++) {
    saved = readdirSync(downloads).find((n) => n.endsWith('.hbchat.json'))
    if (!saved) await new Promise((r) => setTimeout(r, 100))
  }
  if (!saved) fail('export wrote no .hbchat.json')
  const doc = JSON.parse(readFileSync(join(downloads, saved), 'utf8'))
  if (doc.kind !== 'chat.session' || doc.body?.messages?.length !== 3) fail(`the exported document holds ${doc.body?.messages?.length} messages, want 3`)
  const before = await page.evaluate(() => location.hash)
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 3000 }), clickText('.hb-chat-hd button', 'import')])
  await chooser.accept([join(downloads, saved)])
  await page.waitForFunction((h) => location.hash !== h && location.hash.includes('doc='), { timeout: 5000 }, before).catch(() => fail('the import did not open a new chat document'))
  await settled(3).catch(() => fail('the imported chat does not show 3 turns'))
  const back = await turns()
  if (back.map((x) => x.text).join('|') !== kept.map((x) => x.text).join('|')) fail('the imported turns differ from the exported ones')
  // from 1024 px the list stands beside the chat; below it opens from the header
  const inline = await page.evaluate(() => !!document.querySelector('.hb-toolpage.is-split > .is-side .hb-convs-item, .hb-toolpage.is-split > .is-side.hb-convs'))
  if (!inline) await clickText('.hb-chat-hd button', 'chats')
  const listed = await page.waitForFunction(() => document.querySelectorAll('.hb-convs-item').length >= 2, { timeout: 3000 }).then(() => true, () => false)
  if (!listed) fail('the conversation list does not show both chats')
  await page.keyboard.press('Escape')

  // touch pointer: Enter adds a line, the button sends
  const phone = await browser.newPage()
  watch(phone)
  await phone.emulate({ viewport: { width: 390, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }, userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile' })
  await phone.goto(url, { waitUntil: 'load' })
  await phone.waitForSelector('.hb-composer textarea', { timeout: 5000 })
  const coarse = await phone.evaluate(() => matchMedia('(pointer: coarse)').matches)
  if (!coarse) fail('the touch run does not report a coarse pointer')
  const n0 = await phone.$$eval('.hb-chat-log .hb-msg', (m) => m.length)
  await phone.focus('.hb-composer textarea')
  await phone.keyboard.type('no send')
  await phone.keyboard.press('Enter')
  await new Promise((r) => setTimeout(r, 300))
  const n1 = await phone.$$eval('.hb-chat-log .hb-msg', (m) => m.length)
  const val = await phone.$eval('.hb-composer textarea', (e) => e.value)
  if (n1 !== n0 || !val.includes('\n')) fail('enter sent on a coarse pointer')

  // mic dictation on the stub recognizer: interim words fill the box after what was typed, the final stays to send
  await phone.$eval('.hb-composer textarea', (e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })) })
  await phone.focus('.hb-composer textarea')
  await phone.keyboard.type('note:')
  await phone.$eval('.hb-composer .hb-mic-btn', (b) => b.click())
  const box = () => phone.$eval('.hb-composer textarea', (e) => e.value)
  await phone.waitForFunction(() => /^note: what is( on)?$/.test(document.querySelector('.hb-composer textarea').value), { timeout: 5000 })
    .catch(async () => fail(`no interim words in the composer: "${await box()}"`))
  const partial = await box()
  // the last interim reads like the final; the final is in once the mic is back to listening
  await phone.waitForFunction(() => document.querySelector('.hb-composer textarea').value === 'note: what is on the shelf' && document.querySelector('.hb-composer .hb-mic').classList.contains('is-listening'), { timeout: 6000 })
    .catch(async () => fail(`the final did not land in the composer: "${await box()}"`))
  const n2 = await phone.$$eval('.hb-chat-log .hb-msg', (m) => m.length)
  if (n2 !== n1) fail('dictation sent the message on its own')
  await phone.$eval('.hb-composer .hb-mic-btn', (b) => b.click())
  await new Promise((r) => setTimeout(r, 300))
  if ((await box()) !== 'note: what is on the shelf') fail(`stopping the mic changed the composer: "${await box()}"`)
  if (process.env.SHOTS) {
    await phone.$eval('.hb-composer', (e) => e.scrollIntoView({ block: 'center' }))
    await phone.screenshot({ path: join(process.env.SHOTS, 'chat-dictation-390.png') })
  }

  if (off.length) fail(`requests off file://:\n${off.join('\n')}`)
  if (errors.length) fail(`console errors:\n${errors.join('\n')}`)
  console.log(`smoke-chat: ok. "/" focuses the composer, a stub reply streams with its think text in the fold, redo answers again, delete removes a turn, ctrl+z and ctrl+shift+z undo and redo it, ${saved} exports 3 messages and imports back as a second chat, enter on a touch pointer adds a line, dictation on the stub recognizer showed "${partial}" then the final in the composer and did not send, 0 requests off file:// (measured)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}
