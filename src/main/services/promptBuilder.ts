import { RPTerminalCard } from '../types/character'
import { Preset } from '../types/preset'
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

/** Non-enumerable marker tagging a message as a chat-history TURN (vs static system/lore/preset
 * content). Lets fitToBudget trim the oldest turns without ever evicting the static prefix. A
 * Symbol + `enumerable:false` means it never serializes into the provider request or the stored
 * floor (JSON.stringify and object-spread both skip it) and is invisible to deep-equality. */
const HISTORY_TAG = Symbol('rptHistoryTurn')
const markHistory = (m: ChatMessage): ChatMessage => {
  Object.defineProperty(m, HISTORY_TAG, { value: true, enumerable: false, configurable: true })
  return m
}
const isHistoryTurn = (m: ChatMessage): boolean =>
  (m as unknown as Record<symbol, unknown>)[HISTORY_TAG] === true

/**
 * Trim the prompt to fit a token budget. Keeps the leading system/lore prefix
 * (L1/L2) and the most recent conversation turns, dropping the OLDEST history
 * first; the final user turn is always retained. Returns how many messages were
 * dropped so the caller can log it.
 */
export const fitToBudget = (
  messages: ChatMessage[],
  maxTokens: number
): { messages: ChatMessage[]; dropped: number } => {
  const total = messages.reduce((s, m) => s + msgTokens(m), 0)
  if (total <= maxTokens) return { messages, dropped: 0 }

  // Prefer trimming actual chat-history TURNS (tagged by buildHistory): drop the OLDEST turns
  // first while keeping ALL static content (system prompts, world info, character card, preset
  // blocks) and the most recent turns. This is what stops a large constant worldbook from being
  // evicted just because a preset places a user/assistant block ahead of it in the array.
  const history = messages.filter(isHistoryTurn)
  if (history.length > 0) {
    const removable = history.slice(0, -1) // never drop the latest turn
    const remove = new Set<ChatMessage>()
    let running = total
    for (const m of removable) {
      if (running <= maxTokens) break
      remove.add(m)
      running -= msgTokens(m)
    }
    // Even if the static prefix alone still exceeds the budget, keep it intact — truncating the
    // system/lore mid-way is worse than a slightly over-budget prompt (the model's real context
    // window is the hard limit). Only history turns are ever dropped on this path.
    return {
      messages: remove.size ? messages.filter((m) => !remove.has(m)) : messages,
      dropped: remove.size
    }
  }

  // Legacy fallback (no tagged history — e.g. a hand-built array): keep the leading system
  // prefix and the most recent messages, dropping oldest from the first non-system message.
  const convoStart = messages.findIndex((m) => m.role !== 'system')
  if (convoStart === -1) return { messages, dropped: 0 }

  const head = messages.slice(0, convoStart)
  let convo = messages.slice(convoStart)
  const headCost = head.reduce((s, m) => s + msgTokens(m), 0)
  let convoCost = convo.reduce((s, m) => s + msgTokens(m), 0)
  let dropped = 0

  // Drop oldest conversation messages until we fit (always keep the last turn).
  while (headCost + convoCost > maxTokens && convo.length > 1) {
    convoCost -= msgTokens(convo[0])
    convo = convo.slice(1)
    dropped++
  }
  return { messages: [...head, ...convo], dropped }
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
  /** How many recent turns to scan for lorebook keywords (default 3). */
  scanDepth?: number
  /** Max recursive lorebook match passes (default 0 = off). */
  maxRecursion?: number
  /** Pre-matched world-info entries (Phase H inc 2 cache). When given, the internal
   * keyword scan is skipped and these are used verbatim — stable L2 within a mode. */
  matchedEntries?: LorebookEntry[]
  /** Regex rules applied to outgoing prompt text (placement 1 = user, 2 = AI). */
  promptRegex?: RenderRegexRule[]
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
   *  arrive pre-processed (no regex/macro passes), each tagged with the history marker so
   *  fitToBudget still trims them; the pending action is appended after them as the final user
   *  message. Absent = today's built-from-floors path (parity). */
  historyOverride?: ChatMessage[]
  /** prompt.preset composer: replace ONLY the top-level World Info block (the world_info marker +
   *  its safety net) with this string; the internal keyword scan is skipped (assemblePrompt passes
   *  `matchedEntries: []`). Depth-positioned + marker entries live only on the scan path. Absent =
   *  the computed worldInfo string (parity). */
  worldInfoOverride?: string
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

const buildCharDescription = (card: RPTerminalCard, charName: string, render: Renderer): string => {
  const d = card.data
  const parts: string[] = [`Name: ${charName}`]
  if (d.description) parts.push(`Description: ${render(d.description)}`)
  if (d.personality) parts.push(`Personality: ${render(d.personality)}`)
  if (d.scenario) parts.push(`Scenario: ${render(d.scenario)}`)
  return parts.join('\n')
}

/** Expand the running history into alternating messages, ending with the new action.
 * `applyUser`/`applyAssistant` run prompt-time regex on the raw text before macros. */
const buildHistory = (
  floors: FloorFile[],
  userAction: string,
  macroCtx: MacroContext,
  applyUser: (t: string, depth: number) => string,
  applyAssistant: (t: string, depth: number) => string
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
    return markHistory({ role: r.role, content: macroOnly(transformed, macroCtx) })
  })
}

