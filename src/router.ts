import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import { TOOLS } from './tools/registry'
import { GROUPS, toolPath } from './tools/define'
import { kvPut } from './workspace/db'

// Hash routes, so every route also works in the single file build opened
// from file:// (design 1.2).
const toolRoutes: RouteRecordRaw[] = TOOLS.map((t) => ({
  path: toolPath(t, TOOLS),
  name: t.id,
  component: t.load,
  meta: { tool: t.id, group: t.group },
}))

// A group path with several tools opens its first tool.
const groupRoutes: RouteRecordRaw[] = GROUPS.filter((g) => TOOLS.filter((t) => t.group === g.id).length > 1).map((g) => ({
  path: `/${g.id}`,
  redirect: toolPath(TOOLS.find((t) => t.group === g.id)!, TOOLS),
}))

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('./views/HomeView.vue'), meta: { full: true } },
    // an example, one job in one file (rebuild plan 4); a group single file carries none
    ...(__GROUP__ ? [] : [{ path: '/examples/:job/:id', name: 'example', component: () => import('./examples/ExampleView.vue'), meta: { full: true } }]),
    // the explorers (rebuild plan 4), one folder each; a group single file carries none
    ...(__GROUP__ ? [] : [
      { path: '/x/chat', name: 'x-chat', component: () => import('./explorers/chat/ChatStudio.vue'), meta: { full: true, explorer: 'chat' } },
      { path: '/x/transcribe', name: 'x-transcribe', component: () => import('./explorers/transcribe/Transcribe.vue'), meta: { full: true, explorer: 'transcribe' } },
      { path: '/x/character', name: 'x-character', component: () => import('./explorers/character/CharacterExplorer.vue'), meta: { full: true, explorer: 'character' } },
      { path: '/x/room', name: 'x-room', component: () => import('./explorers/room/RoomExplorer.vue'), meta: { full: true, explorer: 'room' } },
      { path: '/x/masks', name: 'x-masks', component: () => import('./explorers/masks/MaskStudio.vue'), meta: { full: true, explorer: 'masks' } },
      { path: '/x/yard', name: 'x-yard', component: () => import('./explorers/yard/Yard.vue'), meta: { full: true, explorer: 'yard' } },
    ]),
    ...toolRoutes,
    ...groupRoutes,
    // Lab pages are layout checks, not tools: they stay out of the nav and
    // the palette and draw their own shell (meta.bare).
    // A group single file carries it only in rooms, beside the room tool.
    ...(__GROUP__ && __GROUP__ !== 'rooms' ? [] : [{ path: '/lab/phone-stage', name: 'lab-phone-stage', component: () => import('./lab/PhoneStageView.vue'), meta: { bare: true } }]),
    { path: '/:rest(.*)*', name: 'missing', component: () => import('./views/MissingView.vue') },
  ],
})

// The last route is remembered so a reload returns to the same tool.
router.afterEach((to) => {
  kvPut('last-route', to.fullPath).catch(() => {
    /* private mode or storage blocked: the suite still runs, it forgets the route */
  })
})
