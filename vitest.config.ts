import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { join, resolve } from 'path'
import os from 'os'

/**
 * Vitest runs the main-process pure modules under Node. Several of them
 * transitively `import … from 'electron'` (e.g. storageService/logService) even
 * though the pure functions never call into it — so alias `electron` to a tiny
 * stub to keep those imports resolvable outside the Electron runtime.
 *
 * The `.test.tsx` renderer smoke test (test/renderer/*) mounts real React trees to
 * catch a top-level render crash the pure suite cannot see; plugin-react gives it the
 * automatic JSX runtime, and each such file opts into jsdom via a `@vitest-environment`
 * docblock. The default environment stays `node` for the ~200 pure-module tests.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    env: {
      // Pin the data root to a temp dir so the dev (process.cwd()) branch of getAppDir never
      // writes into the repo during tests. Tests that mock getAppDir are unaffected.
      RPT_DATA_DIR: join(os.tmpdir(), 'rpt-vitest-data')
    },
    alias: {
      electron: resolve(process.cwd(), 'test/mocks/electron.ts'),
      // Native module built for Electron's ABI — stub it so modules that import the
      // DB layer load under plain Node. The pure helpers under test never open a DB.
      'better-sqlite3': resolve(process.cwd(), 'test/mocks/better-sqlite3.ts')
    }
  }
})
