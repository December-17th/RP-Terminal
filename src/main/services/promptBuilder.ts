import { RPTerminalCard } from '../types/character'
import { Preset, PromptBlock } from '../types/preset'
import { FloorFile } from '../types/chat'
import { Lorebook, LorebookEntry } from '../types/character'
import { matchAcross } from './lorebookService'
import { parseEntryMarker, markerIndex, Marker, InjectMarker } from '../parsers/injectMarkers'
import { applyRegex, RenderRegexRule } from './regexService'
import { evalTemplate, evalTemplateDetailed, TemplateContext } from './templateService'
import { cleanForHistory } from '../../shared/responseView'
import { log } from './logService'
import { expandMacros, MacroContext } from '../../shared/macros'
import { buildStateBlock } from './cacheLayers'
import { AssemblyJournal, RecordSource } from '../../shared/executionRecord'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

// CJK ranges (Chinese/Japanese/Korean + fullwidth) tokenize denser than Latin,
// so estimate them ~1 token/char and other text ~4 chars/token. Rough, but good
// enough to keep us under a budget with margin without a real tokenizer.
const CJK = /[　-鿿가-힯＀-￯]/

export const estimateTokens = (text: string): number => {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

const msgTokens = (m: ChatMessage): number => estimateTokens(m.content) + 4

/**
 * The explicit per-message budget policy carried alongside an assembled prompt (issue 18c/18d).
 * REPLACES the retired non-enumerable `HISTORY_TAG` symbol: instead of a hidden marker on each
 * message object, `buildPromptDetailed` returns one class per emitted message (a parallel array,
 * 1:1 with `messages`), and `fitToBudget` reads THAT to decide what to drop.
 *  · `history` — a chat-history TURN (the analog of the old tag); the trim drops the OLDEST of these
 *    first, never the last one, so a large constant worldbook is never evicted just because a preset
 *    places a user/assistant block ahead of it.
 *  · `pinned`  — static content (system prompts, world info, card fields, preset blocks); never
 *    dropped by the budget policy.
 * These flow on into the assembled artifact's `PromptContribution.budgetClass` (promptArtifact.ts),
 * so a Prompt-native consumer (messages.trim) can honor the same policy without the hidden tag.
 */
export type BudgetClass = 'pinned' | 'history'

/** The rich result of assembly (issue 18c/18d): the wire `messages` plus the parallel budget policy
 *  (`budgetClasses[i]` classifies `messages[i]`). `buildPrompt` returns just `.messages` for the many
 *  callers that don't trim; `buildPromptDetailed` exposes both so `assemblePrompt` can trim history-
 *  aware AND carry the policy onto the artifact's contributions. */
export interface BuildPromptResult {
  messages: ChatMessage[]
  budgetClasses: BudgetClass[]
}

/**
 * Trim the prompt to fit a token budget. Keeps the leading system/lore prefix (L1/L2) and the most
 * recent conversation turns, dropping the OLDEST history first; the final user turn is always
 * retained. Returns how many messages were dropped so the caller can log it.
 *
 * `budgetClasses` (issue 18c/18d, when the caller has an explicit policy — the `buildPromptDetailed`
 * path) drives the preferred history-only drop keyed off DATA, not the old hidden `HISTORY_TAG`
 * symbol; the returned `budgetClasses` is filtered in lockstep so it stays aligned with the trimmed
 * messages. Absent (a hand-built array — messages.trim's legacy path) → the same fallback as before:
 * keep the leading system prefix, drop oldest from the first non-system message. The dropped SET is
 * byte-identical to the pre-18d behavior on both paths.
 */
export const fitToBudget = (
  messages: ChatMessage[],
  maxTokens: number,
  budgetClasses?: BudgetClass[]
): { messages: ChatMessage[]; dropped: number; budgetClasses?: BudgetClass[] } => {
  const total = messages.reduce((s, m) => s + msgTokens(m), 0)
  if (total <= maxTokens)
    return { messages, dropped: 0, ...(budgetClasses ? { budgetClasses } : {}) }

  const remove = new Set<number>()
  // Preferred path: drop the OLDEST explicit `history` turns (issue 18d — was `filter(isHistoryTurn)`),
  // never the last one, keeping every `pinned` message intact even if it alone exceeds the budget
  // (truncating system/lore mid-way is worse than a slightly over-budget prompt — the model's real
  // context window is the hard limit).
  const historyIdx = budgetClasses
    ? messages.map((_, i) => i).filter((i) => budgetClasses[i] === 'history')
    : []
  if (historyIdx.length > 0) {
    const removable = historyIdx.slice(0, -1) // never drop the latest turn
    let running = total
    for (const i of removable) {
      if (running <= maxTokens) break
      remove.add(i)
      running -= msgTokens(messages[i])
    }
  } else {
    // Legacy fallback (no explicit history — a hand-built array, or a history-free prompt): keep the
    // leading system prefix and the most recent messages, dropping oldest from the first non-system
    // message; always keep the last turn.
    const convoStart = messages.findIndex((m) => m.role !== 'system')
    if (convoStart !== -1) {
      let running = total
      for (let i = convoStart; running > maxTokens && i < messages.length - 1; i++) {
        remove.add(i)
        running -= msgTokens(messages[i])
      }
    }
  }

  if (remove.size === 0)
    return { messages, dropped: 0, ...(budgetClasses ? { budgetClasses } : {}) }
  return {
    messages: messages.filter((_, i) => !remove.has(i)),
    dropped: remove.size,
    ...(budgetClasses ? { budgetClasses: budgetClasses.filter((_, i) => !remove.has(i)) } : {})
  }
}

/**
 * Re-label every `system` message as `user` (content unchanged). Some OpenAI-compatible endpoints —
 * notably Gemini behind an OpenAI-compat layer — handle a mid-conversation or repeated `system` role
 * poorly, so SillyTavern demotes system→user there. Gated by `settings.generation.system_as_user` and
 * applied ONLY on the OpenAI-compatible path (Anthropic/Gemini-native handle system via their own params).
 * Run BEFORE `mergeConsecutiveRoles` so the converted blocks coalesce with adjacent user turns.
 */
export const systemToUser = (messages: ChatMessage[]): ChatMessage[] =>
  messages.map((m) => (m.role === 'system' ? { role: 'user', content: m.content } : m))

/**
 * Merge consecutive messages of the SAME role into one (joined by a newline), matching SillyTavern's
 * prompt assembly. A preset commonly splits one logical block across adjacent same-role entries — e.g.
 * `<{{user}}_setting>` (open) / the body / `</{{user}}_setting>` (close) as three toggleable `system`
 * entries — and relies on the host coalescing them; without this they reach the model as separate
 * messages (the lone `<梅芙_setting>` symptom). Pure; gated by `settings.generation.merge_consecutive_roles`.
 */
export const mergeConsecutiveRoles = (messages: ChatMessage[]): ChatMessage[] => {
  const out: ChatMessage[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) last.content += '\n' + m.content
    else out.push({ role: m.role, content: m.content })
  }
  return out
}

/**
 * A `ChatMessage` that MAY carry SillyTavern's per-message `name` / `identifier` (ST's `Message`
 * object — openai.js). RPT's own assembly never sets these — every message it emits is an unnamed,
 * identifier-less `{role, content}` — so on the real wire `squashSystemMessages` merges EVERY
 * consecutive system message. The fields exist only so synthesized fixtures / unit tests can exercise
 * ST's named-message and protected-control-identifier carve-outs. `ChatMessage[]` is assignable here
 * (the extra fields are optional), so the provider seam passes its plain array unchanged.
 */
export interface SquashMessage extends ChatMessage {
  /** ST `message.name` — a named system message (e.g. an example-dialogue turn) is NEVER squashed. */
  name?: string
  /** ST `message.identifier` — the control identifiers in ST's exclude list are never squashed. */
  identifier?: string
}

