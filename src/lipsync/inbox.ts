// What "send to" hands the lipsync tool: audio stays a blob in this tab,
// so it waits here until the tool opens and takes it. Framework free.
import type { TimedWord } from './track.ts'

export interface LipsyncSend {
  name: string
  audio?: Blob
  text?: string
  /** Word times from the speech engine that made the audio. */
  words?: TimedWord[]
}

let waiting: LipsyncSend | null = null
export const post = (s: LipsyncSend): void => { waiting = s }
export const take = (): LipsyncSend | null => { const s = waiting; waiting = null; return s }
