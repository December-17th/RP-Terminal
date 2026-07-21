import type { AgentRole } from './types'
import type { AgentPromptOrigin, AgentRunContextBudget } from './runs'

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
  /**
   * The Agent's `modelHint` — a DISPLAY-ONLY model recommendation. For imported Agents this may carry the
   * model the card/file declared (owner policy neutralizes the imported preset/model at install time and
   * preserves the model here as a recommendation only; it is never applied at runtime).
   */
  recommendedModel?: string
  /**
   * Whether the user has bound an API preset to this Agent (`invocationConfig.apiPresetId`). Imported
   * Agents start with NO preset (owner policy) — the UI surfaces a "pick a preset" notice when this is
   * false. When no preset is bound, a run falls back to the profile's active preset.
   */
  hasApiPreset: boolean
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

/**
 * One message of a dry-run Prompt Preview (Microscope-lite D4). Byte-identical to what a real run
 * would dispatch for the same floor/vars, plus its coarse origin badge.
 */
export interface AgentPromptPreviewMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  origin?: AgentPromptOrigin
}

/**
 * Result of the pre-run Prompt Preview (design §D4): the exact messages an Agent run WOULD send against
 * the latest committed floor, with token attribution and provider/preset info, computed with ZERO
 * provider calls and ZERO side effects. `prefixCount` is the modeled reuse-boundary index — the number
 * of leading messages that are reuse-safe (immutable prefix). The preview reflects the floor/vars as
 * they stand NOW; a later run re-renders and may differ.
 */
export type AgentPromptPreview =
  | {
      ok: true
      messages: AgentPromptPreviewMessage[]
      prefixCount: number
      attribution: AgentRunContextBudget
      provider?: {
        presetId: string
        presetName: string
        provider: string
        model: string
        contextWindow: number
        cacheMode: string
      }
      warnings: string[]
    }
  | {
      ok: false
      code:
        | 'INVALID_REQUEST'
        | 'NO_COMMITTED_FLOOR'
        | 'AGENT_NOT_FOUND'
        | 'PROMPT_BINDING_MISSING'
        | 'PROVIDER_SELECTION'
        | 'PREVIEW_FAILED'
      message?: string
    }

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
  // Dry-run Prompt Preview (Microscope-lite D4): builds the exact prompt an Agent WOULD send against the
  // latest committed floor, with zero provider calls and zero side effects.
  previewPrompt: 'agent-catalog-preview-prompt',
  // Profile-local invocation config (M5b) — the re-homed per-Agent API preset. Kept off the definition
  // get/edit channels because it never belongs to the portable definition (never exported).
  getInvocationConfig: 'agent-catalog-get-invocation-config',
  setInvocationConfig: 'agent-catalog-set-invocation-config'
} as const
