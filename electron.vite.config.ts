import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // Two entries: the app entry (index) + the sandbox worker thread (T3.2),
        // each emitted to out/main/. sandboxService spawns out/main/sandboxWorker.js.
        input: {
          index: resolve('src/main/index.ts'),
          sandboxWorker: resolve('src/main/workers/sandboxWorker.ts')
        },
        // Native/WASM modules: resolve at runtime, don't bundle their binaries.
        external: [
          'better-sqlite3',
          'quickjs-emscripten',
          '@jitl/quickjs-wasmfile-release-sync',
          'adm-zip'
        ]
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        // The host preload (full window.api) + a separate locked-down preload for
        // WebContentsView card-UI panels (minimal host bridge only).
        input: {
          index: resolve('src/preload/index.ts'),
          wcvPreload: resolve('src/preload/wcvPreload.ts')
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
