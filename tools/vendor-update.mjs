// vendor-update: moves every vendored @hackbuild package to its newest npm
// release. For each file: dependency in package.json that points at
// tools/vendor/<name>-<version>-<commit>.tgz, it packs the npm latest into
// tools/vendor (named with the commit the library repo's last release of it
// came from, or "npm"), rewrites package.json, removes the old tarball and
// rewrites SHA256SUMS. Run `npx -y npm@11.21.0 install` after it, which
// writes the lock with each tarball's integrity.
//   node tools/vendor-update.mjs [--dry] [name ...]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dry = process.argv.includes('--dry')
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const VENDOR = 'tools/vendor'
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const npm = (args) => execFileSync('npm', [...args, '--prefer-online'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
let moved = 0
for (const field of ['dependencies', 'devDependencies']) {
  for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
    const m = /^file:tools\/vendor\/(.+)-(\d+\.\d+\.\d+)-([0-9a-z]+)\.tgz$/.exec(spec)
    if (!m || !name.startsWith('@hackbuild/')) continue
    if (only.length && !only.includes(name.split('/')[1])) continue
    const latest = npm(['view', name, 'version'])
    if (latest === m[2]) continue
    console.log(`vendor-update: ${name} ${m[2]} to ${latest}`)
    moved++
    if (dry) continue
    const packed = npm(['pack', `${name}@${latest}`, '--pack-destination', VENDOR, '--silent']).split('\n').pop()
    const file = `${m[1]}-${latest}-npm.tgz`
    renameSync(join(VENDOR, packed), join(VENDOR, file))
    rmSync(join(VENDOR, `${m[1]}-${m[2]}-${m[3]}.tgz`), { force: true })
    pkg[field][name] = `file:${VENDOR}/${file}`
  }
}
if (!dry && moved) {
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
  const sums = readdirSync(VENDOR).filter((f) => f.endsWith('.tgz')).sort()
    .map((f) => `${createHash('sha256').update(readFileSync(join(VENDOR, f))).digest('hex')}  ${f}`)
  writeFileSync(join(VENDOR, 'SHA256SUMS'), sums.join('\n') + '\n')
}
console.log(`vendor-update: ${moved} package${moved === 1 ? '' : 's'} ${dry ? 'would move' : 'moved'}`)