/**
 * SillyTavern's `squashSystemMessages` (openai.js:3827-3866), applied for an IMPORTED ST preset that
 * sets `squash_system_messages: true` (ST gates the call on `oai_settings.squash_system_messages`,
 * openai.js:1599-1601). It is DELIBERATELY NARROWER than RPT's `mergeConsecutiveRoles`:
 *
 *  - it merges ONLY consecutive `system` messages that are UNNAMED and whose `identifier` is not one of
 *    ST's protected controls (`newMainChat` / `newChat` / `groupNudge`, openai.js:3828) — user and
 *    assistant turns pass through untouched, unlike merge-all;
 *  - it DROPS empty `system` messages entirely (openai.js:3835-3837), and a dropped empty never breaks
 *    a squash run (the surrounding squashable systems still merge across it);
 *  - merged content is joined with a single `'\n'` (openai.js:3846).
 *
 * Native RPT presets keep `mergeConsecutiveRoles` (see providerShape); the two are mutually exclusive —
 * ST has no merge-all, so a squashing import must not also merge-all. Pure; returns fresh `{role, content}`
 * objects (RPT's wire carries no name/identifier), never mutating the input.
 */
export const squashSystemMessages = (messages: SquashMessage[]): ChatMessage[] => {
  const EXCLUDE = new Set(['newMainChat', 'newChat', 'groupNudge']) // openai.js:3828
  // openai.js:3839-3841: squashable = not a protected control, role system, and no name.
  const shouldSquash = (m: SquashMessage): boolean =>
    !EXCLUDE.has(m.identifier ?? '') && m.role === 'system' && !m.name
  const out: ChatMessage[] = []
  let last: { msg: ChatMessage; src: SquashMessage } | null = null
  for (const m of messages) {
    // openai.js:3835-3837: force-exclude empty system messages before any squash decision.
    if (m.role === 'system' && !m.content) continue
    if (shouldSquash(m) && last && shouldSquash(last.src)) {
      last.msg.content += '\n' + m.content // openai.js:3846
    } else {
      const msg: ChatMessage = { role: m.role, content: m.content }
      out.push(msg)
      last = { msg, src: m }
    }
  }
  return out
}

export interface PersonaArgs {
  description: string
  /** Whether to inject the description (IN_PROMPT). false = ST's "None" position. */
  inject: boolean
}

export interface BuildPromptArgs {
  card: RPTerminalCard
  preset: Preset
  /** All lorebooks active for this session (matched + merged together). */
  lorebooks: Lorebook[]
  floors: FloorFile[]
  userAction: string
  userName?: string
  persona?: PersonaArgs
  /** Current generation type (ST `type`, lowercased) driving `injection_trigger` filtering
   *  (PromptManager.js:1549-1553). Absent = `normal` — the common case; a preset block with no
   *  trigger array fires regardless, so parity is unaffected for trigger-free presets. */
  generationType?: string
  /** How many recent turns to scan for lorebook keywords (default 3). */
  scanDepth?: number
  /** Max recursive lorebook match passes (default 0 = off). */
  maxRecursion?: number
  /** Pre-matched world-info entries (Phase H inc 2 cache). When given, the internal
   * keyword scan is skipped and these are used verbatim — stable L2 within a mode. */
  matchedEntries?: LorebookEntry[]
  /** Regex rules applied to outgoing prompt text (placement 1 = user, 2 = AI). */
  promptRegex?: RenderRegexRule[]
  /** World Info regex rules (ST placement 5) applied to each activated entry's content, isPrompt-strict
   *  (getWorldInfoRules). ST regexes `entry.content` before macro expansion (world-info.js:5086). */
  worldInfoRegex?: RenderRegexRule[]
  /** Per-mode system instruction (Phase H); a stable block just before the conversation. */
  modeAddendum?: string
  /** ST-Prompt-Template context; when present, authored content is run through the engine. */
  template?: TemplateContext
  /** Prompt-cache level (0 = baseline; ≥1 = L1 Frozen Core). */
  cacheLevel?: number
  /** L1 sub-mode (partition = placeholder state, diff = floor-0 state). */
  l1Mode?: 'partition' | 'diff'
  /** Floor-0-derived frozen variable snapshot the frontier renders against at level ≥1. */
  frozenVars?: Record<string, any>
  /** Optional producer-agnostic tail block (wired from the prompt.assemble `block` port /
   *  prompt.preset `memory` port). Injected just before the user action, the same way as the
   *  live-state block, so it sits in the volatile tail. Empty/unwired = no injection. */
  memoryBlock?: string
  /** prompt.preset composer (context-epochs plan §3): verbatim history messages to use in the
   *  chat_history marker + no-marker safety net INSTEAD of the built-from-floors history. They
   *  arrive pre-processed (no regex/macro passes), each classed `budgetClass:'history'` so
   *  fitToBudget still trims them; the pending action is appended after them as the final user
   *  message. Absent = today's built-from-floors path (parity). */
  historyOverride?: ChatMessage[]
  /** prompt.preset composer: replace ONLY the top-level World Info block (the world_info marker +
   *  its safety net) with this string; the internal keyword scan is skipped (assemblePrompt passes
   *  `matchedEntries: []`). Depth-positioned + marker entries live only on the scan path. Absent =
   *  the computed worldInfo string (parity). */
  worldInfoOverride?: string
  /** Forensic Execution Record sink (issue 07). When present, buildPrompt journals every
   *  controlled transform (marker expansion, macro/template passes, prompt-regex, depth/injection
   *  insertion, safety-net inserts, history emission) into it. PURE observer — the journal never
   *  changes the returned messages. Absent = today's behavior, no record. */
  journal?: AssemblyJournal
  /** Max macro passes (SPreset MacroNest — issue 16). Absent = RPT's default nesting cap (5). An
   *  imported preset with `extensions.SPreset.MacroNest:false` sets 1 (single non-nesting pass). */
  macroMaxPasses?: number
}

/** No-op text transform (used when there are no prompt-time regex rules). */
const identity = (t: string): string => t

type Renderer = (text: string) => string

/** Strip any leftover EJS tags (used only when no template engine is available). */
const stripEjs = (s: string): string => s.replace(/<%[\s\S]*?%>/g, '')

/** History/output text: expand {{macros}} then drop any stray EJS (templates don't run
 * on the model's own output at prompt-time) and trim. */
const macroOnly = (text: string, ctx: MacroContext): string =>
  stripEjs(expandMacros(text, ctx)).trim()

/**
 * Build the character-description block. NATIVE presets fold Personality + Scenario in here
 * (ST's charDescription is just the description, but RPT's single-marker native shape combines
 * them). When the preset carries DISTINCT `char_personality` / `scenario` markers (ST imports),
 * those fields are emitted by their own markers instead — so they're excluded here to avoid
 * duplication. `includePersonality`/`includeScenario` default true (the native shape).
 */
const buildCharDescription = (
  card: RPTerminalCard,
  charName: string,
  render: Renderer,
  opts?: { includePersonality?: boolean; includeScenario?: boolean }
): string => {
  const d = card.data
  const parts: string[] = [`Name: ${charName}`]
  if (d.description) parts.push(`Description: ${render(d.description)}`)
  if (opts?.includePersonality !== false && d.personality)
    parts.push(`Personality: ${render(d.personality)}`)
  if (opts?.includeScenario !== false && d.scenario) parts.push(`Scenario: ${render(d.scenario)}`)
  return parts.join('\n')
}

/**
 * ST `stringFormat` (utils.js:757-764): positional `{n}` substitution — `{0}` is replaced by the first
 * arg, `{1}` by the second, etc.; an index with no matching arg is left literal. ST's `formatWorldInfo`
 * (openai.js:780-792) builds the World Info marker with `stringFormat(wi_format, value)`.
 */
const stringFormat = (format: string, ...args: string[]): string =>
  format.replace(/\{(\d+)\}/g, (m, n: string) => (args[Number(n)] !== undefined ? args[Number(n)] : m))

/**
 * ST `shouldTrigger` (PromptManager.js:1549-1553): a block with no `injection_trigger` array,
 * or an empty one, fires for ALL generation types; otherwise the lowercased current generation
 * type must be listed.
 */
export const shouldTrigger = (block: { injection_trigger?: string[] }, genType: string): boolean => {
  const trig = block.injection_trigger
  if (!Array.isArray(trig) || trig.length === 0) return true
  return trig.includes(genType)
}

/** Character-card override sources (ST systemPromptOverride / jailbreakPromptOverride). */
export interface CardPromptOverrides {
  /** Card `data.system_prompt` — replaces the `main` block's content. */
  system?: string
  /** Card `data.post_history_instructions` — replaces the `jailbreak` block's content. */
  postHistory?: string
}

/**
 * A resolved prompt block. When a character-card override replaced a `main`/`jailbreak` literal, the
 * block carries `originalContent` — the PRE-override preset text — so the override can resolve
 * `{{original}}` to it during macro substitution (ST openai.js:1489-1492 → preparePrompt(…, original)).
 */
