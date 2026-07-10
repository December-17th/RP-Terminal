import { IpcMain, BrowserWindow, dialog } from 'electron'
import * as tableTemplateService from '../services/tableTemplateService'
import * as tableDbService from '../services/tableDbService'
import * as tableOpsService from '../services/tableOpsService'
import * as chatService from '../services/chatService'
import { applyEdit, TableEditOp } from '../services/tableEditService'
import { applyStructureOps, StructureOp } from '../services/tableStructureService'
import { getTablesStatus } from '../services/tableStatusService'
import { templateSqlNames } from '../services/tableDbService'
import {
  startBackfill,
  cancelBackfill,
  getBackfillState,
  BackfillOpts
} from '../services/tableBackfillService'
import { buildGenContext } from '../services/generation/genContext'
import { chatTemplate } from '../services/nodes/builtin/memoryCore'
import { composeMaintainerMessages, memoryMaintainConfig } from '../services/nodes/builtin/memoryNodes'
import { maintainNow, resolveMaintainConfig } from '../services/tableMaintainNow'

/**
 * IPC for SQL-table memory (issue 02): file-based table templates, per-chat assignment (which
 * instantiates/removes the sandbox DB), and a read-only projection of a chat's tables. Import
 * surfaces parser errors as `{ error }` rather than throwing across IPC (mirrors how
 * tableTemplateService returns import results); the renderer localizes/toasts them.
 */
