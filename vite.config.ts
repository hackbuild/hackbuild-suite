import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'

const HERE = new URL('.', import.meta.url).pathname

// Each wasm core ships twice in the bindgen glue: the base64 copy its load()
// decodes, and a default `new URL('<core>_bg.wasm', import.meta.url)` that
// load() never reaches because it always passes bytes or a URL. Vite inlines
// that default too, so the single file carried 7 cores twice (883,692 B raw,
// measured). Off import.meta.url, Vite leaves it alone.
const unusedWasmUrl = {
  name: 'suite-unused-wasm-url',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!/\/node_modules\/@hackbuild\/[^/]+\/dist\/wasm\/[^/]+\.js$/.test(id)) return null
    const out = code.replace(/new URL\((['"])([\w-]+_bg\.wasm)\1, import\.meta\.url\)/g, 'new URL($1$2$1, location.href)')
    return out === code ? null : { code: out, map: null }
  },
}

// A group single file (design D11) carries one group's tools: the registry
// loses every other group's line before Rollup sees it, so their dynamic
// imports, and the views behind them, never enter the bundle.
const onlyGroup = (group: string) => ({
  name: 'suite-only-group',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.endsWith('/src/tools/registry.ts')) return null
    const lines = code.split('\n')
    const kept = lines.filter((l) => !/^\s*defineTool\(\{ id: '[a-z-]+', group: '/.test(l) || l.includes(`group: '${group}'`))
    if (kept.length === lines.length) throw new Error(`group ${group}: the registry has no lines to drop`)
    return { code: kept.join('\n'), map: null }
  },
})

// Three outputs. Hosted (default): ES modules with one lazy chunk per tool,
// for GitHub Pages and any http host, relative paths so it works under
// /hackbuild-suite/. Single (--mode single): one HTML file with every chunk
// inlined, the only form Chrome opens from file:// because it blocks module
// scripts on that origin; the smokes run on it. Group (--mode group-<id>,
// through tools/build-groups.mjs): the single file of one tool group.
export default defineConfig(({ mode }) => {
  const group = mode.startsWith('group-') ? mode.slice(6) : ''
  const single = mode === 'single' || !!group
  return {
    base: './',
    // public/ holds the isolation service worker (design 5 item 10), for the
    // hosted build only, at the root so its scope covers the page. The single
    // file builds never carry it: file:// has no service workers.
    publicDir: single ? false : 'public',
    plugins: single ? [unusedWasmUrl, ...(group ? [onlyGroup(group)] : []), vue(), viteSingleFile({ removeViteModuleLoader: true })] : [vue()],
    // a library's fold, packages/<name>/how.ts in its tarball (design D8);
    // the exports map leaves it out, so it resolves by path
    resolve: { alias: [{ find: /^@hackbuild\/([a-z-]+)\/how$/, replacement: `${HERE}node_modules/@hackbuild/$1/how.ts` }] },
    define: { __SINGLE__: JSON.stringify(single), __GROUP__: JSON.stringify(group) },
    build: {
      outDir: group ? `dist/groups/${group}` : single ? 'dist/single' : 'dist/hosted',
      emptyOutDir: true,
      target: 'es2022',
      assetsInlineLimit: single ? 100_000_000 : 4096,
      // three.js in shared chunks, the core (math, scene, loaders), the webgl
      // renderer, and the webgpu renderer and its node language (the yard's), so none nears the tool
      // chunk budget (design 5 item 11)
      rollupOptions: single ? {} : {
        output: {
          manualChunks(id: string) {
            if (id.includes('/node_modules/three/build/three.core.js')) return 'three'
            if (id.includes('/node_modules/three/build/three.module.js')) return 'three-gl'
            if (id.includes('/node_modules/three/build/three.webgpu.js')) return 'three-gpu'
            if (id.includes('/node_modules/three/build/three.tsl.js')) return 'three-tsl'
            return undefined
          },
        },
      },
    },
  }
})