export type EffectivePromptBlock = PromptBlock & { originalContent?: string }

/**
 * Resolve a preset's ordered prompts into the effective list the builder assembles from,
 * reproducing ST's Prompt Manager collection + character-card overrides:
 *
 *  - drop a block that is disabled OR filtered out by `injection_trigger` for this generation
 *    type (getPromptCollection, PromptManager.js:1516-1541);
 *  - EXCEPT a disabled/filtered `main` literal is retained as a STRUCTURAL EMPTY prompt — ST's
 *    "GMO-free vegan replacement" (PromptManager.js:1531-1537) so relative inserts still resolve.
 *    Its empty content emits no wire message and ST squashes empty system messages out of the
 *    final prompt anyway (openai.js:3836), so the observable output matches;
 *  - a character-card system-prompt / post-history override replaces the `main` / `jailbreak`
 *    literal's content, but ONLY when that block exists, is enabled + triggered, and does not set
 *    `forbid_overrides` (openai.js:1487-1504).
 *
 * `journal` (issue 07 invariant 2) is a PURE observer: every block dropped here (disabled /
 * trigger-filtered) AND every override the card offered but the block forbade is recorded as an
 * `exclude` decision, so no source leaves the request without a journal entry explaining the
 * absence. It never affects the returned list — the wire is byte-identical with or without it.
 *
 * Pure; exported for characterization tests.
 */
export const resolveEffectivePrompts = (
  prompts: PromptBlock[],
  generationType: string,
  overrides: CardPromptOverrides,
  journal?: AssemblyJournal
): EffectivePromptBlock[] => {
  const gt = String(generationType || 'normal')
    .toLowerCase()
    .trim()
  const blockSource = (b: PromptBlock): RecordSource => ({
    kind: 'preset-block',
    id: b.identifier,
    ...(b.name ? { label: b.name } : {})
  })
  const out: EffectivePromptBlock[] = []
  for (const p of prompts) {
    const triggered = p.enabled !== false && shouldTrigger(p, gt)
    if (triggered) {
      if (p.marker === 'none' && p.forbid_overrides !== true) {
        // The override replaces the literal's content; `originalContent` retains the preset text so
        // the override's `{{original}}` resolves to it (ST openai.js:1489-1492).
        if (p.identifier === 'main' && overrides.system) {
          out.push({ ...p, content: overrides.system, originalContent: p.content })
          continue
        }
        if (p.identifier === 'jailbreak' && overrides.postHistory) {
          out.push({ ...p, content: overrides.postHistory, originalContent: p.content })
          continue
        }
      } else if (
        p.marker === 'none' &&
        p.forbid_overrides === true &&
        ((p.identifier === 'main' && !!overrides.system) ||
          (p.identifier === 'jailbreak' && !!overrides.postHistory))
      ) {
        // The card offered an override but the block forbids it: the OVERRIDE text is excluded (the
        // original literal is kept). Record the decision (invariant 2) — the block still ships.
        journal?.exclude(blockSource(p), 'override-denied')
      }
      out.push(p)
    } else if (p.identifier === 'main' && p.marker === 'none') {
      // Structural empty main (never overridden — the block is disabled/filtered).
      out.push({ ...p, content: '', enabled: true })
    } else {
      // Dropped (disabled / trigger-filtered) — record WHY so no source leaves silently (invariant 2).
      journal?.exclude(blockSource(p), p.enabled === false ? 'disabled' : `trigger-filtered:${gt}`)
    }
  }
  return out
}

/** Expand the running history into alternating messages, ending with the new action.
 * `applyUser`/`applyAssistant` run prompt-time regex on the raw text before macros. `mark` records
 * each emitted message as a chat-history TURN (issue 18d: the caller collects these so it can classify
 * `budgetClass:'history'` at the end — the explicit-data replacement for the retired HISTORY_TAG). */
const buildHistory = (
  floors: FloorFile[],
  userAction: string,
  macroCtx: MacroContext,
  applyUser: (t: string, depth: number) => string,
  applyAssistant: (t: string, depth: number) => string,
  mark: (m: ChatMessage) => ChatMessage
): ChatMessage[] => {
  // Collect the raw turns first so each can be assigned its DEPTH — distance from the end of the
  // chat, latest turn = 0 (ST semantics) — BEFORE depth-scoped prompt regex runs. Without this, a
  // `minDepth:1` rule like "keep only the latest user input → <|placeholder|>" would also blank the
  // live input (it has no depth and matches `^[\s\S]*$`).
  const raw: Array<{ role: 'user' | 'assistant'; text: string }> = []
  for (const f of floors) {
    if (f.user_message.content) raw.push({ role: 'user', text: f.user_message.content })
    // The stored response is the FULL raw output; strip reasoning + state tags for the prompt
    // (the model never re-reads its own <thinking> / <UpdateVariable>).
    const resp = cleanForHistory(f.response.content)
    if (resp) raw.push({ role: 'assistant', text: resp })
  }
  if (userAction) raw.push({ role: 'user', text: userAction })

  const n = raw.length
  return raw.map((r, i) => {
    const depth = n - 1 - i
    const transformed = r.role === 'user' ? applyUser(r.text, depth) : applyAssistant(r.text, depth)
    return mark({ role: r.role, content: macroOnly(transformed, macroCtx) })
  })
}

/**
 * One depth-positioned injection candidate. `depth` counts messages up from the bottom of the
 * chat region (0 = bottom). ST groups same-depth candidates by `injection_order` and role before
 * splicing (see `groupDepthInjections`).
 */
interface DepthItem {
  depth: number
  content: string
  role?: ChatMessage['role']
  /** ST `injection_order` (default 100). Same-depth items are grouped by this; extension items are
   *  forced to 100 (ST treats getExtensionPrompt IN_CHAT content as the order-100 group). */
  order?: number
  /** RPT's IN_CHAT "extension" content (lorebook depth entries / pipeline injects) — the analog of
   *  ST's `getExtensionPrompt(IN_CHAT, …)`. Always order 100 and merged AFTER preset prompts of the
   *  same role within the order-100 group (ST joins `[rolePrompts, extensionPrompt]`, openai.js:846-849). */
  extension?: boolean
  /** Forensic lineage (issue 07) — the entry/block this depth item came from. */
  source?: RecordSource
}

/** One grouped role-message ready to splice at a depth, with the lineage of every item merged into it. */
interface GroupedInjection {
  depth: number
  role: ChatMessage['role']
  content: string
  sources: RecordSource[]
}

/** ST role sequence for a same-depth/same-order group (openai.js:838, "most important go lower"). */
const ROLE_SEQUENCE: ChatMessage['role'][] = ['system', 'user', 'assistant']

/**
 * Reproduce SillyTavern's `populationInjectionPrompts` grouping (openai.js:801-866): for each depth,
 * group same-depth prompts by `injection_order`, process orders HIGH→LOW, roles in the sequence
 * [system, user, assistant], joining same-role contents with '\n'; the order-100 group additionally
 * merges the IN_CHAT extension content (RPT's lorebook depth entries / pipeline injects) AFTER the
 * preset prompts of that role.
 *
 * ST builds that sequence into a temp array and then reverses the WHOLE message array
 * (`messages = messages.reverse()`, openai.js:864). Reversing a contiguous block flips its element
 * order, so we emit the NET post-reverse order directly: orders ASCENDING, roles
 * [assistant, user, system]. The reversal reorders MESSAGES, never characters within a joined
 * message — so each message's joined content is byte-identical to ST's.
 *
 * Pure; exported for characterization. Returns grouped role-messages in net final order per depth.
 */
