import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'

// Guards the P0-1 packaging fix: electron-builder's `files` list MUST stay a
// positive allowlist. If it regresses to an exclusion-only (all-`!`) form,
// electron-builder injects `**/*` and ships the entire repo (rp-terminal-data,
// .claude, .scratch, docs, src, example cards, ...). This test fails CI on that
// regression without needing a packaged build. See scripts/verify-package.mjs
// for the complementary check against an actual built app.asar.

// Every non-negated pattern must live within this allowed set.
const ALLOWED = new Set(['out/**', 'package.json', 'resources/icons/rp-terminal-emerald.png'])

const RUNTIME_DEPENDENCIES = [
  '@electron-toolkit/preload',
  '@electron-toolkit/utils',
  '@jitl/quickjs-singlefile-browser-release-sync',
  'adm-zip',
  'better-sqlite3',
  'jquery',
  'lodash',
  'pinia',
  'quickjs-emscripten',
  'uuid',
  'vue',
  'vue-router',
  'yaml',
  'zod'
]

describe('electron-builder.yml files allowlist', () => {
  const ymlPath = path.resolve(__dirname, '..', 'electron-builder.yml')
  const config = parse(fs.readFileSync(ymlPath, 'utf8')) as {
    files?: unknown
    win?: {
      target?: Array<{ target?: string; arch?: string[] }>
      artifactName?: string
      electronLanguages?: string[]
    }
  }

  it('defines a files list', () => {
    expect(Array.isArray(config.files)).toBe(true)
    expect((config.files as unknown[]).length).toBeGreaterThan(0)
  })

  it('is a positive allowlist, not an exclusion-only list', () => {
    const files = config.files as string[]
    const positives = files.filter((p) => !p.startsWith('!'))
    // At least one positive pattern — an all-`!` list is the exact regression
    // that makes electron-builder default to including everything.
    expect(positives.length).toBeGreaterThan(0)
  })

  it('every non-negated pattern is within the allowed set', () => {
    const files = config.files as string[]
    const offenders = files.filter((p) => !p.startsWith('!') && !ALLOWED.has(p))
    expect(offenders).toEqual([])
  })

  it('builds one x64 portable Windows ZIP', () => {
    expect(config.win?.target).toEqual([{ target: 'zip', arch: ['x64'] }])
    expect(config.win?.artifactName).toBe('${name}-${version}-windows-${arch}-portable.${ext}')
  })

  it('ships only the Electron locales supported by the app UI', () => {
    expect(config.win?.electronLanguages).toEqual(['en-US', 'zh-CN'])
  })

  it('keeps only runtime-required modules in production dependencies', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')
    ) as { dependencies?: Record<string, string> }
    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual(RUNTIME_DEPENDENCIES)
  })
})
