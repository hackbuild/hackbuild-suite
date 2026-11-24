<script setup lang="ts">
import { HbSectionHead } from '@virgilvox/hackbuild-ui'
import { GROUPS, toolPath } from '../tools/define'
import { TOOLS } from '../tools/registry'
</script>

<template>
  <div class="hb-shell">
    <HbSectionHead title="tools" kicker="hackbuild suite" />
    <section v-for="g in GROUPS" :key="g.id" class="hb-panel">
      <h2 class="hb-panel-hd">{{ g.title }}</h2>
      <ul class="hb-list">
        <li v-for="t in TOOLS.filter((x) => x.group === g.id)" :key="t.id">
          <RouterLink :to="toolPath(t, TOOLS)" class="hb-link">{{ t.title }}</RouterLink>{{ ': ' + t.job + '. ' }}<span v-if="t.phase" class="hb-tag">phase {{ t.phase }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
