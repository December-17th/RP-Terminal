// Package-content guard for the P0-1 release-blocking disclosure risk.
//
// electron-builder's `files` list is easy to accidentally regress into an
// exclusion-only (all-`!`) form, which makes electron-builder inject `**/*`
// and ship the entire repo (rp-terminal-data, .claude, .scratch, docs, src,
// example cards, ...). This script inspects the built app.asar and fails hard
// if any unexpected root/resource leaked in, or if the release ZIP blew past
// a size budget. When checking a release, it also verifies that the ZIP is an
// exact archive of the audited win-unpacked directory.
//
// Run after `electron-builder --dir`:  npm run check:package

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listPackage } from '@electron/asar'
import AdmZip from 'adm-zip'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isMacPackage = process.argv.includes('--mac')
const distDir = path.join(root, 'dist')

function findMacAppBundles(dir) {
  if (!fs.existsSync(dir)) return []
  const bundles = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const fullPath = path.join(dir, entry.name)
    if (entry.name.endsWith('.app')) bundles.push(fullPath)
    else bundles.push(...findMacAppBundles(fullPath))
  }
  return bundles
}

const macAppBundles = isMacPackage ? findMacAppBundles(distDir) : []
if (isMacPackage && macAppBundles.length !== 1) {
  console.error(
    `check:package FAILED: expected exactly one .app bundle under dist, found ${macAppBundles.length}`
  )
  process.exit(1)
}
const unpackedDir = isMacPackage ? macAppBundles[0] : path.join(distDir, 'win-unpacked')
const asarPath = isMacPackage
  ? path.join(unpackedDir, 'Contents', 'Resources', 'app.asar')
  : path.join(unpackedDir, 'resources', 'app.asar')
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
// Measured after the 2026-07-15 ZIP package audit: ASAR 53.5 MiB, ZIP 130.2 MiB.
const MAX_ASAR_BYTES = 65 * 1024 * 1024 // 65 MiB
const MAX_ZIP_BYTES = 145 * 1024 * 1024 // 145 MiB

function fail(message) {
  console.error(`check:package FAILED: ${message}`)
  process.exit(1)
}

if (!fs.existsSync(unpackedDir)) {
  fail(
    `unpacked application not found at ${unpackedDir}.\n` +
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

if (requireArtifact && isMacPackage) {
  const arch = process.arch
  const zipName = `${packageJson.name}-${packageJson.version}-macos-${arch}-unsigned.zip`
  const zipPath = path.join(distDir, zipName)
  if (!fs.existsSync(zipPath)) fail(`macOS artifact missing: dist/${zipName}`)
  if (fs.statSync(zipPath).size === 0) fail(`macOS artifact is empty: dist/${zipName}`)
  const zipEntries = new AdmZip(path.join(distDir, zipName))
    .getEntries()
    .map((entry) => entry.entryName.replaceAll('\\', '/'))
  const asarEntry = 'RP Terminal.app/Contents/Resources/app.asar'
  if (!zipEntries.includes(asarEntry)) fail(`required macOS ZIP file missing: ${asarEntry}`)
  const unexpectedZipRoots = zipEntries.filter(
    (entry) => entry !== 'RP Terminal.app' && !entry.startsWith('RP Terminal.app/')
  )
  if (unexpectedZipRoots.length > 0) {
    fail(`unexpected root(s) in macOS ZIP: ${unexpectedZipRoots.sort().join(', ')}`)
  }
  if (zipEntries.some((entry) => entry.split('/').includes('rp-terminal-data'))) {
    fail('user data directory bundled in macOS release ZIP')
  }

  console.log(
    `check:package artifact: ${zipName} (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MiB)`
  )
}

if (requireArtifact && !isMacPackage) {
  const artifactName = `${packageJson.name}-${packageJson.version}-windows-x64-portable.zip`
  const artifactPath = path.join(root, 'dist', artifactName)
  if (!fs.existsSync(artifactPath)) fail(`portable ZIP missing: dist/${artifactName}`)
  const artifactBytes = fs.statSync(artifactPath).size
  if (artifactBytes > MAX_ZIP_BYTES) {
    fail(
      `portable ZIP is ${(artifactBytes / 1024 / 1024).toFixed(1)} MiB, over the ` +
        `${MAX_ZIP_BYTES / 1024 / 1024} MiB budget.`
    )
  }

  const normalize = (entry) => entry.replaceAll('\\', '/').replace(/^\/+/, '')
  const zipFiles = new Set(
    new AdmZip(artifactPath)
      .getEntries()
      .filter((entry) => !entry.isDirectory)
      .map((entry) => normalize(entry.entryName))
  )
  const unpackedFiles = new Set()
  const collectUnpackedFiles = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) collectUnpackedFiles(fullPath)
      else if (entry.isFile()) unpackedFiles.add(normalize(path.relative(unpackedDir, fullPath)))
    }
  }
  collectUnpackedFiles(unpackedDir)

  const missingFromZip = [...unpackedFiles].filter((entry) => !zipFiles.has(entry))
  const unexpectedInZip = [...zipFiles].filter((entry) => !unpackedFiles.has(entry))
  if (missingFromZip.length > 0) {
    fail(`file(s) from win-unpacked missing in release ZIP: ${missingFromZip.sort().join(', ')}`)
  }
  if (unexpectedInZip.length > 0) {
    fail(`unexpected file(s) in release ZIP: ${unexpectedInZip.sort().join(', ')}`)
  }
  for (const required of ['RP Terminal.exe', 'resources/app.asar']) {
    if (!zipFiles.has(required)) fail(`required release ZIP file missing: ${required}`)
  }
  const localeFiles = [...zipFiles].filter((entry) => entry.startsWith('locales/')).sort()
  const expectedLocaleFiles = ['locales/en-US.pak', 'locales/zh-CN.pak']
  if (JSON.stringify(localeFiles) !== JSON.stringify(expectedLocaleFiles)) {
    fail(`unexpected Electron locale set: ${localeFiles.join(', ')}`)
  }
  if ([...zipFiles].some((entry) => entry.split('/').includes('rp-terminal-data'))) {
    fail('user data directory bundled in release ZIP')
  }

  console.log(
    `check:package artifact: ${artifactName}, ${(artifactBytes / 1024 / 1024).toFixed(1)} MiB, ` +
      `${zipFiles.size} runtime files`
  )
}

console.log(
  `check:package OK: app.asar ${(asarBytes / 1024 / 1024).toFixed(1)} MiB, ` +
    `top-level roots: ${[...topLevel].sort().join(', ')}`
)
