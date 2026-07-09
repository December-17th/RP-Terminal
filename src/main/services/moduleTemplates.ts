// The agent library (agent & memory UX WP-G; spec §2): built-in module templates compiled into the
// app + a per-profile USER library of saved modules. Both sides serve the palette's "Agent library"
// section over IPC (list-module-templates / get-module-template) and hand the SAME ModulePayload the
// `.rptmodule` import flow does — the renderer inserts it via the one existing path
// (workflowEditorStore.insertModule: remint ids, pre-group, name, collapse). No new insert machinery.
//
//  · Built-ins are code-built (a pure code const): v1 = "Table memory", EXTRACTED from the WP-C
//    merged-default template via the same buildModuleEnvelope walk the module exporter uses — so the
//    palette insert is byte-for-byte the group a fresh seed carries (nodes + internal edges + exposed
//    + note), and it can't drift from the seeded doc (one source of truth: defaultMemoryTemplate.ts).
//  · The user library persists as `.rptmodule` ENVELOPE JSON files under the profile's workflows dir
//    (`workflows/_library/…`), reusing serialize/parseModuleEnvelope — the on-disk format IS the
//    share-file format, and the `_` prefix keeps workflowService's doc scan from picking them up
//    (listWorkflows skips `_`-prefixed entries; listFilesSync only returns files, so the
//    subdirectory itself is invisible to it either way — workflowService.ts:185-186).
//  · Fail-soft everywhere: an unreadable/invalid library file is skipped + logged, never thrown
//    across IPC.

import * as path from 'path'
import { randomUUID } from 'crypto'
import {
  parseModuleEnvelope,
  serializeModuleEnvelope,
  type ModulePayload
} from '../../shared/workflow/moduleEnvelope'
import { buildModuleEnvelope } from './moduleTransferService'
import { buildDefaultMemoryDoc } from './nodes/builtin/defaultMemoryTemplate'
import {
  ensureDir,
  getAppDir,
  listFilesSync,
  readJsonSync,
  writeJsonSyncAtomic
} from './storageService'
import { log } from './logService'

/** One palette entry (the summary the `list-module-templates` IPC returns). Names/descriptions are
 *  module CONTENT (author-written, travels with the file), not app chrome — plain strings, not i18n. */
export interface ModuleTemplateSummary {
  id: string
  name: string
  description?: string
  nodeCount: number
  source: 'builtin' | 'user'
}

const BUILTIN_ID_PREFIX = 'builtin:'

/** Build the built-in registry lazily (module-level cache — the templates are pure code builds).
 *  v1 contents: "Table memory" from the WP-C merged default (group `group-1`). */
let _builtins: { id: string; module: ModulePayload }[] | null = null
const builtinTemplates = (): { id: string; module: ModulePayload }[] => {
  if (_builtins) return _builtins
  const out: { id: string; module: ModulePayload }[] = []
  const built = buildModuleEnvelope(buildDefaultMemoryDoc(), 'group-1')
  if (built) {
    out.push({
      id: `${BUILTIN_ID_PREFIX}table-memory`,
      module: {
        ...built.module,
        description:
          'SQL-table memory maintenance: a mode selector (every N floors / async backlog / off) ' +
          'gating one maintainer chain that fills the bound table template. Ships collapsed; see ' +
          'its setup note.'
      }
    })
  } else {
    // Impossible unless defaultMemoryTemplate loses its group — log loudly rather than crash the palette.
    log('error', 'moduleTemplates: WP-C template has no group-1 — builtin "Table memory" unavailable')
  }
  _builtins = out
  return out
}

const libraryDir = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'workflows', '_library')
const libraryPath = (profileId: string, id: string): string =>
  path.join(libraryDir(profileId), `${id}.json`)

/** Read one user-library envelope file → its ModulePayload, or null (missing/unparseable — logged). */
const readLibraryModule = (profileId: string, id: string): ModulePayload | null => {
  const raw = readJsonSync(libraryPath(profileId, id))
  if (raw == null) return null
  // Re-parse through the SHARED envelope gate (never trust a file, even our own — it is user-editable
  // on disk and hand-droppable). parse takes the serialized text.
  const parsed = parseModuleEnvelope(JSON.stringify(raw))
  if (!parsed.ok) {
    log('error', `moduleTemplates: library entry ${id} failed envelope parse (${parsed.error.code}); skipping`)
    return null
  }
  return parsed.value.module
}

/** List the palette's Agent-library entries: built-ins first, then the user library (name order). */
export const listModuleTemplates = (profileId: string): ModuleTemplateSummary[] => {
  const out: ModuleTemplateSummary[] = builtinTemplates().map(({ id, module }) => ({
    id,
    name: module.name,
    ...(module.description ? { description: module.description } : {}),
    nodeCount: module.nodes.length,
    source: 'builtin' as const
  }))

  const user: ModuleTemplateSummary[] = []
  for (const file of listFilesSync(libraryDir(profileId))) {
    if (!file.endsWith('.json')) continue
    const id = file.replace(/\.json$/, '')
    const module = readLibraryModule(profileId, id)
    if (!module) continue
    user.push({
      id,
      name: module.name,
      ...(module.description ? { description: module.description } : {}),
      nodeCount: module.nodes.length,
      source: 'user'
    })
  }
  user.sort((a, b) => a.name.localeCompare(b.name))
  return [...out, ...user]
}

/** Fetch one template's full payload for insertion (the renderer feeds it to insertModule). Null for
 *  an unknown id / unreadable file (the palette shows a toast; nothing inserted). */
export const getModuleTemplate = (profileId: string, id: string): ModulePayload | null => {
  if (id.startsWith(BUILTIN_ID_PREFIX)) {
    return builtinTemplates().find((b) => b.id === id)?.module ?? null
  }
  // Defensive: an id is a filename segment — refuse separators so a crafted id can't escape the dir.
  if (/[\\/]/.test(id)) return null
  return readLibraryModule(profileId, id)
}

/** Save a module into the user library (the import review sheet's "save to my library" — spec §2).
 *  Validates by round-tripping the SHARED envelope serialize→parse (the same gate an import passes:
 *  structural schema, ≥2 nodes, internal-edge + exposed-member rules) before writing. Fresh uuid id —
 *  never overwrites (the saveTableTemplate precedent). */
export const saveModuleToLibrary = (
  profileId: string,
  module: ModulePayload
): { ok: true; id: string } | { ok: false; error: string } => {
  let text: string
  try {
    text = serializeModuleEnvelope(module)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const parsed = parseModuleEnvelope(text)
  if (!parsed.ok) return { ok: false, error: parsed.error.code }

  const id = randomUUID()
  ensureDir(libraryDir(profileId))
  writeJsonSyncAtomic(libraryPath(profileId, id), JSON.parse(text))
  log('info', `moduleTemplates: saved "${module.name}" to library as ${id} (profile ${profileId})`)
  return { ok: true, id }
}
