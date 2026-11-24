import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'

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
    define: { __SINGLE__: JSON.stringify(single) },
    build: {
      outDir: single ? 'dist/single' : 'dist/hosted',
      emptyOutDir: true,
      target: 'es2022',
      assetsInlineLimit: single ? 100_000_000 : 4096,
    },
  }
})
