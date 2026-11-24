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
    { path: '/', name: 'home', component: () => import('./views/HomeView.vue') },
    ...toolRoutes,
    ...groupRoutes,
    { path: '/:rest(.*)*', name: 'missing', component: () => import('./views/MissingView.vue') },
  ],
})

// The last route is remembered so a reload returns to the same tool.
router.afterEach((to) => {
  kvPut('last-route', to.fullPath).catch(() => {
    /* private mode or storage blocked: the suite still runs, it forgets the route */
  })
})
