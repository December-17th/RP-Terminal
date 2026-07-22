import { getActivePresetId } from '../presetService'
import { matchAcross } from '../lorebookService'
import { getCachedWorldInfo, setCachedWorldInfo } from '../chatService'
import { buildPromptDetailed } from '../promptBuilder'
import { fitToBudget } from '../promptBudget'
import type { BudgetClass, ChatMessage } from '../promptTypes'
import { getPromptRules, getWorldInfoRules, type RegexTierOrder } from '../regexService'
import { buildTemplateContext } from '../templateService'
import { providerShape } from './providerShape'
import { expandMacros } from '../../../shared/macros'
import { resolveStopStrings } from '../../../shared/spreset'
import {
  lastMessageIndex,
  lastUserMessageIndex,
  lastCharMessageIndex
} from '../../../shared/thRuntime/shapes'
import { log } from '../logService'
import { renderChatTablesInjectionBlock } from '../tablesInjectionService'
import { LorebookEntry, getRpExt } from '../../types/character'
import { PresetParameters, Preset } from '../../types/preset'
import { GenContext } from './types'
import { ExecutionRecord } from '../../../shared/executionRecord'
import { createRecordBuilder } from './executionRecord'
import { isWritableVariablesPath } from '../../../shared/agentRuntime/paths'
import { toParts } from '../../../shared/objectPath'
import type { VarWriteHook } from '../../../shared/templateEngine'
import type { FloorStateOperation } from '../agentRuntime/floorState/FloorState'

/**
 * prompt.preset composer overrides (context-epochs plan §3): each field, when present, replaces one
 * ingredient of the assembled prompt so a workflow can compose a per-call prompt from components.
 * With NO overrides (the default-graph path) every branch below is byte-identical to before — the
 * parity gate (test/generation/generateParity*.test.ts).
 */
export interface AssembleOverrides {
  /** Use this preset skeleton + params in place of `ctx.preset` everywhere the preset is read. */
  preset?: Preset
  /** Verbatim history messages (pre-processed — no regex/macro passes); the pending action is
   *  appended after them. */
  history?: ChatMessage[]
  /** Replace ONLY the top-level World Info block; the internal keyword scan is skipped. */
  worldInfo?: string
  /** The pending user action for L4 placement (flows into buildPrompt's userAction). */
  action?: string
}

/**
 * Combine the FSM mode addendum with a World Card's custom agent prompts (Track S §3).
 * A card's `agent.prompts.system` is a world-level system instruction and applies in
 * every mode; a per-mode prompt (`agent.prompts[mode]`, e.g. `combat`) applies only when
 * the FSM is engaged. Returned as a single trimmed, newline-joined system addendum.
 *
 * Lives here (not generationService.ts) because it's only used by assemblePrompt's
 * `buildPrompt` call; generationService re-exports it so its existing consumers/tests
 * are unaffected.
 */
export const composeAddendum = (
  agent: any,
  mode: string,
  fsmEnabled: boolean,
  modeAddendum: string
): string => {
  const prompts = agent?.prompts || {}
  return [
    fsmEnabled ? modeAddendum : '',
    typeof prompts.system === 'string' ? prompts.system : '',
    fsmEnabled && typeof prompts[mode] === 'string' ? prompts[mode] : ''
  ]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join('\n\n')
}

/**
 * L2 world-info matching. Moved verbatim out of `generate()` (Phase 2b-1a) — differs by mode:
 *  • Agentic — Phase H inc 2 cache: match once per FSM mode and reuse across turns
 *    within that mode, so the world-info block stays byte-stable for the provider
 *    prefix cache (Phase G). A transition / lorebook-selection change forces a re-match;
 *    by design new keywords raised mid-mode don't pull new lore until the next transition.
 *  • Classic — re-match every turn for fully dynamic keyword lore (ST behavior); any
 *    stale agentic cache is cleared so a later switch back to agentic starts fresh.
 */
