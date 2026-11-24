// The transcription runtime on the one hub (design 2.2, 3.2): the speech
// to text rows join the catalogue, the dsp core loads from the inlined
// wasm, and under ?stub the transformers.js provider answers with canned
// segments so no weight is fetched. Without ?stub the hub's transformers.js
// provider runs whisper through its default speech recognition loader.
import type { Asr } from '@hackbuild/transcribe'
import { coreState, provide } from '../cores.ts'

/** Lines the stub reads out; the last is a known phantom so the filter has work. */
export const STUB_LINES = ['the level rail shows what the gate kept.', 'each line can be fixed by hand.', 'nothing in this run left the tab.', 'thanks for watching.']

/** A canned transcriber: up to three lines per reel, spread over its length, no weights. */
export function stubTranscriber(lines: readonly string[] = STUB_LINES): Asr {
  let next = 0
  return async (audio) => {
    const dur = audio.length / 16000
    const k = Math.max(1, Math.min(3, Math.floor(dur / 1.2)))
    const step = dur / k
    const chunks = Array.from({ length: k }, (_, i) => ({
      timestamp: [+(i * step + 0.05).toFixed(2), +((i + 1) * step - 0.05).toFixed(2)] as [number, number],
      text: lines[next++ % lines.length]!,
    }))
    return { text: chunks.map((c) => c.text).join(' '), chunks }
  }
}

/** The dsp core from the wasm inlined in the package, so it also loads from file://. */
export function provideDsp(): void {
  if (coreState('dsp') !== 'idle') return
  provide('dsp', async () => {
    const [{ loadDsp }, { AUDIO_DSP_WASM_BASE64 }] = await Promise.all([import('@hackbuild/audio-dsp'), import('@hackbuild/audio-dsp/inline')])
    return loadDsp({ base64: AUDIO_DSP_WASM_BASE64 })
  })
}

let added = false
/** Add the rows and, under ?stub, the canned transcriber. Safe to call more than once. */
export async function addTranscribeRuntimes(): Promise<void> {
  if (added) return
  added = true
  const [{ TRANSCRIBE_RECORDS }, hub] = await Promise.all([import('@hackbuild/transcribe'), import('../models/hub.ts')])
  hub.addRows(TRANSCRIBE_RECORDS)
  if (hub.STUB) {
    const asr = stubTranscriber()
    hub.addStubs({ transcribe: () => asr }, ['tjs'])
  }
}
