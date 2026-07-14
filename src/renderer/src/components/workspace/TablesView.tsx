import React from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { useUiStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useT } from '../../i18n'
import { TableGrid, type TableDef, type TableDefPatch, type TableRead } from './TableGrid'
import type { TableStatusLike } from './tableGridModel'

/**
 * Tables view for SQL-table memory — the lean DATA surface. Per active chat: one section per
 * assigned table (display name + an EDITABLE grid). Memory CONFIGURATION + MAINTENANCE (template
 * binding / import / export / delete, per-table progress, and the refill workbench) live in the
 * full-window Memory Manager (table-refill WS6); the header hint links there.
 *
 * Agent & memory UX WP-I (spec §8): the grid itself is now the SHARED `TableGrid` component (also
 * hosted by the editor's Memory sheet Data tab), and this view additionally loads the per-table
 * maintenance status so the grid can show its pointer marker. `embedded` hides the config-hint header
 * when the view is mounted inside the Memory sheet (the sheet's own tabs replace it).
 *
 * Editing (issue 06) is chat-scoped and goes ENTIRELY through main via `window.api` (the IPC surface):
 * every cell edit / add row / delete row / reset becomes floor-attributed op-logged SQL on the SAME
 * write path AI writes take (`chat-tables-edit` → tableEditService). The renderer only ever sends a
 * column INDEX (never a column name) for a cell edit; main resolves it to the real column. Constraint
 * violations come back as `{ error }` and are toasted (localized `tables.*` key, else the verbatim
 * SQLite message).
 */
const api = (): any => (window as unknown as { api: any }).api

interface TableTemplate {
  name: string
  tables: TableDef[]
}

