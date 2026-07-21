import type { AgentRole } from './types'

/**
 * Renderer-facing projections of the Agent catalog.
 *
 * These are deliberately NOT the stored rows: a `CatalogAgent` carries both the baseline and the
 * effective `AgentDefinition`, and a realistic Agent's prompt runs to tens of kilobytes, so shipping
 * whole rows to build a list would move megabytes across IPC for data the list never renders. The
 * summary carries what the management UI shows; full definitions are fetched one at a time.
 */
export interface AgentCatalogSummary {
  id: string
  name: string
  description?: string
  sourceKind: 'builtin' | 'user-created' | 'user-imported' | 'card'
  sourceKey: string
  sourceVersion: string
  /** False once an Agent's originating card or file has gone away; the row is kept, not deleted. */
  sourcePresent: boolean
  enabled: boolean
  customized: boolean
  upgradeAvailable: boolean
  blocksNextTurn: boolean
  resultMode: 'text' | 'json' | 'tools-only'
  saveAs?: string
  promptMessages: number
  promptChars: number
  /** Roles currently bound to this Agent. A bound Agent cannot be disabled or deleted. */
  roles: AgentRole[]
  updatedAt: string
}

/**
 * Profile-local, non-exported per-Agent invocation config (execution-plan M5b). Currently the single
 * re-homed setting: the API preset the triggered dispatch runs the Agent against. Mirrors the main-side
 * `AgentCatalog.AgentInvocationConfig` shape across the IPC boundary. NEVER travels into an exported
 * `.rptagent` (design §10 forbids user-local preset refs).
 */
export interface AgentInvocationConfig {
  apiPresetId?: string
}

export type AgentFileStatus = 'installed' | 'upgraded' | 'unchanged' | 'conflict' | 'failed'

export interface AgentFileSyncItem {
  file: string
  status: AgentFileStatus
  name?: string
  agentId?: string
  /** Customized paths the incoming file also changes; the upgrade is skipped until resolved. */
  conflicts?: string[]
  errorCode?: string
}

export interface AgentFolderSync {
  dir: string
  items: AgentFileSyncItem[]
}

export type AgentUpgradeResolution = 'keep-customization' | 'use-source'

/** What a pending source upgrade would change, and where it collides with local edits. */
export interface AgentUpgradePreview {
  changedPaths: string[]
  customizedPaths: string[]
  conflicts: string[]
}

/** Uniform envelope for catalog mutations so the UI can show a field-accurate failure. */
export type AgentMutationResult =
  | { ok: true; agent: AgentCatalogSummary }
  | { ok: false; error: string; code?: string; details?: unknown }

/** Outcome of a Manual Invocation started from the Workspace (design §12). The `skipped` variant is
 *  Memory Maintenance's due-gate declining to bill a run when nothing is due (final-review Finding 1) —
 *  a real non-outcome, distinct from a run that succeeded. */
export type AgentManualRunResult =
  | { ok: true; invocationId: string; status: string; result?: unknown }
  | { ok: true; status: 'skipped' }
  | { ok: false; error: string; code?: string }

export const AGENT_CATALOG_CHANNELS = {
  list: 'agent-catalog-list',
  get: 'agent-catalog-get',
  syncFolder: 'agent-catalog-sync-folder',
  setEnabled: 'agent-catalog-set-enabled',
  remove: 'agent-catalog-delete',
  bindRole: 'agent-catalog-bind-role',
  roleBindings: 'agent-catalog-role-bindings',
  create: 'agent-catalog-create',
  edit: 'agent-catalog-edit',
  restore: 'agent-catalog-restore',
  exportOne: 'agent-catalog-export',
  inspectUpgrade: 'agent-catalog-inspect-upgrade',
  upgrade: 'agent-catalog-upgrade',
  run: 'agent-catalog-run',
  // Profile-local invocation config (M5b) — the re-homed per-Agent API preset. Kept off the definition
  // get/edit channels because it never belongs to the portable definition (never exported).
  getInvocationConfig: 'agent-catalog-get-invocation-config',
  setInvocationConfig: 'agent-catalog-set-invocation-config'
} as const