export const matchWorldInfo = (ctx: GenContext): LorebookEntry[] => {
  const { profileId, chatId, fsmEnabled, mode, lorebooks, scanText, maxRecursion, lorebookIds } =
    ctx
  let matchedEntries: LorebookEntry[]
  if (fsmEnabled) {
    const cached = getCachedWorldInfo(profileId, chatId)
    if (cached && cached.mode === mode) {
      matchedEntries = cached.entries
    } else {
      matchedEntries = matchAcross(lorebooks, scanText, Math.random, maxRecursion)
      setCachedWorldInfo(profileId, chatId, { mode, entries: matchedEntries })
      log(
        'info',
        `world info (re)matched for ${mode} mode — ${matchedEntries.length} entr${matchedEntries.length === 1 ? 'y' : 'ies'} cached`
      )
    }
  } else {
    matchedEntries = matchAcross(lorebooks, scanText, Math.random, maxRecursion)
    setCachedWorldInfo(profileId, chatId, null)
  }
  // Diagnostic: surface lorebook reach so an empty/unattached book is obvious in the Logs panel
  // (0 books = nothing attached; books but 0 matched = no constant entries + no keyword hit).
  const loreEntryCount = lorebooks.reduce((n, lb) => n + lb.entries.length, 0)
  log(
    'info',
    `lorebook: ${lorebooks.length} book(s) / ${loreEntryCount} entr${loreEntryCount === 1 ? 'y' : 'ies'} → ${matchedEntries.length} matched · ids=[${lorebookIds.join(', ') || 'none'}]`
  )
  return matchedEntries
}

// ── build-time setvar capture ────────────────────────────────────────────────────────────────────
//
// Build-time `{{setvar}}` / EJS `setvar()` write straight into `ctx.workingVars` (the PARITY HAZARD
// documented on `assemblePrompt`). Those writes reach the STORED floor — but nothing journals them,
// so Forward Replay, which rebuilds a floor from `previous floor variables → model fold → journaled
// operations`, silently drops every one of them.
//
// ONE mechanism, TWO path sources. Capture is always "journal the FINAL value at a candidate path",
// so the two sources can never disagree about a value — they only ever widen the candidate set:
//
//  1. the EJS engine's write hook (`VarWriteHook`, wired below) reports the paths `setvar`/`delvar`
//     actually WROTE. A diff can only see that state CHANGED, so it silently drops the case this
//     whole feature exists for: `setvar('x', 1)` while `x` is already `1`. Live assembly FORCES 1;
//     without a journal row, replay after an earlier-floor edit keeps whatever it inherited.
//  2. a snapshot/diff of `workingVars` across assembly, which still catches every OTHER dialect that
//     writes through the same store — notably the `{{setvar}}`/`{{addvar}}` MACROS (shared/macros.ts),
//     which do not run through the template engine at all.
//
// Replay applies the resulting `'template'` operations BEFORE the model fold
// (FloorState.computeFloorSuffix) — the live order (assembly first, model turn second).

/** Root keys the MODEL FOLD owns and re-derives from the response on every replay: journaling them
 *  as pre-fold operations would be redundant at best and would fight the fold at worst
 *  (`combat_cue` is deleted and re-derived every turn; `stat_data`/`delta_data` are MVU's). */
const FOLD_OWNED_ROOT_KEYS = new Set(['stat_data', 'delta_data', 'combat_cue'])

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** The value as it would SURVIVE onto the floor (floor variables are persisted as JSON), or
 *  `undefined` when JSON cannot represent it — i.e. when the floor would not hold it either. */
const asStorableJson = (value: unknown): unknown => {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? undefined : JSON.parse(text)
  } catch {
    return undefined
  }
}

const sameStorable = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Read a value by the JOURNAL's path dialect — plain split-on-dot segments, matching floorFold's
 *  `variablesParentAt`, which is what replay will walk when it applies the operation. */
const valueAtSegments = (root: Record<string, unknown>, segments: string[]): unknown => {
  let cur: unknown = root
  for (const segment of segments) {
    if (!isPlainObject(cur)) return undefined
    cur = cur[segment]
  }
  return cur
}

/** Candidate paths from the snapshot/diff: every leaf whose STORED value differs across assembly. */
const collectChangedPaths = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix: string,
  out: string[]
): void => {
  const root = prefix === 'variables'
  for (const key of Object.keys(after)) {
    if (root && FOLD_OWNED_ROOT_KEYS.has(key)) continue
    const path = `${prefix}.${key}`
    const previous = before[key]
    const current = after[key]
    // Recurse only when BOTH sides are plain objects; otherwise the subtree is set wholesale, so a
    // freshly-created (even empty) object is never lost to an empty leaf diff.
    if (isPlainObject(previous) && isPlainObject(current)) {
      collectChangedPaths(previous, current, path, out)
      continue
    }
    if (sameStorable(asStorableJson(current), asStorableJson(previous))) continue
    out.push(path)
  }
  for (const key of Object.keys(before)) {
    if (root && FOLD_OWNED_ROOT_KEYS.has(key)) continue
    if (Object.prototype.hasOwnProperty.call(after, key)) continue
    out.push(`${prefix}.${key}`)
  }
}

