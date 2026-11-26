// browse: the shared headless browser parts of shots, ux-gate and contact-sheet.
// A static server for a built directory, a system Chrome launch with a
// throwaway profile, a model and weight block, and a page opened at a width
// (under 500 px through an iframe, because headless Chrome clamps its window
// at 500 px).
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import puppeteer from 'puppeteer-core'

export const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.wasm': 'application/wasm' }

/** Serves `dir` on 127.0.0.1 at a free port. */
export async function serveDir(dir) {
  const server = createServer(async (req, res) => {
    try {
      let p = join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname))
      if ((await stat(p)).isDirectory()) p = join(p, 'index.html')
      const body = await readFile(p) // read first, so a missing index.html is a 404, not a second writeHead
      res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' })
      res.end(body)
    } catch { res.writeHead(404).end() }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() }
}

// Hosts that serve model weights. They fail at name resolution, so a service
// worker cannot fetch them either.
export const MODEL_HOSTS = ['huggingface.co', '*.huggingface.co', 'hf.co', '*.hf.co', '*.xethub.hf.co', 'modelscope.cn', '*.modelscope.cn', 'tfhub.dev', '*.kaggle.com', 'storage.googleapis.com', 'mlc.ai', '*.mlc.ai', 'raw.githubusercontent.com', 'media.githubusercontent.com', 'objects.githubusercontent.com']
const WEIGHT_FILE = /\.(onnx|ort|bin|gguf|safetensors|tflite|task|pt|pth|ckpt|params|mlmodel)(\?|#|$)/i

/** True when a url looks like a weight file, whatever its host. */
export function isWeightUrl(url) {
  try { return WEIGHT_FILE.test(new URL(url).pathname) } catch { return false }
}

/** Launches system Chrome headless with a fresh profile. `close` removes the profile. */
export async function launch({ prefix = 'hb-browse-', blockModels = false } = {}) {
  const profile = mkdtempSync(join(tmpdir(), prefix))
  const args = ['--no-first-run', '--window-size=1440,900']
  if (blockModels) args.push(`--host-resolver-rules=${MODEL_HOSTS.map((h) => `MAP ${h} ~NOTFOUND`).join(', ')}`)
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args })
  return { browser, close: async () => { await browser.close(); rmSync(profile, { recursive: true, force: true }) } }
}

/** Aborts weight file requests on a page; returns the list of blocked urls. */
export async function blockWeights(page, serve = null) {
  const blocked = []
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled()) return
    if (serve && serve(req)) return
    if (isWeightUrl(req.url())) { blocked.push(req.url()); req.abort('blockedbyclient') } else req.continue()
  })
  return blocked
}

/**
 * Opens `url` at `width` x `height`. Under 500 px the url loads in an iframe
 * of that size on a page of `base` (same origin), unless `mobile` is set: then
 * it loads top level under mobile emulation (a live site, where an app in that
 * iframe never renders). Returns the page, the target to evaluate in (the frame
 * or the page) and a shot function.
 */
export async function openAt(browser, url, { width, height = 900, base, ready = 'body *', block = false, settle = 300, dogSite = null, mobile = false }) {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('dialog', (d) => d.dismiss().catch(() => {})) // an alert would hold the load
  const blocked = block ? await blockWeights(page, dogSite ? dogSiteResponder(dogSite).serve : null) : []
  let target
  let shot
  let frameOf = async () => page
  if (width < 500 && mobile) {
    await page.setViewport({ width, height, isMobile: true, hasTouch: true })
    await page.goto(url, { waitUntil: 'load' })
    shot = (path) => page.screenshot({ path })
  } else if (width < 500) {
    await page.setViewport({ width: Math.max(600, width + 40), height })
    // a same origin page with no app on it, so nothing reloads under setContent
    await page.goto(new URL('__frame-host__', base ?? url).href, { waitUntil: 'load' })
    await page.setContent(`<body style="margin:0;background:#888"><iframe id="f" src="${url}" style="border:0;width:${width}px;height:${height}px;display:block"></iframe></body>`, { waitUntil: 'load' })
    const el = await page.$('#f')
    frameOf = () => el.contentFrame()
    shot = (path) => el.screenshot({ path })
  } else {
    await page.setViewport({ width, height })
    await page.goto(url, { waitUntil: 'load' })
    shot = (path) => page.screenshot({ path })
  }
  // an app that reloads itself once (a service worker taking over) drops the
  // first document under the wait: take the frame again and retry
  for (let i = 0; ; i++) {
    try {
      target = await frameOf()
      await target.waitForSelector(ready, { timeout: 10000 })
      break
    } catch (e) {
      if (i >= 2) throw e
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {})
  await new Promise((r) => setTimeout(r, settle))
  return { page, target, shot, errors, blocked }
}

// the dog site, for the yard smokes
export const DOG = 'https://hackbuild.github.io/dog-simulator/'
const DOG_TYPES = { glb: 'model/gltf-binary', wav: 'audio/wav', json: 'application/json', mjs: 'text/javascript' }

/**
 * Answers requests for the dog site's plain files from a local dog site build
 * (dir, its dist/site) as pages does, access-control-allow-origin on each.
 * serve(req) returns true when it answered (or refused) the request.
 */
export function dogSiteResponder(dir) {
  const served = []
  const serve = (r) => {
    const u = r.url()
    if (!u.startsWith(DOG)) return false
    const rel = u.slice(DOG.length).split('?')[0]
    const f = join(dir, rel)
    if (!rel.startsWith('assets/') || !existsSync(f)) { r.abort(); return true }
    served.push(rel)
    r.respond({ status: 200, contentType: DOG_TYPES[rel.split('.').pop()] ?? 'application/octet-stream', headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' }, body: readFileSync(f) })
    return true
  }
  return { serve, served }
}

/** Serves a local dog site build's plain files to a page; returns the paths it served. */
export async function serveDogSite(page, dir) {
  const { serve, served } = dogSiteResponder(dir)
  await page.setRequestInterception(true)
  page.on('request', (r) => { if (!serve(r)) r.continue() })
  return served
}
