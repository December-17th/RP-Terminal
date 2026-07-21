import { IpcMain } from 'electron'
import * as notesMemoryService from '../services/notesMemoryService'
import { buildGenContext } from '../services/generation/genContext'
import { chatTemplate } from '../services/memory/memoryCore'
import { readAllTables } from '../services/tableDbService'
import { renderCatalog } from '../services/tableExportService'
import { parseNotesSections } from '../../shared/memory/notesGrep'
import {
  recallConfig,
  composeRecallMessages,
  notesMaintainConfig,
  composeNotesMaintainerMessages
} from '../services/memory/plotRecallCompose'

/** A clearly-preview stand-in for the pending player action: at real run time `memory.recall` fires
 *  PRE-turn with the player's input in the `{{action}}` slot, but a preview has no pending action, so
 *  the slot shows this marker rather than a blank. */
const PREVIEW_ACTION_SAMPLE = '<预览：此处为玩家的当前行动 / preview: the pending player action>'

/**
 * IPC for the per-chat plot-recall NOTES store (plot-recall WP2): read/write the human-editable
 * markdown notes file backing grep-based agentic recall. The Notes tab (WP7) binds to these; the
 * recall/maintainer nodes (WP4/WP6) call the service directly, not this surface.
 *
 * It ALSO carries the composed-prompt PREVIEW handlers for the two plot-recall planner nodes
 * (`memory.recall`, `notes.maintain`), mirroring `memory-maintain-preview` in tableMemoryIpc: each
 * composes EXACTLY what a run would send via the SAME exported cores the node's run() uses
 * (`composeRecallMessages` / `composeNotesMaintainerMessages`), so the workflow editor can see the
 * planner prompt BEFORE a model call is burned. Any thrown failure comes back as `{ error }` (the
 * renderer localizes it).
 */
export const registerNotesMemoryIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('chat-notes-get', (_, profileId: string, chatId: string) =>
    notesMemoryService.readNotes(profileId, chatId)
  )
  ipcMain.handle('chat-notes-set', (_, profileId: string, chatId: string, notes: string) => {
    notesMemoryService.writeNotes(profileId, chatId, typeof notes === 'string' ? notes : '')
  })

  // memory.recall planner preview: compose the planner prompt for this chat. The heavy slots are REAL
  // chat data — `{{catalogue}}` from the bound table template (renderCatalog, `recall_tables`-narrowed)
  // and `{{notes_toc}}` from the notes file — while `{{action}}`/`{{plan}}` (which only exist mid-turn)
  // fall back to a clearly-preview sample / empty. `{history}` splices the real recent transcript via
  // the compose core. `config` is the node's current config.
  ipcMain.handle('recall-planner-preview', (_, profileId: string, chatId: string, config: unknown) => {
    try {
      const parsed = recallConfig.safeParse(config ?? {})
      if (!parsed.success) return { error: 'bad-config' }
      const cfg = parsed.data
      const gen = buildGenContext(profileId, chatId, '')
      const bound = chatTemplate(gen)
      let catalogue = ''
      if (bound) {
        const only = (cfg.recall_tables ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const template = only.length
          ? { ...bound, tables: bound.tables.filter((t) => only.includes(t.sqlName)) }
          : bound
        catalogue = renderCatalog(template, readAllTables(profileId, chatId, template))
      }
      const notes = notesMemoryService.readNotes(profileId, chatId)
      const notesToc = parseNotesSections(notes)
        .map((s) =>
          s.keywords.length ? `## ${s.heading} (${s.keywords.join(', ')})` : `## ${s.heading}`
        )
        .join('\n')
      const messages = composeRecallMessages(gen, cfg, {
        catalogue,
        notesToc,
        action: PREVIEW_ACTION_SAMPLE,
        plan: ''
      })
      return { messages: messages.map((m) => ({ role: m.role, content: m.content })) }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // notes.maintain preview: compose the maintainer prompt for this chat — fully real data (the current
  // notes file in `{{notes}}` + the recent transcript spliced at `{history}`), exactly like the run.
  ipcMain.handle('notes-maintain-preview', (_, profileId: string, chatId: string, config: unknown) => {
    try {
      const parsed = notesMaintainConfig.safeParse(config ?? {})
      if (!parsed.success) return { error: 'bad-config' }
      const gen = buildGenContext(profileId, chatId, '')
      const currentNotes = notesMemoryService.readNotes(profileId, chatId)
      const messages = composeNotesMaintainerMessages(gen, parsed.data, currentNotes)
      return { messages: messages.map((m) => ({ role: m.role, content: m.content })) }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
}
