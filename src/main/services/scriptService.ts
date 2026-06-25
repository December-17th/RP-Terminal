import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  getAppDir,
  ensureDir,
  readJsonSync,
  writeJsonSyncAtomic,
  listFilesSync
} from './storageService'
import { ArtifactScope, ScopeContext, ScopeMeta, isScopeActive } from '../../shared/artifactScope'
import { StoredScript, ScriptInfo } from '../../shared/scriptTypes'
import { readScopeMeta, setScope, setDisabled, removeScopeEntry } from './scopeMeta'

/**
 * Profile-level scripts library (companion to the regex store), so card scripts gain
 * the same global/world/session scope model as regex (Track S §6). A script is a
 * `{ name, code }` JSON file; scope/owner/enabled live in a `_meta.json` sidecar.
 * Card-embedded scripts (`rp_terminal.scripts`) stay on the card and are merged in at
 * runtime as the World scope — this store adds Global/Session (and extra World) scripts.
 *
 * A script may import remote ES modules. We don't fetch those in main; the iframe loads
 * them natively as a module when the per-card `remoteScripts` grant is on (1B). Here we
 * only detect import hosts (`extractImportHosts`/`runtimeImportHosts`) for the grant + CSP.
 */

// Re-export the shared types so existing importers keep their path (single source: src/shared).
export type { StoredScript, ScriptInfo }

const scriptsDir = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'scripts')
const scriptPath = (profileId: string, file: string): string =>
  path.join(scriptsDir(profileId), file)
// Scope/owner/disabled live in a `_meta.json` sidecar (shared scopeMeta helper).
const readMeta = (profileId: string): Record<string, ScopeMeta> =>
  readScopeMeta(scriptsDir(profileId))

const isUnsafe = (file: string): boolean =>
  file.includes('/') || file.includes('\\') || file.includes('..') || file.startsWith('_')

// --- Remote import detection (pure) ----------------------------------------
//
// Scripts that pull remote ES modules are run natively as <script type="module"> (1B),
// so we don't fetch/inline here — we only detect the URLs they import to (a) report the
// hosts for the per-card remote-scripts grant and (b) build the iframe CSP allow-list.

const IMPORT_PATTERNS: RegExp[] = [
  /(?:import|export)[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g, // import/export … from '…'
  /\bimport\s*['"]([^'"]+)['"]/g, // import '…' (side-effect)
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import('…') (dynamic)
  /\/\/[ \t]*@import[ \t]+['"]?([^'"\s;]+)/g // // @import … directive
]

/** URLs/specifiers a script imports (deduped). Pure. */
export const extractImports = (code: string): string[] => {
  const out: string[] = []
  const c = code || ''
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(c))) {
      const url = m[1].trim()
      if (url && !out.includes(url)) out.push(url)
    }
  }
  return out
}

const urlHost = (u: string): string | null => {
  try {
    return new URL(u).host || null
  } catch {
    return null // bare/relative specifier — no host
  }
}

/** Distinct remote hosts a script imports from (absolute URLs only). */
export const extractImportHosts = (code: string): string[] =>
  Array.from(
    new Set(
      extractImports(code)
        .map(urlHost)
        .filter((h): h is string => !!h)
    )
  )

// --- Store CRUD -------------------------------------------------------------

const fileMeta = (meta: Record<string, ScopeMeta>, file: string): ScopeMeta =>
  meta[file] ?? { scope: 'global' }

export const listScripts = (profileId: string): ScriptInfo[] => {
  const dir = scriptsDir(profileId)
  if (!fs.existsSync(dir)) return []
  const meta = readMeta(profileId)
  const out: ScriptInfo[] = []
  for (const file of listFilesSync(dir)) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue
    const data = readJsonSync<StoredScript>(scriptPath(profileId, file))
    if (!data) continue
    const m = fileMeta(meta, file)
    out.push({
      file,
      name: data.name || 'Untitled script',
      code: data.code || '',
      scope: m.scope ?? 'global',
      owner: m.owner,
      disabled: m.disabled === true,
      remoteHosts: extractImportHosts(data.code || '')
    })
  }
  return out
}

export const getScript = (profileId: string, file: string): StoredScript | null => {
  if (isUnsafe(file)) return null
  return readJsonSync<StoredScript>(scriptPath(profileId, file))
}

/** Create a new script file; returns its filename. */
export const saveScript = (
  profileId: string,
  script: StoredScript,
  scope: ArtifactScope = 'global',
  owner?: string
): string => {
  ensureDir(scriptsDir(profileId))
  const file = `${randomUUID()}.json`
  writeJsonSyncAtomic(scriptPath(profileId, file), {
    name: script.name || 'script',
    code: script.code || ''
  })
  if (scope !== 'global' || owner) setScriptScope(profileId, file, scope, owner)
  return file
}

