<script setup lang="ts">
// Seal a memory store with a password, or open a sealed one on this visit
// (design 2.5b). Shared by the memory tool and the character's memory
// section. There is no recovery, and the copy says so.
import { computed, onMounted, ref, watch } from 'vue'
import { HbButton, HbCallout, HbField, HbInput } from '@virgilvox/hackbuild-ui'
import type { SealLock } from '@hackbuild/memory/seal'
import { logEvent } from '../shell/shell.ts'
import { ws } from '../workspace/state'
import { CHARACTER_KIND } from '../character/kind.ts'
import { CHAT_STORE, emptyData, MEMORY_KIND, type MemoryBody } from './kind.ts'
import { memory, sealExport, sealRev, sealState, sealStore, unlockStore } from './store.ts'

const props = defineProps<{ store: string; id: string }>()
const emit = defineEmits<{ sealed: [lock: SealLock]; opened: [] }>()

const state = ref<'plain' | 'sealed' | 'open' | ''>('')
const pw = ref('')
const pw2 = ref('')
const error = ref('')
const working = ref(false)
const read = async () => (state.value = await sealState(props.store))
onMounted(read)
watch(() => [props.store, sealRev.value], read)

/** No plain copy outlives the seal: memory documents naming the store take
 * the sealed export, and for the chat store the project's characters take
 * the lock (Profile.lock). */
async function sealDocs(lock: SealLock): Promise<void> {
  const data = (await memory(props.store)).export()
  for (const d of await ws.docs()) {
    if (d.kind === MEMORY_KIND && (d.body as MemoryBody).store === props.store) {
      ws.change({ ...d, body: { store: props.store, data: emptyData(props.store), lock, sealed: await sealExport(props.store, data) } satisfies MemoryBody })
    } else if (d.kind === CHARACTER_KIND && props.store === CHAT_STORE) {
      const card = structuredClone(d.body) as { data: { extensions: Record<string, { lock?: SealLock } | undefined> } }
      const prof = card.data.extensions.hackbuild
      if (!prof || prof.lock) continue
      prof.lock = lock
      ws.change({ ...d, body: card })
    }
  }
  await ws.flush()
}

const why = computed(() => {
  if (!pw.value) return 'type a password.'
  if (state.value === 'plain' && pw.value !== pw2.value) return 'the two passwords differ.'
  return ''
})

async function go(): Promise<void> {
  if (why.value || working.value) return
  working.value = true
  error.value = ''
  try {
    if (state.value === 'plain') {
      const lock = await sealStore(props.store, pw.value)
      await sealDocs(lock)
      logEvent('note', `memory ${props.store}: sealed with a password. there is no recovery.`)
      emit('sealed', lock)
    } else {
      await unlockStore(props.store, pw.value)
      logEvent('note', `memory ${props.store}: opened with its password.`)
      emit('opened')
    }
    pw.value = pw2.value = ''
  } catch (e) {
    error.value = (e as Error).message
    logEvent('fail', `memory ${props.store}: ${error.value}`)
  } finally {
    working.value = false
    await read()
  }
}
</script>

<template>
  <HbCallout v-if="state === 'open'" variant="info" title="sealed">
    this memory is sealed with a password and open on this visit. a new visit asks again. there is no recovery.
  </HbCallout>
  <form v-else-if="state" class="hb-stack" @submit.prevent="go">
    <p class="hb-hint">
      {{ state === 'sealed'
        ? 'this memory is sealed. give its password to recall and edit it. there is no recovery.'
        : 'seal with a password: memories, vectors and pins are kept sealed in this browser. there is no recovery: a lost password means the memory is gone.' }}
    </p>
    <HbField label="password" :for="`${id}-pw`">
      <HbInput :id="`${id}-pw`" v-model="pw" type="password" :autocomplete="state === 'plain' ? 'new-password' : 'current-password'" :invalid="!!error" />
    </HbField>
    <HbField v-if="state === 'plain'" label="password again" :for="`${id}-pw2`">
      <HbInput :id="`${id}-pw2`" v-model="pw2" type="password" autocomplete="new-password" :invalid="!!pw2 && pw !== pw2" />
    </HbField>
    <HbCallout v-if="error" variant="err">{{ error }}</HbCallout>
    <div>
      <HbButton type="submit" size="sm" :variant="state === 'plain' ? 'secondary' : 'primary'" :disabled="!!why || working" :title="why">
        {{ working ? 'deriving the key' : state === 'plain' ? 'seal with a password' : 'open' }}
      </HbButton>
    </div>
  </form>
</template>