/**
 * A recorded write key → the path the journal can actually address, or `undefined` when the write
 * can never be journaled (a fold-owned root, an unusable key).
 *
 * Two dialects meet here. The engine writes with the bracket-aware `toParts` (`a[0].b` → a.0.b),
 * while replay walks PLAIN OBJECTS only. So a path whose route runs through an array / scalar /
 * missing container is truncated to that ancestor and journaled WHOLESALE — the same truncation the
 * diff walk makes when the two sides aren't both plain objects.
 */
const journalPathFor = (after: Record<string, unknown>, key: string): string | undefined => {
  const parts = toParts(key)
  if (!parts.length || FOLD_OWNED_ROOT_KEYS.has(parts[0])) return undefined
  let container: unknown = after
  const kept: string[] = []
  for (let i = 0; i < parts.length; i++) {
    kept.push(parts[i])
    if (i === parts.length - 1) break
    const next = isPlainObject(container) ? container[parts[i]] : undefined
    if (!isPlainObject(next)) break
    container = next
  }
  return `variables.${kept.join('.')}`
}

/** Is some strict ancestor of `path` already journaled? Then its value rides along and re-journaling
 *  the descendant is pure noise (both carry the same post-assembly value either way). */
const hasJournaledAncestor = (path: string, journaled: Set<string>): boolean => {
  const segments = path.split('.')
  for (let i = segments.length - 1; i > 1; i--)
    if (journaled.has(segments.slice(0, i).join('.'))) return true
  return false
}

/**
 * Snapshot `workingVars` before assembly, so capture can tell "already absent" from "deleted" and so
 * the diff source has something to compare with. A deep JSON clone — assembly mutates the live object
 * in place, by reference, on purpose.
 *
 * The fold-owned roots are left OUT of the clone: capture skips them on both sides anyway, and
 * `stat_data` is by far the largest thing in a mature session's variables.
 */
export const snapshotTemplateVars = (
  workingVars: Record<string, unknown>
): Record<string, unknown> => {
  const capturable: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(workingVars ?? {}))
    if (!FOLD_OWNED_ROOT_KEYS.has(key)) capturable[key] = value
  return JSON.parse(JSON.stringify(capturable)) as Record<string, unknown>
}

/**
 * Records which variable paths build-time template helpers wrote during ONE assembly, so journaling
 * no longer depends on the value having CHANGED.
 *
 * Only writes that land on the FLOOR's own store count, which is why the hook is handed the store:
 * `storeFor` routes `scope:'global'` to the globals bag, and promptBuilder renders the L1 frozen
 * frontier against a separate `frozenVars` snapshot (`{...template, vars: frozenVars}`) — neither
 * object reaches the floor, so journaling a write to either would force a value the live turn never
 * stored. Every other scope (local/chat/message) DOES resolve to `ctx.vars`, i.e. the floor store,
 * and is recorded.
 */
export interface TemplateWriteRecorder {
  onVarWrite: VarWriteHook
  /** The recorded write keys, first-write order, deduplicated. */
  paths: () => string[]
}

export const createTemplateWriteRecorder = (
  floorStore: Record<string, unknown>
): TemplateWriteRecorder => {
  const seen = new Set<string>()
  return {
    // `kind` is deliberately ignored: capture journals the FINAL state at each recorded path, so a
    // path written twice yields one operation with the last value, and a path written then deleted
    // yields a delete — decided below by the value, not by the last write's kind.
    onVarWrite: (path, _kind, store) => {
      if (store !== floorStore || !path) return
      seen.add(path)
    },
    paths: () => [...seen]
  }
}

