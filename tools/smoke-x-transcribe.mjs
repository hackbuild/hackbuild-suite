// smoke-x-transcribe: the transcribe explorer (rebuild plan 4) on ?stub, no
// weights. The drop zone is the page with one pink action and a folder
// button; the sample queues two files that run through a stand in model,
// each channel shows its levels, the transcript edits in place with undo,
// the export menu offers four formats, copy and a zip, the capture tab holds
// the front end, and the engine tab a language and a hub repo check.
//   npm run build && node tools/smoke-x-transcribe.mjs
import { existsSync } from 'node:fs'
import { launch, serveDir } from './browse.mjs'

if (!existsSync('dist/hosted/index.html')) throw new Error('no hosted build: run npm run build first')
const server = await serveDir('dist/hosted')
const chrome = await launch({ prefix: 'smoke-x-transcribe-', blockModels: true })
const errors = []
const fail = (m) => { throw new Error(m) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  const page = await chrome.browser.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${server.base}?stub#/x/transcribe`, { waitUntil: 'load' })
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {})
  await page.waitForSelector('.hb-lay-drop [data-pick]', { timeout: 10000 }).catch(() => fail('no drop zone'))
  const first = await page.evaluate(() => ({
    pink: [...document.querySelectorAll('.hb-btn-go')].filter((b) => b.checkVisibility()).map((b) => b.textContent.trim()),
    folder: !!document.querySelector('.hb-lay-drop [data-folder]'),
    exports: document.querySelectorAll('[data-ex]').length,
  }))
  if (first.pink.join() !== 'choose a file') fail(`pink in the empty state: ${first.pink.join(', ')}`)
  if (!first.folder) fail('no folder button')
  if (first.exports) fail('exports show before there is text')

  await page.evaluate(() => window.hbExplorer.sample())
  await page.waitForFunction(() => document.querySelectorAll('.hb-transcript [data-line]').length === 3, { timeout: 8000 }).catch(() => fail('no transcript lines'))
  const done = await page.evaluate(() => ({
    strips: document.querySelectorAll('.hb-qstrip').length,
    snr: [...document.querySelectorAll('.hb-qstrip-meta')].every((m) => /snr/i.test(m.textContent)),
    exports: [...document.querySelectorAll('.hb-lay-verbs [data-ex], .hb-lay-verbs [data-copy], .hb-lay-verbs [data-zip]')].map((b) => b.textContent.trim()),
    zip: (() => { const z = window.hbExplorer.queue.zip(); return z ? { files: z.manifest.files.length, outputs: z.manifest.files[0].outputs.length } : null })(),
  }))
  if (done.strips !== 2 || !done.snr) fail(`channels: ${JSON.stringify(done)}`)
  if (done.exports.join(',') !== 'save txt,srt,vtt,json,copy,all 2 as zip') fail(`export menu: ${done.exports.join(', ')}`)
  if (!done.zip || done.zip.files !== 2 || done.zip.outputs !== 4) fail(`zip manifest: ${JSON.stringify(done.zip)}`)

  // an edit in place, then undo shows
  await page.evaluate(() => {
    const l = document.querySelector('.hb-transcript [data-line="0"]')
    l.focus()
    l.textContent = 'fixed by hand.'
    l.blur()
  })
  await page.waitForSelector('.hb-lay-verbs [data-undo]', { timeout: 3000 }).catch(() => fail('no undo after an edit'))

  for (const t of ['model', 'sound']) await page.evaluate((name) => [...document.querySelectorAll('.hb-rack [role=tab]')].find((x) => x.textContent.trim() === name).click(), t)
  const rack = await page.evaluate(() => ({
    sliders: document.querySelectorAll('.xt-cap input[type=range]').length,
    checks: document.querySelectorAll('.xt-cap input[type=checkbox]').length,
    selects: document.querySelectorAll('.xt-cap select').length,
    repo: !!document.querySelector('.xt-repo input'),
  }))
  if (rack.sliders !== 4 || rack.checks !== 4 || rack.selects !== 2 || !rack.repo) fail(`rack: ${JSON.stringify(rack)}`)
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`)
  console.log(`smoke-x-transcribe: ok. one pink in the empty state, a folder button, 2 channels with levels, 3 lines edited with undo, exports ${done.exports.join(', ')}, a zip of ${done.zip.files} files with a manifest, capture with 4 sliders, 2 selects and 4 checks, a hub repo check (measured, ?stub, no weights)`)
} finally {
  await chrome.close()
  server.close()
}