export const TablesView: React.FC<{ profileId: string; embedded?: boolean }> = ({
  profileId,
  embedded = false
}) => {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const floors = useChatStore((s) => s.floors)
  // WS6 Phase B: the config home is the full-window Memory Manager (was: the workflow editor's sheet).
  const openMemoryManager = useUiStore((s) => s.openMemoryManager)
  // Global default cadence: the "全局 (N)" the header frequency control shows for a -1 (use-global)
  // table. Older profiles lack the group → default 3 (matches the main-side resolver fallback).
  const globalFreq = useSettingsStore((s) => s.settings?.tables?.default_update_frequency ?? 3)
  const t = useT()

  const [assigned, setAssigned] = React.useState(false)
  const [tables, setTables] = React.useState<TableRead[]>([])
  const [templateId, setTemplateId] = React.useState<string | null>(null)
  const [template, setTemplate] = React.useState<TableTemplate | null>(null)
  // WP-I: per-table maintenance status (pointer marker in the shared grid).
  const [status, setStatus] = React.useState<Record<string, TableStatusLike>>({})

  const loadChat = React.useCallback(async () => {
    if (!activeChatId) {
      setAssigned(false)
      setTables([])
      setTemplateId(null)
      setTemplate(null)
      setStatus({})
      return
    }
    try {
      // A cheap read tells us whether a template is assigned (→ "off" hint) vs assigned-but-empty.
      const id = (await api().getChatTableTemplate(profileId, activeChatId)) ?? null
      setAssigned(!!id)
      setTemplateId(id)
      if (!id) {
        setTables([])
        setTemplate(null)
        setStatus({})
        return
      }
      setTables((await api().readChatTables(profileId, activeChatId)) ?? [])
      // The assigned template object powers the per-table prompt editor (issue 03). A stale id → null,
      // in which case TableGrid simply hides the editor toggle.
      setTemplate(((await api().getTableTemplate(profileId, id)) as TableTemplate | null) ?? null)
      setStatus((await api().readChatTablesStatus(profileId, activeChatId)) ?? {})
    } catch {
      setAssigned(false)
      setTables([])
      setTemplateId(null)
      setTemplate(null)
      setStatus({})
    }
  }, [profileId, activeChatId])

  /** Refetch just the template object after a prompt edit (data grids are unaffected). */
  const reloadTemplate = React.useCallback(async () => {
    if (!templateId) return
    try {
      setTemplate(((await api().getTableTemplate(profileId, templateId)) as TableTemplate | null) ?? null)
    } catch {
      /* keep the current template on a transient read failure */
    }
  }, [profileId, templateId])

  React.useEffect(() => {
    void loadChat()
  }, [loadChat, floors.length])

  /** Turn a service `{ error }` into a toast: localize a `tables.*` key, else show the raw message. */
  const toastError = React.useCallback(
    (prefix: string, error: string): void => {
      const detail = error.startsWith('tables.') ? t(error) : error
      useToastStore.getState().push(`${prefix}: ${detail}`)
    },
    [t]
  )

  if (!activeChatId) {
    return <div style={{ opacity: 0.5 }}>{t('status.waiting')}</div>
  }

  /** Route one hand edit through main, toast any error, then refetch. */
  const applyEdit = async (edit: {
    kind: 'cell' | 'insert' | 'delete' | 'reset'
    table: string
    rowid?: number
    columnIndex?: number
    value?: string
    values?: (string | null)[]
  }): Promise<void> => {
    try {
      const res = await api().editChatTable(profileId, activeChatId, edit)
      if (res && res.error) {
        toastError(t('tables.editFailed'), res.error)
        return
      }
    } catch {
      useToastStore.getState().push(t('tables.editFailed'))
    }
    await loadChat()
  }

  /** Persist a per-table prompt patch through main, toast the outcome, then refetch the template. */
  const onSaveTemplate = async (tablePatch: TableDefPatch): Promise<void> => {
    if (!templateId) return
    try {
      const res = await api().updateTableTemplate(profileId, templateId, { tables: [tablePatch] })
      if (res && res.error) {
        toastError(t('tables.templateSaveFailed'), res.error)
        return
      }
    } catch {
      useToastStore.getState().push(t('tables.templateSaveFailed'))
      return
    }
    useToastStore.getState().push(t('tables.templateSaved'))
    await reloadTemplate()
  }

  /** Match a data-grid table to its TableDef by sqlName, falling back to displayName. */
  const findDef = (tbl: TableRead): TableDef | null => {
    if (!template) return null
    return (
      template.tables.find((d) => d.sqlName === tbl.sqlName) ??
      template.tables.find((d) => d.displayName === tbl.displayName) ??
      null
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Lightweight header: a hint that configuration (template binding / backfill) lives in the
          Memory rail, plus a Refresh for the data grid. Hidden when the view is embedded inside the
          Memory sheet (WP-I — the sheet's tabs ARE the configuration home; a jump would be circular). */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          borderBottom: '1px solid var(--rpt-border)',
          paddingBottom: 8,
          marginBottom: 8
        }}
      >
        {!embedded && (
          <>
            <span style={{ fontSize: 12, opacity: 0.7 }}>{t('tables.configHint')}</span>
            <button
              className="rpt-duel-secondary"
              style={{ fontSize: 12, padding: '3px 10px' }}
              onClick={() => openMemoryManager()}
            >
              {t('tables.openMemory')}
            </button>
          </>
        )}
        <button
          className="rpt-duel-secondary"
          style={{ fontSize: 12, padding: '3px 8px', marginLeft: 'auto' }}
          onClick={() => void loadChat()}
        >
          {t('tables.refresh')}
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {!assigned ? (
          <div style={{ opacity: 0.5, fontSize: 12 }}>
            <em>{t('tables.noneAssigned')}</em>
          </div>
        ) : tables.length === 0 ? (
          <div style={{ opacity: 0.5, fontSize: 12 }}>
            <em>{t('tables.emptyTemplate')}</em>
          </div>
        ) : (
          tables.map((tbl) => (
            <TableGrid
              key={tbl.sqlName}
              table={tbl}
              def={findDef(tbl)}
              globalFreq={globalFreq}
              onEdit={applyEdit}
              onSaveTemplate={onSaveTemplate}
              status={status[tbl.sqlName] ?? null}
            />
          ))
        )}
      </div>
    </div>
  )
}
