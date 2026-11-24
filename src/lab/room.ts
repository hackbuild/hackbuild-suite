// Fixtures for the phone stage check: the seven rack tabs with a little in
// each, as on the hackbuild-ui phone stage plus rack demo. No model runs.
import type { HbChatLine, HbGaugeRow, HbMemoryEntry } from '@virgilvox/hackbuild-ui'

export const NAME = 'mannequin'

export const RACK_TABS = ['talk', 'mind', 'eyes', 'memory', 'body', 'brain', 'voice']

export const TALK: HbChatLine[] = [
  { role: 'user', text: 'walk to the bench' },
  { role: 'assistant', text: 'walking. the bench is three steps ahead.' },
]

export const ORDERS = ['come here', 'sit', 'fetch the block', 'stop']

export const DRIVES: HbGaugeRow[] = [
  { label: 'curiosity', value: 0.62, current: true },
  { label: 'tired', value: 0.21 },
  { label: 'social', value: 0.48 },
  { label: 'hunger', value: 0.12 },
]

export const MEMORY: HbMemoryEntry[] = [
  { id: 'm1', kind: 'fact', text: 'the red block lives on the bench, next to the clamp.', when: 'nov 3 added' },
  { id: 'm2', kind: 'rule', text: 'stop short of the bench edge.', when: 'chat', pinned: true },
]

export const REPLIES = [
  'heard you. this is a fixture reply; no model runs here.',
  'walk me with the pad or wasd. the stage is real 3d.',
  'done. open the rack to read the mind tab.',
]
