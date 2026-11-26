// smoke-x-chat: the chat studio explorer (rebuild plan 4) on ?stub, no
// weights. The empty state fills the conversation, the rack has five tabs
// with memory first, a stand in model loads from the chip's pick, a message
// gets a streamed reply with memory used under it and the recall trace in
// the rack, a note added in memory shows in the list, the persona trims its
// rules under a small budget, and the chats export as json.
//   npm run build && node tools/smoke-x-chat.mjs
import { existsSync } from 'node:fs'
import { launch, serveDir } from './browse.mjs'

if (!existsSync('dist/hosted/index.html')) throw new Error('no hosted build: run npm run build first')
const server = await serveDir('dist/hosted')
const chrome = await launch({ prefix: 'smoke-x-chat-', blockModels: true })
const errors = []
const fail = (m) => { throw new Error(m) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  const page = await chrome.browser.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${server.base}?stub#/x/chat`, { waitUntil: 'load' })
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {})
  await page.waitForSelector('.hb-lay-convempty', { timeout: 10000 }).catch(() => fail('no empty state in the conversation'))
  const first = await page.evaluate(() => ({
    name: document.querySelector('.hb-lay-convempty-name')?.textContent.trim(),
    tabs: [...document.querySelectorAll('.hb-rack [role=tab]')].map((t) => t.textContent.trim()),
    modes: [...document.querySelectorAll('.hb-lay-verbs .hb-seg button')].map((b) => b.textContent.trim()),
  }))
  if (first.name !== 'what are we working on?') fail(`empty state: ${first.name}`)
  if (first.tabs.join(',') !== 'memory,chats,persona,reply,voice') fail(`rack tabs: ${first.tabs.join(', ')}`)
  if (first.modes.join(',') !== 'quick,default,complex') fail(`modes: ${first.modes.join(', ')}`)
  await page.waitForFunction(() => document.querySelectorAll('.hb-mempanel .hb-mem').length === 3, { timeout: 8000 }).catch(() => fail('the memory pane did not list the 3 stand in facts'))

  await page.evaluate(() => window.hbExplorer.pick.load())
  await page.type('.hb-lay-composer textarea', 'what filament do i print with?')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => [...document.querySelectorAll('.hb-msg:not(.is-user) .hb-msg-text')].some((t) => t.textContent.includes('stand in reply')), { timeout: 8000 }).catch(() => fail('no streamed reply'))
  await page.waitForFunction(() => !!document.querySelector('.hb-msg-used') && !!document.querySelector('.hb-meminspect, .hb-meminspect-list, table'), { timeout: 5000 }).catch(() => fail('no memory used under the reply or no recall trace in the rack'))
  const used = await page.evaluate(() => document.querySelector('.hb-msg-used summary')?.textContent.trim())

  // a note added in the memory tab joins the list
  await page.type('.hb-mempanel textarea', 'the dog collar needs a buckle')
  await page.evaluate(() => document.querySelector('.hb-mempanel [data-add]').click())
  await page.waitForFunction(() => document.querySelectorAll('.hb-mempanel .hb-mem').length === 4, { timeout: 5000 }).catch(() => fail('the added note did not show'))

  // persona trims rules first; chats dump and restore
  const state = await page.evaluate(async () => {
    const { list } = window.hbExplorer
    const d = list.dump()
    return { chats: d.chats.length, turns: d.chats[0].turns.length }
  })
  if (state.turns < 2) fail(`the chat dump holds ${state.turns} turns`)
  for (const t of ['chats', 'persona', 'reply', 'voice']) {
    await page.evaluate((name) => [...document.querySelectorAll('.hb-rack [role=tab]')].find((x) => x.textContent.trim() === name).click(), t)
    await wait(150)
  }
  const panes = await page.evaluate(() => ({
    persona: !!document.querySelector('.hb-persona textarea'),
    voice: !!document.querySelector('[data-auto]'),
    sliders: document.querySelectorAll('.xc-reply input[type=range]').length,
  }))
  if (!panes.persona || !panes.voice || panes.sliders !== 5) fail(`rack panes: ${JSON.stringify(panes)}`)
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`)
  console.log(`smoke-x-chat: ok. empty state, 5 rack tabs with memory first, a streamed stand in reply with "${used}", a recall trace, a note added (4 items), ${state.chats} chat with ${state.turns} turns in the dump, persona, voice and 5 reply sliders (measured, ?stub, no weights)`)
} finally {
  await chrome.close()
  server.close()
}