export const registerTableMemoryIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('table-templates-list', (_, profileId) =>
    tableTemplateService.listTableTemplates(profileId)
  )
  ipcMain.handle('table-template-get', (_, profileId, id) =>
    tableTemplateService.getTableTemplateById(profileId, id)
  )
  // Update a template's editable (non-structural) fields — the Tables-view prompt editor (manual-pass
  // issue 03). Prompt edits take effect on the NEXT maintenance pass (table.read/table.gate re-read the
  // template); no sandbox rebuild. A template is shared: edits apply to every chat assigned to it.
  ipcMain.handle('table-template-update', (_, profileId, id, patch) =>
    tableTemplateService.updateTableTemplate(profileId, id, patch)
  )
  ipcMain.handle('table-template-delete', (_, profileId, id) => {
    tableTemplateService.deleteTableTemplate(profileId, id)
    // Any chat that had it assigned loses its sandbox too.
    chatService.removeTableTemplateIdFromChats(profileId, id)
  })
  ipcMain.handle('table-template-import-dialog', async (event, profileId) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      properties: ['openFile'],
      filters: [{ name: 'Table Template', extensions: ['json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return tableTemplateService.importTableTemplateFromFile(profileId, result.filePaths[0])
  })

  // Per-chat assignment. Setting a new id (re)instantiates the sandbox; null removes it (both
  // destructive — the renderer confirms first).
  ipcMain.handle('chat-table-template-get', (_, profileId, chatId) =>
    chatService.getChatTableTemplateId(profileId, chatId)
  )
  ipcMain.handle('chat-table-template-set', (_, profileId, chatId, id) =>
    chatService.setChatTableTemplateId(profileId, chatId, id)
  )

  // The memory.maintain node panel preview: compose the EXACT maintainer prompt a run would send for
  // this chat (composeMaintainerMessages — shared with the node's run(), so no drift). `config` carries
  // the NODE's current config on the workflow-editor path; on the Memory-Manager Maintenance-tab path it
  // is null / a bare `{ lastNFloors }` override, and we resolve the chat's EFFECTIVE memory.maintain node
  // config (the SAME core run-now uses) so the preview matches an on-demand run. `{ error: 'no-template' }`
  // when no table memory is bound; any thrown failure comes back as `{ error }` (the renderer localizes it).
  ipcMain.handle('memory-maintain-preview', (_, profileId, chatId, config) => {
    try {
      const gen = buildGenContext(profileId, chatId, '')
      const template = chatTemplate(gen)
      if (!template) return { error: 'no-template' }
      const parsed = memoryMaintainConfig.safeParse(config ?? {})
      const cfg = parsed.success
        ? parsed.data
        : (() => {
            const resolved = resolveMaintainConfig(profileId, chatId)
            if (!resolved) return null
            const override = (config ?? {}) as { lastNFloors?: number }
            return typeof override.lastNFloors === 'number'
              ? { ...resolved, lastNFloors: override.lastNFloors }
              : resolved
          })()
      if (!cfg) return { error: 'bad-config' }
      const messages = composeMaintainerMessages(gen, template, cfg)
      return { messages: messages.map((m) => ({ role: m.role, content: m.content })) }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Run ONE maintenance pass on demand (Memory-Manager WP2 workbench). Reuses the SAME cores automatic
  // maintenance runs (resolveMaintainConfig → composeMaintainerMessages → runLlmCall → applyTableEdit);
  // `opts` is `{ lastNFloors?, extraHint? }`. Returns the run-now report shape (never throws across IPC).
  ipcMain.handle(
    'chat-tables-maintain-now',
    (_, profileId: string, chatId: string, opts: { lastNFloors?: number; extraHint?: string }) =>
      maintainNow(profileId, chatId, {
        lastNFloors:
          typeof opts?.lastNFloors === 'number' &&
          Number.isInteger(opts.lastNFloors) &&
          opts.lastNFloors >= 1
            ? opts.lastNFloors
            : undefined,
        extraHint: typeof opts?.extraHint === 'string' ? opts.extraHint : undefined
      })
  )

  // Read: every table of the chat's assigned template, with current rows + per-row rowids (issue 06).
  ipcMain.handle('chat-tables-read', (_, profileId, chatId) => {
    const id = chatService.getChatTableTemplateId(profileId, chatId)
    if (!id) return []
    const template = tableTemplateService.getTableTemplateById(profileId, id)
    if (!template) return []
    return tableDbService.readAllTables(profileId, chatId, template)
  })

  // Hand edit (issue 06): a cell edit / row add / row delete / table reset. The renderer sends only a
  // column INDEX for cell edits; main maps it → the REAL sandbox column name (never a renderer-
  // supplied name), then routes through `applyEdit` (the SAME op-logged write path as AI writes).
  // Returns `{ ok, changes } | { error }` — the error string is the SQLite/validation message the
  // renderer toasts. `columnIndex` is validated against the sandbox's column list.
  ipcMain.handle(
    'chat-tables-edit',
    (
      _,
      profileId: string,
      chatId: string,
      edit: {
        kind: 'cell' | 'insert' | 'delete' | 'reset'
        table: string
        rowid?: number
        columnIndex?: number
        value?: string
        values?: (string | null)[]
      }
    ) => {
      const id = chatService.getChatTableTemplateId(profileId, chatId)
      if (!id) return { error: 'tables.editNoTemplate' }
      const template = tableTemplateService.getTableTemplateById(profileId, id)
      if (!template) return { error: 'tables.editNoTemplate' }
      // The target table must be a registered template table (the same allowlist AI writes use).
      if (!templateSqlNames(template).has(edit.table)) {
        return { error: 'tables.editUnknownTable' }
      }

      const op: TableEditOp = { kind: edit.kind, table: edit.table }
      if (edit.kind === 'cell') {
        const cols = tableDbService.sandboxColumns(profileId, chatId, edit.table)
        const idx = edit.columnIndex
        if (idx == null || idx < 0 || idx >= cols.length) {
          return { error: 'tables.editBadColumn' }
        }
        op.column = cols[idx] // the REAL column name, resolved from the index main-side
        op.rowid = edit.rowid
        op.value = edit.value ?? ''
      } else if (edit.kind === 'insert') {
        op.values = edit.values ?? []
      } else if (edit.kind === 'delete') {
        op.rowid = edit.rowid
      }
      return applyEdit(profileId, chatId, template, op)
    }
  )

  // Per-table maintenance progress (issue 07): from the chat-level table_progress store (shared by the
  // per-turn gate + the manual backfill) joined with the template frequencies + the chat's floor count.
  // `{ sqlName: { lastFloor, processed, nextExpected, unprocessed } }`. Best-effort → `{}` on failure.
  ipcMain.handle('chat-tables-status', (_, profileId, chatId) =>
    getTablesStatus(profileId, chatId)
  )

  // History op-log (Memory-Manager WP3): a display projection of the per-chat table op log, newest-
  // first. Each entry is keyed to a FLOOR (the rewind cut granularity) and labelled by SQL statement
  // kind + table — `table_ops` has no author column, so ops are NOT tagged maintenance-vs-hand-edit.
  // `[]` when no template is bound (nothing to show).
  ipcMain.handle('chat-tables-ops-list', (_, profileId: string, chatId: string) => {
    const id = chatService.getChatTableTemplateId(profileId, chatId)
    if (!id) return []
    return tableOpsService.listOpsForDisplay(profileId, chatId)
  })

  // History rewind (Memory-Manager WP3): roll the tables back to BEFORE `fromFloor` by dropping every
  // op at/after it and rebuilding the sandbox from the survivors — the SAME primitives truncateFloors
  // runs for a floor cut, minus the floor deletion (DATA-ONLY: chat messages + the maintenance progress
  // pointer are untouched). `rebuildSandbox` self-serializes on the per-chat write lock. DESTRUCTIVE
  // (drops later ops); the renderer confirms first. `{ ok, dropped } | { error }` (a localized
  // `tables.*` key the renderer toasts); the renderer re-reads the table state on success.
  ipcMain.handle('chat-tables-rewind', (_, profileId: string, chatId: string, fromFloor: number) => {
    if (!Number.isInteger(fromFloor) || fromFloor < 0) return { error: 'tables.rewindBadFloor' }
    const id = chatService.getChatTableTemplateId(profileId, chatId)
    if (!id) return { error: 'tables.editNoTemplate' }
    const template = tableTemplateService.getTableTemplateById(profileId, id)
    if (!template) return { error: 'tables.editNoTemplate' }
    const dropped = tableOpsService.rewindTables(profileId, chatId, fromFloor, template)
    return { ok: true, dropped }
  })

  // Structural template edit + bound-chat migration (Memory-Manager WP4a). `ops` is an ordered list
  // of high-level structural ops (add/rename/drop table or column). Validation rejects the WHOLE batch
  // on any invalid op WITHOUT touching the template or any sandbox; on success the template is rewritten
  // and every bound chat's sandbox is ALTERed + its op log re-baselined so a later rewind/rebuild
  // reproduces the migrated rows. Returns the report or `{ ok:false, error }` (a localizable
  // `tables.structure*` key the renderer toasts). Never throws across IPC.
  ipcMain.handle(
    'table-structure-apply',
    (
      _,
      profileId: string,
      templateId: string,
      ops: StructureOp[]
    ) => applyStructureOps(profileId, templateId, ops)
  )

  // Manual backfill (issue 07). Start validates the scope/batch inputs (X ≥ 1 or all, Y ≥ 1, retries
  // 0–5) and returns `{ ok } | { error }` with the error as a localized `tables.*` key (the established
  // contract); the actual run is async and streams progress via `table-backfill-progress`.
  ipcMain.handle(
    'table-backfill-start',
    async (
      _,
      profileId: string,
      chatId: string,
      raw: {
        lastFloors: number | 'all'
        batchSize: number
        apiPresetId?: string | null
        retries?: number
      }
    ) => {
      const lastFloors: number | 'all' =
        raw.lastFloors === 'all'
          ? 'all'
          : Number.isInteger(raw.lastFloors) && (raw.lastFloors as number) >= 1
            ? (raw.lastFloors as number)
            : NaN
      if (typeof lastFloors === 'number' && Number.isNaN(lastFloors)) {
        return { error: 'tables.backfillBadScope' }
      }
      if (!Number.isInteger(raw.batchSize) || raw.batchSize < 1) {
        return { error: 'tables.backfillBadBatch' }
      }
      const retries = Number.isInteger(raw.retries) ? Math.max(0, Math.min(5, raw.retries!)) : 0
      const opts: BackfillOpts = {
        lastFloors,
        batchSize: raw.batchSize,
        apiPresetId: raw.apiPresetId || undefined,
        retries
      }
      try {
        await startBackfill(profileId, chatId, opts)
        return { ok: true }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return { error: msg.startsWith('tables.') ? msg : msg }
      }
    }
  )

  ipcMain.handle('table-backfill-cancel', (_, profileId: string, chatId: string) => {
    cancelBackfill(profileId, chatId)
  })

  ipcMain.handle('table-backfill-state', (_, _profileId: string, chatId: string) =>
    getBackfillState(chatId)
  )

  // Export the chat's (or a stored) template back to chatSheets v2 JSON behind a save dialog (issue
  // 06). `chatId` present = export WITH that chat's current data as initial rows. Mirrors the
  // workflow export-dialog precedent (workflowIpc `export-workflow-dialog`).
  ipcMain.handle(
    'table-template-export-dialog',
    async (event, profileId: string, templateId: string, chatId?: string | null) => {
      const template = tableTemplateService.getTableTemplateById(profileId, templateId)
      const defaultName = (template?.name || templateId).replace(/[\\/:*?"<>|]/g, '_')
      const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, {
        defaultPath: `${defaultName}.json`,
        filters: [{ name: 'Table Template', extensions: ['json'] }]
      })
      if (result.canceled || !result.filePath) return false
      return tableTemplateService.exportTableTemplateToFile(
        profileId,
        templateId,
        result.filePath,
        chatId
      )
    }
  )
}
