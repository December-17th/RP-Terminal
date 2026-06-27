import { defineConfig } from 'vitest/config'
import { join, resolve } from 'path'
import os from 'os'

/**
 * Vitest runs the main-process pure modules under Node. Several of them
 * transitively `import … from 'electron'` (e.g. storageService/logService) even
 * though the pure functions never call into it — so alias `electron` to a tiny
 * stub to keep those imports resolvable outside the Electron runtime.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
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
