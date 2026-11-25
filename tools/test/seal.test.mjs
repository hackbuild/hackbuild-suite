import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openSealed, readSealed, sealFile } from '../../src/workspace/seal.ts'

const enc = new TextEncoder()
const plain = enc.encode(JSON.stringify({ format: 'hackbuild-suite.doc', name: 'notes', body: { text: 'the desk is by the window' } }))

test('a sealed document opens with its password and holds no plain text', async () => {
  const bytes = await sealFile('hunter two', 'document', plain)
  assert.ok(!new TextDecoder().decode(bytes).includes('window'))
  const f = await readSealed(bytes)
  assert.equal(f?.what, 'document')
  assert.deepEqual(await openSealed('hunter two', f), plain)
})

test('a sealed workspace is a zip with the lock and the sealed bytes', async () => {
  const bytes = await sealFile('pw', 'workspace', plain)
  assert.equal(bytes[0], 0x50)
  const f = await readSealed(bytes)
  assert.equal(f?.what, 'workspace')
  assert.equal(f.lock.algo, 'pbkdf2-sha256')
  assert.deepEqual(await openSealed('pw', f), plain)
})

test('a wrong password rejects and says there is no recovery', async () => {
  const f = await readSealed(await sealFile('right', 'document', plain))
  await assert.rejects(openSealed('wrong', f), /wrong password\. there is no recovery/)
})

test('a changed byte rejects', async () => {
  const f = await readSealed(await sealFile('pw', 'document', plain))
  f.sealed[f.sealed.length - 3] ^= 1
  await assert.rejects(openSealed('pw', f), /file was changed/)
})

test('a plain file reads as not sealed; two seals of one file differ', async () => {
  assert.equal(await readSealed(plain), null)
  assert.equal(await readSealed(enc.encode('not json')), null)
  const a = await sealFile('pw', 'document', plain)
  const b = await sealFile('pw', 'document', plain)
  assert.notDeepEqual(a, b)
})
