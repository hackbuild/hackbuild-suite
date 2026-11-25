import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'

const HERE = new URL('.', import.meta.url).pathname

// Two outputs. Hosted (default): ES modules with one lazy chunk per tool,
// for GitHub Pages and any http host, relative paths so it works under
// /hackbuild-suite/. Single (--mode single): one HTML file with every chunk
// inlined, the only form Chrome opens from file:// because it blocks module
// scripts on that origin.
export default defineConfig(({ mode }) => {
  const single = mode === 'single'
  return {
    base: './',
    plugins: single ? [vue(), viteSingleFile({ removeViteModuleLoader: true })] : [vue()],
    // a library's fold, packages/<name>/how.ts in its tarball (design D8);
    // the exports map leaves it out, so it resolves by path
    resolve: { alias: [{ find: /^@hackbuild\/([a-z-]+)\/how$/, replacement: `${HERE}node_modules/@hackbuild/$1/how.ts` }] },
    define: { __SINGLE__: JSON.stringify(single) },
    build: {
      outDir: single ? 'dist/single' : 'dist/hosted',
      emptyOutDir: true,
      target: 'es2022',
      assetsInlineLimit: single ? 100_000_000 : 4096,
    },
  }
})
