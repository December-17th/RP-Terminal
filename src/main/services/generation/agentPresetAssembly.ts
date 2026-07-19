import type {
  AgentLorebookEntryFilter,
  AgentLorebookSelection,
  HistoryPolicy,
  PromptMessage
} from '../../../shared/agentRuntime'
import type { AgentPresetAssemblyRequest } from '../agentRuntime/prompt'
import type { Lorebook, LorebookEntry } from '../../types/character'
import type { FloorFile } from '../../types/chat'
import type { ChatMessage } from '../promptTypes'
import { getLorebookById, listLorebooks, matchAcross } from '../lorebookService'
import { log } from '../logService'
import { presetFromEnvelope } from '../presetService'
import { buildScanText } from '../promptBuilder'
import { estimateTokens } from '../promptBudget'
import { assemblePrompt } from './assemble'
import { buildGenContext } from './genContext'
import type { GenContext } from './types'

/**
 * The REAL preset-driven Agent prompt assembler (ADR 0021, slices 3 + 4).
 *
 * Registered into `agentRuntime` by `agentPresetAssemblyBridge.ts` — see that file and
 * `agentRuntime/prompt/agentPresetAssembler.ts` for why the dependency runs in this direction.
 *
 * It deliberately reuses Classic's own path rather than inventing a parallel one: `buildGenContext`
 * for the owning floor's real context, `matchAcross` for world info, `assemblePrompt` for the
 * ordered messages. Only four things are substituted, and each is an ADR requirement:
 *   1. the preset — the Agent's bundled envelope, not the profile's active preset;
 *   2. the lorebooks — `bundle.lorebooks`, so an Agent can read a different slice of the world;
 *   3. history — EMPTY unless the Agent declared a History Policy;
 *   4. the pending user action — there is none; an Agent's task instruction is its own `prompt`.
 *
 * SIDE-EFFECT FREE with respect to the chat. It never writes the world-info cache (which is why it
 * calls `matchAcross` directly instead of `matchWorldInfo`), never persists `setvar` mutations (the
 * working variables are cloned), and never touches the floor.
 */

/**
 * Narrow a lorebook's entries by entry `comment` — the entry's ST title — with `exclude` applied
 * after `include`.
 *
 * COMMENTS ARE NOT UNIQUE. Two entries in the same book may share a title, and a filter naming that
 * title matches EVERY one of them. That is the intended semantic, not an oversight: the contract
 * selects by the name a human author sees, and an author who writes "exclude Spoilers" means all of
 * them. Do not try to disambiguate duplicates here.
 */
const filterEntries = (
  entries: LorebookEntry[],
  filter: AgentLorebookEntryFilter | undefined
): LorebookEntry[] => {
  if (!filter) return entries
  const include = filter.include ? new Set(filter.include) : undefined
  const exclude = new Set(filter.exclude ?? [])
  return entries.filter((entry) => {
    const title = entry.comment || ''
    if (include && !include.has(title)) return false
    return !exclude.has(title)
  })
}

/**
 * The lorebooks feeding assembly. `session` (or no selection at all) is the session's normal set;
 * `explicit` resolves BY NAME, never by user-local id — a portable Agent cannot reference one.
 * A named book that does not exist in this profile is logged and skipped rather than fatal.
 */
const selectLorebooks = (
  profileId: string,
  sessionBooks: Lorebook[],
  selection: AgentLorebookSelection | undefined
): Lorebook[] => {
  const books =
    !selection || selection.mode === 'session'
      ? sessionBooks
      : selection.lorebooks.flatMap((wanted) => {
          const summary =
            listLorebooks(profileId).find((candidate) => candidate.name === wanted) ??
            listLorebooks(profileId).find(
              (candidate) => candidate.name.toLowerCase() === wanted.toLowerCase()
            )
          const book = summary ? getLorebookById(profileId, summary.id) : null
          if (!book) {
            log('info', `Agent lorebook selection: no lorebook named "${wanted}" in this profile`)
            return []
          }
          return [book]
        })
  const entries = selection?.entries
  if (!entries) return books
  return books.map((book) => ({ ...book, entries: filterEntries(book.entries, entries) }))
}

/**
 * The history block, honoured — NOT advisory (ADR 0021 consequences). With no Policy the caller
 * passes none and history is `[]`; with one, every declared bound is enforced here:
 *   · `maxFloors` keeps the NEWEST floors (oldest are removed first, per design §5.3);
 *   · `includeUserMessages` adds the player's own turns — narration alone is the baseline;
 *   · `includePlayerResults` appends the owning floor's player-facing Agent Result Slots. The design
 *     names "player-facing Agent results" but not their rendering; they are cumulative per floor, so
 *     one compact JSON block at the tail is emitted rather than a per-floor diff. UNSPECIFIED by the
 *     ADR — revisit if a consumer needs per-floor attribution.
 *   · `maxTokens` drops whole messages from the OLDEST end until the block fits.
 */
