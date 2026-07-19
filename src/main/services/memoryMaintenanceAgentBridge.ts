import type { PromptMessage } from '../../shared/agentRuntime'
import {
  setMemoryMaintenanceBridge,
  type MemoryMaintenanceScope
} from './agentRuntime/memoryMaintenanceSlot'
import { buildGenContext } from './generation/genContext'
import type { GenContext } from './generation/types'
import { applyTableEdit, chatTemplate, dueTables } from './nodes/builtin/memoryCore'
import { composeMaintainerMessages, memoryMaintainConfig } from './nodes/builtin/memoryNodes'
import { extractTagAll } from './nodes/builtin/parseNodes'
import { advanceProgress, getProgress } from './tableProgressService'
import { getFloorCount, transcriptEpoch } from './floorService'
import { getSettings } from './settingsService'
import { writeScopeDirective } from './tableMaintenance'
import { resolveEffectiveDoc } from './workflowService'
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
 * SETTINGS, read LIVE (M4 keeps the doc alive; M5 retires it): the chat's effective doc still owns the
 * maintain config, the mode (off switch), and the API-preset choice, so the bridge reads them from
 * `resolveEffectiveDoc` at dispatch/compose time. The Agent's own `everyNFloors: 3` trigger is the
 * cadence clock; the doc owns the rest until the settings UI is re-homed onto the Agent in M5.
 */

type MemoryMaintainConfig = z.infer<typeof memoryMaintainConfig>

interface LiveConfig {
  /** control.mode.selected — 'every_turn' | 'async' | 'off' (default 'every_turn'). */
  mode: string
  cfg: MemoryMaintainConfig
}

/**
 * Read the chat's effective Table-memory settings from the still-live doc: the maintain node's config
 * (its scaffold messages, lastNFloors, max_rows, api_preset_id) and the mode node's selection. `null`
 * when the doc has no `memory.maintain` node or its config is malformed — meaning there is nothing to
 * run, exactly as `evaluateDocTriggers` would not have fired an absent node.
 */
const resolveLive = (profileId: string, chatId: string): LiveConfig | null => {
  const { doc } = resolveEffectiveDoc(profileId, chatId)
  const maintainNode = doc.nodes.find((node) => node.type === 'memory.maintain')
  if (!maintainNode) return null
  const parsed = memoryMaintainConfig.safeParse(maintainNode.config ?? {})
  if (!parsed.success) return null
  const modeNode = doc.nodes.find((node) => node.type === 'control.mode')
  const mode = (modeNode?.config as { selected?: string } | undefined)?.selected ?? 'every_turn'
  return { mode, cfg: parsed.data }
}

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
      const live = resolveLive(scope.profileId, scope.chatId)
      // Mode off, or no maintain node in the doc → nothing to do (preserve the user's off switch).
      if (!live || live.mode === 'off') return null
      const gen = buildGenContext(scope.profileId, scope.chatId, '')
      const template = chatTemplate(gen)
      if (!template) return null
      const { due } = computeDue(gen, template)
      // Internal due-gate: an empty due set SKIPS the model call entirely (memoryNodes.ts:174).
      if (!due.length) return null
      return live.cfg.api_preset_id ? { apiPresetId: live.cfg.api_preset_id } : {}
    } catch (cause) {
      log('error', `Memory Maintenance planDispatch failed — ${errorMessage(cause)}`)
      return null
    }
  },

  composePrompt(scope: MemoryMaintenanceScope) {
    try {
      const live = resolveLive(scope.profileId, scope.chatId)
      if (!live || live.mode === 'off') return undefined
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
      const messages = composeMaintainerMessages(gen, template, live.cfg, {
        scopeDirective: writeScopeDirective(dueDisplay)
      })
      composed.set(scope.chatId, {
        floor: scope.floor,
        gen,
        template,
        cfg: live.cfg,
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
