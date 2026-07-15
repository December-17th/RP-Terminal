// Package-content guard for the P0-1 release-blocking disclosure risk.
//
// electron-builder's `files` list is easy to accidentally regress into an
// exclusion-only (all-`!`) form, which makes electron-builder inject `**/*`
// and ship the entire repo (rp-terminal-data, .claude, .scratch, docs, src,
// example cards, ...). This script inspects the built app.asar and fails hard
// if any forbidden top-level root leaked in, or if the archive blew past a
// size budget (a ratchet with headroom over the measured clean size).
//
// Run after `electron-builder --dir`:  npm run check:package

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listPackage } from '@electron/asar'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const unpackedDir = path.join(root, 'dist', 'win-unpacked')
const asarPath = path.join(unpackedDir, 'resources', 'app.asar')

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

// Byte budget: a ratchet set to ~1.2x the measured clean ASAR size. Raise it
// deliberately (with a rebuild + re-measure) only when the app legitimately
// grows; a sudden jump usually means unwanted content leaked in.
// Measured clean size: ~84.9 MiB (2026-07-15). 1.2x ratchet => 102 MiB.
const MAX_ASAR_BYTES = 102 * 1024 * 1024 // 102 MiB

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
for (const entry of entries) {
  const segments = entry.split(/[\\/]/).filter(Boolean)
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
      'positive allowlist (out/**, package.json, resources/**), not an exclusion list.'
  )
}

// Sanity: the app's actual entry point must be present.
if (!topLevel.has('out')) {
  fail('expected `out/` (the app entry point) inside app.asar but it is missing.')
}

console.log(
  `check:package OK: app.asar ${(asarBytes / 1024 / 1024).toFixed(1)} MiB, ` +
    `top-level roots: ${[...topLevel].sort().join(', ')}`
)
