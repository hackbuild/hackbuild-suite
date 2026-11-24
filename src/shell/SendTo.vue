<script setup lang="ts">
// The "send to" menu every tool carries (design 1.2): one row per result
// and tool that takes it, as "mask to relief". A pick builds the result,
// hands it to the workspace and the target opens on it.
import { computed } from 'vue'
import { HbButton, HbDropdown, type HbDropdownItem } from '@virgilvox/hackbuild-ui'
import { sendTo, targetsFor, type SendOffer } from '../workspace/sendto'
import { logEvent } from './shell'

const props = defineProps<{ from: string; offers: SendOffer[] }>()

const items = computed<HbDropdownItem[]>(() => props.offers.flatMap((o, i) =>
  targetsFor(o.type, props.from).map((t) => ({ label: `${o.what} to ${t.tool}`, value: `${i}:${t.tool}`, disabled: !o.ready }))))
const any = computed(() => props.offers.some((o) => o.ready))

async function pick(v: string | number): Promise<void> {
  const [i, tool] = String(v).split(':')
  const o = props.offers[Number(i)]
  if (!o || !tool) return
  try {
    const s = await o.get()
    if (s) await sendTo(tool, s, props.from)
  } catch (err) {
    logEvent('fail', `send to ${tool}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
</script>

<template>
  <HbDropdown :items="items" align="right" @select="pick">
    <template #trigger>
      <HbButton variant="secondary" size="sm" :disabled="!any" data-sendto>send to</HbButton>
    </template>
  </HbDropdown>
</template>