const historyMessages = (
  floors: FloorFile[],
  policy: HistoryPolicy,
  latestVariables: Record<string, unknown>
): ChatMessage[] => {
  const selected =
    policy.maxFloors !== undefined && policy.maxFloors >= 0
      ? floors.slice(Math.max(0, floors.length - policy.maxFloors))
      : floors
  const out: ChatMessage[] = []
  for (const floor of selected) {
    if (policy.includeUserMessages && floor.user_message?.content) {
      out.push({ role: 'user', content: floor.user_message.content })
    }
    if (floor.response?.content) out.push({ role: 'assistant', content: floor.response.content })
  }
  if (policy.includePlayerResults) {
    const results = (latestVariables?.__rpt as Record<string, unknown> | undefined)?.agent_results
    if (results && typeof results === 'object' && Object.keys(results).length) {
      out.push({ role: 'system', content: `Agent results:\n${JSON.stringify(results, null, 2)}` })
    }
  }
  if (policy.maxTokens !== undefined) {
    let total = out.reduce((sum, message) => sum + estimateTokens(message.content), 0)
    while (out.length && total > policy.maxTokens) {
      total -= estimateTokens(out[0].content)
      out.shift()
    }
  }
  return out
}

/** Wire messages → the contract's `PromptMessage` shape. Assembled text is DATA, never re-rendered. */
const asPromptMessages = (messages: ChatMessage[]): PromptMessage[] =>
  messages.map((message) => ({
    role: message.role,
    content: [{ type: 'text', text: message.content }]
  }))

/**
 * The Agent's own `prompt`, appended AFTER the preset's output as the task instruction (ADR 0021 §1).
 * Text segments are rendered here — the Harness is told not to render an assembled prompt, so this is
 * the one place the instruction can still template. Binding segments are left untouched: they are
 * resolved from `promptValues` inside the Harness, and upstream data must never become template code.
 */
const taskInstruction = (
  prompt: PromptMessage[],
  render: ((text: string) => string) | undefined
): PromptMessage[] => {
  if (!render) return prompt
  return prompt.map((message) => ({
    role: message.role,
    content: message.content.map((segment) =>
      segment.type === 'text' ? { ...segment, text: render(segment.text) } : segment
    )
  }))
}

export const assembleAgentPresetPrompt = (
  request: AgentPresetAssemblyRequest
): PromptMessage[] | undefined => {
  const bundle = request.definition.preset
  if (!bundle) return undefined
  const preset = presetFromEnvelope(bundle.preset)
  if (!preset) {
    log(
      'error',
      `Agent "${request.definition.name}" bundles a preset that could not be read — falling back to its prompt messages`
    )
    return undefined
  }

  const base = buildGenContext(request.profileId, request.chatId, '', 'quiet')
  // The Agent assembles against ITS OWNING FLOOR, not the chat's head: a queued invocation whose
  // floor has since been overtaken must still see the world it was scheduled against.
  const floors = base.floors.filter((floor) => floor.floor <= request.floor)
  const lastFloor = floors[floors.length - 1]
  const lorebooks = selectLorebooks(request.profileId, base.lorebooks, bundle.lorebooks)
  const scanText = buildScanText(floors, '', base.scanDepth)
  const context: GenContext = {
    ...base,
    userAction: '',
    preset,
    floors,
    lastFloor,
    lorebooks,
    lorebookIds: lorebooks.map((book) => book.name),
    // CLONED, unlike Classic's by-reference working store: an Agent's build-time `setvar` is a
    // scratchpad, and letting it write through would make assembling a prompt a state mutation.
    workingVars: structuredClone(lastFloor?.variables ?? {}) as Record<string, any>,
    scanText
  }

  const matched = matchAcross(lorebooks, scanText, Math.random, base.maxRecursion)
  const history = request.history
    ? historyMessages(floors, request.history, lastFloor?.variables ?? {})
    : // No declared History Policy = NO history (ADR 0021 §3). An empty array is an explicit
      // override; omitting the key would fall through to the default floor-derived history.
      []

  const assembled = assemblePrompt(context, matched, '', { preset, history, action: '' })
  return [
    ...asPromptMessages(assembled.sendMessages),
    ...taskInstruction(request.definition.prompt, request.render)
  ]
}
