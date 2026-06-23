import { RPTerminalCard } from '../types/character'
import { Preset } from '../types/preset'
import { FloorFile } from '../types/chat'
import { Lorebook, LorebookEntry } from '../types/character'
import { matchAcross } from './lorebookService'
import { parseEntryMarker, markerIndex, Marker, InjectMarker } from '../parsers/injectMarkers'
import { applyRegex, RenderRegexRule } from './regexService'
import { evalTemplate, TemplateContext } from './templateService'
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

export interface PersonaArgs {
  description: string
  inject: boolean
  /** null = inject at the top (before history); a number = depth from the bottom. */
  depth: number | null
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
  applyUser: (t: string) => string,
  applyAssistant: (t: string) => string
): ChatMessage[] => {
  const msgs: ChatMessage[] = []
  const user = (t: string): string => macroOnly(applyUser(t), macroCtx)
  const assistant = (t: string): string => macroOnly(applyAssistant(t), macroCtx)
  for (const f of floors) {
    if (f.user_message.content) msgs.push({ role: 'user', content: user(f.user_message.content) })
    // The stored response is the FULL raw output; strip reasoning + state tags for the prompt
    // (the model never re-reads its own <thinking> / <UpdateVariable>).
    const resp = cleanForHistory(f.response.content)
    if (resp) msgs.push({ role: 'assistant', content: assistant(resp) })
  }
  if (userAction) msgs.push({ role: 'user', content: user(userAction) })
  return msgs
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
  const personaContent = personaInject
    ? makeRender('', frontierTemplate)(args.persona!.description)
    : ''

  // Prompt-time regex: transform history/user text on its way into the prompt
  // (placement 1 = user, 2 = AI). Display-only (markdownOnly) rules are excluded upstream.
  const promptRegex = args.promptRegex ?? []
  const regexCtx = { user: userName, char: charName }
  const applyUser = promptRegex.length
    ? (t: string): string => applyRegex(t, promptRegex, 1, regexCtx)
    : identity
  const applyAssistant = promptRegex.length
    ? (t: string): string => applyRegex(t, promptRegex, 2, regexCtx)
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
  // Phase D: a matched entry whose comment/decorator is an injection marker is drained into a prompt
  // POSITION below, not emitted as plain world-info. Partition markers out; @@dont_activate drops the
  // entry entirely. Non-marker cards are unaffected (parseEntryMarker → marker null → all "regular").
  const parsedMatched = matched.map((e) => ({ e, p: parseEntryMarker(e.comment, e.content) }))
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
  // All marker entries to drain into positions (matched markers + forced), minus @@dont_activate.
  const markerEntries = [
    ...parsedMatched.filter(({ p }) => p.marker && p.activation !== 'never'),
    ...forced
  ]
  const topEntries = regular.filter((e) => e.insertion_depth == null)
  const depthEntries = regular.filter((e) => e.insertion_depth != null)
  const worldInfo = topEntries
    .map((e) => render(e.content))
    .filter(Boolean)
    .join('\n\n')

  const messages: ChatMessage[] = []
  const presetDepthItems: DepthItem[] = []
  let historyEmitted = false
  let worldInfoEmitted = false

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
      case 'chat_history': {
        messages.push(
          ...buildHistory(floors, userAction, macroBase(personaMacro), applyUser, applyAssistant)
        )
        historyEmitted = true
        break
      }
      case 'post_history': {
        const ph = render(card.data.post_history_instructions)
        if (ph) messages.push({ role: block.role, content: ph })
        break
      }
      default: {
        const content = render(block.content)
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
    const convoStart = messages.findIndex((m) => m.role !== 'system')
    const wiMessage: ChatMessage = { role: 'system', content: `World Info:\n${worldInfo}` }
    if (convoStart === -1) messages.push(wiMessage)
    else messages.splice(convoStart, 0, wiMessage)
  }
  // Diagnostic: where did the matched lore go? (empty render vs emitted-but-trimmable.)
  log(
    'info',
    `worldInfo: ${worldInfo.length} chars · ${topEntries.length} top + ${depthEntries.length} depth · emitted=${worldInfoEmitted ? 'preset-marker' : worldInfo ? 'safety-net(head)' : 'EMPTY'}`
  )

  // Safety net: a preset with no chat_history marker would otherwise send no
  // conversation at all. Append history + action so generation still works.
  if (!historyEmitted) {
    messages.push(
      ...buildHistory(floors, userAction, macroBase(personaMacro), applyUser, applyAssistant)
    )
  }

  // Per-mode system addendum (Phase H): a stable, cache-friendly system block for
  // the active FSM mode, placed just before the conversation begins. Constant within
  // a mode, so it never invalidates the cached prefix between turns.
  const modeAddendum = args.modeAddendum?.trim()
  if (modeAddendum) {
    const convoStart = messages.findIndex((m) => m.role !== 'system')
    const mm: ChatMessage = { role: 'system', content: modeAddendum }
    if (convoStart === -1) messages.push(mm)
    else messages.splice(convoStart, 0, mm)
  }

  // Persona description at the top: a stable, cache-friendly system block placed
  // just before the conversation begins.
  if (personaContent && args.persona?.depth == null) {
    const convoStart = messages.findIndex((m) => m.role !== 'system')
    const pm: ChatMessage = {
      role: 'system',
      content: `[${userName}'s Persona]\n${personaContent}`
    }
    if (convoStart === -1) messages.push(pm)
    else messages.splice(convoStart, 0, pm)
  }

  // Depth-positioned injections: lorebook entries with a numeric depth, plus the
  // persona block if it was given a depth instead of top placement.
  const byDepth = new Map<number, string[]>()
  for (const e of depthEntries) {
    const c = render(e.content)
    if (!c) continue
    const d = e.insertion_depth as number
    if (!byDepth.has(d)) byDepth.set(d, [])
    byDepth.get(d)!.push(c)
  }
  const depthItems: DepthItem[] = [...byDepth.entries()].map(([depth, contents]) => ({
    depth,
    content: `World Info:\n${contents.join('\n\n')}`
  }))
  if (personaContent && args.persona?.depth != null) {
    depthItems.push({
      depth: args.persona.depth,
      content: `[${userName}'s Persona]\n${personaContent}`
    })
  }
  // Depth-tagged preset prompt blocks (keep their authored role).
  depthItems.push(...presetDepthItems)
  if (depthItems.length) {
    const convoStart = messages.findIndex((m) => m.role !== 'system')
    applyDepthInjections(messages, depthItems, convoStart, userAction !== '')
  }

  // Phase D: drain [GENERATE:*] + @INJECT marker entries into message positions (the array is final, so
  // markerIndex's 0-based positions + regex/target lookups are stable). RENDER markers → markerIndex null
  // (handled at render time). Splice high→low so earlier inserts don't shift later targets; ties by order.
  if (markerEntries.length) {
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
    for (const inj of injections)
      messages.splice(inj.at, 0, { role: inj.role, content: inj.content })
  }

  // L1: relocate live state to one tail block, just before the user action (so it sits
  // in the volatile tail, never in the cached frontier). 'partition' showed placeholders
  // in the frontier; 'diff' showed floor-0 values — either way this block is the live truth.
  if (cacheLevel >= 1) {
    const stateBlock = buildStateBlock(args.template?.vars)
    if (stateBlock) {
      const insertAt = userAction !== '' ? messages.length - 1 : messages.length
      messages.splice(insertAt, 0, { role: 'system', content: stateBlock })
    }
  }

  return messages
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