/**
 * The build-time writes assembly made, as journalable floor operations. Every candidate path — from
 * the engine's write recorder (`recordedPaths`) and from the snapshot/diff alike — is journaled with
 * the value it holds AFTER assembly, so a path written twice produces ONE `set` carrying the last
 * value and a path written then deleted produces a `delete`.
 *
 * Fold-owned roots are skipped; so is any path the journal would refuse (runtime-owned
 * `variables.__rpt`, prototype keys) — capture must never be able to fail a turn.
 */
export const captureTemplateWrites = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  recordedPaths: readonly string[] = []
): FloorStateOperation[] => {
  const from = before ?? {}
  const to = after ?? {}
  const candidates: string[] = []
  collectChangedPaths(from, to, 'variables', candidates)
  for (const key of recordedPaths) {
    const path = journalPathFor(to, key)
    if (path) candidates.push(path)
  }

  const operations: FloorStateOperation[] = []
  const journaled = new Set<string>()
  for (const path of candidates) {
    if (journaled.has(path) || !isWritableVariablesPath(path)) continue
    if (hasJournaledAncestor(path, journaled)) continue
    const segments = path.split('.').slice(1)
    const stored = asStorableJson(valueAtSegments(to, segments))
    if (stored === undefined) {
      // Never journaled and gone again — there is nothing for replay to reproduce.
      if (asStorableJson(valueAtSegments(from, segments)) === undefined) continue
      operations.push({ kind: 'delete', path })
    } else {
      operations.push({ kind: 'set', path, value: stored })
    }
    journaled.add(path)
  }
  return operations
}

/**
 * Assemble the exact message array + sampler params sent to the provider. Moved verbatim out of
 * `generate()` (Phase 2b-1a) — same build/trim/reshape pipeline, same request log.
 *
 * PARITY HAZARD: `buildPrompt`'s `template` context is built from `ctx.workingVars` PASSED BY
 * REFERENCE (never cloned/spread) — build-time `setvar()` calls mutate that same object, and
 * those mutations must persist onto the floor (read later by the caller / persist step).
 */
