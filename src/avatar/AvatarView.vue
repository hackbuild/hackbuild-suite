<script setup lang="ts">
// The avatar tool shell (design 3.11): the shared stage toolbar with the
// built in mannequin and nothing of the avatar inspector yet; item 5.2
// fills the rack. The seed sets where the body starts and which way it
// faces, so a restart repeats the take.
import { HbPanel } from '@virgilvox/hackbuild-ui'
import StageTool from '../stagekit/StageTool.vue'
import { useStageTool } from '../stagekit/useStageTool'
import { SPEED } from '../stage/walk'

const tool = useStageTool({
  id: 'avatar',
  empty: 'this is the built in rig. drop a glb or vrm anywhere to use your own.',
  duration: 10,
  tunables(reg) {
    reg.define({ key: 'walk.speed', group: 'walk', label: 'speed', def: SPEED, min: 0.2, max: 3, step: 0.1, unit: 'm/s', note: 'walking speed at full stick.', source: 'inferred' })
    reg.define({ key: 'start.spread', group: 'start', label: 'spread', def: 0.5, min: 0, max: 4, step: 0.1, unit: 'm', note: 'how far from the spot the seed may start the body.', source: 'inferred' })
  },
  restart(rng, _seed, { walk, reg }) {
    const r = reg.get('start.spread') * Math.sqrt(rng())
    const a = rng() * Math.PI * 2
    walk.place(r * Math.cos(a), r * Math.sin(a), (rng() - 0.5) * Math.PI)
  },
})
</script>

<template>
  <StageTool :tool="tool" title="avatar">
    <template #rack>
      <HbPanel heading="avatar" sunk>
        <p class="hb-hint">the inspector is not built yet. the stage, the toolbar and the drop work.</p>
      </HbPanel>
    </template>
  </StageTool>
</template>
