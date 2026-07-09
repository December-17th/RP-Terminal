import { z } from 'zod'
import { buildGenContext } from './generation/genContext'
import { GenContext } from './generation/types'
import { resolveEffectiveDoc } from './workflowService'
import { ChatMessage } from './promptBuilder'
import { TableTemplate } from '../types/tableTemplate'
import { RunContext } from './nodes/types'
import { composeMaintainerMessages, memoryMaintainConfig } from './nodes/builtin/memoryNodes'
import { chatTemplate, applyTableEdit } from './nodes/builtin/memoryCore'
import {
  runLlmCall,
  buildLlmCallConfig,
  presetParamsWithTemperature
} from './nodes/builtin/generationNodes'
import { extractTagAll } from './nodes/builtin/parseNodes'

/**
 * On-demand "run maintenance now" (Memory-Manager WP2) — a SINGLE maintenance pass fired from the
 * Maintenance tab / shujuku-style 填表工作台. It runs the SAME maintainer the automatic per-turn
 * `memory.maintain` node runs, reusing its shared cores verbatim so behavior (provider-shaping,
 * trailing-role handling, op-logged apply, progress advance) can never drift from a normal pass:
 *   · `resolveMaintainConfig` reads the chat's EFFECTIVE workflow doc's `memory.maintain` node config,
 *   · `composeMaintainerMessages` builds the fully-shaped prompt ({{tables}}/{history} + providerShape),
 *   · `runLlmCall` makes the side call (stream off),
 *   · `extractTagAll('TableEdit')` + `applyTableEdit` land the write (busy-guarded, op-logged).
 *
 * NOTE: no fresh compose/apply path is built here — an ad-hoc array could end on an `assistant` turn
 * (the Gemini empty-completion bug we just fixed). `extraHint`, when set, is appended AFTER
 * provider-shape as a trailing `user` instruction so the array still ends on a `user` turn.
 */

type MemoryMaintainConfig = z.infer<typeof memoryMaintainConfig>

/**
 * Resolve the chat's effective `memory.maintain` node config — the exact maintainer config an automatic
 * pass runs. Returns null when the resolved doc has no `memory.maintain` node (or its config is
 * malformed). Shared by `maintainNow` AND the Maintenance-tab prompt preview so both agree with a turn.
 */
export const resolveMaintainConfig = (
  profileId: string,
  chatId: string
): MemoryMaintainConfig | null => {
  const { doc } = resolveEffectiveDoc(profileId, chatId)
  const node = doc.nodes.find((n) => n.type === 'memory.maintain')
  if (!node) return null
  const parsed = memoryMaintainConfig.safeParse(node.config ?? {})
  return parsed.success ? parsed.data : null
}

export interface MaintainNowOpts {
  /** Trailing floors of transcript to include; overrides the resolved config's lastNFloors when set. */
  lastNFloors?: number
  /** An optional extra instruction folded in as a trailing `user` turn (keeps the array ending on user). */
  extraHint?: string
}

/** The run-now report: an applied write, an empty (no-changes) reply, or a no-op / class-B failure. */
export type MaintainNowResult =
  | { ok: true; applied: number; changes: number; empty?: boolean }
  | { ok: false; reason: 'no-template' | 'no-node' | 'aborted' }
  | { ok: false; reason: 'error'; message: string }

/** A minimal side-call RunContext for a headless maintenance pass (no chat streaming, no panels). */
const sideCallContext = (profileId: string, chatId: string, signal: AbortSignal): RunContext => ({
  profileId,
  chatId,
  signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
})

/**
 * Compose the maintainer messages a run-now pass sends: the shared `composeMaintainerMessages` output
 * (provider-shaped, so its trailing-role handling is inherited) plus, when `extraHint` is set, a
 * trailing `user` instruction. Appending AFTER provider-shape keeps the array ending on a `user` turn
 * even when the base scaffold would end on an `assistant` reply (the Gemini empty-completion bug).
 * Exported so the regression test can assert the array never ends on an `assistant` role.
 */
export const composeMaintainNowMessages = (
  gen: GenContext,
  template: TableTemplate,
  cfg: MemoryMaintainConfig,
  extraHint?: string
): ChatMessage[] => {
  const base = composeMaintainerMessages(gen, template, cfg)
  const hint = extraHint?.trim()
  return hint ? [...base, { role: 'user', content: hint }] : base
}

/**
 * Run ONE maintenance pass on demand. No template bound → `{ ok:false, reason:'no-template' }` with no
 * model call. On success: `{ ok:true, applied, changes }`, or `{ ok:true, applied:0, changes:0, empty:true }`
 * for an empty `<TableEdit>` reply. A bad SQL batch / provider give-up surfaces as `{ ok:false,
 * reason:'error', message }` (the class-B failure the shared apply core throws).
 */
export const maintainNow = async (
  profileId: string,
  chatId: string,
  opts: MaintainNowOpts = {}
): Promise<MaintainNowResult> => {
  const gen = buildGenContext(profileId, chatId, '')
  const template = chatTemplate(gen)
  if (!template) return { ok: false, reason: 'no-template' }

  const base = resolveMaintainConfig(profileId, chatId)
  if (!base) return { ok: false, reason: 'no-node' }
  const cfg: MemoryMaintainConfig = {
    ...base,
    ...(typeof opts.lastNFloors === 'number' ? { lastNFloors: opts.lastNFloors } : {})
  }

  const messages = composeMaintainNowMessages(gen, template, cfg, opts.extraHint)
  const params = presetParamsWithTemperature(gen, cfg.temperature)
  const callCfg = buildLlmCallConfig(cfg)
  const ctx = sideCallContext(profileId, chatId, new AbortController().signal)

  try {
    const r = await runLlmCall(ctx, gen, messages, params, callCfg)
    if (r === null) return { ok: false, reason: 'aborted' }
    const sql = extractTagAll(r.raw, 'TableEdit')[0] ?? ''
    if (!sql.trim()) return { ok: true, applied: 0, changes: 0, empty: true }
    // Op-logged, busy-guarded write through the SAME core a normal pass uses; advance the pointer to
    // match automatic maintenance (unless the resolved config opts out).
    const applied = applyTableEdit(gen, template, sql, {
      advanceProgress: cfg.advance_progress !== false,
      label: 'memory.maintain (run now)'
    })
    return { ok: true, applied: applied.applied, changes: applied.changes }
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}