export const groupDepthInjections = (items: DepthItem[]): GroupedInjection[] => {
  const byDepth = new Map<number, DepthItem[]>()
  for (const it of items) {
    if (!it.content) continue // ST: `&& prompt.content` (openai.js:813)
    if (!byDepth.has(it.depth)) byDepth.set(it.depth, [])
    byDepth.get(it.depth)!.push(it)
  }
  const orderOf = (it: DepthItem): number => (it.extension ? 100 : (it.order ?? 100))
  const out: GroupedInjection[] = []
  for (const [depth, group] of byDepth) {
    // Orders ASCENDING = ST's build-DESCENDING reversed (openai.js:833 sorts `+b - +a`).
    const orders = [...new Set(group.map(orderOf))].sort((a, b) => a - b)
    for (const order of orders) {
      // Roles [assistant, user, system] = ST's [system, user, assistant] (openai.js:838) reversed.
      for (const role of [...ROLE_SEQUENCE].reverse()) {
        const inRole = group.filter((it) => orderOf(it) === order && (it.role ?? 'system') === role)
        if (!inRole.length) continue
        // ST: `rolePrompts` (preset prompts of this order+role, joined by '\n') then `extensionPrompt`
        // (order-100 IN_CHAT extension content), the two joined with '\n' after each is trimmed
        // (openai.js:840-849). A stable preset-before-extension partition preserves that.
        const presetJoined = inRole.filter((it) => !it.extension).map((it) => it.content).join('\n')
        const extJoined = inRole.filter((it) => it.extension).map((it) => it.content).join('\n')
        const content = [presetJoined, extJoined]
          .filter((x) => x)
          .map((x) => x.trim())
          .join('\n')
        if (!content) continue // ST: `if (jointPrompt && jointPrompt.length)` (openai.js:851)
        const sources = [
          ...inRole.filter((it) => !it.extension),
          ...inRole.filter((it) => it.extension)
        ]
          .map((it) => it.source)
          .filter((s): s is RecordSource => !!s)
        out.push({ depth, role, content, sources })
      }
    }
  }
  return out
}

/**
 * Splice grouped depth injections into the assembled message array. Depth counts messages up from
 * the bottom of the chat region; ST places depth `d` immediately above the d-th message from the
 * bottom (final index `base - d`). Insertions are clamped into the conversation region (never the
 * cached system prefix) and spliced highest-index-first so earlier inserts don't shift later targets.
 *
 * RPT DIVERGENCE (deliberate, tracked — ADR 0016): the trailing user action always stays last
 * (`maxIdx = base - 1` when present) so nothing volatile lands past the provider cache breakpoint
 * (the L4-last invariant). ST places a depth-0 injection AFTER the newest message; RPT keeps it just
 * before the pending action. For every depth ≥ 1, and for depth 0 with no trailing user (e.g. a
 * continue), the net placement matches ST.
 */
const applyGroupedDepthInjections = (
  messages: ChatMessage[],
  items: DepthItem[],
  convoStart: number,
  hasTrailingUser: boolean,
  journal?: AssemblyJournal
): void => {
  const grouped = groupDepthInjections(items)
  if (!grouped.length) return
  const base = messages.length
  const maxIdx = hasTrailingUser ? base - 1 : base
  const start = convoStart === -1 ? base : convoStart
  const depths = [...new Set(grouped.map((g) => g.depth))]
  const plan = depths.map((depth) => ({
    depth,
    idx: Math.max(start, Math.min(base - depth, maxIdx)),
    msgs: grouped.filter((g) => g.depth === depth)
  }))
  // Splice larger indices first (no shift of smaller targets); on a tie (two depths clamped to the
  // same index) inject the LOWER depth first so the higher depth stacks above it, matching ST.
  plan.sort((a, b) => b.idx - a.idx || a.depth - b.depth)
  for (const p of plan) {
    messages.splice(p.idx, 0, ...p.msgs.map((g) => ({ role: g.role, content: g.content })))
    // Forensic lineage (issue 07): one depth-inject entry per contributing source, sharing the
    // insertion index + role, so a MERGED message retains EVERY source id it was joined from.
    p.msgs.forEach((g, offset) => {
      const at = p.idx + offset
      const srcs = g.sources.length ? g.sources : [{ kind: 'pipeline', id: 'depth-inject' } as RecordSource]
      for (const s of srcs) journal?.depthInject(s, g.depth, at, g.role, g.content)
    })
  }
}

/** Insert a system block just before the first conversation (non-system) message — or append it when
 *  the array is all-system. Centralizes the convoStart find+splice repeated for the world-info safety
 *  net, the mode addendum, and the persona block (WS-5). Returns the index it inserted at (forensic). */
const insertBeforeConvo = (messages: ChatMessage[], msg: ChatMessage): number => {
  const convoStart = messages.findIndex((m) => m.role !== 'system')
  const at = convoStart === -1 ? messages.length : convoStart
  messages.splice(at, 0, msg)
  return at
}

/** A matched/forced lorebook entry paired with its parsed marker classification. */
type ParsedEntry = { e: LorebookEntry; p: ReturnType<typeof parseEntryMarker> }

interface PartitionedLore {
  /** Marker entries (`[GENERATE]`/`@INJECT`/…) to drain into positions, matched + force-activated. */
  markerEntries: ParsedEntry[]
  /** Plain world-info entries with no numeric depth → the top-level World Info block. */
  topEntries: LorebookEntry[]
  /** Plain world-info entries with a numeric depth → injected into the history at that depth. */
  depthEntries: LorebookEntry[]
}

/**
 * Partition matched lorebook entries (+ force-activated marker entries from the books) into the three
 * buckets buildPrompt consumes. Pure (no render context); extracted from buildPrompt (WS-5). A matched
 * entry whose comment/decorator is an injection marker is drained into a prompt POSITION, not emitted as
 * plain world-info; `@@dont_activate` drops it; `@@activate`/`@@always_enabled` force-activate an unmatched
 * marker entry. Non-marker cards are unaffected (parseEntryMarker → marker null → all "regular").
 */
