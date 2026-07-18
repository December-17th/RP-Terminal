// RPT assembly adapter seam for the conformance runner (M5 / issue 20, 20a).
//
// WIRED. This feeds a fixture's machine-readable `input` (preset / character / chat /
// generationType / pre-activated World Info / SPreset config) into REAL RPT prompt
// assembly and returns the assembled chat array so the runner can diff it against the
// fixture's `expected.chat`.
//
// The pipeline mirrors `assemblePrompt` (src/main/services/generation/assemble.ts) at the
// ASSEMBLY layer, which is exactly what ADR 0016 pins ("RPT reproduces SillyTavern 1.18.0's
// prompt-ASSEMBLY semantics"). Concretely:
//   1. `parseStPreset` normalizes the raw ST chat-completion preset into RPT's native Preset
//      (the fixtures carry ST-shaped presets: prompt_order + openai_max_tokens; the oai_settings
//      knobs ST saves into a preset file — wi_format / personality_format / scenario_format /
//      squash_system_messages — are folded in from `input.settings` first, exactly as an ST
//      preset file would carry them).
//   2. `buildPromptDetailed` produces the assembled message array (markers, format strings,
//      macros, depth injections, history) + its budget policy.
//   3. `fitToBudget` under a very large budget — a no-op for these fixtures. RPT's char-estimate
//      budgeting is an enumerated out-of-effort divergence (KNOWN-DIVERGENCES §4.2); the oracle
//      supplies a fixed `tokenBudget`. The fixtures are authored small so ST's tokenizer does not
//      trim either — so NOT trimming reproduces ST's no-trim result faithfully.
//   4. ST-faithful system-message COALESCING only (stage A of `providerShape`): SPreset ChatSquash
//      when the preset enables it, else ST's selective `squashSystemMessages` when the preset
//      carries `squash_system_messages: true`, else NOTHING.
//
// DELIBERATELY EXCLUDED from the comparison (they are RPT provider-correctness reshapes applied
// AFTER assembly, NOT part of ST's assembled prompt — see KNOWN-DIVERGENCES §5, §9):
//   • RPT's merge-ALL `mergeConsecutiveRoles` (§5): an RPT-only behavior; ST has no merge-all and
//     leaves adjacent unnamed system messages discrete. The fixtures pin ST's discrete assembly, so
//     applying merge-all here would collapse exactly the per-message format strings this suite
//     verifies. (wp-2.5-squash-off documents the production merge-all divergence via `knownDivergence`.)
//   • `orderForProvider` end-on-user reordering (§9): ST keeps a post-history / jailbreak system
//     block AFTER the last user turn (e.g. wp-2.1-char-card-overrides, wp-2.2-depth-zero); RPT's
//     provider seam would move the user last. That reshape is a wire concern, not assembly parity.
//   • system→user demotion (only fires when opted in on the OpenAI-compatible path).
//
// Some fixtures cannot be reproduced deterministically from their recorded input and stay
// structural (adapter returns null): a nondeterministic macro ({{roll}} / {{random}} / {{pick}})
// needs a seeded RNG the fixture doesn't supply (wp-2.3-macro-dice pins a frozen placeholder value).

import type { FixtureInput, FixtureMessage } from './fixtureSchema'
import { RPTerminalCardSchema } from '../../src/main/types/character'
import type { LorebookEntry } from '../../src/main/types/character'
import { PresetSchema } from '../../src/main/types/preset'
import { parseStPreset } from '../../src/main/parsers/stPresetParser'
import { parseSPresetConfig, spresetBoundRegexes, chatSquash } from '../../src/shared/spreset'
import {
  buildPromptDetailed,
  fitToBudget,
  squashSystemMessages,
  type ChatMessage
} from '../../src/main/services/promptBuilder'
import { buildTemplateContext } from '../../src/shared/templateEngine'
import { expandMacros } from '../../src/shared/macros'
import { appliesToPrompt, type RenderRegexRule } from '../../src/shared/regexTypes'

