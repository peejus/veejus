import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = {
  '@shared': resolve(import.meta.dirname, 'src/shared'),
  '@core': resolve(import.meta.dirname, 'src/core'),
}

export default defineConfig({
  main: { resolve: { alias } },
  preload: {
    resolve: { alias },
    build: {
      // Sandboxed preloads cannot require sibling chunks, so build each entry self-contained.
      isolatedEntries: true,
      externalizeDeps: false,
      rollupOptions: {
        input: {
          control: resolve(import.meta.dirname, 'src/preload/control.ts'),
          output: resolve(import.meta.dirname, 'src/preload/output.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    resolve: { alias },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          control: resolve(import.meta.dirname, 'src/renderer/control/index.html'),
          output: resolve(import.meta.dirname, 'src/renderer/output/index.html'),
        },
      },
    },
  },
})
