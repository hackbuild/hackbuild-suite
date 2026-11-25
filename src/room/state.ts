// What the rack and the room share (design 3.10 steps 1 and 11, F-9): the
// organ picks, the brain tier (remembered), the persona, the endpoint and
// whether the agent is awake. The rack is the first screen; "open rack"
// returns to it and its button then reads "resume".
import { computed, ref, shallowRef } from 'vue'
import { usePersisted, type HbRackPreset, type HbRackSlot } from '@virgilvox/hackbuild-ui'
import type { ChatEngine } from '@hackbuild/chat'
import { PRESETS, presetTotal } from '@hackbuild/models'
import * as hub from '../models/hub.ts'
import { PARAMS, type Brain, type Decide, type Params } from './brain.ts'
import type { RoomBody } from './kind.ts'

/** The organs of the room, in the rack's order, each with its job. */
export const ORGANS: { slot: string; role: string }[] = [
  { slot: 'brain', role: 'plans each turn. reflexes stand in while it loads.' },
  { slot: 'eyes', role: 'captions what the eye sees.' },
  { slot: 'depth', role: 'depth from the eye image, for clearances.' },
  { slot: 'embedder', role: 'recall by meaning. without it recall is keyword only.' },
  { slot: 'ears', role: 'turns the mic into words.' },
  { slot: 'voice', role: 'speaks the replies.' },
]

export const PERSONA = 'curious, plain spoken, a little wry. speaks briefly. lives in this one small room and knows only what it has seen, heard and been told.'

export const brain = usePersisted<Brain>('suite-room-brain', 'reflex only')
export const picks = usePersisted<Record<string, string>>('suite-room-picks', {})
export const persona = usePersisted('suite-room-persona', PERSONA)
export const name = usePersisted('suite-room-name', 'ada')
export const decide = usePersisted<Decide>('suite-room-decide', 'the model')
export const params = usePersisted<Params>('suite-room-params', { ...PARAMS })
/** Free text added to the end of the prompt (P-PERSONA-6). */
export const extra = usePersisted('suite-room-extra', '')
export const voiceEngine = usePersisted('suite-room-voice', 'web-speech')
export const voicePreset = usePersisted('suite-room-preset', 'narrator-female')
export const voiceRate = usePersisted('suite-room-rate', 1)
/** A room document opened from a drop or the workspace; the stage applies it on its next restart. */
export const opened = shallowRef<{ id: string; body: RoomBody } | null>(null)
export const endpoint = ref('')
export const endpointModel = ref('')
export const endpointKey = ref('')
export const keyOk = ref(false)

/** Woken once this visit; the rack then reads "resume". */
export const woke = ref(false)
/** The rack shows: before the first wake, and after "open rack". */
export const rackOpen = ref(true)
/** The brain engine when the tier has one ready. */
export const engine = shallowRef<ChatEngine | null>(null)

export const origin = typeof location !== 'undefined' && location.protocol === 'file:' ? 'file' : 'http'

export const slots = computed<HbRackSlot[]>(() =>
  ORGANS.flatMap(({ slot, role }) => {
    const s = hub.rackSlots.value.find((x) => x.slot === slot)
    return s && s.options.length ? [{ ...s, role, required: false }] : []
  }),
)

/** The hub presets cut to the room organs, each with its summed download. */
export const presets = computed<HbRackPreset[]>(() => {
  const keep = new Set(ORGANS.map((o) => o.slot))
  return PRESETS.map((p) => {
    const cut = { ...p, picks: Object.fromEntries(Object.entries(p.picks).filter(([k]) => keep.has(k))) }
    const t = presetTotal(cut, hub.allRecords.value)
    return { id: p.id, label: p.label, picks: cut.picks as Record<string, string>, totalMB: t.mb, totalSource: t.source, unknown: t.unknown }
  })
})

/** The brain pick: the rack's, else the first option of the slot. */
export const brainId = computed(() => picks.value.brain ?? slots.value.find((s) => s.slot === 'brain')?.options[0]?.value ?? null)
export const brainState = computed(() => (brainId.value ? hub.states.value[brainId.value]?.state ?? 'none' : 'none'))

export const endpointOk = computed(() => /^https?:\/\/\S+$/.test(endpoint.value) && (keyOk.value || !endpointKey.value))