export interface RptAssemblyResult {
  chat: FixtureMessage[]
}

/** Nondeterministic macros whose value can't be reproduced without a seeded RNG the fixture omits. */
const NONDETERMINISTIC_MACRO = /\{\{\s*(roll|random|pick|dice)\b/i

/** Scan every authored string the build would macro-expand for a nondeterministic macro. */
const hasNondeterministicMacro = (input: FixtureInput): boolean => {
  const prompts = (input.preset?.prompts as Array<{ content?: unknown }> | undefined) ?? []
  const strings: string[] = []
  for (const p of prompts) if (typeof p?.content === 'string') strings.push(p.content)
  const char = input.character ?? {}
  for (const v of Object.values(char)) if (typeof v === 'string') strings.push(v)
  for (const m of input.chatMessages ?? []) strings.push(m.content)
  return strings.some((s) => NONDETERMINISTIC_MACRO.test(s))
}

/**
 * Split the flat chat transcript into RPT floors + the pending user action. The last turn is the
 * pending action when it's a `user` turn and the generation is not a `continue` (a continue extends
 * the assistant tail, so there is no pending user). Each remaining history turn becomes its own
 * one-message floor — `buildHistory` emits the non-empty side of each floor in order, so this
 * reproduces the exact history role sequence regardless of how the turns pair up.
 */
const toFloorsAndAction = (
  msgs: FixtureMessage[],
  generationType: string
): { floors: any[]; userAction: string } => {
  const list = msgs ?? []
  const last = list[list.length - 1]
  const pendingUser = generationType !== 'continue' && last?.role === 'user'
  const historyMsgs = pendingUser ? list.slice(0, -1) : list
  const userAction = pendingUser ? last!.content : ''
  const floors = historyMsgs.map((m, i) => ({
    floor: i,
    chat_id: 'fixture',
    timestamp: '',
    user_message: { content: m.role === 'user' ? m.content : '', timestamp: '' },
    response: { content: m.role === 'assistant' ? m.content : '', model: '', provider: '' },
    events: [],
    variables: {}
  }))
  return { floors, userAction }
}

/** Pre-activated World Info entry → LorebookEntry. Assembly-only parity: selection is an INPUT the
 *  oracle supplies (ADR 0016), fed to `buildPromptDetailed` as `matchedEntries` (scan skipped). An
 *  entry with a numeric `depth` becomes a depth-injected entry; otherwise it joins the top-level blob. */
const toLorebookEntry = (e: {
  content: string
  depth?: number
  order?: number
}): LorebookEntry =>
  ({
    keys: [],
    content: e.content,
    comment: '',
    enabled: true,
    insertion_depth: typeof e.depth === 'number' ? e.depth : null
  }) as unknown as LorebookEntry

/** Normalize a core-ST-shaped regex record into a RenderRegexRule. Mirrors the private
 *  `normalizeRule` in regexService.ts (kept here so the adapter stays self-contained; the
 *  bound records live inside the preset and are installed at import in production). */
const toRenderRule = (r: any): RenderRegexRule => {
  const raw = String(r.findRegex ?? r.regex ?? '')
  let source = raw
  let flags = 'g'
  if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
    const at = raw.lastIndexOf('/')
    source = raw.slice(1, at)
    flags = raw.slice(at + 1) || 'g'
  }
  const placement = Array.isArray(r.placement)
    ? r.placement.map((p: any) => Number(p)).filter((n: number) => !Number.isNaN(n))
    : []
  return {
    id: r.id || 'spreset-bound',
    scriptName: r.scriptName || r.name || 'Unnamed script',
    source,
    flags,
    replace: r.replaceString ?? '',
    placement,
    disabled: r.disabled === true,
    markdownOnly: r.markdownOnly === true,
    promptOnly: r.promptOnly === true,
    minDepth: typeof r.minDepth === 'number' ? r.minDepth : null,
    maxDepth: typeof r.maxDepth === 'number' ? r.maxDepth : null,
    substituteRegex: typeof r.substituteRegex === 'number' ? r.substituteRegex : 0,
    runOnEdit: r.runOnEdit === true,
    trimStrings: Array.isArray(r.trimStrings)
      ? r.trimStrings.filter((s: any) => typeof s === 'string')
      : [],
    origin: 'spreset'
  }
}

/** SPreset RegexBinding bound regexes → prompt-time regex rules (installed at import in production;
 *  here built directly from `extensions.SPreset`). Only prompt-phase rules are kept. */
const boundPromptRegex = (rawPreset: Record<string, unknown> | undefined): RenderRegexRule[] => {
  const config = parseSPresetConfig(rawPreset?.extensions)
  return spresetBoundRegexes(config).map(toRenderRule).filter(appliesToPrompt)
}

/**
 * Produce RPT's assembled prompt from a fixture's machine-readable input, or null to keep the
 * scenario structural (nondeterministic macro / not a parseable preset).
 */
export function assembleForFixture(input: FixtureInput): RptAssemblyResult | null {
  if (hasNondeterministicMacro(input)) return null

  const userName = input.userName || 'User'
  const card = RPTerminalCardSchema.parse({
    data: { name: 'Character', ...(input.character ?? {}) }
  })

  // Fold the oai_settings a preset file carries (wi_format / *_format / squash flag) from
  // `input.settings` into the raw preset, then normalize the ST preset into RPT's native shape.
  // The preset's own fields win over settings.
  const rawPreset = { ...(input.settings ?? {}), ...(input.preset ?? {}) }
  const parsed = parseStPreset(rawPreset, (input.preset?.name as string) || 'Fixture Preset')
  if (!parsed) return null
  const preset = PresetSchema.parse(parsed)

  const { floors, userAction } = toFloorsAndAction(input.chatMessages, input.generationType)
  const matchedEntries = (input.worldInfo ?? []).map(toLorebookEntry)
  const promptRegex = boundPromptRegex(input.preset)

  // Template context: `vars` backs {{setvar}}/{{getvar}}; constants back {{user}}/{{char}}/…. The
  // fixtures carry no EJS (<%…%>), so evalTemplate short-circuits (no engine init needed).
  const vars: Record<string, unknown> = {}
  const template = buildTemplateContext(vars, {
    constants: {
      userName,
      charName: card.data.name || 'Character',
      assistantName: card.data.name || 'Character',
      lastUserMessage: userAction
    }
  })

  const { messages, budgetClasses } = buildPromptDetailed({
    card,
    preset,
    lorebooks: [],
    floors,
    userAction,
    userName,
    generationType: input.generationType,
    matchedEntries,
    promptRegex,
    // SPreset MacroNest (issue 16): false ⇒ single non-nesting pass; true/absent ⇒ default nesting.
    macroMaxPasses: preset.spreset?.macroNest === false ? 1 : undefined,
    template
  })

  // Assembly-only: a very large budget so RPT's char-estimate trim never diverges from ST's
  // tokenizer trim (KNOWN-DIVERGENCES §4.2); the small fixtures never trim on either side.
  const { messages: trimmed } = fitToBudget(messages, Number.MAX_SAFE_INTEGER, budgetClasses)

  // Stage-A coalescing ONLY (see header): ChatSquash > ST system squash > nothing.
  const cs = preset.spreset?.chatSquash
  let chat: ChatMessage[]
  if (cs?.enabled) {
    chat = chatSquash(trimmed, cs, (s) =>
      expandMacros(s, { user: userName, char: card.data.name || 'Character' })
    )
  } else if (preset.squash_system_messages === true) {
    chat = squashSystemMessages(trimmed)
  } else {
    chat = trimmed
  }

  return { chat: chat.map((m) => ({ role: m.role, content: m.content })) }
}
