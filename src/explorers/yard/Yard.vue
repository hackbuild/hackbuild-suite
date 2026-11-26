<script setup lang="ts">
// yard (rebuild plan 4 and 5): the dog simulator itself, @hackbuild/agents-views
// Yard mounted live under the bar, playing at once (the still behind ?stub, for
// gates, and offline). The yard brings its own stage and rack; no model chip
// shows here, the yard's setup panel picks his models.
import { onMounted } from 'vue'
import { chipPick } from '../../shell/chip'
import YardFrame from './YardFrame.vue'

onMounted(() => { chipPick.value = null })
</script>

<template>
  <YardFrame full />
</template>
