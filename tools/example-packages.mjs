// example-packages: the install line of each example comes from its own
// imports. Reads every examples/<job>/<id>/example.ts, takes the package of
// each import (a bare specifier: @scope/name or name), and writes the list
// into examples/index.json as `packages`. An example may import only
// published packages: @hackbuild/*, @virgilvox/hackbuild-ui, three and vue.
//   node tools/example-packages.mjs           write index.json
//   node tools/example-packages.mjs --check   fail when index.json differs or an import is not allowed
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const ALLOWED = /^(@hackbuild\/[a-z0-9-]+|@virgilvox\/hackbuild-ui|three|vue)$/

/** The packages a source file imports, in first use order. */
export function importsOf(src) {
  const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)]
    .map((m) => m[1] ?? m[2] ?? m[3])
  const out = { packages: [], relative: [], disallowed: [] }
  for (const s of specs) {
    if (s.startsWith('.') || s.startsWith('/')) { out.relative.push(s); continue }
    const parts = s.split('/')
    const pkg = s.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    if (!ALLOWED.test(pkg)) out.disallowed.push(pkg)
    if (!out.packages.includes(pkg)) out.packages.push(pkg)
  }
  return out
}

export function check(index = JSON.parse(readFileSync('examples/index.json', 'utf8'))) {
  const problems = []
  const next = structuredClone(index)
  for (const e of next.examples) {
    const file = `examples/${e.job}/${e.id}/example.ts`
    if (!existsSync(file)) { problems.push(`${file}: missing`); continue }
    const got = importsOf(readFileSync(file, 'utf8'))
    for (const r of got.relative) problems.push(`${file}: imports ${r}; an example imports published packages only`)
    for (const d of got.disallowed) problems.push(`${file}: imports ${d}, not a published hackbuild package, three or vue`)
    const pkgs = got.packages.filter((p) => p !== '@virgilvox/hackbuild-ui')
    if (!pkgs.includes(e.readme)) problems.push(`${file}: its readme package ${e.readme} is not imported`)
    if (JSON.stringify(pkgs) !== JSON.stringify(e.packages)) problems.push(`${file}: index.json lists ${e.packages.join(' ')}, the file imports ${pkgs.join(' ')}`)
    e.packages = pkgs
  }
  return { problems, next }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { problems, next } = check()
  if (process.argv.includes('--check')) {
    if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
    console.log(`example-packages: ${next.examples.length} install lines match their imports`)
  } else {
    writeFileSync('examples/index.json', JSON.stringify(next, null, 2) + '\n')
    const left = problems.filter((p) => !p.includes('index.json lists'))
    if (left.length) { console.error(left.join('\n')); process.exit(1) }
    console.log(`example-packages: wrote ${next.examples.length} install lines from their imports`)
  }
}
