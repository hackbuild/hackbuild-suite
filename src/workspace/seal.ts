// Sealed files (design 2.5b): a workspace zip or a document file sealed
// with a password through @hackbuild/memory/seal. The lock record travels
// in the file beside the sealed bytes, so the file opens anywhere with the
// password and nothing else. There is no recovery: a lost password means
// the file is gone. Loaded on the first sealed export or import, so the
// crypto stays out of the first load. Framework free.
import { unzipStore, zipStore } from '@hackbuild/audio-dsp'
import type { SealLock } from '@hackbuild/memory/seal'

export const SEALED_FORMAT = 'hackbuild-suite.sealed'
/** What a sealed file holds; also the envelope context, so a sealed
 * document does not open as a workspace. */
export type SealedWhat = 'workspace' | 'document'
export const NO_RECOVERY = 'there is no recovery. a lost password means the file is gone.'

const seal = () => import('@hackbuild/memory/seal')
const enc = new TextEncoder()
const dec = new TextDecoder()

export interface SealedFile {
  what: SealedWhat
  lock: SealLock
  sealed: Uint8Array
}

interface Header {
  format: typeof SEALED_FORMAT
  what: SealedWhat
  lock: SealLock
}

const context = (what: SealedWhat) => `file:${what}`

/** Seal `plain` under a new lock for `password`. A workspace comes out as a
 * zip of sealed.json and sealed.bin; a document as one json. */
export async function sealFile(password: string, what: SealedWhat, plain: Uint8Array): Promise<Uint8Array> {
  if (!password) throw new Error('type a password to seal with.')
  const s = await seal()
  const { lock, key } = await s.makeLock(password)
  const sealed = await s.sealBytes(key, plain, context(what))
  const head: Header = { format: SEALED_FORMAT, what, lock }
  if (what === 'workspace') return zipStore([{ name: 'sealed.json', data: JSON.stringify(head) }, { name: 'sealed.bin', data: sealed }])
  return enc.encode(JSON.stringify({ ...head, sealed: s.toBase64(sealed) }))
}

/** The sealed file inside `bytes`, or null when the file is plain. */
export async function readSealed(bytes: Uint8Array): Promise<SealedFile | null> {
  const s = await seal()
  let head: Partial<Header> & { sealed?: string }
  let body: Uint8Array | undefined
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    let entries: Map<string, Uint8Array>
    try {
      entries = new Map(unzipStore(bytes).map((e) => [e.name, e.data]))
    } catch {
      return null
    }
    const h = entries.get('sealed.json')
    if (!h) return null
    head = JSON.parse(dec.decode(h))
    body = entries.get('sealed.bin')
  } else {
    if (bytes[0] !== 0x7b) return null
    try {
      head = JSON.parse(dec.decode(bytes))
    } catch {
      return null
    }
    if (head?.format !== SEALED_FORMAT) return null
    body = typeof head.sealed === 'string' ? s.fromBase64(head.sealed) : undefined
  }
  if (head?.format !== SEALED_FORMAT) return null
  if (!body || !s.isSealed(body)) throw new Error('this sealed file has no sealed bytes. it may be cut short.')
  if (!head.lock || (head.what !== 'workspace' && head.what !== 'document')) throw new Error('this sealed file has no lock record.')
  return { what: head.what, lock: head.lock, sealed: body }
}

/** Open a sealed file. Throws "wrong password." for a wrong password and
 * names a changed file; both leave the file as it was. */
export async function openSealed(password: string, f: SealedFile): Promise<Uint8Array> {
  const s = await seal()
  let key
  try {
    key = await s.deriveKey(password, f.lock)
  } catch (e) {
    if (e instanceof s.SealError && e.code === 'wrong-password') throw new Error(`wrong password. ${NO_RECOVERY}`)
    throw e
  }
  try {
    return await s.openBytes(key, f.sealed, context(f.what))
  } catch {
    throw new Error('the password is right and the sealed bytes do not open. the file was changed or cut short.')
  }
}
