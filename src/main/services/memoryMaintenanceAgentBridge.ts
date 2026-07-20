import type { PromptMessage } from '../../shared/agentRuntime'
import {
  setMemoryMaintenanceBridge,
  type MemoryMaintenanceScope
} from './agentRuntime/memoryMaintenanceSlot'
import { buildGenContext } from './generation/genContext'
import type { GenContext } from './generation/types'
import { applyTableEdit, chatTemplate, dueTables } from './memory/memoryCore'
import { composeMaintainerMessages, memoryMaintainConfig } from './memory/maintainerCompose'
import { resolveEffectiveMaintainConfig } from './memory/maintainConfig'
import { extractTagAll } from '../../shared/memory/tagExtract'
import { advanceProgress, getProgress } from './tableProgressService'
import { getFloorCount, transcriptEpoch } from './floorService'
import { getSettings } from './settingsService'
import { writeScopeDirective } from './tableMaintenance'
import { log } from './logService'
import type { TableTemplate } from '../types/tableTemplate'
import type { z } from 'zod'

/**
 * The REAL Memory Maintenance Agent bridge (execution-plan M4; parser-backed design §6).
 *
 * Registered into `agentRuntime` by importing this module once from `main/index.ts` (side-effect
 * only), the same shape as `agentPresetAssemblyBridge.ts`. `agentRuntime` never imports `nodes/` or
 * `generation/`; this file — outside `agentRuntime` — does, and installs the closure.
 *
 * It reuses the EXACT node cores so the converted Agent and the (still-present, but no longer fired)
 * `memory.maintain` node can never drift: `composeMaintainerMessages` (shared byte-for-byte with the
 * `memory-maintain-preview` IPC), `dueTables`, `applyTableEdit`, `extractTagAll`, `advanceProgress`,
 * and the `transcriptEpoch` staleness fence. The three-way `<TableEdit>` discrimination is copied
 * verbatim from `memoryNodes.ts:216-260`.
 *
 * SETTINGS (execution-plan M5b/M5c-1 re-home): the GROUP settings are now the Agent's — the off-switch is
 * the catalog `enabled` flag (a disabled Agent never reaches this bridge), the cadence is the Agent's
 * `trigger.onFloorCommitted.everyNFloors`, and the API-preset is the catalog's profile-local invocation
 * config. As of M5c-1 the maintainer SCAFFOLD config no longer comes from the workflow doc either: the
 * bridge composes from the BUILT-IN default (`DEFAULT_MEMORY_MAINTAIN_CONFIG`) overlaid with the Agent's
 * profile-local `invocation_config.maintain` override (seeded once from a legacy customized doc). The
 * bridge no longer imports `resolveEffectiveDoc` — it touches no workflow surface.
 */

type MemoryMaintainConfig = z.infer<typeof memoryMaintainConfig>

// The effective maintainer config (built-in default ⊕ the Agent's profile-local override) is resolved by
// the shared `resolveEffectiveMaintainConfig` (also used by the memory-maintain-preview IPC), so the
// converted Agent and the preview never drift.
const resolveMaintainConfig = (profileId: string): MemoryMaintainConfig | null =>
  resolveEffectiveMaintainConfig(profileId)

/** Compute the DUE tables for this floor exactly as the node does (memoryNodes.ts:171-173). */
const computeDue = (
  gen: GenContext,
  template: TableTemplate
): { due: string[]; currentFloor: number } => {
  const currentFloor = Math.max(0, getFloorCount(gen.profileId, gen.chatId) - 1)
  const globalDefault = getSettings(gen.profileId).tables?.default_update_frequency ?? 3
  const due = dueTables(template, getProgress(gen.profileId, gen.chatId), currentFloor, globalDefault)
  return { due, currentFloor }
}

/**
 * Per-chat context captured at COMPOSE time and consumed at APPLY time. The epoch here is the one the
 * staleness fence brackets: it was read from the transcript that produced the maintainer prompt, so if
 * a regenerate/edit/swipe lands before the apply, `applyTableEdit`/the empty-tag branch drop the batch.
 * Keyed by chat (bounded to #chats), floor-checked at apply so a stale entry from a superseded floor is
 * never applied.
 */
interface ComposeContext {
  floor: number
  gen: GenContext
  template: TableTemplate
  cfg: MemoryMaintainConfig
  due: string[]
  currentFloor: number
  composedEpoch: number
}
const composed = new Map<string, ComposeContext>()

const asPromptMessages = (
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
): PromptMessage[] =>
  messages.map((message) => ({ role: message.role, content: [{ type: 'text', text: message.content }] }))

