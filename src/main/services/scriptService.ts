import fs from 'fs'
import path from 'path'
import { randomUUID, createHash } from 'crypto'
import {
  getAppDir,
  ensureDir,
  readJsonSync,
  writeJsonSyncAtomic,
  listFilesSync
} from './storageService'
import { ArtifactScope, ScopeContext, ScopeMeta, isScopeActive } from './regexService'
import { log } from './logService'

/**
 * Profile-level scripts library (companion to the regex store), so card scripts gain
 * the same global/world/session scope model as regex (Track S §6). A script is a
 * `{ name, code }` JSON file; scope/owner/enabled live in a `_meta.json` sidecar.
 * Card-embedded scripts (`rp_terminal.scripts`) stay on the card and are merged in at
 * runtime as the World scope — this store adds Global/Session (and extra World) scripts.
 *
 * Scripts run in the same sandboxed iframe as card scripts (no network at runtime), but
 * their code may carry remote `import` directives that the MAIN process resolves at load
 * time (fetch + cache) — see resolveRemoteImports. The iframe stays network-isolated.
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
const cacheDir = (profileId: string): string => path.join(scriptsDir(profileId), '_cache')

const readMeta = (profileId: string): Record<string, ScriptMeta> =>
  readJsonSync<Record<string, ScriptMeta>>(metaPath(profileId)) || {}
const writeMeta = (profileId: string, meta: Record<string, ScriptMeta>): void =>
  writeJsonSyncAtomic(metaPath(profileId), meta)

const isUnsafe = (file: string): boolean =>
  file.includes('/') || file.includes('\\') || file.includes('..') || file.startsWith('_')

// --- Remote import directives (pure) ---------------------------------------

// Matches a whole line that is either `import "URL"` / `import 'URL'` or a
// `// @import URL` comment directive (the comment form may omit quotes). Classic
// (non-module) scripts can't use real ES imports, so these lines are extracted and
// replaced with the fetched code inline. Group 2 is the URL (group 1 is the optional quote).
const IMPORT_LINE =
  /^[ \t]*(?:\/\/[ \t]*@import[ \t]+|import[ \t]+)(['"]?)([^'"\s;]+)\1[ \t]*;?[ \t]*$/gm

/** URLs a script imports (deduped, in first-seen order). Pure. */
export const extractImports = (code: string): string[] => {
  const out: string[] = []
  for (const m of code.matchAll(IMPORT_LINE)) {
    const url = m[2].trim()
    if (url && !out.includes(url)) out.push(url)
  }
  return out
}

/**
 * Replace each import directive line with the fetched remote code (or a comment when a
 * URL couldn't be resolved / wasn't allowed). Pure — the fetching is done separately so
 * this stays testable. Unresolved imports are neutralized so a script never hard-errors.
 */
export const inlineImports = (code: string, resolved: Record<string, string>): string =>
  code.replace(IMPORT_LINE, (_full, _quote: string, url: string) => {
    const key = String(url).trim()
    if (Object.prototype.hasOwnProperty.call(resolved, key)) {
      return `/* @import ${key} */\n${resolved[key]}\n/* end @import ${key} */`
    }
    return `/* @import ${key} — not loaded (remote scripts not allowed or fetch failed) */`
  })

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

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
      remoteHosts: extractImports(data.code || '').map(hostOf)
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

// --- Remote import resolution (main-process fetch + cache) ------------------

const cachePathFor = (profileId: string, url: string): string =>
  path.join(cacheDir(profileId), `${createHash('sha256').update(url).digest('hex')}.js`)

/**
 * Fetch a remote script (https only), caching to disk so a granted world loads offline
 * after the first fetch. Returns the JS source or null on failure. Main process only.
 */
const fetchRemote = async (profileId: string, url: string): Promise<string | null> => {
  if (!/^https:\/\//i.test(url)) {
    log('error', `remote script import blocked (not https): ${url}`)
    return null
  }
  const cache = cachePathFor(profileId, url)
  const cached = readCached(cache)
  if (cached != null) return cached
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    ensureDir(cacheDir(profileId))
    fs.writeFileSync(cache, text, 'utf-8')
    log('info', `fetched remote script ${url} (${text.length} bytes, cached)`)
    return text
  } catch (err: any) {
    log('error', `failed to fetch remote script ${url}: ${err?.message || err}`)
    return null
  }
}

const readCached = (cache: string): string | null => {
  try {
    return fs.existsSync(cache) ? fs.readFileSync(cache, 'utf-8') : null
  } catch {
    return null
  }
}

/**
 * Resolve a script's remote import directives. When `allow` is false the directives are
 * neutralized (no fetch) and the hosts are reported so the caller can prompt for a grant.
 * Returns the rewritten code plus the set of remote hosts the script referenced.
 */
export const resolveRemoteImports = async (
  profileId: string,
  code: string,
  allow: boolean
): Promise<{ code: string; hosts: string[] }> => {
  const urls = extractImports(code)
  const hosts = Array.from(new Set(urls.map(hostOf)))
  if (urls.length === 0) return { code, hosts }
  const resolved: Record<string, string> = {}
  if (allow) {
    for (const url of urls) {
      const js = await fetchRemote(profileId, url)
      if (js != null) resolved[url] = js
    }
  }
  return { code: inlineImports(code, resolved), hosts }
}
