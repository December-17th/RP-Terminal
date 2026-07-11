import { z } from 'zod'
import { buildGenContext } from '../../generation/genContext'
import { GenContext } from '../../generation/types'
import { providerShape } from '../../generation/providerShape'
import { ChatMessage } from '../../promptBuilder'
import { NodeImpl } from '../types'
import { interpolate } from './messageNodes'
import {
  runLlmCall,
  llmCallConfigSchema,
  buildLlmCallConfig,
  presetParamsWithTemperature
} from './generationNodes'
import { extractTagAllWithAttrs } from './parseNodes'
import { recentTranscript, historyText, composedPromptDebug } from './memoryCore'
import { readNotes, writeNotes } from '../../notesMemoryService'
import { mergeNotes, NoteEdit, NoteEditMode } from '../../../../shared/memory/notesGrep'

/**
 * `notes.maintain` — the POST-turn WRITE side of grep-based plot-recall memory (plot-recall WP6;
 * design docs/grep-notes-memory-design.md §Approach). It grows the per-chat human-readable notes file
 * `memory.recall` reads: one side LLM call reads the recent transcript + the current notes and emits
 * `<MemoryNote section="…" mode="append|replace">…</MemoryNote>` edits, which are merged into the file
 * by heading (`mergeNotes`, WP1) and written back (`writeNotes`, WP2).
 *
 * It COMPOSES the shared cores — never reimplements them: `buildGenContext` (self-seeds its Context, the
 * `memory.maintain` pattern), `recentTranscript`/`historyText`/`composedPromptDebug` (memoryCore),
 * `runLlmCall`/`buildLlmCallConfig`/`presetParamsWithTemperature` (generationNodes), and the pure
 * `extractTagAllWithAttrs` (parseNodes) + `mergeNotes` (shared/memory/notesGrep). Its scaffold prompt is
 * routed to the Prompt editor via `promptFields` (the `memory.maintain` convention).
 *
 * Gated by its `when` Signal (the same `control.mode`/cadence chain the table maintainer joins). No-op —
 * ZERO model calls — when there is NO notes file AND NO transcript (an idle/first-turn chat is
 * byte-identical to before). This node is trigger-rooted / POST-phase, so a failure THROWS a
 * `NodeRunFailure` and the engine routes it on the `error` port — the same failure stance as
 * `memory.maintain` (the pre-phase fatal-throw guard that forces `memory.recall` to fail-open does NOT
 * apply here).
 *
 * DISJOINTNESS discipline (design §Risks): the default scaffold instructs the model to write NARRATIVE
 * PROSE only — do not restate MVU numbers or duplicate the SQL tables — and to always target a named
 * `##` section (the addressable/mergeable unit; `mergeNotes` drops any preamble before the first
 * heading, and creates a section when the model names one that does not exist yet).
 */

/** One role-tagged scaffold row (mirrors the memory.maintain message shape). */
export interface NotesMaintainerMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** The `{history}` splice marker (a whole-content row REPLACED by the history messages — memory.maintain). */
const HISTORY_MARKER = '{history}'

const DEFAULT_LAST_N_FLOORS = 6

/**
 * The default maintainer scaffold (zh — document DATA, deliberately NOT i18n, same stance as
 * `MAINTAINER_SYSTEM_PROMPT`). A `system` row carries the framing + prose-only discipline + the
 * `<MemoryNote>` output contract; ONE `user` row carries the current-notes slot ({{notes}}) and ends the
 * prompt on a `user` turn (inline `{history}`) — a trailing standalone-`{history}`/assistant row makes
 * OpenAI-compatible Gemini return an empty completion (the maintainer-prompt guard).
 *
 * SLOT CONTRACT (owned by this node): {{notes}} → the current notes file; a `{history}` marker (a row
 * EXACTLY `{history}` splices the transcript role-preserving; an inline `{history}` flattens it to text).
 */
export const NOTES_MAINTAINER_MESSAGES: NotesMaintainerMessage[] = [
  {
    role: 'system',
    content: `你是本轮正文之后的「剧情笔记」维护者。你的唯一职责：把最近发生的、值得长期记住的叙事信息，写进一份人类可读的 Markdown 笔记，供日后按需检索。

硬性纪律：
- 只写叙事/剧情散文：人物动机与关系变化、承诺与秘密、地点与线索、悬而未决的伏笔等。
- 不要复述 MVU 数值，也不要重复 SQL 记忆表里的结构化数据；那些有各自的通道，笔记只补充它们无法承载的散文脉络。
- 内容必须写进具名的 ## 小节。每条 <MemoryNote> 用 section 属性指定小节标题（已存在则更新，不存在则新建）。
- mode="append" 追加到该小节；mode="replace" 整体改写该小节。默认 replace。
- 若本轮没有值得记录的新信息，直接不输出任何 <MemoryNote> 标签。

输出格式（可输出零到多条，标签之间仅换行，标签内是该小节的散文正文）：
<MemoryNote section="小节标题" mode="append">
……本小节的散文内容……
</MemoryNote>`
  },
  {
    role: 'user',
    content: `# 当前笔记（供参考，避免重复已记录的内容）：
<当前笔记>
{{notes}}
</当前笔记>

# 最近剧情（据此提炼值得长期记住的信息）：
{history}`
  }
]

const notesMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string()
})

export const notesMaintainConfig = llmCallConfigSchema.extend({
  /** The scaffold/maintainer prompt (role-alternating). Routed to the Prompt editor (promptFields). */
  messages: z.array(notesMessageSchema).default(NOTES_MAINTAINER_MESSAGES),
  /** Trailing floors of transcript to include (1..50). Default 6 (the maintainer window). */
  lastNFloors: z.number().int().min(1).max(50).optional(),
  /** Overrides the preset's temperature for THIS call when set (0..2). */
  temperature: z.number().min(0).max(2).optional()
})

type NotesMaintainConfig = z.infer<typeof notesMaintainConfig>

/**
 * Compose the fully-shaped maintainer prompt: interpolate the authored scaffold (macros/EJS) FIRST, then
 * substitute the current-notes slot + `{history}` as INERT DATA (split/join) so the notes prose can
 * never inject executable template code — the `composeMaintainerMessages` discipline. Exported so a
 * preview / test sees EXACTLY what a run sends.
 */
export const composeNotesMaintainerMessages = (
  gen: GenContext,
  cfg: Pick<NotesMaintainConfig, 'messages' | 'lastNFloors'>,
  currentNotes: string
): ChatMessage[] => {
  const history = recentTranscript(gen, { lastNFloors: cfg.lastNFloors ?? DEFAULT_LAST_N_FLOORS })
  const rows: ChatMessage[] = []
  for (const m of cfg.messages) {
    if (m.content.trim() === HISTORY_MARKER) {
      rows.push(...history)
      continue
    }
    const interpolated = interpolate(m.content, {}, gen)
    const filled = interpolated
      .split('{{notes}}')
      .join(currentNotes)
      .split(HISTORY_MARKER)
      .join(historyText(history))
    rows.push({ role: m.role, content: filled })
  }
  return providerShape(gen.settings, rows)
}

/**
 * Parse the reply's `<MemoryNote section="…" mode="append|replace">…</MemoryNote>` tags into
 * `mergeNotes` edits. Drops any note without a `section` heading or with an empty body; an unrecognized
 * `mode` falls back to 'replace'. Exported for tests.
 */
export const parseMemoryNotes = (raw: string): NoteEdit[] => {
  const edits: NoteEdit[] = []
  for (const note of extractTagAllWithAttrs(raw, 'MemoryNote')) {
    const heading = (note.attrs.section ?? '').trim()
    if (!heading) continue
    const body = note.content.trim()
    if (!body) continue
    const mode: NoteEditMode = (note.attrs.mode ?? '').trim().toLowerCase() === 'append'
      ? 'append'
      : 'replace'
    edits.push({ heading, body, mode })
  }
  return edits
}

export const notesMaintain: NodeImpl = {
  type: 'notes.maintain',
  title: 'Notes',
  // The scaffold prompt is routed to the dedicated Prompt editor + drives the on-card excerpt.
  promptFields: ['messages'],
  inputs: [{ name: 'when', type: 'Signal' }],
  outputs: [
    { name: 'report', type: 'Text' },
    { name: 'error', type: 'Error' }
  ],
  configSchema: notesMaintainConfig,
  run: async (ctx, _inputs, node) => {
    const cfg = node.config as NotesMaintainConfig
    const gen: GenContext = buildGenContext(ctx.profileId!, ctx.chatId!, '')

    // No-op: nothing to summarize AND no existing notes to revise → NO model call (byte-identical to
    // before when the chat is idle / first-turn).
    const currentNotes = readNotes(gen.profileId, gen.chatId)
    const history = recentTranscript(gen, { lastNFloors: cfg.lastNFloors ?? DEFAULT_LAST_N_FLOORS })
    if (!currentNotes.trim() && history.length === 0) return { outputs: {} }

    // Compose EXACTLY what a preview shows; substitute the notes + {history} as DATA, provider-shape.
    const sendMessages = composeNotesMaintainerMessages(gen, cfg, currentNotes)
    const promptDebug = composedPromptDebug(sendMessages)

    // One side call — stream defaults false (a maintenance reply is never the player-facing stream).
    const params = presetParamsWithTemperature(gen, cfg.temperature)
    const callCfg = buildLlmCallConfig(cfg)
    const r = await runLlmCall(ctx, gen, sendMessages, params, callCfg)
    // Abort-with-empty: no reply to parse; the prompt is still traced so the empty result is diagnosable.
    if (r === null) return { outputs: {}, debug: promptDebug }

    // Parse the <MemoryNote> edits (blank reply → no edits → NO write).
    const edits = parseMemoryNotes(r.raw)
    if (edits.length === 0) return { outputs: { report: 'no notes' }, debug: promptDebug }

    // Merge by heading (mergeNotes creates unknown sections, upserts existing ones) → write back.
    const merged = mergeNotes(currentNotes, edits)
    writeNotes(gen.profileId, gen.chatId, merged)
    return { outputs: { report: `applied ${edits.length} note edit(s)` }, debug: promptDebug }
  }
}