export const assemblePrompt = (
  ctx: GenContext,
  matchedEntries: LorebookEntry[],
  memoryBlock: string,
  overrides?: AssembleOverrides
): {
  sendMessages: ChatMessage[]
  params: PresetParameters
  record: ExecutionRecord
  /** Issue 18c: the PRE-shape, post-trim message list + its explicit budget policy — the assembler's
   *  authored inputs, handed to `assembledArtifact` so the `Prompt` artifact's contributions carry
   *  `budgetClass` (history/pinned). Not consumed by the legacy `sendMessages`/`params` callers. */
  authored: { messages: ChatMessage[]; budgetClasses: BudgetClass[] }
  /** The variable paths build-time `setvar`/`delvar` wrote onto `ctx.workingVars` during THIS
   *  assembly — the write-recorder half of build-time setvar capture. Hand to `captureTemplateWrites`
   *  (the turn does; other callers may ignore it). */
  varWrites: string[]
} => {
  // Forensic Execution Record (issue 07 / WP-1.1). ADDITIVE + behavior-neutral: the builder
  // journals every controlled transform and is returned alongside the UNCHANGED sendMessages;
  // callers may ignore it. `t0` bounds the added assembly time reported as `record.stats.buildMs`.
  const t0 = Date.now()
  const record = createRecordBuilder()
  // Build-time setvar capture, source 1: the engine's own write hook. Bound to `workingVars` BY
  // IDENTITY so only writes that land on the floor's store are recorded (see the recorder's doc).
  const varWrites = createTemplateWriteRecorder(ctx.workingVars)
  const {
    profileId,
    chatId,
    chat,
    card,
    settings,
    fsmEnabled,
    mode,
    generationType,
    modeConfig,
    lorebooks,
    floors,
    lastFloor,
    workingVars,
    globals,
    userName,
    cacheLevel,
    l1Mode,
    frozenVars,
    scanDepth,
    maxRecursion
  } = ctx
  // Overrides (prompt.preset composer, plan §3): with none present, these resolve to the exact
  // ctx values used before, so the assembled output stays byte-identical (parity gate).
  const preset = overrides?.preset ?? ctx.preset
  const userAction = overrides?.action ?? ctx.userAction

  // SPreset (issue 16 / WP-2.6) runtime knobs, projected onto the preset at import (`preset.spreset`).
  // Absent on native / plain-ST presets → every branch below is the pre-SPreset default (parity gate).
  //  • RegexBinding → preset-first regex tier order (preset ahead of global/character); else st-default.
  //  • MacroNest:false → a single non-nesting macro pass; true/absent → RPT's default nesting cap.
  const regexOrder: RegexTierOrder = preset.spreset?.regexBindingEnabled
    ? 'preset-first'
    : 'st-default'
  const macroMaxPasses = preset.spreset?.macroNest === false ? 1 : undefined

  // WS4 (D10): fold the capped per-table memory block into the SAME memory tail as the recall / pack
  // block (`memoryBlock` → buildPrompt's tail splice). Computed here (not via a node) so it rides the
  // existing splice for EVERY workflow without consuming the `prompt-assembly` checkpoint's `block`
  // anchor lane (which is reserved for pack rejoin). Empty when no template is bound / nothing to inject
  // → the block is unchanged (parity). Ordered [recall/pack block][tables block] in the tail.
  const tablesBlock = renderChatTablesInjectionBlock(profileId, chatId)
  const memoryTail = [memoryBlock, tablesBlock].filter((s) => s && s.trim()).join('\n\n')

  const { messages: built, budgetClasses } = buildPromptDetailed({
    card,
    preset,
    lorebooks,
    floors,
    userAction,
    userName,
    // ST generation type (openai.js prepareOpenAIMessages `type`) drives injection_trigger filtering
    // (resolveEffectivePrompts). Threaded from the turn seed; 'normal' for a plain player send.
    generationType,
    journal: record,
    historyOverride: overrides?.history,
    worldInfoOverride: overrides?.worldInfo,
    persona: {
      description: settings.persona?.description || '',
      inject: settings.persona?.inject !== false
    },
    scanDepth,
    maxRecursion,
    matchedEntries,
    promptRegex: getPromptRules(
      profileId,
      { cardId: chat.character_id, chatId, presetId: getActivePresetId(profileId) },
      regexOrder
    ),
    // World Info regex (ST placement 5), isPrompt-strict — applied to each activated entry's content
    // in promptBuilder's renderLoreEntry, matching ST's WI builder (world-info.js:5086).
    worldInfoRegex: getWorldInfoRules(
      profileId,
      { cardId: chat.character_id, chatId, presetId: getActivePresetId(profileId) },
      regexOrder
    ),
    // SPreset MacroNest (issue 16): undefined = RPT default nesting; 1 = single non-nesting pass.
    macroMaxPasses,
    cacheLevel,
    l1Mode,
    frozenVars,
    memoryBlock: memoryTail,
    // FSM mode addendum + the World Card's custom agent prompts (system + per-mode).
    modeAddendum: composeAddendum(getRpExt(card)?.agent, mode, fsmEnabled, modeConfig.addendum),
    // Canonical TemplateContext (WS-1) — shared constructor; `workingVars` is the live store (passed by
    // reference so build-time setvar persists onto the floor). The engine resolves both `getvar('x')` and
    // `getvar('stat_data.x')` from it.
    template: buildTemplateContext(workingVars, {
      // EJS engine on/off (settings toggle). When off, evalTemplate strips tags instead of running them;
      // {{macros}} still expand (they share vars/globals).
      enabled: settings.templates?.enabled !== false,
      // Observation-only: records which paths build-time setvar/delvar wrote (see the capture header).
      onVarWrite: varWrites.onVarWrite,
      globals,
      constants: {
        userName,
        charName: card.data.name || 'Character',
        assistantName: card.data.name || 'Character',
        lastUserMessage: userAction,
        lastCharMessage: lastFloor?.response.content || '',
        // SillyTavern message-index globals (ST-Prompt-Template). The pending user action counts as the
        // last message, so on the opening turn lastMessageId === 1 (presets gate "is this the opening?" on it).
        lastMessageId: lastMessageIndex(floors, !!userAction.trim()),
        lastUserMessageId: lastUserMessageIndex(floors, !!userAction.trim()),
        lastCharMessageId: lastCharMessageIndex(floors),
        chatId,
        characterId: chat.character_id,
        runType: 'generate'
      },
      // TH-3 read-only template accessors (getchar/getwi/getMessageHistory/…).
      data: {
        charData: card.data as Record<string, unknown>,
        worldInfo: matchedEntries.map((e) => ({ name: e.comment || '', content: e.content })),
        messages: floors.map((f) => ({
          user: f.user_message.content,
          assistant: f.response.content
        })),
        chatName: card.data.name || '',
        presetName: preset.name,
        presetPrompts: preset.prompts.map((p) => ({
          name: p.name,
          identifier: p.identifier,
          content: p.content
        }))
      }
    })
  })

  // Trim oldest history to stay under the configured context budget. The explicit `budgetClasses`
  // policy (issue 18c/18d — history vs pinned, per message) drives the history-aware drop, replacing
  // the retired non-enumerable HISTORY_TAG; `trimmedClasses` stays aligned with `trimmed` and rides
  // onto the artifact's contributions as `budgetClass`.
  const budget = settings.generation?.max_context_tokens || 200000
  const {
    messages: trimmed,
    dropped,
    budgetClasses: trimmedClasses
  } = fitToBudget(built, budget, budgetClasses)
  if (dropped > 0) {
    log('info', `context budget ${budget} tok — trimmed ${dropped} oldest message(s)`)
    record.arrayStage(
      'trim',
      built.length,
      trimmed.length,
      `budget ${budget} tok — dropped ${dropped} oldest turn(s)`
    )
  }
  // Provider shaping — the SINGLE seam (issue 10 / WP-1.4): system→user (OpenAI-compatible + opt-in),
  // merge consecutive same-role, then provider ordering. Applied AFTER fitToBudget (which needs the
  // per-message history tags) so the stored `request` matches exactly what's sent. The SAME function
  // shapes the hand-authored `prompt.messages` workflow path; passing `record` journals + logs each stage
  // that fires. `sendMessages` is the exact array sent to the API, so the `request` log is faithful.
  // ST selective system-message squash (issue 15 / WP-2.5): opt in ONLY for an imported ST preset that
  // carries `squash_system_messages: true`. A native preset never sets the flag (undefined → merge-all),
  // so its wire output is byte-identical (parity gate). Squash then REPLACES merge-all for that preset.
  // SPreset ChatSquash (issue 16): the preset's own role-based adjacent-merge, run in stage (A) of the
  // shaping seam. Affixes are macro-expanded with the same {{user}}/{{char}} the build uses. Absent /
  // disabled → the pre-SPreset squash/merge branch (parity). `squashed_post_script` eval is NEVER run.
  const chatSquashConfig = preset.spreset?.chatSquash
  const chatSquashOpt = chatSquashConfig?.enabled
    ? {
        config: chatSquashConfig,
        expand: (s: string): string =>
          expandMacros(s, { user: userName, char: card.data.name || 'Character' })
      }
    : undefined
  const sendMessages = providerShape(settings, trimmed, record, {
    squashSystemMessages: preset.squash_system_messages === true,
    chatSquash: chatSquashOpt
  })

  // Agentic mode caps the output ceiling at the FSM mode's limit (e.g. Combat is terse),
  // never exceeding the preset's own max_tokens. Classic mode uses the preset value as-is.
  const presetMax = preset.parameters.max_tokens
  const baseMax = fsmEnabled
    ? presetMax != null
      ? Math.min(presetMax, modeConfig.max_output_tokens)
      : modeConfig.max_output_tokens
    : presetMax
  // SPreset ChatSquash stop strings (issue 16, spec:1150-1166): parsed from `stop_string` and forwarded
  // on the OpenAI-compatible path (params.stop). Empty on native presets → the key is absent (parity).
  const stopStrings = resolveStopStrings(chatSquashConfig)
  const params = {
    ...preset.parameters,
    max_tokens: baseMax,
    ...(stopStrings.length ? { stop: stopStrings } : {})
  }

  log(
    'request',
    `→ ${settings.api.provider} · ${settings.api.model || '(no model)'} · ${fsmEnabled ? `${mode} mode` : 'classic'} · ${sendMessages.length} msgs · ${settings.api.endpoint || '(default endpoint)'}`,
    sendMessages
  )

  return {
    sendMessages,
    params,
    record: record.finish(sendMessages, Date.now() - t0),
    // Pre-shape authored inputs + budget policy for the `Prompt` artifact's contributions (issue 18c).
    authored: { messages: trimmed, budgetClasses: trimmedClasses ?? budgetClasses },
    varWrites: varWrites.paths()
  }
}
