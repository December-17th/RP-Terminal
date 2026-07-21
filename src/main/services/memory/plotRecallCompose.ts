import { z } from 'zod'
import { GenContext } from '../generation/types'
import { ChatMessage } from '../promptBuilder'
import { providerShape } from '../generation/providerShape'
import { interpolate } from '../promptInterpolate'
import { recentTranscript, historyText } from './memoryCore'
import { llmCallConfigSchema } from '../generation/llmCallConfig'
import { RECALL_PLANNER_MESSAGES } from './defaultRecallPrompts'

/**
 * Plot-recall PLANNER + notes-maintainer prompt composers and their config schemas, relocated OUT of the
 * (deleted) `nodes/builtin/{recallNodes,notesNodes}.ts` node files (execution-plan M5c-2) into a stable
 * memory-service home so the survivor that shares them — the Memory Manager NOTES/recall PREVIEW IPC
 * (`ipc/notesMemoryIpc.ts`) — keeps working after the workflow surface is deleted. Moved VERBATIM: the
 * composed byte stream is the same `composeMaintainerMessages` discipline (interpolate the authored
 * scaffold, then substitute model-derived slots as INERT data), and the config schemas are unchanged.
 */

/** The `{history}` splice marker (a whole-content row REPLACED by the history messages). */
const HISTORY_MARKER = '{history}'
/** Trailing floors of transcript in the recall planner prompt (shujuku's contextTurnCount). */
const RECALL_DEFAULT_LAST_N_FLOORS = 3
/** Trailing floors of transcript in the notes maintainer prompt. */
const NOTES_DEFAULT_LAST_N_FLOORS = 6

// ── memory.recall PLANNER ──────────────────────────────────────────────────────────────────────────

const recallMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string()
})

export const recallConfig = llmCallConfigSchema.extend({
  /** The planner scaffold (role-alternating), routed to the Prompt editor. Defaults to the adapted
   *  stage-3 planner content in `defaultRecallPrompts.ts`. */
  messages: z.array(recallMessageSchema).default(RECALL_PLANNER_MESSAGES),
  temperature: z.number().min(0).max(2).optional(),
  lastNFloors: z.number().int().min(1).max(50).optional(),
  max_rows: z.number().int().min(0).optional(),
  max_note_sections: z.number().int().min(0).optional(),
  max_chars: z.number().int().min(0).optional(),
  directive: z.string().optional(),
  recall_tables: z.string().optional(),
  emit_plot_block: z.boolean().optional()
})

type RecallConfig = z.infer<typeof recallConfig>

interface RecallSlots {
  catalogue: string
  notesToc: string
  action: string
  plan: string
}

/**
 * Compose the fully-shaped planner prompt. Interpolate the authored scaffold (macros/EJS) FIRST, then
 * substitute every model-derived slot as INERT DATA (split/join) so an LLM's previous plan, the
 * transcript, or the catalogue can never inject executable template code. A row that is EXACTLY
 * `{history}` splices the transcript role-preserving; an inline `{history}` flattens it into text.
 */
export const composeRecallMessages = (
  gen: GenContext,
  cfg: Pick<RecallConfig, 'messages' | 'lastNFloors'>,
  slots: RecallSlots
): ChatMessage[] => {
  const history = recentTranscript(gen, { lastNFloors: cfg.lastNFloors ?? RECALL_DEFAULT_LAST_N_FLOORS })
  const rows: ChatMessage[] = []
  for (const m of cfg.messages) {
    if (m.content.trim() === HISTORY_MARKER) {
      rows.push(...history)
      continue
    }
    const interpolated = interpolate(m.content, {}, gen)
    const filled = interpolated
      .split('{{catalogue}}')
      .join(slots.catalogue)
      .split('{{notes_toc}}')
      .join(slots.notesToc)
      .split('{{action}}')
      .join(slots.action)
      .split('{{plan}}')
      .join(slots.plan)
      .split(HISTORY_MARKER)
      .join(historyText(history))
    rows.push({ role: m.role, content: filled })
  }
  return providerShape(gen.settings, rows)
}

/**
 * Compose the DISPLAY-ONLY `plot_block` directive (plot-recall data layer) from the planner's output.
 * This block is NOT part of the model prompt — it is persisted on the floor for a later renderer to
 * beautify. Pure + total (never throws) so it is unit-testable against the live findRegex. A family with
 * an empty body is dropped, but the `<用户本轮输入>` marker is ALWAYS present so `findRegex` still fires.
 */
export const buildPlotBlock = (parts: {
  action: string
  questPlan: string
  recall: string
  storyEngine: string
}): string => {
  const segments: string[] = [`<用户本轮输入>\n${parts.action.trim()}\n</用户本轮输入>`]
  const closedTag = (name: string, body: string): void => {
    const b = body.trim()
    if (b) segments.push(`<${name}>\n${b}\n</${name}>`)
  }
  closedTag('QuestPlan', parts.questPlan)
  // The beautifier's recalled-rows JS extracts codes via /AM\d+/; this project's chronicle uses MT####,
  // so map MT→AM in the <Recall> body so the original HTML's recalled-list populates.
  closedTag('Recall', parts.recall.replace(/MT(\d+)/g, 'AM$1'))
  closedTag('StoryEngine', parts.storyEngine)
  return segments.join('\n\n')
}

// ── notes.maintain MAINTAINER ──────────────────────────────────────────────────────────────────────

/** The default notes-maintainer scaffold (zh — document DATA, deliberately NOT i18n). A `system` row
 *  carries the prose-only discipline + the `<MemoryNote>` output contract; ONE `user` row carries the
 *  current-notes slot ({{notes}}) and ends the prompt on a `user` turn (inline `{history}`). */
export const NOTES_MAINTAINER_MESSAGES: Array<{
  role: 'system' | 'user' | 'assistant'
  content: string
}> = [
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
  /** The scaffold/maintainer prompt (role-alternating). Routed to the Prompt editor. */
  messages: z.array(notesMessageSchema).default(NOTES_MAINTAINER_MESSAGES),
  lastNFloors: z.number().int().min(1).max(50).optional(),
  temperature: z.number().min(0).max(2).optional()
})

type NotesMaintainConfig = z.infer<typeof notesMaintainConfig>

/**
 * Compose the fully-shaped notes-maintainer prompt: interpolate the authored scaffold (macros/EJS) FIRST,
 * then substitute the current-notes slot + `{history}` as INERT DATA (split/join). Exported so a preview
 * / test sees EXACTLY what a run sends.
 */
export const composeNotesMaintainerMessages = (
  gen: GenContext,
  cfg: Pick<NotesMaintainConfig, 'messages' | 'lastNFloors'>,
  currentNotes: string
): ChatMessage[] => {
  const history = recentTranscript(gen, { lastNFloors: cfg.lastNFloors ?? NOTES_DEFAULT_LAST_N_FLOORS })
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
