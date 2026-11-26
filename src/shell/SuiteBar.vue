<script setup lang="ts">
// The one bar (rebuild plan 2.1, after hackle): the mark, the tool name that
// opens the switcher, one model chip for the current tool, and one menu.
import { defineAsyncComponent } from 'vue'
import { HbDropdown, HbHeader, type HbDropdownItem } from '@virgilvox/hackbuild-ui'
import type { ModelPick } from '@hackbuild/ai-views'

const props = defineProps<{ name: string; pick: ModelPick | null }>()
const emit = defineEmits<{ switcher: []; menu: [value: string] }>()

// the chip and its sheet come with the views package, after the first paint
const ModelSelect = defineAsyncComponent(() => import('@hackbuild/ai-views/vue').then((m) => m.ModelSelect))

const MENU: HbDropdownItem[] = [
  { label: 'project', value: 'project' },
  { label: 'settings', value: 'settings' },
  { label: 'keys', value: 'keys' },
  { label: 'log', value: 'log' },
]
</script>

<template>
  <HbHeader>
    <h1><button type="button" class="sx-name" aria-haspopup="dialog" :aria-label="`${props.name}. switch tool`" @click="emit('switcher')">{{ props.name }}<span>.</span></button></h1>
    <div class="hb-header-end">
      <!-- the yard's readout chips, setup and commands, as hackle's header held them -->
      <div class="hb-view sx-bar-yard" />
      <ModelSelect v-if="props.pick" :key="props.pick.job" :pick="props.pick" variant="chip" />
      <HbDropdown :items="MENU" align="right" @select="(v) => emit('menu', String(v))">
        <template #trigger>
          <button type="button" class="hb-iconbtn" aria-label="menu">
            <svg class="hb-icon is-stroke" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
        </template>
      </HbDropdown>
    </div>
  </HbHeader>
</template>
