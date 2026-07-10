import React, { useCallback, useEffect, useState } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useT } from '../../i18n'
import './workflowEditor.css'

// The memory.maintain node's Prompt-tab extension (memory.maintain plan, WP2): under the scaffold
// prompt editor, it surfaces the REAL brain of a memory system — each bound table's per-operation
// maintenance rules — and edits them back into the TEMPLATE FILE (table-template-update), so every chat
// using the template sees the change. A composed-prompt preview shows exactly what a run would send.
//
// Binding is per-chat: we resolve the active chat's template, name it, and warn that edits are shared.

/** The editable per-table fields (mirrors TableDefPatchSchema — structural DDL/sqlName excluded). */
const OP_FIELDS = ['note', 'initNode', 'insertNode', 'updateNode', 'deleteNode'] as const
type OpField = (typeof OP_FIELDS)[number]

interface TableDefLike {
  uid: string
  sqlName: string
  displayName: string
  note: string
  initNode: string
  insertNode: string
  updateNode: string
  deleteNode: string
  updateFrequency: number
}
interface TemplateLike {
  name: string
  tables: TableDefLike[]
}

interface PreviewMessage {
  role: string
  content: string
}

export default function MemoryMaintainPanel({
  profileId,
  config
}: {
  profileId: string
  /** The node's current config — passed to the preview so it matches what a run would send. */
  config: Record<string, unknown>
}): React.JSX.Element {
  const t = useT()
  const activeChatId = useChatStore((s) => s.activeChatId)

  const [templateId, setTemplateId] = useState<string | null>(null)
  const [template, setTemplate] = useState<TemplateLike | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Resolve the active chat's bound template, then load it. Re-run on chat switch.
  useEffect(() => {
    let cancelled = false
    if (!activeChatId) {
      setTemplate(null)
      setTemplateId(null)
      setLoading(false)
      return
    }
    setLoading(true)
    void (async () => {
      const id = await window.api.getChatTableTemplate(profileId, activeChatId)
      if (cancelled) return
      setTemplateId(id)
      if (!id) {
        setTemplate(null)
        setLoading(false)
        return
      }
      const tpl = (await window.api.getTableTemplate(profileId, id)) as TemplateLike | null
      if (cancelled) return
      setTemplate(tpl)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [profileId, activeChatId])

  const toggle = (uid: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(uid)) next.delete(uid)
      else next.add(uid)
      return next
    })

  // Optimistic local edit; persist the single field on blur (prompt edits are chunky, not keystroke).
  const editLocal = (uid: string, field: OpField, value: string): void =>
    setTemplate((prev) =>
      prev
        ? { ...prev, tables: prev.tables.map((t) => (t.uid === uid ? { ...t, [field]: value } : t)) }
        : prev
    )

  const persist = useCallback(
    (uid: string, field: OpField, value: string): void => {
      if (!templateId) return
      void window.api.updateTableTemplate(profileId, templateId, { tables: [{ uid, [field]: value }] })
    },
    [profileId, templateId]
  )

  if (loading) {
    return <div className="rpt-mm-note">{t('workflowEditor.memoryMaintain.loading')}</div>
  }
  if (!activeChatId) {
    return <div className="rpt-mm-note">{t('workflowEditor.memoryMaintain.noChat')}</div>
  }
  if (!templateId || !template) {
    return <div className="rpt-mm-note">{t('workflowEditor.memoryMaintain.noTemplate')}</div>
  }

  return (
    <div className="rpt-mm">
      <div className="rpt-mm-banner">
        <span className="rpt-mm-banner-label">{t('workflowEditor.memoryMaintain.editingTemplate')}</span>
        <span className="rpt-mm-banner-name" title={template.name}>
          {template.name}
        </span>
        <div className="rpt-mm-banner-caveat">{t('workflowEditor.memoryMaintain.sharedCaveat')}</div>
      </div>

      <div className="rpt-mm-section-title">{t('workflowEditor.memoryMaintain.tablesTitle')}</div>
      {template.tables.length === 0 && (
        <div className="rpt-mm-note">{t('workflowEditor.memoryMaintain.noTables')}</div>
      )}
      {template.tables.map((tbl) => {
        const open = expanded.has(tbl.uid)
        return (
          <div key={tbl.uid} className="rpt-mm-table">
            <button
              type="button"
              className="rpt-mm-table-head"
              aria-expanded={open}
              onClick={() => toggle(tbl.uid)}
            >
              <span className="rpt-mm-caret" aria-hidden>
                {open ? '▾' : '▸'}
              </span>
              <span className="rpt-mm-table-name">{tbl.displayName || tbl.sqlName}</span>
              <code className="rpt-mm-table-sql">{tbl.sqlName}</code>
            </button>
            {open && (
              <div className="rpt-mm-table-body">
                {OP_FIELDS.map((field) => (
                  <label key={field} className="rpt-mm-field">
                    <span className="rpt-mm-field-label">
                      {t(`workflowEditor.memoryMaintain.op.${field}`)}
                    </span>
                    <textarea
                      className="rpt-mm-textarea"
                      value={tbl[field] ?? ''}
                      rows={field === 'note' ? 3 : 2}
                      placeholder={t('workflowEditor.memoryMaintain.opPlaceholder')}
                      onChange={(e) => editLocal(tbl.uid, field, e.target.value)}
                      onBlur={(e) => persist(tbl.uid, field, e.target.value)}
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
        )
      })}

      <MemoryPreview profileId={profileId} config={config} />
    </div>
  )
}

/** The "what a run would send" preview: composes the maintainer prompt for the active chat via the
 *  same core the node uses (memory-maintain-preview IPC). Mirrors AssemblePreview's on-demand shape.
 *  Exported so the Memory-Manager Maintenance tab (WP2) reuses it — passing a bare `{ lastNFloors }`
 *  override there makes the handler resolve the chat's effective memory.maintain config. */
export function MemoryPreview({
  profileId,
  config
}: {
  profileId: string
  config: Record<string, unknown>
}): React.JSX.Element | null {
  const t = useT()
  const activeChatId = useChatStore((s) => s.activeChatId)
  const [messages, setMessages] = useState<PreviewMessage[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!activeChatId) return null

  const run = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const res = await window.api.previewMemoryMaintain(profileId, activeChatId, config)
      if (res.error || !res.messages) {
        setError(res.error === 'no-template' ? t('workflowEditor.memoryMaintain.noTemplate') : t('workflowEditor.memoryMaintain.previewError'))
        setMessages(null)
      } else {
        setMessages(res.messages)
      }
    } catch {
      setError(t('workflowEditor.memoryMaintain.previewError'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rpt-mm-preview">
      <div className="rpt-mm-section-title">{t('workflowEditor.memoryMaintain.previewTitle')}</div>
      <button type="button" className="rpt-mm-preview-btn" onClick={() => void run()} disabled={loading}>
        {loading ? t('workflowEditor.memoryMaintain.previewLoading') : t('workflowEditor.memoryMaintain.previewButton')}
      </button>
      {error && <div className="rpt-mm-error">{error}</div>}
      {messages &&
        messages.map((m, i) => (
          <div key={i} className="rpt-mm-preview-msg">
            <span className="rpt-mm-preview-role">{m.role}</span>
            <pre className="rpt-assemble-preview-text">{m.content}</pre>
          </div>
        ))}
    </div>
  )
}
