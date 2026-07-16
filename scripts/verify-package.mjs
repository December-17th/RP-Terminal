// Package-content guard for the P0-1 release-blocking disclosure risk.
//
// electron-builder's `files` list is easy to accidentally regress into an
// exclusion-only (all-`!`) form, which makes electron-builder inject `**/*`
// and ship the entire repo (rp-terminal-data, .claude, .scratch, docs, src,
// example cards, ...). This script inspects the built app.asar and fails hard
// if any unexpected root/resource leaked in, or if the archive or portable
// executable blew past a size budget.
//
// Run after `electron-builder --dir`:  npm run check:package

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listPackage } from '@electron/asar'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const unpackedDir = path.join(root, 'dist', 'win-unpacked')
const asarPath = path.join(unpackedDir, 'resources', 'app.asar')
const requireArtifact = process.argv.includes('--require-artifact')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

// Top-level roots that must never appear inside the shipped app.asar.
const FORBIDDEN_ROOTS = new Set([
  'rp-terminal-data',
  '.claude',
  '.worktrees',
  '.scratch',
  '.superpowers',
  '.local-notes',
  'test',
  'docs',
  'src',
  '.vscode',
  '.git'
])

const EXPECTED_ROOTS = new Set(['node_modules', 'out', 'package.json', 'resources'])
const REQUIRED_ENTRIES = [
  'out/main/index.js',
  'out/main/sandboxWorker.js',
  'out/preload/index.js',
  'out/preload/wcvPreload.js',
  'out/renderer/index.html',
  'package.json',
  'resources/icons/rp-terminal-emerald.png'
]
const ALLOWED_RESOURCE_ENTRIES = new Set([
  'resources',
  'resources/icons',
  'resources/icons/rp-terminal-emerald.png'
])
const FORBIDDEN_ENTRY_PREFIXES = [
  'node_modules/better-sqlite3/binding.gyp',
  'node_modules/better-sqlite3/deps',
  'node_modules/better-sqlite3/src'
]

// Ratchets with headroom over measured clean outputs. Raise deliberately only
// after rebuilding and auditing a legitimate size increase.
// Measured after the 2026-07-15 package audit: ASAR 53.5 MiB, portable 89.6 MiB.
const MAX_ASAR_BYTES = 65 * 1024 * 1024 // 65 MiB
const MAX_PORTABLE_BYTES = 110 * 1024 * 1024 // 110 MiB

function fail(message) {
  console.error(`check:package FAILED: ${message}`)
  process.exit(1)
}

if (!fs.existsSync(unpackedDir)) {
  fail(
    `dist/win-unpacked not found at ${unpackedDir}.\n` +
      'Build the package first, e.g. `npm run build && npx electron-builder --dir`.'
  )
}

if (!fs.existsSync(asarPath)) {
  fail(`app.asar not found at ${asarPath}. Re-run electron-builder --dir.`)
}

const asarBytes = fs.statSync(asarPath).size
if (asarBytes > MAX_ASAR_BYTES) {
  fail(
    `app.asar is ${(asarBytes / 1024 / 1024).toFixed(1)} MiB, over the ` +
      `${(MAX_ASAR_BYTES / 1024 / 1024).toFixed(0)} MiB budget. ` +
      'Something large likely leaked into the package.'
  )
}

// listPackage returns archive-absolute paths like "/out/main/index.js".
const entries = listPackage(asarPath, { isPack: false })
const topLevel = new Set()
const normalizedEntries = new Set()
for (const entry of entries) {
  const segments = entry.split(/[\\/]/).filter(Boolean)
  const normalized = segments.join('/')
  normalizedEntries.add(normalized)
  if (segments.length > 0) topLevel.add(segments[0])
}

const leaked = []
for (const name of topLevel) {
  if (FORBIDDEN_ROOTS.has(name)) leaked.push(name)
  else if (name.toLowerCase().startsWith('example')) leaked.push(name)
}

if (leaked.length > 0) {
  fail(
    `forbidden top-level root(s) found inside app.asar: ${leaked.sort().join(', ')}.\n` +
      'The electron-builder `files` allowlist likely regressed. It must stay a ' +
      'positive allowlist, not an exclusion list.'
  )
}

const unexpectedRoots = [...topLevel].filter((name) => !EXPECTED_ROOTS.has(name))
if (unexpectedRoots.length > 0) {
  fail(`unexpected top-level root(s): ${unexpectedRoots.sort().join(', ')}`)
}
const missingRoots = [...EXPECTED_ROOTS].filter((name) => !topLevel.has(name))
if (missingRoots.length > 0) {
  fail(`required top-level root(s) missing: ${missingRoots.sort().join(', ')}`)
}

const missingEntries = REQUIRED_ENTRIES.filter((entry) => !normalizedEntries.has(entry))
if (missingEntries.length > 0) {
  fail(`required packaged file(s) missing: ${missingEntries.join(', ')}`)
}
const unexpectedResources = [...normalizedEntries].filter(
  (entry) => entry.startsWith('resources') && !ALLOWED_RESOURCE_ENTRIES.has(entry)
)
if (unexpectedResources.length > 0) {
  fail(`unexpected resource(s) bundled: ${unexpectedResources.sort().join(', ')}`)
}
const forbiddenEntries = [...normalizedEntries].filter((entry) =>
  FORBIDDEN_ENTRY_PREFIXES.some((prefix) => entry === prefix || entry.startsWith(`${prefix}/`))
)
if (forbiddenEntries.length > 0) {
  fail(`build-only native source(s) bundled: ${forbiddenEntries.sort().join(', ')}`)
}

if (requireArtifact) {
  const artifactName = `${packageJson.name}-${packageJson.version}-windows-x64-portable.exe`
  const artifactPath = path.join(root, 'dist', artifactName)
  if (!fs.existsSync(artifactPath)) fail(`portable release artifact missing: dist/${artifactName}`)
  const artifactBytes = fs.statSync(artifactPath).size
  if (artifactBytes > MAX_PORTABLE_BYTES) {
    fail(
      `portable executable is ${(artifactBytes / 1024 / 1024).toFixed(1)} MiB, over the ` +
        `${MAX_PORTABLE_BYTES / 1024 / 1024} MiB budget.`
    )
  }
  console.log(
    `check:package artifact: ${artifactName}, ${(artifactBytes / 1024 / 1024).toFixed(1)} MiB`
  )
}

console.log(
  `check:package OK: app.asar ${(asarBytes / 1024 / 1024).toFixed(1)} MiB, ` +
    `top-level roots: ${[...topLevel].sort().join(', ')}`
)
