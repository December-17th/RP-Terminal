import fs from 'fs'
import path from 'path'
import {
  getAppDir,
  ensureDir,
  readJsonSync,
  writeJsonSyncAtomic,
  listDirectoriesSync
} from './storageService'
import { log } from './logService'
import { PluginManifestSchema, PluginManifest, PluginState, InstalledPlugin } from '../types/plugin'

/**
 * Plugin host/loader (P2). Standalone plugins are folders under
 * `userData/rp-terminal-data/plugins/<id>/` containing a `manifest.json` + an
 * entry script. This service discovers them, reads/validates manifests, serves
 * entry code to the renderer (which runs it in a sandboxed iframe), and tracks
 * per-profile enable + granted-permission state. It never executes plugin code
 * itself — execution is the renderer's sandbox.
 */

const pluginsDir = (): string => path.join(getAppDir(), 'plugins')
const pluginDir = (id: string): string => path.join(pluginsDir(), id)
const statePath = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'plugins-state.json')

// --- per-profile enable/permission state ---
const readState = (profileId: string): Record<string, PluginState> =>
  readJsonSync<Record<string, PluginState>>(statePath(profileId)) || {}

const writeState = (profileId: string, state: Record<string, PluginState>): void => {
  try {
    writeJsonSyncAtomic(statePath(profileId), state)
  } catch (e: any) {
    log('error', 'Failed to persist plugin state', e?.message || String(e))
  }
}

const readManifest = (dir: string): PluginManifest | null => {
  const raw = readJsonSync<unknown>(path.join(dir, 'manifest.json'))
  if (!raw) return null
  const parsed = PluginManifestSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** Discover every installed plugin, merged with this profile's enable/grant state. */
export const listPlugins = (profileId: string): InstalledPlugin[] => {
  ensureDir(pluginsDir())
  const state = readState(profileId)
  const out: InstalledPlugin[] = []

  for (const id of listDirectoriesSync(pluginsDir())) {
    const dir = pluginDir(id)
    const manifest = readManifest(dir)
    const st = state[id] || { enabled: false, grants: [] }

    if (!manifest) {
      out.push({
        id,
        manifest: PluginManifestSchema.parse({ id, name: id }),
        enabled: false,
        grants: st.grants || [],
        code: '',
        error: 'Invalid or missing manifest.json'
      })
      continue
    }

    let code = ''
    let error: string | undefined
    try {
      code = fs.readFileSync(path.join(dir, manifest.entry), 'utf-8')
    } catch {
      error = `Entry script not found: ${manifest.entry}`
    }

    out.push({
      id,
      manifest,
      enabled: !!st.enabled && !error,
      grants: st.grants || [],
      code,
      error
    })
  }

  return out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
}

/** Install (or update) a plugin from a source folder containing manifest.json. */
export const installFromFolder = (srcDir: string): string => {
  const manifest = readManifest(srcDir)
  if (!manifest) throw new Error('No valid manifest.json found in the selected folder')

  const dest = pluginDir(manifest.id)
  ensureDir(pluginsDir())
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true })
  fs.cpSync(srcDir, dest, { recursive: true })
  log('info', `Installed plugin ${manifest.id} (${manifest.name})`)
  return manifest.id
}

export const uninstall = (profileId: string, id: string): void => {
  const dir = pluginDir(id)
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  const state = readState(profileId)
  delete state[id]
  writeState(profileId, state)
  log('info', `Uninstalled plugin ${id}`)
}

/** Enable/disable a plugin; `grants` (if given) replaces the approved permission set. */
export const setEnabled = (
  profileId: string,
  id: string,
  enabled: boolean,
  grants?: string[]
): PluginState => {
  const state = readState(profileId)
  const prev = state[id] || { enabled: false, grants: [] }
  const next: PluginState = {
    enabled,
    grants: grants !== undefined ? grants : prev.grants
  }
  state[id] = next
  writeState(profileId, state)
  return next
}

export const setGrants = (profileId: string, id: string, grants: string[]): PluginState => {
  const state = readState(profileId)
  const next: PluginState = { enabled: state[id]?.enabled ?? false, grants }
  state[id] = next
  writeState(profileId, state)
  return next
}

/** Write a small, headless example plugin into the plugins dir (for testing). */
export const scaffoldExample = (): string => {
  const id = 'com.rpterminal.example'
  const dir = pluginDir(id)
  ensureDir(dir)

  const manifest: PluginManifest = PluginManifestSchema.parse({
    id,
    name: 'Example Plugin',
    version: '1.0.0',
    description: 'Panel counting generations this profile (+ reset), and a /hello slash command.',
    author: 'RP Terminal',
    type: 'app-extension',
    entry: 'main.js',
    apiVersion: 'rpt.v1',
    permissions: ['vars:read', 'vars:write', 'ui:toast', 'ui:panel', 'slash']
  })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')

  const main = `// Example RP Terminal plugin (rpt.v1) — renders a panel (P3).
const root = document.createElement('div')
document.body.appendChild(root)

async function render() {
  const n = (await rpt.global.get('pluginTurns')) || 0
  root.innerHTML = '<div style="margin-bottom:6px">Generations this profile: <b>' + n + '</b></div>'
  const btn = document.createElement('button')
  btn.textContent = 'Reset count'
  btn.onclick = async function () {
    await rpt.global.set('pluginTurns', 0)
    rpt.ui.toast('Reset')
    render()
  }
  root.appendChild(btn)
}

rpt.ui.registerPanel({ title: 'Example Plugin' })
rpt.slash.registerCommand('hello', function (args) {
  rpt.ui.toast('Hello ' + (args[0] || 'world') + '!')
}, { description: 'Greet someone: /hello [name]' })
rpt.on('ready', render)
rpt.on('generation:end', async function () {
  await rpt.global.inc('pluginTurns')
  render()
})
render()
`
  fs.writeFileSync(path.join(dir, 'main.js'), main, 'utf-8')
  log('info', `Scaffolded example plugin at ${dir}`)
  return id
}
