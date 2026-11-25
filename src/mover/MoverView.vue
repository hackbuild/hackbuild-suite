<script setup lang="ts">
// The mover tool (design 3.12): steer a body through a world with
// collisions. Click the floor for a goal and `Steerer` walks the planned
// waypoints while `World` keeps the capsule out of the walls, or drive it
// with the keys and the pad (P-ROOM-14 manual drive, P-PHONE-10 pad). Pick
// box, cylinder or wall and click the floor to place one; right click or
// long press a thing for the menu that sends sentences (P-ROOM-2). New
// here: the world editor with save, and the steer state read each step.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import {
  HbButton, HbCausalLog, HbChip, HbChipGroup, HbExportPanel, HbFold, HbHow, HbKv, HbList, HbParamRow,
  type HbCausalEvent, type HbExportFormat, type HbExportReadout, type HbExportRequest,
} from '@virgilvox/hackbuild-ui'
import { saveFile } from '@virgilvox/hackbuild-ui/vanilla'
import { Vector2, Vector3 } from 'three'
import type { Rng } from '@hackbuild/organic'
import StageTool from '../stagekit/StageTool.vue'
import { useStageTool } from '../stagekit/useStageTool'
import { exportDoc, kinds, registerKind, useDocument, ws } from '../workspace/state'
import { logEvent } from '../shell/shell'
import { tone } from '../vision/frame'
import {
  BODY_R, ITEM_KINDS, MOVER_COPY, MOVER_KIND, SIZES, extent, inside, moverKind, newItem, seededWorld, steerRows, traceCsv,
  type ItemKind, type MoverBody, type SteerRead, type WorldItem,
} from './kind.ts'
import type { MoverSim } from './sim.ts'
import type { WorldView } from './bind.ts'

if (!kinds.get(MOVER_KIND)) registerKind(moverKind)

const MODES = ['goal', ...ITEM_KINDS] as const
type Mode = (typeof MODES)[number]

const tool = useStageTool({
  id: 'mover',
  empty: MOVER_COPY.empty,
  walk: false,
  tunables: (reg) => {
    reg.define({ key: 'walk.speed', group: 'steer', label: 'cruise speed', def: 1.4, min: 0.4, max: 3, step: 0.1, unit: 'm/s', note: 'steer speed to a goal and drive speed at full stick.', source: 'inferred' })
    reg.define({ key: 'place.wall', group: 'place', label: 'wall length', def: SIZES.wall.w, min: 0.6, max: 6, step: 0.1, unit: 'm', note: 'length of a new wall.', source: 'inferred' })
    reg.define({ key: 'place.box', group: 'place', label: 'box height', def: SIZES.box.h, min: 0.1, max: 2, step: 0.05, unit: 'm', note: 'a box at 0.36 m or lower is stepped onto, not walked round (STEP_UP).', source: 'vendor', cite: 'mover STEP_UP 0.36' })
  },
  restart: (rng) => begin(rng),
  tick: (dt) => frame(dt),
  menu: (at) => menuAt(at),
  say: (s) => say(s),
  hints: (base) => [...base.filter((h) => h.keys !== 'wasd'), { keys: 'wasd', label: 'drive' }, { keys: 'click', label: 'goal or place' }],
})

const doc = useDocument<MoverBody>(MOVER_KIND)
const world = reactive<MoverBody>(moverKind.create())
const open = reactive({ steer: true, world: true, feed: false, export: false })
const mode = ref<Mode>('goal')
const along = ref(false)
const selected = ref<string | null>(null)
const sim = shallowRef<MoverSim | null>(null)
const view = shallowRef<WorldView | null>(null)
const live = reactive({ rows: [] as { label: string; value: string }[], feed: [] as HbCausalEvent[], arrived: 0, state: null as SteerRead | null })
let bind: typeof import('./bind.ts') | null = null
let fromDoc = true
let seedRng: Rng | null = null

const speed = computed(() => tool.values['walk.speed'] ?? 1.4)
const wallLen = computed(() => tool.values['place.wall'] ?? SIZES.wall.w)
const boxH = computed(() => tool.values['place.box'] ?? SIZES.box.h)
const sel = computed(() => world.items.find((t) => t.label === selected.value) ?? null)

