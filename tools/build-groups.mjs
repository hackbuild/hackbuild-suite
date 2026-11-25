// build-groups: the seven group single files (design D11), one HTML per tool
// group, each opened from file:// on its own.
//   node tools/build-groups.mjs [group ...]
// Writes dist/groups/<group>.html; with no names it builds every group.
import { renameSync, rmSync, statSync } from 'node:fs'
import { build } from 'vite'

export const GROUP_IDS = ['chat', 'voice', 'image', 'character', 'rooms', 'motion', 'agents']
const want = process.argv.slice(2)
for (const g of want) if (!GROUP_IDS.includes(g)) throw new Error(`no group ${g}; groups are ${GROUP_IDS.join(', ')}`)
for (const g of want.length ? want : GROUP_IDS) {
  await build({ mode: `group-${g}`, logLevel: 'warn' })
  renameSync(`dist/groups/${g}/index.html`, `dist/groups/${g}.html`)
  rmSync(`dist/groups/${g}`, { recursive: true, force: true })
  console.log(`build-groups: ${g}.html ${statSync(`dist/groups/${g}.html`).size} B raw (measured)`)
}
