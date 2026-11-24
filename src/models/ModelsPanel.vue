<script setup lang="ts">
// The model manager drawer (design 2.2): this machine as the capability
// panel, the slot rack, the catalogue with its custom row, and what is
// stored and loaded. One hub and one store behind every section.
import { ref } from 'vue'
import { HbCapabilities, HbCustomModelForm, HbModelManager, HbModelRack, HbReasons } from '@virgilvox/hackbuild-ui'
import {
  act, addCustom, allRecords, cancel, caps, checkCustom, customCheck, customSaved, defaultId, defaults, evict, fits, load,
  machine, persist, policy, rackPresets, rackSlots, rackStates, reasons, removeCustom, resident, states, storage, stored, unload,
} from './hub'

const picked = ref<string | null>(null)
const picks = ref<Record<string, string>>({})
function preset(id: string) {
  const p = rackPresets.value.find((x) => x.id === id)
  if (p) picks.value = { ...p.picks }
}
</script>

<template>
  <HbModelManager
    v-model="picked"
    :records="allRecords"
    :fits="fits"
    :states="states"
    :stored="stored"
    :resident="resident"
    :estimate="storage"
    :default-id="defaultId"
    :default-why="defaults.reasons[0]?.why ?? ''"
    :policy="policy"
    :group-order="['start here']"
    @load="load"
    @cancel="cancel"
    @unload="unload"
    @evict="evict"
    @persist="persist"
  >
    <template #machine>
      <HbCapabilities :caps="caps" :machine="machine" quiet @act="act" />
      <HbReasons :rows="reasons" />
    </template>
    <template #rack>
      <HbModelRack v-model="picks" :slots="rackSlots" :states="rackStates(picks)" :presets="rackPresets" @load="(_s, id) => load(id)" @preset="preset" />
    </template>
    <template #custom>
      <HbCustomModelForm
        :modes="['onnx']"
        :check="customCheck"
        :saved="customSaved"
        @check="(_m, v) => checkCustom(v)"
        @add="(_e, v) => addCustom(v)"
        @pick="(id) => (picked = id)"
        @remove="removeCustom"
      />
    </template>
  </HbModelManager>
</template>
