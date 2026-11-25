// The motion-net document kind (design 3.11) and the words of the weights
// row. A session keeps the style chip, the view and the bake length, saved
// as `.hbnet.json`; weights and body files are never in it. The network's
// run bakes into the clip file the gait tool writes: local rotations of
// the 27 bones by name, the root track and the paw contacts.
// Framework free and three free.
import { STYLES, UPSTREAM, type StyleLabel } from '@hackbuild/motion-net'
import type { DocKind } from '../workspace/kinds.ts'

export const NET_KIND = 'motion-net.session'

export const STYLE_CHIPS = ['auto', ...STYLES] as const
export type StyleChip = 'auto' | StyleLabel

/** What walks on the stage: the network, the procedural gait, or both side by side. */
export const SHOWS = ['network', 'procedural', 'both'] as const
export type Show = (typeof SHOWS)[number]

export interface NetBody {
  style: StyleChip
  show: Show
  /** Seconds of the run the bake keeps. */
  bake: number
}

export const newNetBody = (): NetBody => ({ style: 'auto', show: 'network', bake: 6 })

export function checkNet(raw: unknown): string | null {
  const b = raw as Partial<NetBody> | null
  if (!b || typeof b !== 'object') return 'the body is not an object.'
  if (!(STYLE_CHIPS as readonly string[]).includes(String(b.style))) return `style ${String(b.style)} is not auto or one of ${STYLES.join(', ').toLowerCase()}.`
  if (!(SHOWS as readonly string[]).includes(String(b.show))) return `view ${String(b.show)} is not network, procedural or both.`
  if (typeof b.bake !== 'number' || !(b.bake >= 1 && b.bake <= 30)) return 'bake is seconds between 1 and 30.'
  return null
}

export const netKind: DocKind<NetBody> = {
  kind: NET_KIND,
  tool: 'motion-net',
  label: 'motion-net',
  ext: '.hbnet.json',
  version: 1,
  create: newNetBody,
  check: checkNet,
}

/** The binary's size in MB from the package's byte count (vendor), one decimal: 17.7. */
export const WEIGHTS_MB = Math.round(UPSTREAM.binBytes / 1e5) / 10

/** Host and owner of a weights url, for the source row: "raw.githubusercontent.com, sweriko/ai4anim-webgpu". */
export function sourceOf(url: string): string {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    return parts.length >= 2 ? `${u.host}, ${parts[0]}/${parts[1]}` : u.host
  } catch {
    return url
  }
}

/** The status line for the weights, by state. */
export function weightsLine(s: { state: 'none' | 'loading' | 'ready' | 'failed'; loaded?: number; error?: string; stub?: boolean; stored?: boolean }): string {
  const mb = (n: number) => (n / 1e6).toFixed(n >= 1e7 ? 0 : 1)
  if (s.state === 'loading') return `weights, ${mb(s.loaded ?? 0)} of ${WEIGHTS_MB} mb. the procedural gait runs meanwhile.`
  if (s.state === 'ready') return s.stub ? 'the stub network is running: a kinematic trot in the network\'s layout, not the network.' : 'the network is running on the upstream weights.'
  if (s.state === 'failed') return `the weights did not load: ${s.error ?? 'no reason given'}. the procedural gait is running.`
  return s.stored
    ? `no weights loaded. the procedural gait is running. the weights are stored in this browser; load reads them with no download.`
    : `no weights loaded. the procedural gait is running. weights come from upstream when you press load, ${WEIGHTS_MB} mb.`
}