export const updateScript = (
  profileId: string,
  file: string,
  patch: Partial<StoredScript>
): void => {
  if (isUnsafe(file)) return
  const cur = readJsonSync<StoredScript>(scriptPath(profileId, file))
  if (!cur) return
  writeJsonSyncAtomic(scriptPath(profileId, file), {
    name: patch.name ?? cur.name,
    code: patch.code ?? cur.code
  })
}

export const setScriptScope = (
  profileId: string,
  file: string,
  scope: ArtifactScope,
  owner?: string
): void => {
  if (isUnsafe(file)) return
  setScope(scriptsDir(profileId), file, scope, owner)
}

export const setScriptDisabled = (profileId: string, file: string, disabled: boolean): void => {
  if (isUnsafe(file)) return
  setDisabled(scriptsDir(profileId), file, disabled)
}

export const deleteScript = (profileId: string, file: string): void => {
  if (isUnsafe(file)) return
  const p = scriptPath(profileId, file)
  if (fs.existsSync(p)) fs.unlinkSync(p)
  removeScopeEntry(scriptsDir(profileId), file)
}

/**
 * Delete every script bound to a given scope+owner (e.g. all `preset`-scoped scripts a
 * preset bundled), so deleting that owner doesn't leave orphans. Returns the count removed.
 */
export const deleteScriptsByOwner = (
  profileId: string,
  scope: ArtifactScope,
  owner: string
): number => {
  let removed = 0
  for (const s of listScripts(profileId)) {
    if (s.scope === scope && s.owner === owner) {
      deleteScript(profileId, s.file)
      removed++
    }
  }
  return removed
}

/** Enabled scripts whose scope is active for this card/chat context, in name order. */
export const getActiveScripts = (profileId: string, ctx: ScopeContext): StoredScript[] => {
  return listScripts(profileId)
    .filter((s) => !s.disabled && isScopeActive({ scope: s.scope, owner: s.owner }, ctx))
    .map((s) => ({ name: s.name, code: s.code }))
}

/** The remote hosts the active runtime scripts import from — for the grant + CSP. */
export const runtimeImportHosts = (scripts: StoredScript[]): string[] => {
  const hosts = new Set<string>()
  for (const s of scripts) for (const h of extractImportHosts(s.code)) hosts.add(h)
  return Array.from(hosts)
}

// --- Import from JSON (Tavern Helper script format) -------------------------

export interface ImportedScript {
  name: string
  code: string
  enabled: boolean
}

/** Append auto-`registerButton` calls for a TH script's declarative `button.buttons[]`
 * so they appear in the ☰ Actions menu; clicking one emits the button name as a local
 * event (`eventEmit`) the script's content can listen for via `eventOn`. */
const withButtons = (code: string, buttons: string[]): string => {
  if (buttons.length === 0) return code
  return (
    code +
    `\n;(function(){var __b=${JSON.stringify(buttons)};` +
    `if(typeof rpt!=='undefined'&&rpt.ui&&rpt.ui.registerButton){__b.forEach(function(n){` +
    `rpt.ui.registerButton({id:n,label:n},function(){try{if(typeof eventEmit==='function')eventEmit(n);}catch(e){}});});}})();\n`
  )
}

/**
 * Normalize an imported scripts payload — a Tavern Helper script object
 * (`{type:'script', name, enabled, content, button:{buttons:[{name,visible}]}}`), an array
 * of them, or our native `{name, code}` — into store scripts. The declarative buttons are
 * baked into the code as auto-registered menu buttons. Pure.
 */
export const normalizeImportedScripts = (raw: any): ImportedScript[] => {
  const items = Array.isArray(raw) ? raw : [raw]
  const out: ImportedScript[] = []
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const code =
      typeof it.content === 'string' ? it.content : typeof it.code === 'string' ? it.code : ''
    if (!code) continue
    const buttons = Array.isArray(it.button?.buttons)
      ? it.button.buttons
          .filter((b: any) => b && b.visible !== false && b.name)
          .map((b: any) => String(b.name))
      : []
    out.push({
      name: (typeof it.name === 'string' && it.name) || 'Imported Script',
      code: withButtons(code, buttons),
      enabled: it.enabled !== false
    })
  }
  return out
}

/** Import one JSON file of TH/native scripts into the store at a scope. Returns the count. */
export const importScriptsFromFile = (
  profileId: string,
  filePath: string,
  scope: ArtifactScope = 'global',
  owner?: string
): number => {
  let raw: any
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return 0
  }
  let count = 0
  for (const s of normalizeImportedScripts(raw)) {
    const file = saveScript(profileId, { name: s.name, code: s.code }, scope, owner)
    if (!s.enabled) setScriptDisabled(profileId, file, true)
    count++
  }
  return count
}