setMemoryMaintenanceBridge({
  planDispatch(scope: MemoryMaintenanceScope) {
    try {
      const cfg = resolveMaintainConfig(scope.profileId)
      // No maintain node in the doc / malformed config → nothing to compose. The off-switch is now the
      // Agent's enabled flag (a disabled Agent never reaches this bridge), so mode is no longer read.
      if (!cfg) return null
      const gen = buildGenContext(scope.profileId, scope.chatId, '')
      const template = chatTemplate(gen)
      if (!template) return null
      const { due } = computeDue(gen, template)
      // Internal due-gate: an empty due set SKIPS the model call entirely (memoryNodes.ts:174).
      if (!due.length) return null
      // The API-preset choice now rides the trigger request from the catalog invocation config (M5b);
      // the due-gate returns an EMPTY plan on success (a non-null "there is work to do" signal).
      return {}
    } catch (cause) {
      log('error', `Memory Maintenance planDispatch failed — ${errorMessage(cause)}`)
      return null
    }
  },

  composePrompt(scope: MemoryMaintenanceScope) {
    try {
      const cfg = resolveMaintainConfig(scope.profileId)
      if (!cfg) return undefined
      const gen = buildGenContext(scope.profileId, scope.chatId, '')
      const template = chatTemplate(gen)
      if (!template) return undefined
      const { due, currentFloor } = computeDue(gen, template)
      if (!due.length) return undefined
      // Staleness fence: capture the epoch in the SAME sync block that composes from the floors
      // (memoryNodes.ts:180). applyResult brackets compose→apply with this value.
      const composedEpoch = transcriptEpoch(gen.chatId)
      const dueSet = new Set(due)
      const dueDisplay = template.tables
        .filter((table) => dueSet.has(table.sqlName))
        .map((table) => table.displayName)
      // The SAME shared composer the preview IPC uses (memory-maintain-preview, tableMemoryIpc.ts:109),
      // plus the due-set write-scope directive the auto pass prepends (memoryNodes.ts:190).
      const messages = composeMaintainerMessages(gen, template, cfg, {
        scopeDirective: writeScopeDirective(dueDisplay)
      })
      composed.set(scope.chatId, {
        floor: scope.floor,
        gen,
        template,
        cfg,
        due,
        currentFloor,
        composedEpoch
      })
      return asPromptMessages(messages)
    } catch (cause) {
      log('error', `Memory Maintenance composePrompt failed — ${errorMessage(cause)}`)
      return undefined
    }
  },

  applyResult(scope: MemoryMaintenanceScope, rawResult: unknown) {
    const context = composed.get(scope.chatId)
    // A superseded floor's stale compose context must never apply against a newer run.
    if (!context || context.floor !== scope.floor) return
    composed.delete(scope.chatId)
    const raw = typeof rawResult === 'string' ? rawResult : ''
    if (!raw) return
    const { gen, template, cfg, due, currentFloor, composedEpoch } = context

    // Three-way discrimination, verbatim from memoryNodes.ts:216-260. `extractTagAll` returns [] when
    // NO <TableEdit> tag is present and [''] for an explicit empty tag — a distinction that is
    // load-bearing.
    const tags = extractTagAll(raw, 'TableEdit')
    //  NO tag → malformed reply: report, do NOT apply, do NOT advance the due pointers (advancing would
    //  silently skip this turn's content forever; the next commit boundary retries the same floors).
    if (!tags.length) return
    const sql = tags[0] ?? ''
    if (!sql.trim()) {
      //  EMPTY tag → a COMPLIANT "no changes" reply. It MUST advance the due pointers or the due tables
      //  stay due and burn a model call EVERY cadence window. Re-run the fence here since this branch
      //  bypasses applyTableEdit's own fence.
      if (cfg.advance_progress !== false) {
        if (transcriptEpoch(gen.chatId) !== composedEpoch) return // stale transcript, skipped
        advanceProgress(gen.profileId, gen.chatId, due, currentFloor)
      }
      return
    }
    // SQL → apply via the shared write-core (busy-guard + applySqlBatch + op-log + advance-after-success),
    // scoped + advanced to the DUE tables, bracketed by the epoch fence.
    applyTableEdit(gen, template, sql, {
      advanceProgress: cfg.advance_progress !== false,
      writeScope: due,
      advanceTables: due,
      label: 'Memory Maintenance',
      expectTranscriptEpoch: composedEpoch,
      advanceTo: currentFloor
    })
  }
})

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)