function save() {
  if (doc.doc.value) doc.edit((d) => { d.items = world.items.map((t) => ({ ...t })); d.start = { ...world.start }; d.goal = world.goal && { ...world.goal } })
}

// ------------------------------------------------------------- run

/** A restart keeps the world the person made: the body goes back to the start, the goal clears. */
function begin(rng: Rng) {
  seedRng = rng
  const w = tool.walk.value
  if (!w || !bind) return
  if (fromDoc) {
    if (!world.items.length && !doc.body.value?.items.length) Object.assign(world, seededWorld(rng))
    // the whole room from above, so every spot of the floor is in reach of a
    // click; again when a body lands, which frames it from the front
    overview()
    w.stage.on('loaded', () => void nextTick(overview))
  }
  fromDoc = false
  sim.value = new bind.MoverSim(world.items, world.start, speed.value)
  if (!view.value) view.value = new bind.WorldView(w.stage.scene, world.items, tone('--hb-pink') || '#e0457b')
  else view.value.set(world.items)
  w.place(world.start.x, world.start.z, 0)
  const g = world.goal
  world.goal = null
  if (g) goalAt(g.x, g.z)
  tool.body.line = MOVER_COPY.empty
  save()
  read()
}

/** The studio fog fades all past 14 m; from above the room it is pushed out, and given back on leave. */
let fogWas: { fog: { near: number; far: number }; near: number; far: number } | null = null
function overview() {
  const w = tool.walk.value
  if (!w) return
  const fog = w.stage.scene.fog as { near: number; far: number } | null
  if (fog && 'near' in fog && fogWas?.fog !== fog) {
    fogWas = { fog, near: fog.near, far: fog.far }
    fog.near = 18
    fog.far = 40
  }
  tool.view.value = 'top'
  w.view('top')
  // after the toolbar's own view change; the orbit stops at a few body heights, the room needs more
  void nextTick(() => {
    w.stage.controls.maxDistance = Math.max(w.stage.controls.maxDistance, 30)
    w.stage.zoomBy(0.3)
  })
}

const fwd = new Vector3()
function frame(dt: number) {
  const s = sim.value
  const w = tool.walk.value
  if (!s || !w) return
  const m = tool.move.value
  let drive: { vx: number; vz: number } | null = null
  if (m.x || m.y) {
    // camera relative, as the pad walks everywhere else
    w.stage.camera.getWorldDirection(fwd)
    fwd.y = 0
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1)
    fwd.normalize()
    const rx = -fwd.z
    const rz = fwd.x
    let vx = fwd.x * -m.y + rx * m.x
    let vz = fwd.z * -m.y + rz * m.x
    const n = Math.min(1, Math.hypot(vx, vz)) / (Math.hypot(vx, vz) || 1)
    vx *= n * speed.value
    vz *= n * speed.value
    drive = { vx, vz }
  }
  const had = !!s.goal
  s.step(dt, drive)
  if (had && !s.goal) {
    world.goal = null
    live.arrived++
    tool.body.line = s.events.at(-1)?.text ?? 'arrived.'
    save()
  }
  const root = w.stage.body?.avatar.root
  w.place(s.actor.pos.x, s.actor.pos.z, s.heading() ?? root?.rotation.y ?? 0)
  view.value?.goal(s.goal, { x: s.actor.pos.x, z: s.actor.pos.z }, s.path.slice(s.leg))
  read()
}

let readAt = 0
function read() {
  const s = sim.value
  if (!s) return
  live.state = s.read()
  // the rack refreshes ten times a second; the state handle every step
  if (s.t - readAt < 0.1 && s.t > readAt) return
  readAt = s.t
  live.rows = steerRows(live.state)
  live.feed = s.events.slice(-60).map((e, i) => ({ id: i + s.events.length, t: e.t, agent: 'body', kind: e.kind, text: e.text }))
}

// ------------------------------------------------------------- edit

function goalAt(x: number, z: number): boolean {
  const s = sim.value
  if (!s) return false
  const why = s.setGoal(x, z)
  if (why) { tool.body.line = why; return false }
  world.goal = { x, z }
  tool.body.line = `walking to ${x.toFixed(1)}, ${z.toFixed(1)} by ${s.path.length} waypoint${s.path.length === 1 ? '' : 's'}.`
  save()
  return true
}

