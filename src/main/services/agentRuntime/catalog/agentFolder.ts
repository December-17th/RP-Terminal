import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type {
  AgentFileSyncItem,
  AgentFolderSync,
  AgentUpgradeResolution
} from '../../../../shared/agentRuntime'
import { AgentCatalog, AgentCatalogError, type CatalogAgent } from './AgentCatalog'

/**
 * Folder-backed Agent authoring source.
 *
 * Agent Definitions are hand-edited as `.rptagent` JSON on disk and imported into `agent_catalog`
 * as `user-imported` rows. The DB stays the runtime store (design §3.1) — this is an import source,
 * NOT a second storage path, so baselines, customization ops, effective snapshots, role bindings,
 * and upgrade staging all keep working exactly as they do for any other imported Agent.
 *
 * Two properties make re-scanning safe:
 *
 * 1. the source KEY is the filename, so a file always maps to the same catalog row; and
 * 2. the source VERSION is a content hash, so an edited file is an upgrade rather than a duplicate.
 *
 * Because a re-scan routes through `AgentCatalog.upgrade`, edits made in the app survive an edit to
 * the file, and a genuine clash is reported as a conflict instead of silently overwriting the user.
 */
export const AGENT_FILE_EXTENSION = '.rptagent'

export interface SyncAgentFolderOptions {
  /** Resolution to apply to conflicting upgrades. Omitted = report the conflict and skip the file. */
  conflicts?: AgentUpgradeResolution
}

/**
 * The folder scanned for Agent files. `RPT_AGENT_DIR` overrides it; the default is `test-agents/`
 * beside the running app, which in dev is the repo root.
 */
export const resolveAgentFolder = (): string =>
  process.env.RPT_AGENT_DIR?.trim() || path.join(process.cwd(), 'test-agents')

const contentVersion = (text: string): string =>
  crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)

export const listAgentFiles = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((file) => file.endsWith(AGENT_FILE_EXTENSION))
        .sort()
    : []

const findByFile = (catalog: AgentCatalog, file: string): CatalogAgent | undefined =>
  catalog
    .list()
    .find((agent) => agent.source.kind === 'user-imported' && agent.source.key === file)

const message = (error: unknown): string =>
  error instanceof AgentCatalogError || error instanceof Error ? error.message : String(error)

const syncFile = (
  catalog: AgentCatalog,
  dir: string,
  file: string,
  options: SyncAgentFolderOptions
): AgentFileSyncItem => {
  let text: string
  try {
    text = fs.readFileSync(path.join(dir, file), 'utf8')
  } catch (error) {
    return { file, status: 'failed', message: message(error) }
  }

  const inspection = catalog.inspectStandalone(text)
  if (!inspection.ok) {
    return {
      file,
      status: 'failed',
      message:
        inspection.format === 'legacy-workflow-pack'
          ? 'File is a legacy workflow pack, not an Agent Definition'
          : (inspection.errors?.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') ??
            'File is not a valid Agent Definition')
    }
  }

  const version = contentVersion(text)
  const existing = findByFile(catalog, file)

  if (!existing) {
    try {
      const installed = catalog.importStandalone(text, { sourceKey: file, sourceVersion: version })
      return { file, status: 'installed', name: installed.name, agentId: installed.id }
    } catch (error) {
      return { file, status: 'failed', name: inspection.definition.name, message: message(error) }
    }
  }

  if (existing.source.version === version) {
    return { file, status: 'unchanged', name: existing.name, agentId: existing.id }
  }

  try {
    const preview = catalog.inspectUpgrade(existing.id, inspection.definition, version)
    if (preview.conflicts.length && !options.conflicts) {
      return {
        file,
        status: 'conflict',
        name: existing.name,
        agentId: existing.id,
        conflicts: preview.conflicts
      }
    }
    const upgraded = catalog.upgrade(existing.id, inspection.definition, version, {
      ...(options.conflicts ? { conflicts: options.conflicts } : {})
    })
    return { file, status: 'upgraded', name: upgraded.name, agentId: upgraded.id }
  } catch (error) {
    return { file, status: 'failed', name: existing.name, agentId: existing.id, message: message(error) }
  }
}

/**
 * Import every Agent file in `dir` into the profile catalog. Never throws for a single bad file: a
 * failure is reported per item so one malformed Agent cannot block the rest of the folder.
 */
export const syncAgentFolder = (
  catalog: AgentCatalog,
  dir: string = resolveAgentFolder(),
  options: SyncAgentFolderOptions = {}
): AgentFolderSync => ({
  dir,
  items: listAgentFiles(dir).map((file) => syncFile(catalog, dir, file, options))
})
