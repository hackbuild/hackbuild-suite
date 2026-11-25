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

// Two outputs. Hosted (default): ES modules with one lazy chunk per tool,
// for GitHub Pages and any http host, relative paths so it works under
// /hackbuild-suite/. Single (--mode single): one HTML file with every chunk
// inlined, the only form Chrome opens from file:// because it blocks module
// scripts on that origin.
export default defineConfig(({ mode }) => {
  const single = mode === 'single'
  return {
    base: './',
    plugins: single ? [unusedWasmUrl, vue(), viteSingleFile({ removeViteModuleLoader: true })] : [vue()],
    // a library's fold, packages/<name>/how.ts in its tarball (design D8);
    // the exports map leaves it out, so it resolves by path
    resolve: { alias: [{ find: /^@hackbuild\/([a-z-]+)\/how$/, replacement: `${HERE}node_modules/@hackbuild/$1/how.ts` }] },
    define: { __SINGLE__: JSON.stringify(single) },
    build: {
      outDir: single ? 'dist/single' : 'dist/hosted',
      emptyOutDir: true,
      target: 'es2022',
      assetsInlineLimit: single ? 100_000_000 : 4096,
      // three.js in two shared chunks, the core (math, scene, loaders) and the
      // webgl renderer, so neither nears the tool chunk budget (design 5 item 11)
      rollupOptions: single ? {} : {
        output: {
          manualChunks(id: string) {
            if (id.includes('/node_modules/three/build/three.core.js')) return 'three'
            if (id.includes('/node_modules/three/build/three.module.js')) return 'three-gl'
            return undefined
          },
        },
      },
    },
  }
})