const partitionLore = (matched: LorebookEntry[], lorebooks: Lorebook[]): PartitionedLore => {
  const parsedMatched: ParsedEntry[] = matched.map((e) => ({
    e,
    p: parseEntryMarker(e.comment, e.content)
  }))
  const regular = parsedMatched
    .filter(({ p }) => !p.marker && p.activation !== 'never')
    .map(({ e }) => e)
  // @@activate / @@always_enabled force-activate a marker entry even when the keyword scan didn't match
  // it. Pre-filter cheaply (anchored regex, no full parse) before parsing the few candidates.
  const looksMarked = (e: LorebookEntry): boolean =>
    /^\s*@@/.test(e.content) || /^\s*(\[GENERATE|\[RENDER|@INJECT)/i.test(e.comment)
  const keyOf = (e: LorebookEntry): string => JSON.stringify([e.comment, e.content])
  const matchedKeys = new Set(matched.map(keyOf))
  const forced = lorebooks
    .flatMap((lb) => lb.entries)
    .filter((e) => e.enabled !== false && looksMarked(e) && !matchedKeys.has(keyOf(e)))
    .map((e) => ({ e, p: parseEntryMarker(e.comment, e.content) }))
    .filter(({ p }) => p.marker && p.activation === 'force')
  const markerEntries = [
    ...parsedMatched.filter(({ p }) => p.marker && p.activation !== 'never'),
    ...forced
  ]
  return {
    markerEntries,
    topEntries: regular.filter((e) => e.insertion_depth == null),
    depthEntries: regular.filter((e) => e.insertion_depth != null)
  }
}

/** The text scanned for lorebook keywords: the last `scanDepth` turns + the pending action. */
export const buildScanText = (floors: FloorFile[], userAction: string, scanDepth: number): string =>
  [
    ...floors
      .slice(-Math.max(1, scanDepth))
      .flatMap((f) => [f.user_message.content, cleanForHistory(f.response.content)]),
    userAction
  ]
    .filter(Boolean)
    .join('\n')

/**
 * Assemble the final provider message array from the card, preset ordering,
 * matched lorebook entries and chat history. The preset's prompt blocks drive
 * the order; dynamic markers expand to live content.
 *
 * Phase G — cache-friendly layering. The output is ordered for maximal prefix
 * reuse so providers (OpenAI auto prefix-caching; Anthropic cache_control —
 * applied in apiService) can cache a stable head across turns:
 *   L1 static core   — system prompts + character description + examples (stable per session)
 *   L2 semi-static   — world info / lorebook (changes only when keywords change)
 *   L3 rolling history — prior turns (append-only; the prefix is byte-stable)
 *   L4 volatile      — the new user action, ALWAYS the final message (0% cache)
 * The only invariant we hard-enforce here is L4-last: the pending user action is
 * appended after everything else so nothing volatile sits inside the cached prefix.
 */
/**
 * Assembly core (issue 18c/18d). Returns the wire `messages` PLUS the parallel `budgetClasses` policy
 * (history vs pinned per message). `buildPrompt` below is the `.messages`-only wrapper the many callers
 * that never trim keep using unchanged. History messages are collected by object identity during the
 * build (an internal `Set`, never exposed) and turned into explicit `budgetClass` DATA at the end —
 * the replacement for the retired non-enumerable HISTORY_TAG.
 */
export const buildPromptDetailed = (args: BuildPromptArgs): BuildPromptResult => {
  const { card, preset, lorebooks, floors, userAction } = args
  const charName = card.data.name || 'Character'
  const userName = args.userName || 'User'
  // History-turn identity (issue 18d): collected here by object reference during the build, then
  // projected to explicit `budgetClass:'history'` data on return. Internal only — never a Symbol on
  // the message and never exposed, so the wire + stored floor are byte-identical to before.
  const historyRefs = new Set<ChatMessage>()
  const markHist = (m: ChatMessage): ChatMessage => {
    historyRefs.add(m)
    return m
  }
  // The pending player-action turn + the final history turn, captured when history is emitted (via the
  // chat_history marker OR the no-marker safety net). Used to position the char_description injection
  // (owner directive, KNOWN-DIVERGENCES §10) immediately before the player action — or, on a `continue`
  // with no pending user, just after the history tail. Both are message OBJECTS so `indexOf` still finds
  // them after later tail splices (depth injects / cache tail / memory block) shift indices around them.
  let playerActionRef: ChatMessage | null = null
  let historyTailRef: ChatMessage | null = null

  // ST Prompt Manager collection + character-card overrides (issue 11). Drops trigger-filtered /
  // disabled blocks, keeps a structural empty `main`, and folds the card's system_prompt /
  // post_history_instructions into `main` / `jailbreak`. For a trigger-free preset with no card
  // overrides this is exactly `preset.prompts` (parity). Everything below iterates THIS list.
  const effectivePrompts = resolveEffectivePrompts(
    preset.prompts,
    args.generationType ?? 'normal',
    {
      system: card.data.system_prompt || undefined,
      postHistory: card.data.post_history_instructions || undefined
    },
    args.journal
  )
  // Whether the preset carries its OWN character-personality / scenario markers (ST imports). When
  // it does, char_description must NOT re-fold those fields (they're emitted by their markers).
  const hasPersonalityMarker = effectivePrompts.some((b) => b.marker === 'char_personality')
  const hasScenarioMarker = effectivePrompts.some((b) => b.marker === 'scenario')
  // Whether a "before-char" World Info slot exists (native `world_info` counts as one). Used so the
  // `world_info_after` marker only falls back to rendering the combined WI blob when no before-slot
  // will render it (RPT has no per-entry before/after split — see the world_info_after case).
  const hasWiBeforeSlot = effectivePrompts.some(
    (b) => b.marker === 'world_info' || b.marker === 'world_info_before'
  )

  const personaDescription = args.persona?.description ?? ''
  const personaMacro = personaDescription.trim()
  const personaInject = !!args.persona?.inject && !!personaMacro
  // {{persona}} expands to the description in authored content (but not inside the
  // persona block itself — that's rendered with an empty persona to avoid recursion).
  // ST gates only the IN_PROMPT insertion; the macro resolver always sees the active bio.

  // Central transform order for authored content: macros → EJS template → (regex runs
  // separately on history/user text). The macro pass shares the template's var/global
  // stores so {{setvar}} and <% setvar() %> stay coherent; it leaves <%...%> intact so
  // the engine runs next. (Previously macros stripped EJS before eval — templates never
  // executed via the builder; that's fixed here.)
  // {{lastUserMessage}} — the most recent user turn's raw text (ST chat-macros.js:108-111). During
  // assembly the pending action IS the last user message (ST adds it to chat before generating);
  // otherwise it's the newest floor's user message.
  const lastUserMessage =
    userAction ||
    [...floors].reverse().find((f) => f.user_message?.content)?.user_message?.content ||
    ''
  const macroBase = (
    pd: string,
    vars?: Record<string, any>,
    globals?: Record<string, any>,
    original?: string
  ): MacroContext => ({
    user: userName,
    char: charName,
    persona: pd,
    lastUserMessage,
    // ST character-field macros (env-macros.js:67-89): {{personality}}/{{scenario}}/{{description}}.
    // Threaded so an imported preset's `personality_format` / `scenario_format` (which default to
    // `{{personality}}` / `{{scenario}}`) resolve when the marker cases render them. Empty string (not
    // undefined) when the card field is absent — matching ST's `env.character.<field> ?? ''`.
    personality: card.data.personality || '',
    scenario: card.data.scenario || '',
    description: card.data.description || '',
    original,
    vars: vars ?? args.template?.vars,
    globals: globals ?? args.template?.globals,
    // SPreset MacroNest (issue 16): undefined = RPT's default nesting; 1 = single non-nesting pass.
    maxPasses: args.macroMaxPasses
  })
  const makeRender =
    (pd: string, tmpl?: TemplateContext): Renderer =>
    (t) => {
      const m = expandMacros(t, macroBase(pd, tmpl?.vars, tmpl?.globals))
      return tmpl ? evalTemplate(m, tmpl) : stripEjs(m).trim()
    }
  // L1 Frozen Core: at cache level ≥1 the durable frontier renders against a FROZEN
  // variable snapshot (floor-0 derived), so its bytes are byte-stable across turns and
  // the provider prefix cache holds. Live state moves to a tail block (appended below).
  const cacheLevel = args.cacheLevel ?? 0
  const frontierTemplate: TemplateContext | undefined = args.template
    ? cacheLevel >= 1
      ? { ...args.template, vars: args.frozenVars ?? {} }
      : args.template
    : undefined
  const render = makeRender(personaMacro, frontierTemplate)

  // IMPORT-vs-NATIVE marker formatting (issue 11 / ST 1.18.0 parity). An imported ST preset carries the
  // per-marker format strings (the parser sets all three, defaulting to ST defaults); a native RPT preset
  // leaves them undefined. When present, the char/scenario/personality/world-info markers below reproduce
  // ST's own formatting — a BARE charDescription (openai.js:1369), `stringFormat(wi_format, …)`
  // (formatWorldInfo, openai.js:780-792), and `substituteParams(personality_format|scenario_format)`
  // (openai.js:1359-1360). When absent, they keep RPT's native `Name:/Description:` + `World Info:\n` shape.
  const wiFormat = preset.wi_format
  const isStImport =
    wiFormat != null || preset.personality_format != null || preset.scenario_format != null
  // Build the World Info marker/safety-net content. Import: ST `formatWorldInfo` — a blank/whitespace
  // wi_format yields the bare value (openai.js:787-788), otherwise `stringFormat`. Native: `World Info:\n`.
  const renderWorldInfo = (blob: string): string =>
    wiFormat != null ? (wiFormat.trim() ? stringFormat(wiFormat, blob) : blob) : `World Info:\n${blob}`

  // Expand {{macros}} for one entry — applying {{setvar}}/{{addvar}}/… side effects to the shared var
  // store. `original` (the pre-override preset text) is threaded for card-overridden main/jailbreak so
  // their {{original}} resolves.
  const macroPass = (content: string, original?: string): string =>
    expandMacros(
      content,
      macroBase(personaMacro, frontierTemplate?.vars, frontierTemplate?.globals, original)
    )
  // EJS-evaluate already-macro-expanded PRESET content. An error here means a broken preset entry → FAIL THE
  // TURN with a detailed log (which entry + reason + source), so a conditional never silently drops or leaks
  // all its branches. (Card-field renders below stay graceful via `render`.)
  // Error policy: "preset blocks fail loud" tier — see docs/rpt-api.md §7 (WS-9).
  const ejsStrict = (expanded: string, label: string): string => {
    if (!frontierTemplate) return stripEjs(expanded).trim()
    const r = evalTemplateDetailed(expanded, frontierTemplate)
    if (r.error) {
      log(
        'error',
        `✗ preset template error in "${label}"`,
        `${r.error}\n— source: ${expanded.slice(0, 400)}`
      )
      throw new Error(`preset template "${label}": ${r.error}`)
    }
    return r.output
  }
  // ST-faithful macro PRE-PASS: apply every enabled literal preset block's {{macros}} (so {{setvar}} side
  // effects land in the shared var store) BEFORE any EJS runs — so an EJS getvar() in one block sees a
  // {{setvar}} authored in a LATER block (e.g. a model-selector toggle a CoT block reads) on the very first
  // prompt, matching ST (whole macro pass, then whole EJS pass). Cached so macros aren't re-applied below
  // (addvar/random run once); the EJS pass in the loop reads the fully-populated vars.
  const macroExpanded = new Map<(typeof effectivePrompts)[number], string>()
  for (const b of effectivePrompts) {
    if (b.enabled !== false && b.marker === 'none' && b.content)
      macroExpanded.set(b, macroPass(b.content, b.originalContent))
  }
  const personaContent = personaInject
    ? makeRender('', frontierTemplate)(personaDescription)
    : ''

  // Prompt-time regex: transform history/user text on its way into the prompt
  // (placement 1 = user, 2 = AI). Display-only (markdownOnly) rules are excluded upstream.
  const promptRegex = args.promptRegex ?? []
  const regexCtx = { user: userName, char: charName }
  const applyUser = promptRegex.length
    ? (t: string, depth: number): string => applyRegex(t, promptRegex, 1, regexCtx, depth)
    : identity
  const applyAssistant = promptRegex.length
    ? (t: string, depth: number): string => applyRegex(t, promptRegex, 2, regexCtx, depth)
    : identity

  // Forensic Execution Record (issue 07 + issue 14 PER-RULE LINEAGE). `journal` is a PURE observer;
  // every call below reads values already in scope and appends an entry — it never changes `messages`.
  // `jUser`/`jAssistant` run the same regex but pass an `onRuleApplied` hook so the journal attributes
  // each change to the RULE that fired (`{kind:'regex-rule', id, label:scriptName}`) rather than the
  // whole turn — M1 review finding 3. A rule that matches nothing emits no entry (no journal / no rules
  // → the raw closures, zero overhead).
  const journal = args.journal
  const jRegex =
    journal && promptRegex.length
      ? (placement: number) =>
          (t: string, depth: number): string =>
            applyRegex(t, promptRegex, placement, regexCtx, depth, undefined, (rule, before, after) =>
              journal.regex(
                // SPreset RegexBinding rules (issue 16) journal under a DISTINCT source kind so the
                // SPreset namespace stays separate from core regex in execution-record attribution.
                {
                  kind: rule.origin === 'spreset' ? 'spreset-regex' : 'regex-rule',
                  id: rule.id,
                  label: rule.scriptName
                },
                depth,
                before,
                after
              )
            )
      : null
  const jUser = jRegex ? jRegex(1) : applyUser
  const jAssistant = jRegex ? jRegex(2) : applyAssistant

  // Lorebook scan over the last few turns plus the pending action, across all
  // active lorebooks. Entries with a numeric insertion_depth are injected into the
  // history at that depth; the rest go into the top-level World Info block.
  // Phase H inc 2: use the cached/pre-matched entries when provided (stable L2 within a
  // mode); otherwise fall back to a fresh keyword scan over the recent turns + action.
  const matched =
    args.matchedEntries ??
    matchAcross(
      lorebooks,
      buildScanText(floors, userAction, args.scanDepth ?? 3),
      Math.random,
      args.maxRecursion ?? 0
    )
  // Partition matched lore into marker entries (drained into positions below) + top/depth world-info.
  const { markerEntries, topEntries, depthEntries } = partitionLore(matched, lorebooks)
  // Render each matched lorebook entry GRACEFULLY (unlike `ejsStrict` for presets, which throws). On an
  // EJS error, fall back to the macro-expanded text with EJS tags STRIPPED — so an entry that is mostly
  // prose with one bad `<%…%>` block (e.g. 命定之诗's 艾莉亚 entry: 10KB of character lore + a trailing
  // `await TavernHelper.…` seeder our sync/TavernHelper-less prompt engine can't run) still contributes
  // its prose instead of being dropped whole. This is the pre-1941f38 behavior, kept for lorebook entries
  // only: presets still fail loud (the branch-leak that 1941f38 fixed is a preset concern). The entry +
  // reason are logged either way so a genuinely broken entry is visible.
  // Error policy: "card / lorebook content degrades gracefully" tier — see docs/rpt-api.md §7 (WS-9).
  // World Info regex (ST placement 5): applied to the RAW entry content BEFORE macro/EJS expansion,
  // matching ST which regexes `entry.content` in the WI builder (world-info.js:5086) with isPrompt.
  // isPrompt-strict selection (getWorldInfoRules) already excluded both-false rules. freezePayloads
  // guards a pathological WI paste (PR #90 precedent) — output-identical for plain text.
  const worldInfoRegex = args.worldInfoRegex ?? []
  const applyWorldInfo = worldInfoRegex.length
    ? (t: string): string => applyRegex(t, worldInfoRegex, 5, regexCtx, undefined, true)
    : identity
  const renderLoreEntry = (e: LorebookEntry): string => {
    const expanded = expandMacros(
      applyWorldInfo(e.content),
      macroBase(personaMacro, frontierTemplate?.vars, frontierTemplate?.globals)
    )
    if (!frontierTemplate) return stripEjs(expanded).trim()
    const r = evalTemplateDetailed(expanded, frontierTemplate)
    const label = e.comment || '(unnamed)'
    if (r.error) {
      const fallback = stripEjs(expanded).trim()
      log(
        'error',
        `✗ lorebook entry "${label}" EJS error — ${fallback ? 'EJS stripped, prose kept' : 'dropped (no prose)'}`,
        `${r.error}\n— source: ${e.content.slice(0, 400)}`
      )
      return fallback
    }
    if (!r.output && e.content.trim())
      log(
        'info',
        `lorebook entry "${label}" rendered EMPTY — dropped from World Info ` +
          `(EJS produced no output; if it reads getvar(), the var may be missing from the build's stat_data)`
      )
    return r.output
  }
  // The top-level World Info block. With a `worldInfoOverride` (prompt.preset composer, plan §3) the
  // internal scan is skipped upstream (matchedEntries: []) so the computed value is '' — use the
  // override verbatim. Without one this is exactly the computed string (parity).
  const worldInfo = args.worldInfoOverride ?? topEntries.map(renderLoreEntry).filter(Boolean).join('\n\n')

  // The conversation history messages. Default: built from floors (regex + macro passes, action
  // appended, each classed 'history'). Override (prompt.preset composer): the caller's verbatim,
  // pre-processed messages — still classed 'history' so fitToBudget trims them — with the pending
  // action appended as the final user message, preserving L4-last. The action gets the SAME
  // treatment as the default path's live turn (prompt regex at depth 0, then macros) — only the
  // PRIOR turns arrive pre-processed.
  const historyMessages = (): ChatMessage[] => {
    let out: ChatMessage[]
    if (!args.historyOverride) {
      out = buildHistory(floors, userAction, macroBase(personaMacro), jUser, jAssistant, markHist)
    } else {
      out = args.historyOverride.map((m) => markHist({ role: m.role, content: m.content }))
      if (userAction) {
        out.push(
          markHist({ role: 'user', content: macroOnly(jUser(userAction, 0), macroBase(personaMacro)) })
        )
      }
    }
    // Capture the history tail (and the pending action, which is that tail when a userAction exists —
    // buildHistory / the override both append it last) so the char_description injection lands correctly
    // wherever history is emitted.
    if (out.length) {
      historyTailRef = out[out.length - 1]
      if (userAction) playerActionRef = out[out.length - 1]
    }
    return out
  }

  const messages: ChatMessage[] = []
  const presetDepthItems: DepthItem[] = []
  let historyEmitted = false
  let worldInfoEmitted = false
  let worldInfoRendered = false
  // Whether the preset MANAGES persona placement itself (has a persona_description marker, enabled or
  // not). A present-but-disabled marker is an explicit opt-out → the safety net must NOT re-add the
  // persona; only a preset with no marker at all falls back to the pre-conversation block.
  const hasPersonaMarker = preset.prompts.some((b) => b.marker === 'persona_description')

  for (const block of effectivePrompts) {
    if (block.enabled === false) continue

    switch (block.marker) {
      case 'char_description': {
        // IMPORT: ST's charDescription is the BARE card description (openai.js:1369) — no wrapper, and
        // personality/scenario ride their own markers. NATIVE: RPT folds Name + Description (+ Personality
        // + Scenario when no distinct markers) into one block. ST drops an empty charDescription
        // (getChat, openai.js:3738-3739); native's `Name:` prefix is always non-empty, so the `if`
        // preserves the native push while suppressing an empty imported one.
        const content = isStImport
          ? render(card.data.description || '')
          : buildCharDescription(card, charName, render, {
              includePersonality: !hasPersonalityMarker,
              includeScenario: !hasScenarioMarker
            })
        if (content) {
          messages.push({ role: block.role, content })
          journal?.marker({ kind: 'card-field', id: 'char_description' }, block.role, content)
        }
        break
      }
      case 'char_personality': {
        // ST charPersonality marker (openai.js:1370). Own role/position; the card's personality field.
        // IMPORT applies `personality_format` exactly as ST: `personality && format ?
        // substituteParams(format) : (personality || '')` (openai.js:1360) — so a blank format falls back
        // to the bare field and {{personality}} inside the format resolves to it. NATIVE (no format) keeps
        // the bare rendered field (prior behavior).
        const p = render(card.data.personality || '')
        const content = p && preset.personality_format ? render(preset.personality_format) : p
        if (content) {
          messages.push({ role: block.role, content })
          journal?.marker({ kind: 'card-field', id: 'char_personality' }, block.role, content)
        }
        break
      }
      case 'scenario': {
        // ST scenario marker (openai.js:1371). Own role/position; the card's scenario field. IMPORT
        // applies `scenario_format` the same way as charPersonality (openai.js:1359); NATIVE keeps bare.
        const s = render(card.data.scenario || '')
        const content = s && preset.scenario_format ? render(preset.scenario_format) : s
        if (content) {
          messages.push({ role: block.role, content })
          journal?.marker({ kind: 'card-field', id: 'scenario' }, block.role, content)
        }
        break
      }
      case 'mes_example': {
        const ex = render(card.data.mes_example)
        if (ex) {
          const content = `Example dialogue:\n${ex}`
          messages.push({ role: block.role, content })
          journal?.marker({ kind: 'card-field', id: 'mes_example' }, block.role, content)
        }
        break
      }
      // World Info markers. ST keeps worldInfoBefore (↑Char) + worldInfoAfter (↓Char) distinct
      // (openai.js:1367-1368) AND formats each via `formatWorldInfo`/`wi_format` (openai.js:780-792) —
      // but RPT's lorebook model carries no per-entry before/after position (LorebookEntry has no ST
      // `position`), so there's ONE computed `worldInfo` blob rendered at the first before-slot (native
      // `world_info` or ST `world_info_before`); `world_info_after` stays empty unless there's no
      // before-slot at all (then it renders the blob as a fallback so imports that only carry the
      // after-marker still get their lore). The before/after SPLIT into distinct messages is a documented
      // divergence (test/conformance/KNOWN-DIVERGENCES.md §7). `renderWorldInfo` applies the import's
      // wi_format (or the native `World Info:\n` header).
      case 'world_info':
      case 'world_info_before': {
        if (worldInfo && !worldInfoRendered) {
          const content = renderWorldInfo(worldInfo)
          messages.push({ role: block.role, content })
          journal?.marker({ kind: 'marker', id: block.marker }, block.role, content)
          worldInfoRendered = true
        }
        worldInfoEmitted = true
        break
      }
      case 'world_info_after': {
        if (worldInfo && !worldInfoRendered && !hasWiBeforeSlot) {
          const content = renderWorldInfo(worldInfo)
          messages.push({ role: block.role, content })
          journal?.marker({ kind: 'marker', id: 'world_info_after' }, block.role, content)
          worldInfoRendered = true
        }
        worldInfoEmitted = true
        break
      }
      case 'persona_description': {
        // ST personaDescription / IN_PROMPT: the RAW persona description at the preset's ordered
        // position. No `[Name's Persona]` header here — the preset author owns the framing (e.g. a
        // `<{{user}}_setting>…</{{user}}_setting>` envelope around this marker), matching ST, which
        // emits the bare description. The header is added only by the headerless safety-net below.
        if (personaContent) {
          messages.push({ role: block.role, content: personaContent })
          journal?.marker({ kind: 'persona', id: 'persona_description' }, block.role, personaContent)
        }
        break
      }
      case 'chat_history': {
        const hist = historyMessages()
        messages.push(...hist)
        historyEmitted = true
        journal?.history(
          { kind: 'history', id: 'chat_history' },
          hist.length,
          hist.map((m) => m.content).join('\n')
        )
        break
      }
      case 'post_history': {
        const ph = render(card.data.post_history_instructions)
        if (ph) {
          messages.push({ role: block.role, content: ph })
          journal?.marker({ kind: 'card-field', id: 'post_history' }, block.role, ph)
        }
        break
      }
      default: {
        const src: RecordSource = {
          kind: 'preset-block',
          id: block.identifier,
          label: block.name || block.identifier
        }
        const content = ejsStrict(
          macroExpanded.get(block) ?? macroPass(block.content, block.originalContent),
          block.name || block.identifier
        )
        // Journal the literal block's transform (raw authored text → macro+EJS result) even when it
        // renders empty (forensically useful: "this block evaluated to nothing").
        journal?.literal(src, block.content, content)
        if (!content) break
        // A literal block with a numeric depth is injected into the history (like a
        // lorebook/persona entry) rather than emitted here in preset order.
        if (block.injection_depth != null) {
          presetDepthItems.push({
            depth: block.injection_depth,
            content,
            role: block.role,
            order: block.injection_order ?? 100,
            source: src
          })
        } else {
          messages.push({ role: block.role, content })
        }
      }
    }
  }

  // Safety net: a preset without a world_info marker (e.g. an empty preset) would
  // otherwise drop matched lorebook entries. Inject them just before the first
  // conversation message so keyword/constant world info still reaches the model.
  if (worldInfo && !worldInfoEmitted) {
    const content = renderWorldInfo(worldInfo)
    const at = insertBeforeConvo(messages, { role: 'system', content })
    journal?.safetyNet({ kind: 'marker', id: 'world_info-net' }, at, 'system', content)
  }
  // Diagnostic: where did the matched lore go? (empty render vs emitted-but-trimmable.)
  log(
    'info',
    `worldInfo: ${worldInfo.length} chars · ${topEntries.length} top + ${depthEntries.length} depth · emitted=${worldInfoEmitted ? 'preset-marker' : worldInfo ? 'safety-net(head)' : 'EMPTY'}`
  )

  // Safety net: a preset with no chat_history marker would otherwise send no
  // conversation at all. Append history + action so generation still works.
  if (!historyEmitted) {
    const hist = historyMessages()
    messages.push(...hist)
    journal?.history(
      { kind: 'history', id: 'chat_history-net' },
      hist.length,
      hist.map((m) => m.content).join('\n')
    )
  }

  // Per-mode system addendum (Phase H): a stable, cache-friendly system block for
  // the active FSM mode, placed just before the conversation begins. Constant within
  // a mode, so it never invalidates the cached prefix between turns.
  const modeAddendum = args.modeAddendum?.trim()
  if (modeAddendum) {
    const at = insertBeforeConvo(messages, { role: 'system', content: modeAddendum })
    journal?.safetyNet({ kind: 'pipeline', id: 'mode-addendum' }, at, 'system', modeAddendum)
  }

  // Safety net: a preset without a persona_description marker (the common case for ST presets
  // that don't manage the persona entry) still gets the persona block, placed just before the
  // conversation begins — a stable, cache-friendly system block. A preset that HAS the marker owns
  // placement (including a disabled marker = opt-out), so the net is suppressed there.
  if (personaContent && !hasPersonaMarker) {
    const content = `[${userName}'s Persona]\n${personaContent}`
    const at = insertBeforeConvo(messages, { role: 'system', content })
    journal?.safetyNet({ kind: 'persona', id: 'persona-net' }, at, 'system', content)
  }

  // Depth-positioned injections: lorebook entries with a numeric depth.
  const byDepth = new Map<number, string[]>()
  for (const e of depthEntries) {
    const c = renderLoreEntry(e) // named+sourced diagnostic on error/empty (same as top-level World Info)
    if (!c) continue
    const d = e.insertion_depth as number
    if (!byDepth.has(d)) byDepth.set(d, [])
    byDepth.get(d)!.push(c)
  }
  // Lorebook depth entries are RPT's IN_CHAT "extension" content (ST's getExtensionPrompt IN_CHAT):
  // order 100, system role, merged into the order-100 group at each depth (openai.js:846-849). One
  // combined `World Info:` block per depth preserves prior single-depth output; when a preset depth
  // block shares that depth/role/order it now MERGES with this block instead of racing it.
  const depthItems: DepthItem[] = [...byDepth.entries()].map(([depth, contents]) => ({
    depth,
    content: `World Info:\n${contents.join('\n\n')}`,
    role: 'system' as ChatMessage['role'],
    order: 100,
    extension: true,
    source: { kind: 'lorebook-entry', id: `world_info@depth${depth}` } as RecordSource
  }))
  // Depth-tagged preset prompt blocks (keep their authored role + injection_order).
  depthItems.push(...presetDepthItems)
  if (depthItems.length) {
    const convoStart = messages.findIndex((m) => m.role !== 'system')
    applyGroupedDepthInjections(messages, depthItems, convoStart, userAction !== '', journal)
  }

  // Phase D: drain [GENERATE:*] + @INJECT marker entries into message positions.
  applyInjectionMarkers(messages, markerEntries, render, journal)

  // L1 (experimental/dormant — see WS-2): relocate live state to one tail block before the user action.
  applyCacheTail(messages, cacheLevel, args.template?.vars, userAction !== '', journal)

  // Optional prompt-tail block (unwired = none): same tail convention as the state block — a
  // system message just before the final user action, so on Anthropic it demotes + merges into
  // the volatile tail, past the cache breakpoint. Inserted AFTER the state block so the tail
  // order is [state][block][action]. Works at any cache level (block ⟂ cache.level).
  if (args.memoryBlock) {
    const insertAt = userAction !== '' ? messages.length - 1 : messages.length
    messages.splice(insertAt, 0, { role: 'system', content: args.memoryBlock })
    journal?.safetyNet({ kind: 'memory', id: 'memory-tail' }, insertAt, 'system', args.memoryBlock)
  }

  // Owner directive (KNOWN-DIVERGENCES §10): surface the character even when the assembled preset carries
  // NO char_description marker. RPT renders the SAME content the marker would produce — a BARE description
  // for an ST import (isStImport), else Name + Description folded (personality/scenario folded in only when
  // those markers are ALSO absent, exactly as the char_description marker case above) — and injects it as a
  // `system` message (the default marker role) IMMEDIATELY BEFORE the pending player action. Chat history
  // stays before it; anything that legitimately follows the user (post_history / jailbreak) stays after it.
  // ST instead REPAIRS the import, re-adding the marker at ITS default position (PromptManager.js:995-1067),
  // so this is a deliberate POSITION divergence, not a presence one. getDefaultPreset carries the marker, so
  // native/default flows never enter this branch (verified by the promptBuilder characterization tests).
  // Check the RAW prompt list (like `hasPersonaMarker` above), NOT `effectivePrompts`: a marker the author
  // explicitly DISABLED is an opt-out — present → no injection. `resolveEffectivePrompts` drops disabled /
  // trigger-filtered blocks, so reading it would treat a disabled marker as ABSENT and duplicate the field.
  const hasCharDescriptionMarker = preset.prompts.some((b) => b.marker === 'char_description')
  if (!hasCharDescriptionMarker) {
    const content = isStImport
      ? render(card.data.description || '')
      : buildCharDescription(card, charName, render, {
          includePersonality: !hasPersonalityMarker,
          includeScenario: !hasScenarioMarker
        })
    if (content) {
      // Position: immediately before the player action. On a `continue` (no pending user) inject just
      // AFTER the history tail — the slot the action would occupy, ahead of any post-history block —
      // falling back to the very end only when there is no history at all. `indexOf` is resolved HERE,
      // after every tail splice, so the anchor's live index is used.
      let at: number
      if (playerActionRef) {
        at = messages.indexOf(playerActionRef)
      } else if (historyTailRef) {
        const t = messages.indexOf(historyTailRef)
        at = t < 0 ? messages.length : t + 1
      } else {
        at = messages.length
      }
      if (at < 0) at = messages.length
      messages.splice(at, 0, { role: 'system', content })
      journal?.safetyNet({ kind: 'card-field', id: 'char_description-injected' }, at, 'system', content)
    }
  }

  // Project the collected history-turn identity into the explicit budget policy (issue 18d): every
  // message that was emitted as a chat-history turn is `history` (droppable oldest-first); everything
  // else is `pinned` (never dropped). This 1:1-with-`messages` array is what fitToBudget reads instead
  // of the retired HISTORY_TAG, and what the assembled artifact carries as `budgetClass`.
  const budgetClasses: BudgetClass[] = messages.map((m) => (historyRefs.has(m) ? 'history' : 'pinned'))
  return { messages, budgetClasses }
}

/** The `.messages`-only view of `buildPromptDetailed` (issue 18d). The overwhelming majority of
 *  callers only need the assembled array; the budget policy is consulted solely by the trim inside
 *  `assemblePrompt`. Kept as a thin wrapper so every existing caller/test is unchanged. */
export const buildPrompt = (args: BuildPromptArgs): ChatMessage[] => buildPromptDetailed(args).messages

/**
 * Phase D — drain `[GENERATE:*]` + `@INJECT` marker entries into message positions. The array is final
 * here, so `markerIndex`'s 0-based positions + regex/target lookups are stable. RENDER markers →
 * `markerIndex` null (handled at render time). Spliced high→low so earlier inserts don't shift later
 * targets; ties broken by order. Mutates `messages`. (Extracted from buildPrompt — WS-5.)
 */
const applyInjectionMarkers = (
  messages: ChatMessage[],
  markerEntries: ParsedEntry[],
  render: Renderer,
  journal?: AssemblyJournal
): void => {
  if (!markerEntries.length) return
  const injections = markerEntries
    .map(({ e, p }) => {
      const marker = p.marker as Marker
      const at = markerIndex(marker, messages)
      if (at == null) return null
      const body = p.private ? `<% { %>${p.template}<% } %>` : p.template
      const content = render(body)
      if (!content) return null
      const isInject = marker.kind === 'inject'
      const role: ChatMessage['role'] = isInject
        ? ((marker as InjectMarker).role ?? 'system')
        : 'system'
      const order = (isInject ? (marker as InjectMarker).order : undefined) ?? e.insertion_order
      const id = e.comment || (isInject ? '@INJECT' : `[GENERATE:${marker.kind}]`)
      return { at: Math.max(0, Math.min(at, messages.length)), role, content, order, id }
    })
    .filter(
      (
        x
      ): x is {
        at: number
        role: ChatMessage['role']
        content: string
        order: number
        id: string
      } => x != null
    )
    .sort((a, b) => b.at - a.at || b.order - a.order)
  for (const inj of injections) {
    messages.splice(inj.at, 0, { role: inj.role, content: inj.content })
    journal?.markerInject({ kind: 'lorebook-entry', id: inj.id }, inj.at, inj.role, inj.content)
  }
}

/**
 * L1 "Frozen Core" tail (experimental/dormant — see WS-2; reached only at cacheLevel ≥ 1). Relocates the
 * live state to one tail block just before the user action, so it sits in the volatile tail, never in the
 * cached frontier. No-op at cacheLevel 0 or when there's no state. Mutates `messages`. (Extracted — WS-5.)
 */
const applyCacheTail = (
  messages: ChatMessage[],
  cacheLevel: number,
  vars: Record<string, any> | undefined,
  hasTrailingUser: boolean,
  journal?: AssemblyJournal
): void => {
  if (cacheLevel < 1) return
  const stateBlock = buildStateBlock(vars)
  if (!stateBlock) return
  const insertAt = hasTrailingUser ? messages.length - 1 : messages.length
  messages.splice(insertAt, 0, { role: 'system', content: stateBlock })
  journal?.safetyNet({ kind: 'pipeline', id: 'cache-tail' }, insertAt, 'system', stateBlock)
}

/**
 * Active `[RENDER:*]` marker entries' RAW templates, split by side. These are render-time injections —
 * the renderer evaluates each per-message (with that floor's vars) and wraps the displayed text. Only
 * always-on entries (`constant` or `@@activate`/`@@always_enabled`) are included; keyword-matched render
 * markers aren't supported (render is display-time, decoupled from a turn's keyword scan).
 */
export const collectRenderMarkers = (
  lorebooks: Lorebook[]
): { before: string[]; after: string[] } => {
  const before: string[] = []
  const after: string[] = []
  for (const lb of lorebooks) {
    for (const e of lb.entries) {
      if (e.enabled === false) continue
      const { marker, template, activation } = parseEntryMarker(e.comment, e.content)
      if (marker?.kind !== 'render' || activation === 'never') continue
      if (!e.constant && activation !== 'force') continue
      ;(marker.side === 'after' ? after : before).push(template)
    }
  }
  return { before, after }
}
