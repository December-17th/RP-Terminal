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
import { ArtifactScope, ScopeContext, ScopeMeta, isScopeActive } from './regexService'

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

export interface StoredScript {
  name: string
  code: string
}

export interface ScriptInfo extends StoredScript {
  file: string
  scope: ArtifactScope
  owner?: string
  disabled: boolean
  /** Remote URLs this script pulls via import directives (for the UI + grant prompt). */
  remoteHosts: string[]
}

interface ScriptMeta extends ScopeMeta {
  disabled?: boolean
}

const scriptsDir = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'scripts')
const scriptPath = (profileId: string, file: string): string =>
  path.join(scriptsDir(profileId), file)
const metaPath = (profileId: string): string => path.join(scriptsDir(profileId), '_meta.json')
const readMeta = (profileId: string): Record<string, ScriptMeta> =>
  readJsonSync<Record<string, ScriptMeta>>(metaPath(profileId)) || {}
const writeMeta = (profileId: string, meta: Record<string, ScriptMeta>): void =>
  writeJsonSyncAtomic(metaPath(profileId), meta)

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
  Array.from(new Set(extractImports(code).map(urlHost).filter((h): h is string => !!h)))

// --- Store CRUD -------------------------------------------------------------

const fileMeta = (meta: Record<string, ScriptMeta>, file: string): ScriptMeta =>
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
  const meta = readMeta(profileId)
  const prev = meta[file] || {}
  // Preserve the disabled flag across scope changes; drop the owner for global.
  meta[file] = { scope, owner: scope === 'global' ? undefined : owner, disabled: prev.disabled }
  writeMeta(profileId, meta)
}

export const setScriptDisabled = (profileId: string, file: string, disabled: boolean): void => {
  if (isUnsafe(file)) return
  const meta = readMeta(profileId)
  const prev = meta[file] || { scope: 'global' as ArtifactScope }
  meta[file] = { ...prev, disabled }
  writeMeta(profileId, meta)
}

export const deleteScript = (profileId: string, file: string): void => {
  if (isUnsafe(file)) return
  const p = scriptPath(profileId, file)
  if (fs.existsSync(p)) fs.unlinkSync(p)
  const meta = readMeta(profileId)
  if (meta[file]) {
    delete meta[file]
    writeMeta(profileId, meta)
  }
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