function place(kind: ItemKind, x: number, z: number) {
  const size = kind === 'wall' ? { ...SIZES.wall, w: wallLen.value } : kind === 'box' ? { ...SIZES.box, h: boxH.value } : SIZES[kind]
  const t = newItem(world.items, kind, x, z, kind === 'wall' && along.value ? 1 : 0, size)
  const a = sim.value?.actor.pos
  if (a && inside([t], a.x, a.z, BODY_R)) { tool.body.line = 'that would stand on the body. click open floor.'; return }
  world.items.push(t)
  selected.value = t.label
  changed(`${t.label} placed at ${t.x.toFixed(1)}, ${t.z.toFixed(1)}.`)
}

function changed(line: string) {
  sim.value?.setItems(world.items)
  view.value?.set(world.items)
  if (world.goal && !sim.value?.goal) world.goal = null
  tool.body.line = line
  tool.walk.value?.stage.loop.invalidate()
  save()
}

function turnItem(label: string) {
  const t = world.items.find((x) => x.label === label)
  if (!t) return
  t.turn = t.turn ? 0 : 1
  changed(`${t.label} turned.`)
}
function removeItem(label: string) {
  world.items = world.items.filter((x) => x.label !== label)
  if (selected.value === label) selected.value = null
  changed(`${label} removed.`)
}
function resize(label: string, key: 'w' | 'h', v: number) {
  const t = world.items.find((x) => x.label === label)
  if (!t) return
  t[key] = Math.round(v * 100) / 100
  if (t.kind === 'cylinder' && key === 'w') t.d = t[key]
  changed(`${t.label} resized.`)
}

let down: { x: number; y: number; t: number; b: number } | null = null
function onDown(e: PointerEvent) { down = { x: e.clientX, y: e.clientY, t: performance.now(), b: e.button } }
function onUp(e: PointerEvent) {
  const d = down
  down = null
  const w = tool.walk.value
  const v = view.value
  if (!d || d.b !== 0 || !w || !v || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || performance.now() - d.t > 600) return
  const box = w.stage.renderer.domElement.getBoundingClientRect()
  const hit = v.room.pick(new Vector2(((e.clientX - box.left) / box.width) * 2 - 1, -((e.clientY - box.top) / box.height) * 2 + 1), w.stage.camera)
  if (!hit) return
  if ('label' in hit) {
    if (mode.value === 'goal') { tool.body.line = MOVER_COPY.inWall; return }
    selected.value = hit.label
    tool.body.line = `${hit.label} picked. edit it in the world fold.`
    return
  }
  if (mode.value === 'goal') goalAt(hit.x, hit.z)
  else place(mode.value, hit.x, hit.z)
}

// a double click resets the stage to the front; in the editor two quick
// clicks are two edits, so the reset comes back to the room from above
const onDbl = () => { if (tool.view.value === 'top') overview() }
watch(() => tool.host.value, (el, old) => {
  old?.removeEventListener('pointerdown', onDown)
  old?.removeEventListener('pointerup', onUp)
  old?.removeEventListener('dblclick', onDbl)
  el?.addEventListener('pointerdown', onDown)
  el?.addEventListener('pointerup', onUp)
  el?.addEventListener('dblclick', onDbl)
}, { immediate: true })

// ------------------------------------------------------------- menu

function menuAt(at: { x: number; y: number }) {
  const w = tool.walk.value
  const v = view.value
  if (!w || !v) return null
  const box = w.stage.renderer.domElement.getBoundingClientRect()
  const hit = v.room.pick(new Vector2((at.x / box.width) * 2 - 1, -(at.y / box.height) * 2 + 1), w.stage.camera)
  if (!hit || !('label' in hit)) return null
  const l = hit.label
  return { title: l, items: [{ label: 'go there', say: `go to ${l}` }, { label: 'turn it', say: `turn ${l}` }, { label: 'remove it', say: `remove ${l}` }] }
}