/**
 * Splice depth-positioned system blocks into an assembled message array. `depth`
 * counts messages up from the bottom; the trailing user action always stays last
 * (so nothing volatile lands after it). Insertions are clamped into the
 * conversation region (never into the cached system prefix), and applied bottom-up
 * so earlier inserts don't shift the targets of later ones.
 */
interface DepthItem {
  depth: number
  content: string
  role?: ChatMessage['role']
}

const applyDepthInjections = (
  messages: ChatMessage[],
  items: DepthItem[],
  convoStart: number,
  hasTrailingUser: boolean
): void => {
  const base = messages.length
  const maxIdx = hasTrailingUser ? base - 1 : base
  const start = convoStart === -1 ? base : convoStart
  const planned = items
    .map((it) => ({
      idx: Math.max(start, Math.min(base - it.depth, maxIdx)),
      content: it.content,
      role: it.role ?? 'system'
    }))
    .sort((a, b) => b.idx - a.idx)
  for (const p of planned) messages.splice(p.idx, 0, { role: p.role, content: p.content })
}

/** Insert a system block just before the first conversation (non-system) message — or append it when
 *  the array is all-system. Centralizes the convoStart find+splice repeated for the world-info safety
 *  net, the mode addendum, and the persona block (WS-5). */
const insertBeforeConvo = (messages: ChatMessage[], msg: ChatMessage): void => {
  const convoStart = messages.findIndex((m) => m.role !== 'system')
  if (convoStart === -1) messages.push(msg)
  else messages.splice(convoStart, 0, msg)
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
export const buildPrompt = (args: BuildPromptArgs): ChatMessage[] => {
  const { card, preset, lorebooks, floors, userAction } = args
  const charName = card.data.name || 'Character'
  const userName = args.userName || 'User'

  const personaInject = !!args.persona?.inject && !!args.persona?.description?.trim()
  // {{persona}} expands to the description in authored content (but not inside the
  // persona block itself — that's rendered with an empty persona to avoid recursion).
  const personaMacro = personaInject ? args.persona!.description : ''

  // Central transform order for authored content: macros → EJS template → (regex runs
  // separately on history/user text). The macro pass shares the template's var/global
  // stores so {{setvar}} and <% setvar() %> stay coherent; it leaves <%...%> intact so
  // the engine runs next. (Previously macros stripped EJS before eval — templates never
  // executed via the builder; that's fixed here.)
  const macroBase = (
    pd: string,
    vars?: Record<string, any>,
    globals?: Record<string, any>
  ): MacroContext => ({
    user: userName,
    char: charName,
    persona: pd,
    vars: vars ?? args.template?.vars,
    globals: globals ?? args.template?.globals
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
  // Expand {{macros}} for one entry — applying {{setvar}}/{{addvar}}/… side effects to the shared var store.
  const macroPass = (content: string): string =>
    expandMacros(
      content,
      macroBase(personaMacro, frontierTemplate?.vars, frontierTemplate?.globals)
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
  const macroExpanded = new Map<(typeof preset.prompts)[number], string>()
  for (const b of preset.prompts) {
    if (b.enabled !== false && b.marker === 'none' && b.content)
      macroExpanded.set(b, macroPass(b.content))
  }
  const personaContent = personaInject
    ? makeRender('', frontierTemplate)(args.persona!.description)
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
  const renderLoreEntry = (e: LorebookEntry): string => {
    const expanded = expandMacros(
      e.content,
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
  // appended, each markHistory-tagged). Override (prompt.preset composer): the caller's verbatim,
  // pre-processed messages — still markHistory-tagged so fitToBudget trims them — with the pending
  // action appended as the final user message, preserving L4-last. The action gets the SAME
  // treatment as the default path's live turn (prompt regex at depth 0, then macros) — only the
  // PRIOR turns arrive pre-processed.
  const historyMessages = (): ChatMessage[] => {
    if (!args.historyOverride) {
      return buildHistory(floors, userAction, macroBase(personaMacro), applyUser, applyAssistant)
    }
    const out = args.historyOverride.map((m) => markHistory({ role: m.role, content: m.content }))
    if (userAction) {
      out.push(
        markHistory({ role: 'user', content: macroOnly(applyUser(userAction, 0), macroBase(personaMacro)) })
      )
    }
    return out
  }

  const messages: ChatMessage[] = []
  const presetDepthItems: DepthItem[] = []
  let historyEmitted = false
  let worldInfoEmitted = false
  let personaEmitted = false

  for (const block of preset.prompts) {
    if (block.enabled === false) continue

    switch (block.marker) {
      case 'char_description': {
        messages.push({ role: block.role, content: buildCharDescription(card, charName, render) })
        break
      }
      case 'mes_example': {
        const ex = render(card.data.mes_example)
        if (ex) messages.push({ role: block.role, content: `Example dialogue:\n${ex}` })
        break
      }
      case 'world_info': {
        if (worldInfo) messages.push({ role: block.role, content: `World Info:\n${worldInfo}` })
        worldInfoEmitted = true
        break
      }
      case 'persona_description': {
        // ST personaDescription / IN_PROMPT: the user persona description placed at the preset's
        // ordered position. Emitted only when inject is on and there's content to show.
        if (personaContent) {
          messages.push({ role: block.role, content: `[${userName}'s Persona]\n${personaContent}` })
        }
        personaEmitted = true
        break
      }
      case 'chat_history': {
        messages.push(...historyMessages())
        historyEmitted = true
        break
      }
      case 'post_history': {
        const ph = render(card.data.post_history_instructions)
        if (ph) messages.push({ role: block.role, content: ph })
        break
      }
      default: {
        const content = ejsStrict(
          macroExpanded.get(block) ?? macroPass(block.content),
          block.name || block.identifier
        )
        if (!content) break
        // A literal block with a numeric depth is injected into the history (like a
        // lorebook/persona entry) rather than emitted here in preset order.
        if (block.injection_depth != null) {
          presetDepthItems.push({ depth: block.injection_depth, content, role: block.role })
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
    insertBeforeConvo(messages, { role: 'system', content: `World Info:\n${worldInfo}` })
  }
  // Diagnostic: where did the matched lore go? (empty render vs emitted-but-trimmable.)
  log(
    'info',
    `worldInfo: ${worldInfo.length} chars · ${topEntries.length} top + ${depthEntries.length} depth · emitted=${worldInfoEmitted ? 'preset-marker' : worldInfo ? 'safety-net(head)' : 'EMPTY'}`
  )

  // Safety net: a preset with no chat_history marker would otherwise send no
  // conversation at all. Append history + action so generation still works.
  if (!historyEmitted) {
    messages.push(...historyMessages())
  }

  // Per-mode system addendum (Phase H): a stable, cache-friendly system block for
  // the active FSM mode, placed just before the conversation begins. Constant within
  // a mode, so it never invalidates the cached prefix between turns.
  const modeAddendum = args.modeAddendum?.trim()
  if (modeAddendum) {
    insertBeforeConvo(messages, { role: 'system', content: modeAddendum })
  }

  // Safety net: a preset without a persona_description marker (the common case for ST presets
  // that don't manage the persona entry) still gets the persona block, placed just before the
  // conversation begins — a stable, cache-friendly system block.
  if (personaContent && !personaEmitted) {
    insertBeforeConvo(messages, {
      role: 'system',
      content: `[${userName}'s Persona]\n${personaContent}`
    })
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
  const depthItems: DepthItem[] = [...byDepth.entries()].map(([depth, contents]) => ({
    depth,
    content: `World Info:\n${contents.join('\n\n')}`
  }))
  // Depth-tagged preset prompt blocks (keep their authored role).
  depthItems.push(...presetDepthItems)
  if (depthItems.length) {
    const convoStart = messages.findIndex((m) => m.role !== 'system')
    applyDepthInjections(messages, depthItems, convoStart, userAction !== '')
  }

  // Phase D: drain [GENERATE:*] + @INJECT marker entries into message positions.
  applyInjectionMarkers(messages, markerEntries, render)

  // L1 (experimental/dormant — see WS-2): relocate live state to one tail block before the user action.
  applyCacheTail(messages, cacheLevel, args.template?.vars, userAction !== '')

  // Optional prompt-tail block (unwired = none): same tail convention as the state block — a
  // system message just before the final user action, so on Anthropic it demotes + merges into
  // the volatile tail, past the cache breakpoint. Inserted AFTER the state block so the tail
  // order is [state][block][action]. Works at any cache level (block ⟂ cache.level).
  if (args.memoryBlock) {
    const insertAt = userAction !== '' ? messages.length - 1 : messages.length
    messages.splice(insertAt, 0, { role: 'system', content: args.memoryBlock })
  }

  return messages
}

/**
 * Phase D — drain `[GENERATE:*]` + `@INJECT` marker entries into message positions. The array is final
 * here, so `markerIndex`'s 0-based positions + regex/target lookups are stable. RENDER markers →
 * `markerIndex` null (handled at render time). Spliced high→low so earlier inserts don't shift later
 * targets; ties broken by order. Mutates `messages`. (Extracted from buildPrompt — WS-5.)
 */
const applyInjectionMarkers = (
  messages: ChatMessage[],
  markerEntries: ParsedEntry[],
  render: Renderer
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
      return { at: Math.max(0, Math.min(at, messages.length)), role, content, order }
    })
    .filter(
      (x): x is { at: number; role: ChatMessage['role']; content: string; order: number } =>
        x != null
    )
    .sort((a, b) => b.at - a.at || b.order - a.order)
  for (const inj of injections) messages.splice(inj.at, 0, { role: inj.role, content: inj.content })
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
  hasTrailingUser: boolean
): void => {
  if (cacheLevel < 1) return
  const stateBlock = buildStateBlock(vars)
  if (!stateBlock) return
  const insertAt = hasTrailingUser ? messages.length - 1 : messages.length
  messages.splice(insertAt, 0, { role: 'system', content: stateBlock })
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
