// llms: writes public/llms.txt (llmstxt.org format) from examples/index.json:
// the suite, the four libraries' llms.txt, and every built example with its
// source path. Generated; never edit public/llms.txt by hand.
//   node tools/llms.mjs           write it
//   node tools/llms.mjs --check   fail when it is stale
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const SITE = 'https://hackbuild.github.io/hackbuild-suite/'
const SRC = 'https://github.com/hackbuild/hackbuild-suite/blob/main/'
const LIBS = [
  ['hackbuild-browser-ai', 'chat, speech, vision, image and the model catalogue in the browser'],
  ['hackbuild-motion', 'avatars, retargeting, ik, gait and lip sync on three.js'],
  ['hackbuild-agents', 'drives, senses, cameras and movers for agents in a scene'],
  ['hackbuild-ui', 'the design system: tokens, classes, layouts and the model picker'],
]
const index = JSON.parse(readFileSync('examples/index.json', 'utf8'))
const built = index.examples.filter((e) => existsSync(`examples/${e.job}/${e.id}/example.ts`))

const out = [
  '# hackbuild suite',
  '',
  '> Browser AI and 3D character tools that run in one tab, built on the hackbuild libraries. Each example does one job in one TypeScript file: it exports `mount(host)`, draws a hackbuild-ui layout, and binds a view package to a library. Model weights load in the browser through a model pick; the examples ship stub loaders so they run with nothing downloaded, and `weightsLoader(store)` from @hackbuild/ai-views loads real weights.',
  '',
  `Live site: ${SITE}. Every example is at ${SITE}#/examples/<job>/<id>, with its source on screen.`,
  '',
  '## Libraries',
  '',
  ...LIBS.map(([r, what]) => `- [${r}](https://hackbuild.github.io/${r}/llms.txt): ${what}`),
  '',
  ...index.jobs.flatMap((j) => {
    const rows = built.filter((e) => e.job === j.id)
    if (!rows.length) return []
    return [
      `## Examples: ${j.title}`,
      '',
      ...rows.map((e) => `- [${e.title}](${SRC}examples/${e.job}/${e.id}/example.ts): ${e.line}. source \`examples/${e.job}/${e.id}/example.ts\`, install \`npm install ${e.packages.join(' ')} @virgilvox/hackbuild-ui\`, live ${SITE}#/examples/${e.job}/${e.id}`),
      '',
    ]
  }),
  '## Optional',
  '',
  `- [stand ins](${SRC}examples/shared/fixtures.ts): the mount contract, the stub loader, the machine fixture and the drawn samples the examples share`,
  `- [readme](${SRC}README.md): what the suite is, the explorers, privacy`,
  '',
]
const text = out.join('\n')
const file = 'public/llms.txt'
if (process.argv.includes('--check')) {
  const have = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (have !== text) { console.error('llms: public/llms.txt is stale. run node tools/llms.mjs'); process.exit(1) }
  console.log(`llms: public/llms.txt is current, ${built.length} examples`)
} else {
  writeFileSync(file, text)
  console.log(`llms: wrote public/llms.txt, ${built.length} examples`)
}
