<script setup lang="ts">
// The slot rack, the first screen of the room (design 3.10 step 1, F-9):
// ported from the room original's organ rack. One row per organ with its
// own load, status and fault; presets named by weight class with their
// summed download; the persona card; the brain tier select, remembered;
// "wake the agent", with the note naming what is still missing. The no
// webgpu and opened from a file warnings show only when true. After the
// first wake the button reads "resume" (F-9 step 7).
import { computed } from 'vue'
import { HbApiKey, HbButton, HbCallout, HbField, HbInput, HbModelRack, HbPanel, HbSelect, HbTextarea } from '@virgilvox/hackbuild-ui'
import * as hub from '../models/hub.ts'
import { BRAINS, BRAIN_NOTES } from './brain.ts'
import * as room from './state.ts'
import { BODY_ACCEPT } from '../stagekit/body'

const emit = defineEmits<{ wake: [] }>()

const webgpu = computed(() => hub.env.value?.webgpu ?? true)
const brainSlot = computed(() => room.slots.value.find((s) => s.slot === 'brain'))
const brainLabel = computed(() => brainSlot.value?.options?.find((o) => o.value === room.brainId.value)?.label ?? 'none')

/** Wake is open unless the tier needs something it does not have. */
const gate = computed(() => {
  const b = room.brain.value
  if (b === 'your endpoint' && !room.endpointOk.value) return { ok: false, note: 'type the endpoint url, such as http://localhost:11434/v1, to wake on your endpoint.' }
  if (b === 'in tab') {
    const s = room.brainState.value
    if (s === 'loaded') return { ok: true, note: `ready. ${brainLabel.value} plans every turn.` }
    if (s === 'downloading') return { ok: true, note: `${brainLabel.value} is loading. it wakes on reflexes and the brain takes over when it is in.` }
    return { ok: true, note: `ready on reflexes. load ${brainLabel.value} in the brain row, or wake now and it runs on reflexes until a brain loads.` }
  }
  if (b === 'your endpoint') return { ok: true, note: `ready. ${room.endpoint.value} plans every turn.` }
  return { ok: true, note: 'ready. no model, no download: reflexes decide.' }
})

function pickBody(e: Event) {
  const input = e.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (files.length) room.bodyFiles.value = files
}

function preset(id: string) {
  const p = room.presets.value.find((x) => x.id === id)
  if (!p) return
  room.picks.value = { ...room.picks.value, ...p.picks }
  // one after another: loads at once spike memory and abort
  void (async () => {
    for (const mid of Object.values(p.picks)) {
      const st = hub.states.value[mid]?.state
      if (st !== 'loaded' && st !== 'downloading') await hub.load(mid)
    }
  })()
}
</script>

<template>
  <div class="hb-toolpage" data-rack>
    <HbPanel heading="room" sunk>
      <p>a body with eyes, two grippers, a memory and a voice, in a small room. with a model loaded the model makes every decision. without one it runs on reflexes. every organ below runs in this tab.</p>
      <div class="hb-acts" data-gate>
        <HbButton variant="primary" :disabled="!gate.ok" @click="emit('wake')">{{ room.woke.value ? 'resume' : 'wake the agent' }}</HbButton>
        <span class="hb-hint">{{ gate.note }}</span>
      </div>
      <HbCallout v-if="!webgpu" variant="warn">no webgpu adapter in this browser. the in tab models run on cpu and slowly; reflexes and your endpoint work as before.</HbCallout>
      <HbCallout v-if="room.origin === 'file'" variant="warn">opened from a file: the browser may keep less of the model cache, so weights can download again between visits.</HbCallout>
    </HbPanel>

    <HbModelRack
      v-model="room.picks.value"
      :slots="room.slots.value"
      :states="hub.rackStates(room.picks.value)"
      :presets="room.presets.value"
      label="organs"
      @load="(_s, id) => hub.load(id)"
      @preset="preset"
      @remove="hub.removeSlot"
    >
      <template #organ="{ row }">
        <HbButton v-if="row.slot === 'body'" as="label" variant="secondary" size="sm">
          pick a body
          <input type="file" :accept="BODY_ACCEPT" hidden data-body-organ @change="pickBody">
        </HbButton>
      </template>
    </HbModelRack>

    <HbPanel heading="persona" sunk>
      <HbField label="name" for="room-name"><HbInput id="room-name" v-model="room.name.value" autocomplete="off" /></HbField>
      <HbField label="who it is" for="room-persona" hint="the start of every prompt. the rest it learns in the room.">
        <HbTextarea id="room-persona" v-model="room.persona.value" :rows="3" />
      </HbField>
    </HbPanel>

    <HbPanel heading="brain" sunk>
      <HbSelect v-model="room.brain.value" :options="[...BRAINS]" label="who decides" />
      <p class="hb-hint">{{ BRAIN_NOTES[room.brain.value] }}</p>
      <div v-if="room.brain.value === 'your endpoint'" class="hb-stack">
        <HbField label="endpoint url" for="room-url" hint="an openai style server">
          <HbInput id="room-url" v-model="room.endpoint.value" placeholder="http://localhost:11434/v1" autocomplete="off" />
        </HbField>
        <HbField label="model" for="room-model"><HbInput id="room-model" v-model="room.endpointModel.value" placeholder="llama3.2" autocomplete="off" /></HbField>
        <HbApiKey v-model="room.endpointKey.value" v-model:valid="room.keyOk.value" label="key, if the server asks for one" note="sent only to that url, kept in this tab for this visit, never saved." />
      </div>
    </HbPanel>

  </div>
</template>
