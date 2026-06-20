import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

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
    alias: {
      electron: resolve(process.cwd(), 'test/mocks/electron.ts')
    }
  }
})
