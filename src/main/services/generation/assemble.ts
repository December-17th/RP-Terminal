import { getActivePresetId } from '../presetService'
import { resolveYuzuMaxTokens } from '../settingsService'
import { matchAcross } from '../lorebookService'
import { getCachedWorldInfo, setCachedWorldInfo } from '../chatService'
import { buildPromptDetailed, fitToBudget, ChatMessage, BudgetClass } from '../promptBuilder'
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
import { buildVnOverlay } from '../yuzu/vnPrompt'
import { ExecutionRecord } from '../../../shared/executionRecord'
import { createRecordBuilder } from './executionRecord'

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
} => {
  // Forensic Execution Record (issue 07 / WP-1.1). ADDITIVE + behavior-neutral: the builder
  // journals every controlled transform and is returned alongside the UNCHANGED sendMessages;
  // callers may ignore it. `t0` bounds the added assembly time reported as `record.stats.buildMs`.
  const t0 = Date.now()
  const record = createRecordBuilder()
  const {
    profileId,
    chatId,
    chat,
    card,
    settings,
    fsmEnabled,
    mode,
    vnMode,
    generationType,
    lorebookIds,
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
  const regexOrder: RegexTierOrder = preset.spreset?.regexBindingEnabled ? 'preset-first' : 'st-default'
  const macroMaxPasses = preset.spreset?.macroNest === false ? 1 : undefined

  // WS4 (D10): fold the capped per-table memory block into the SAME memory tail as the recall / pack
  // block (`memoryBlock` → buildPrompt's tail splice). Computed here (not via a node) so it rides the
  // existing splice for EVERY workflow without consuming the `prompt-assembly` checkpoint's `block`
  // anchor lane (which is reserved for pack rejoin). Empty when no template is bound / nothing to inject
  // → the block is unchanged (parity). Ordered [recall/pack block][tables block] in the tail.
  const tablesBlock = renderChatTablesInjectionBlock(profileId, chatId)
  // Project Yuzu (ADR 0008 §7): in VN mode, append the YSS scene overlay to the SAME memory tail — it rides
  // the existing `memoryBlock` splice (buildPrompt: a system block immediately before the user action), so it
  // lands closest to the action and reorders nothing else. Off = empty string → filtered out → byte-identical.
  const vnOverlay = vnMode ? buildVnOverlay(profileId, lorebookIds) : ''
  const memoryTail = [memoryBlock, tablesBlock, vnOverlay].filter((s) => s && s.trim()).join('\n\n')

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
  const { messages: trimmed, dropped, budgetClasses: trimmedClasses } = fitToBudget(
    built,
    budget,
    budgetClasses
  )
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
  // Project Yuzu (ADR 0008 §7): in VN mode the player's setting (settings.yuzu.max_tokens, default 30000)
  // REPLACES the preset's ceiling verbatim — the preset max_tokens is a classic-chat concern. Off = the
  // classic value verbatim (parity). Mirrored in contextNodes.contextParams.
  const maxTokens = vnMode ? resolveYuzuMaxTokens(settings) : baseMax
  // SPreset ChatSquash stop strings (issue 16, spec:1150-1166): parsed from `stop_string` and forwarded
  // on the OpenAI-compatible path (params.stop). Empty on native presets → the key is absent (parity).
  const stopStrings = resolveStopStrings(chatSquashConfig)
  const params = {
    ...preset.parameters,
    max_tokens: maxTokens,
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
    authored: { messages: trimmed, budgetClasses: trimmedClasses ?? budgetClasses }
  }
}