/** A sentence from the menu, acted on and written to the feed. */
function say(s: string) {
  const m = /^(go to|turn|remove) (\w+ \d+)$/.exec(s)
  const t = m ? world.items.find((x) => x.label === m[2]) : undefined
  const sm = sim.value
  if (!m || !t || !sm) return
  sm.events.push({ t: sm.t, kind: 'drive', text: `"${s}"` })
  logEvent('note', `mover: ${s}`)
  if (m[1] === 'turn') return turnItem(t.label)
  if (m[1] === 'remove') return removeItem(t.label)
  // beside the thing, on the side of the body
  const a = sm.actor.pos
  const e = extent(t)
  const dx = a.x - t.x
  const dz = a.z - t.z
  const d = Math.hypot(dx, dz) || 1
  const reach = Math.max(e.w, e.d) / 2 + BODY_R + 0.35
  if (!goalAt(t.x + (dx / d) * reach, t.z + (dz / d) * reach)) goalAt(t.x - (dx / d) * reach, t.z - (dz / d) * reach)
}

// ------------------------------------------------------------- save, export

async function saveWorld() {
  save()
  await ws.flush()
  tool.body.line = `world saved: ${world.items.length} thing${world.items.length === 1 ? '' : 's'}.`
  logEvent('note', `mover: world saved, ${world.items.length} things`)
}
function seeded() {
  if (!seedRng) return
  Object.assign(world, seededWorld(seedRng))
  selected.value = null
  sim.value = bind ? new bind.MoverSim(world.items, world.start, speed.value) : null
  tool.walk.value?.place(0, 0, 0)
  changed('a seeded world. click the floor to set a goal.')
}
function clearWorld() {
  world.items = []
  selected.value = null
  changed('the world is empty. place a box, a cylinder or a wall.')
}

const name = computed(() => `mover-${tool.seed.value}`)
const formats: HbExportFormat[] = [
  { key: 'doc', label: 'world', ext: moverKind.ext, note: 'every box, cylinder and wall, the start and the goal.' },
  { key: 'trace', label: 'steer trace', ext: '.csv', note: 'each step: time, spot, mode and why.' },
]
const readout = computed<HbExportReadout[]>(() => [
  { label: 'things', value: String(world.items.length) },
  { label: 'steps', value: String(sim.value?.trace.length ?? 0) },
  { label: 'seed', value: String(tool.seed.value) },
])
async function onExport(req: HbExportRequest) {
  const fname = req.filename || name.value
  if (req.format === 'doc') {
    const d = doc.doc.value
    if (d) await exportDoc(d.id, { filename: fname })
    return
  }
  const tr = sim.value?.trace ?? []
  if (!tr.length) { tool.body.line = 'no steps yet. press play.'; return }
  saveFile(`${fname}.csv`, traceCsv(tr), 'text/csv')
}

// ------------------------------------------------------------- start

onMounted(async () => {
  await ws.ready()
  const all = (await ws.docs()).filter((d) => d.kind === MOVER_KIND)
  if (all.length) await doc.open(all.sort((a, b) => b.updated - a.updated)[0]!.id)
  else await doc.create('world')
  const d = doc.body.value
  if (d) Object.assign(world, JSON.parse(JSON.stringify(d)))
  bind = await import('./bind.ts')
  if (tool.walk.value) tool.restart()
})
watch(() => tool.walk.value, (w) => { if (w && bind && !sim.value) tool.restart() })
// a tap in the top view would turn it about the pole: from above, drag pans and pinch zooms
watch([() => tool.view.value, () => tool.walk.value] as const, ([v, w]) => { if (w) w.stage.controls.enableRotate = v !== 'top' }, { immediate: true })
watch(speed, (v) => { if (sim.value) sim.value.steer.o.speed = v })

onBeforeUnmount(() => {
  if (fogWas) Object.assign(fogWas.fog, { near: fogWas.near, far: fogWas.far })
  view.value?.dispose()
  view.value = null
  sim.value = null
})

// for the smoke: the tool handle on the stage host, no global
watch(view, (v) => {
  const el = tool.host.value as (HTMLElement & { mover?: unknown }) | null
  const w = tool.walk.value
  if (!el || !v || !w || !bind) return
  const sc = bind.screenOf
  el.mover = {
    world, live, mode,
    camera: () => w.stage.camera.position.toArray(),
    state: () => sim.value?.read(),
    trace: () => sim.value?.trace.map((r) => [r.x, r.z]),
    screenOf: (x: number, z: number) => sc(x, z, w.stage.camera, w.stage.renderer.domElement),
  }
})

