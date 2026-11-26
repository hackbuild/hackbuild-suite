<script setup lang="ts">
// yard (rebuild plan 4 and 5): the dog simulator itself, embedded. In this
// phase it is the dog site in a frame that fills the page under the bar,
// playing at once (a still behind ?stub, for gates). The dog brings his own stage and rack; no model
// chip shows here, the dog's setup panel picks his models.
import { onMounted } from 'vue'
import { chipPick } from '../../shell/chip'
import YardFrame from './YardFrame.vue'

onMounted(() => { chipPick.value = null })
</script>

<template>
  <YardFrame full />
</template>
