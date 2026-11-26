// explorer-rows: the explorers as tools read them, from src/shell/explorers.ts,
// src/router.ts and src/tools/registry.ts: id, title, line, the live route and
// the source file. An explorer with its own route links its folder; one not
// yet rebuilt links the tool page it opens. Used by llms.mjs and check-readme.mjs.
import { readFileSync } from 'node:fs'

export function explorerRows(root = '.') {
  const ex = readFileSync(`${root}/src/shell/explorers.ts`, 'utf8')
  const router = readFileSync(`${root}/src/router.ts`, 'utf8')
  const reg = readFileSync(`${root}/src/tools/registry.ts`, 'utf8')
  const rows = []
  for (const m of ex.matchAll(/\{ id: '([a-z-]+)', title: '([^']*)', line: '([^']*)', tool: '([a-z-]*)'(?:, route: '([^']*)')?/g)) {
    const [, id, title, line, tool, route] = m
    let source, live
    if (route) {
      const r = router.match(new RegExp(`path: '${route}',[^\\n]*import\\('\\./([^']+)'\\)`))
      if (!r) throw new Error(`explorer-rows: no route ${route} in src/router.ts`)
      source = `src/${r[1]}`
      live = `#${route}`
    } else {
      const t = reg.match(new RegExp(`id: '${tool}', group: '([a-z-]+)'[^\\n]*import\\('\\.\\./([^']+)'\\)`))
      if (!t) throw new Error(`explorer-rows: no tool ${tool} in src/tools/registry.ts`)
      source = `src/${t[2]}`
      live = `#/${t[1]}/${tool}`
    }
    rows.push({ id, title, line, live, source, rebuilt: !!route })
  }
  return rows
}
