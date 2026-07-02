import React from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { useT } from '../../i18n'

/**
 * Read-only view for SQL-table memory (issue 02). Per active chat:
 *  - a header with the assigned-template selector (list + "none"), Import, and Delete-template;
 *  - one section per table (display name + a plain read-only grid of headers + rows).
 *
 * v1 is read-only and self-contained (no SettingsModal wiring); writes/injection are later issues.
 * Assign/reassign/unassign all recreate-or-drop the per-chat sandbox DB, so each confirms first.
 * Chat-scoped; talks to main only via window.api (the IPC surface).
 */
const api = (): any => (window as unknown as { api: any }).api

interface TemplateSummary {
  id: string
  name: string
  tableCount: number
}
interface TableRead {
  sqlName: string
  displayName: string
  columns: string[]
  rows: unknown[][]
}

export const TablesView: React.FC<{ profileId: string }> = ({ profileId }) => {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const floors = useChatStore((s) => s.floors)
  const t = useT()

  const [templates, setTemplates] = React.useState<TemplateSummary[]>([])
  const [assignedId, setAssignedId] = React.useState<string | null>(null)
  const [tables, setTables] = React.useState<TableRead[]>([])

  const loadTemplates = React.useCallback(async () => {
    try {
      setTemplates((await api().listTableTemplates(profileId)) ?? [])
    } catch {
      setTemplates([])
    }
  }, [profileId])

  const loadChat = React.useCallback(async () => {
    if (!activeChatId) {
      setAssignedId(null)
      setTables([])
      return
    }
    try {
      const id = (await api().getChatTableTemplate(profileId, activeChatId)) ?? null
      setAssignedId(id)
      setTables(id ? ((await api().readChatTables(profileId, activeChatId)) ?? []) : [])
    } catch {
      setAssignedId(null)
      setTables([])
    }
  }, [profileId, activeChatId])

  React.useEffect(() => {
    void loadTemplates()
  }, [loadTemplates])

  React.useEffect(() => {
    void loadChat()
  }, [loadChat, floors.length])

  if (!activeChatId) {
    return <div style={{ opacity: 0.5 }}>{t('status.waiting')}</div>
  }

  const onAssign = async (value: string): Promise<void> => {
    const id = value === '' ? null : value
    // Both assign and unassign drop-and-recreate the sandbox — confirm the destructive step.
    const message = id ? t('tables.confirmAssign') : t('tables.confirmUnassign')
    if (!confirm(message)) {
      void loadChat() // revert the <select> to the stored value
      return
    }
    try {
      await api().setChatTableTemplate(profileId, activeChatId, id)
    } catch {
      useToastStore.getState().push(t('tables.assignFailed'))
    }
    await loadChat()
  }

  const onImport = async (): Promise<void> => {
    const result = await api().importTableTemplateDialog(profileId)
    if (result === null) return // user cancelled the file dialog
    if (result.error) {
      // Service returns either an i18n key (tables.importError*) or a verbatim parser message.
      const detail = result.error.startsWith('tables.') ? t(result.error) : result.error
      useToastStore.getState().push(`${t('tables.importFailed')}: ${detail}`)
      return
    }
    await loadTemplates()
  }

  const onDeleteTemplate = async (): Promise<void> => {
    if (!assignedId) return
    if (!confirm(t('tables.confirmDeleteTemplate'))) return
    try {
      await api().deleteTableTemplate(profileId, assignedId)
    } catch {
      useToastStore.getState().push(t('tables.deleteFailed'))
    }
    await loadTemplates()
    await loadChat()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
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
        <label style={{ fontSize: 12, opacity: 0.8 }}>{t('tables.template')}</label>
        <select
          value={assignedId ?? ''}
          onChange={(e) => void onAssign(e.target.value)}
          style={{
            fontSize: 12,
            padding: '3px 8px',
            background: 'var(--rpt-bg-tertiary)',
            color: 'var(--rpt-text-primary)',
            border: '1px solid var(--rpt-border)',
            borderRadius: 4
          }}
        >
          <option value="">{t('tables.none')}</option>
          {templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {tpl.name} ({tpl.tableCount})
            </option>
          ))}
        </select>
        <button
          className="rpt-duel-secondary"
          style={{ fontSize: 12, padding: '3px 10px' }}
          onClick={() => void onImport()}
        >
          {t('tables.import')}
        </button>
        <button
          className="rpt-duel-secondary"
          style={{ fontSize: 12, padding: '3px 10px' }}
          disabled={!assignedId}
          onClick={() => void onDeleteTemplate()}
        >
          {t('tables.deleteTemplate')}
        </button>
        <button
          className="rpt-duel-secondary"
          style={{ fontSize: 12, padding: '3px 8px', marginLeft: 'auto' }}
          onClick={() => void loadChat()}
        >
          {t('tables.refresh')}
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {!assignedId ? (
          <div style={{ opacity: 0.5, fontSize: 12 }}>
            <em>{t('tables.noneAssigned')}</em>
          </div>
        ) : tables.length === 0 ? (
          <div style={{ opacity: 0.5, fontSize: 12 }}>
            <em>{t('tables.emptyTemplate')}</em>
          </div>
        ) : (
          tables.map((tbl) => (
            <TableGrid key={tbl.sqlName} table={tbl} emptyLabel={t('tables.noRows')} />
          ))
        )}
      </div>
    </div>
  )
}

const TableGrid: React.FC<{ table: TableRead; emptyLabel: string }> = ({ table, emptyLabel }) => (
  <div style={{ marginBottom: 16 }}>
    <div
      style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, color: 'var(--rpt-text-primary)' }}
    >
      {table.displayName}{' '}
      <span style={{ opacity: 0.5, fontWeight: 400, fontSize: 11 }}>{table.sqlName}</span>
    </div>
    <div style={{ overflowX: 'auto' }}>
      <table
        style={{
          borderCollapse: 'collapse',
          fontSize: 12,
          width: '100%',
          color: 'var(--rpt-text-primary)'
        }}
      >
        <thead>
          <tr>
            {table.columns.map((col, i) => (
              <th
                key={i}
                style={{
                  border: '1px solid var(--rpt-border)',
                  padding: '3px 6px',
                  textAlign: 'left',
                  background: 'var(--rpt-bg-secondary)',
                  whiteSpace: 'nowrap'
                }}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.length === 0 ? (
            <tr>
              <td
                colSpan={Math.max(1, table.columns.length)}
                style={{
                  border: '1px solid var(--rpt-border)',
                  padding: '4px 6px',
                  opacity: 0.5,
                  fontStyle: 'italic'
                }}
              >
                {emptyLabel}
              </td>
            </tr>
          ) : (
            table.rows.map((row, r) => (
              <tr key={r}>
                {table.columns.map((_, c) => (
                  <td
                    key={c}
                    style={{
                      border: '1px solid var(--rpt-border)',
                      padding: '3px 6px',
                      verticalAlign: 'top'
                    }}
                  >
                    {row[c] == null ? '' : String(row[c])}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  </div>
)
