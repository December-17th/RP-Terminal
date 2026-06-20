import { RPTerminalCard } from '../types/character'
import { Preset } from '../types/preset'
import { FloorFile } from '../types/chat'
import { Lorebook } from '../types/character'
import { matchAcross } from './lorebookService'
import { evalTemplate, TemplateContext } from './templateService'

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
  /** ST-Prompt-Template context; when present, authored content is run through the engine. */
  template?: TemplateContext
}

type Renderer = (text: string) => string

/**
 * Expand the handful of macros we support and strip ST-Prompt-Template control
 * blocks (`<% ... %>`). A real EJS-style template engine is a planned follow-up;
 * until then we strip the syntax so it never leaks into the prompt.
 */
const expandMacros = (
  text: string,
  charName: string,
  userName: string,
  personaDesc = ''
): string => {
  if (!text) return ''
  return text
    .replace(/\{\{char\}\}/gi, charName)
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/\{\{persona\}\}/gi, personaDesc)
    .replace(/<%[\s\S]*?%>/g, '')
    .trim()
}

const buildCharDescription = (card: RPTerminalCard, charName: string, render: Renderer): string => {
  const d = card.data
  const parts: string[] = [`Name: ${charName}`]
  if (d.description) parts.push(`Description: ${render(d.description)}`)
  if (d.personality) parts.push(`Personality: ${render(d.personality)}`)
  if (d.scenario) parts.push(`Scenario: ${render(d.scenario)}`)
  return parts.join('\n')
}

/** Expand the running history into alternating messages, ending with the new action. */
const buildHistory = (
  floors: FloorFile[],
  userAction: string,
  charName: string,
  userName: string,
  personaDesc: string
): ChatMessage[] => {
  const msgs: ChatMessage[] = []
  for (const f of floors) {
    if (f.user_message.content) {
      msgs.push({
        role: 'user',
        content: expandMacros(f.user_message.content, charName, userName, personaDesc)
      })
    }
    if (f.response.content) {
      msgs.push({
        role: 'assistant',
        content: expandMacros(f.response.content, charName, userName, personaDesc)
      })
    }
  }
  if (userAction) {
    msgs.push({ role: 'user', content: expandMacros(userAction, charName, userName, personaDesc) })
  }
  return msgs
}

/**
 * Splice depth-positioned system blocks into an assembled message array. `depth`
 * counts messages up from the bottom; the trailing user action always stays last
 * (so nothing volatile lands after it). Insertions are clamped into the
 * conversation region (never into the cached system prefix), and applied bottom-up
 * so earlier inserts don't shift the targets of later ones.
 */
const applyDepthInjections = (
  messages: ChatMessage[],
  items: Array<{ depth: number; content: string }>,
  convoStart: number,
  hasTrailingUser: boolean
): void => {
  const base = messages.length
  const maxIdx = hasTrailingUser ? base - 1 : base
  const start = convoStart === -1 ? base : convoStart
  const planned = items
    .map((it) => ({
      idx: Math.max(start, Math.min(base - it.depth, maxIdx)),
      content: it.content
    }))
    .sort((a, b) => b.idx - a.idx)
  for (const p of planned) messages.splice(p.idx, 0, { role: 'system', content: p.content })
}

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

  const makeRender =
    (pd: string): Renderer =>
    (t) =>
      args.template
        ? evalTemplate(expandMacros(t, charName, userName, pd), args.template as TemplateContext)
        : expandMacros(t, charName, userName, pd)
  const render = makeRender(personaMacro)
  const personaContent = personaInject ? makeRender('')(args.persona!.description) : ''

  // Lorebook scan over the last few turns plus the pending action, across all
  // active lorebooks. Entries with a numeric insertion_depth are injected into the
  // history at that depth; the rest go into the top-level World Info block.
  const scanText = [
    ...floors.slice(-3).flatMap((f) => [f.user_message.content, f.response.content]),
    userAction
  ]
    .filter(Boolean)
    .join('\n')
  const matched = matchAcross(lorebooks, scanText)
  const topEntries = matched.filter((e) => e.insertion_depth == null)
  const depthEntries = matched.filter((e) => e.insertion_depth != null)
  const worldInfo = topEntries
    .map((e) => render(e.content))
    .filter(Boolean)
    .join('\n\n')

  const messages: ChatMessage[] = []
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
        messages.push(...buildHistory(floors, userAction, charName, userName, personaMacro))
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
        if (content) messages.push({ role: block.role, content })
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

  // Safety net: a preset with no chat_history marker would otherwise send no
  // conversation at all. Append history + action so generation still works.
  if (!historyEmitted) {
    messages.push(...buildHistory(floors, userAction, charName, userName, personaMacro))
  }

  // Persona description at the top: a stable, cache-friendly system block placed
  // just before the conversation begins.
  if (personaContent && (args.persona?.depth == null)) {
    const convoStart = messages.findIndex((m) => m.role !== 'system')
    const pm: ChatMessage = { role: 'system', content: `[${userName}'s Persona]\n${personaContent}` }
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
  const depthItems = [...byDepth.entries()].map(([depth, contents]) => ({
    depth,
    content: `World Info:\n${contents.join('\n\n')}`
  }))
  if (personaContent && args.persona?.depth != null) {
    depthItems.push({
      depth: args.persona.depth,
      content: `[${userName}'s Persona]\n${personaContent}`
    })
  }
  if (depthItems.length) {
    const convoStart = messages.findIndex((m) => m.role !== 'system')
    applyDepthInjections(messages, depthItems, convoStart, userAction !== '')
  }

  return messages
}
