<script setup lang="ts">
// The room tool (design 3.10, F-2 with the F-9 rack): the rack first, then
// the room. The room mounts on the first wake and stays mounted while the
// rack is open again, so "resume" returns to the same run. The brain
// engine follows the tier: none for reflexes, the rack's brain row once it
// is loaded, or your endpoint.
import { defineAsyncComponent, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { ChatEngine } from '@hackbuild/chat'
import * as hub from '../models/hub.ts'
import { logEvent } from '../shell/shell'
import RoomRack from './RoomRack.vue'
import * as room from './state.ts'
import { kinds, registerKind, useDocument, ws } from '../workspace/state'
import { ROOM_KIND, roomKind, type RoomBody } from './kind.ts'

if (!kinds.get(ROOM_KIND)) registerKind(roomKind)

// three.js and the stage load on the first wake, not with the rack
const RoomStage = defineAsyncComponent(() => import('./RoomStage.vue'))

// the room document: the last one, or one opened from a drop or the workspace
const route = useRoute()
const doc = useDocument<RoomBody>(ROOM_KIND)
function apply(id: string, b: RoomBody) {
  const c = b.cast[0]
  if (c) {
    room.name.value = c.name
    if (c.persona) room.persona.value = c.persona
    room.extra.value = c.extra
    room.brain.value = c.brain
    room.decide.value = c.decide
    room.params.value = { ...room.params.value, ...c.params }
    room.voiceEngine.value = c.voice.engine
    room.voicePreset.value = c.voice.preset
    room.voiceRate.value = c.voice.rate
  }
  room.opened.value = { id, body: b }
}
async function openDoc(id: string | null) {
  await ws.ready()
  if (!id) {
    const all = (await ws.docs()).filter((d) => d.kind === ROOM_KIND)
    if (!all.length) return
    id = all.sort((a, b) => b.updated - a.updated)[0]!.id
  }
  const d = await doc.open(id)
  apply(d.id, d.body)
  logEvent('note', `room: opened ${d.name}, seed ${d.body.seed}`)
}
onMounted(() => {
  void hub.start()
  void openDoc(typeof route.query.doc === 'string' ? route.query.doc : null)
})
watch(() => route.query.doc, (id) => { if (typeof id === 'string' && id !== doc.doc.value?.id) void openDoc(id) })

async function pickEngine(): Promise<void> {
  const b = room.brain.value
  if (b === 'reflex only') {
    room.engine.value = null
    return
  }
  if (b === 'your endpoint') {
    if (!room.endpointOk.value) { room.engine.value = null; return }
    const { openaiCompatible } = await import('@hackbuild/chat/remote')
    room.engine.value = openaiCompatible({ base: room.endpoint.value.replace(/\/+$/, ''), model: room.endpointModel.value || 'default', ...(room.endpointKey.value ? { apiKey: room.endpointKey.value } : {}) })
    return
  }
  const id = room.brainId.value
  if (!id || room.brainState.value !== 'loaded') {
    room.engine.value = null
    return
  }
  try {
    const l = await hub.hub().use({ id })
    const v = l.value as Partial<ChatEngine> | null
    hub.hub().release(l)
    if (v && typeof v.stream === 'function') room.engine.value = v as ChatEngine
    else if (hub.STUB) {
      // under ?stub the hub loads nothing; the room plans with its stub model
      const { stubChat } = await import('../chat/stub.ts')
      room.engine.value = stubChat({ id: `stub ${id}` })
    } else room.engine.value = null
  } catch (e) {
    room.engine.value = null
    logEvent('fail', `room: the brain did not start: ${e instanceof Error ? e.message : String(e)}`)
  }
}
watch([room.brain, room.brainState, room.brainId, room.endpoint, room.endpointModel], () => void pickEngine(), { immediate: true })

async function wake() {
  if (!doc.doc.value) await doc.create('room')
  room.woke.value = true
  room.rackOpen.value = false
  void pickEngine()
  logEvent('note', `room: ${room.name.value} ${room.woke.value ? 'awake' : 'waking'}, ${room.brain.value}`)
}
</script>

<template>
  <RoomRack v-show="room.rackOpen.value" @wake="wake" />
  <RoomStage v-if="room.woke.value" v-show="!room.rackOpen.value" :doc="doc" />
</template>