const HOW = `import { World, Steerer, box, wallBox, cyl, nearest } from "@hackbuild/mover";

const world = new World([box(0, 0, 0, 12, 12, 0.5), wallBox(0, 1.5, 2.4, 0.2, 0, 1.2)]);
const steer = new Steerer("body", { speed: 1.4 });
const body = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, radius: 0.28, height: 1.7, grounded: true };
const wall = { id: "wall 1", parts: [{ ax: -1.1, az: 1.5, bx: 1.1, bz: 1.5, r: 0.14 }] };
steer.setGoal(waypoint.x, waypoint.z); // the next waypoint of a path round the walls
function step(t, dt) {
  const me = { id: "body", x: body.pos.x, z: body.pos.z, vx: body.vel.x, vz: body.vel.z, radius: 0.28, moving: true };
  const out = steer.update(t, me, [me], [wall]); // out.mode, out.why
  body.vel.x = out.vx; body.vel.z = out.vz;
  world.step(body, dt); // walls push sideways, low boxes are stepped onto
  world.endFrame();
}`
</script>

<template>
  <StageTool :tool="tool" title="mover">
    <template #under>
      <div class="hb-acts">
        <HbChipGroup v-model="mode" :options="[...MODES]" label="click to" data-place />
        <HbChip :model-value="along" toggle data-along @click="along = !along">walls along z</HbChip>
      </div>
    </template>

    <template #rack>
      <HbFold v-model="open.steer" :num="0" summary="steer state" persist-key="mover-steer">
        <div class="hb-instrument" data-pane="steer">
          <HbKv v-for="r in live.rows" :key="r.label" :label="r.label" :value="r.value" />
          <p class="hb-hint">the steerer walks the planned waypoints and keeps clear of every footprint; the world pushes the capsule out of walls and lifts it onto anything up to 0.36 m.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.world" :num="1" summary="world" persist-key="mover-world">
        <div class="hb-instrument" data-pane="world">
          <HbList>
            <div v-for="t in world.items" :key="t.label" class="hb-row" :data-item="t.label">
              <HbButton :variant="selected === t.label ? 'primary' : 'secondary'" size="sm" :aria-pressed="selected === t.label" @click="selected = t.label">{{ t.label }}</HbButton>
              {{ t.x.toFixed(1) }}, {{ t.z.toFixed(1) }} m
            </div>
            <div v-if="!world.items.length" class="hb-row">nothing placed. pick box, cylinder or wall and click the floor.</div>
          </HbList>
          <template v-if="sel">
            <HbParamRow :model-value="sel.w" :label="sel.kind === 'cylinder' ? 'diameter' : 'length'" :min="0.2" :max="6" :step="0.1" unit="m" :default-value="SIZES[sel.kind].w" @update:model-value="(v) => resize(sel!.label, 'w', Number(v))" />
            <HbParamRow :model-value="sel.h" label="height" :min="0.1" :max="2" :step="0.05" unit="m" :default-value="SIZES[sel.kind].h" @update:model-value="(v) => resize(sel!.label, 'h', Number(v))" />
            <div class="hb-acts">
              <HbButton variant="secondary" size="sm" @click="turnItem(sel.label)">turn {{ sel.label }}</HbButton>
              <HbButton variant="secondary" size="sm" @click="removeItem(sel.label)">remove {{ sel.label }}</HbButton>
            </div>
          </template>
          <div class="hb-acts">
            <HbButton size="sm" data-save @click="saveWorld">save world</HbButton>
            <HbButton variant="secondary" size="sm" @click="seeded">seeded world</HbButton>
            <HbButton variant="secondary" size="sm" @click="clearWorld">clear</HbButton>
          </div>
          <p class="hb-hint">the world saves with this tab's documents and opens again next time. export it as a world file to share.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.feed" :num="2" summary="steer feed" persist-key="mover-feed">
        <HbCausalLog :events="live.feed" :limit="40" :kinds="['goal', 'mode', 'arrived', 'stall', 'drive']" label="steer feed" />
      </HbFold>

      <HbFold v-model="open.export" :num="3" summary="export" persist-key="mover-export">
        <HbExportPanel :formats="formats" :name="name" :readout="readout" :busy="sim ? '' : 'the stage is starting.'" label="mover" @export="onExport" />
      </HbFold>

      <HbHow :packages="['@hackbuild/mover', '@hackbuild/avatar-host']" install="npm i @hackbuild/mover" :code="HOW" persist-key="mover-how" />
    </template>
  </StageTool>
</template>
