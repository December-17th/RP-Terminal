// The prompt editor (agent & memory UX WP-E; spec §6 Prompt tab): a real editor replacing the generic
// objectArray control for a node's authored prompt field(s). A role-message array field (agent.llm's
// `messages`) renders as reorderable role-chip rows with auto-growing monospace textareas; a plain
// string field (text.template's `template`) renders as one textarea. Both get insertable placeholder
// chips. Writes back through the SAME store path the schema form uses (setNodeConfig) — one write path,
// no drift. All row/reorder/placeholder logic is the pure detailsPanelModel; this file is only the view.
import React from 'react'
import { useT } from '../../i18n'
import {
  PROMPT_ROLES,
  addRow,
  insertAtCaret,
  moveRow,
  normalizeRows,
  placeholdersForType,
  removeRow,
  setContent,
  setRole,
  type PromptRow
} from './detailsPanelModel'

/** A prompt field to edit: its config key + whether it holds a role-message array (vs a plain string). */
export interface PromptFieldSpec {
  key: string
  isArray: boolean
}

export default function PromptEditor({
  fields,
  config,
  readOnly,
  onChange,
  nodeType
}: {
  fields: PromptFieldSpec[]
  config: Record<string, unknown>
  readOnly: boolean
  /** Write the whole new value for `field` back into the node config (parent calls setNodeConfig). */
  onChange: (field: string, value: unknown) => void
  /** The edited node's `type` — selects its per-node-type placeholder chips (D2). Omitted → generic set. */
  nodeType?: string
}): React.JSX.Element {
  const t = useT()
  // The placeholder chips this node's prompt slots actually fill (per-node-type; generic fallback).
  const placeholders = placeholdersForType(nodeType)
  // The textarea that last held focus (for placeholder-chip insertion at the caret).
  const activeEl = React.useRef<HTMLTextAreaElement | null>(null)
  const activeKey = React.useRef<string | null>(null)

  return (
    <div className="rpt-prompt-editor">
      {fields.map((field) => {
        const raw = config[field.key]
        if (field.isArray) {
          const rows = normalizeRows(raw)
          const write = (next: PromptRow[]): void => onChange(field.key, next)
          return (
            <PromptArrayField
              key={field.key}
              fieldKey={field.key}
              rows={rows}
              readOnly={readOnly}
              write={write}
              activeEl={activeEl}
              activeKey={activeKey}
              placeholders={placeholders}
            />
          )
        }
        // Plain string field.
        const text = typeof raw === 'string' ? raw : ''
        const areaKey = `${field.key}#str`
        return (
          <div key={field.key} className="rpt-prompt-field">
            <div className="rpt-prompt-field-label">{field.key}</div>
            <AutoTextarea
              value={text}
              readOnly={readOnly}
              onFocusEl={(el) => {
                activeEl.current = el
                activeKey.current = areaKey
              }}
              onChange={(v) => onChange(field.key, v)}
            />
            <PlaceholderChips
              readOnly={readOnly}
              placeholders={placeholders}
              onInsert={(chip) => {
                const el = activeEl.current
                const caret = el && activeKey.current === areaKey ? el.selectionStart : null
                onChange(field.key, insertAtCaret(text, chip, caret))
              }}
              label={t('workflowEditor.prompt.insert')}
            />
          </div>
        )
      })}
    </div>
  )
}

/** One role-message array field: reorderable role-chip rows. */
function PromptArrayField({
  fieldKey,
  rows,
  readOnly,
  write,
  activeEl,
  activeKey,
  placeholders
}: {
  fieldKey: string
  rows: PromptRow[]
  readOnly: boolean
  write: (next: PromptRow[]) => void
  activeEl: React.MutableRefObject<HTMLTextAreaElement | null>
  activeKey: React.MutableRefObject<string | null>
  placeholders: readonly string[]
}): React.JSX.Element {
  const t = useT()
  const dragFrom = React.useRef<number | null>(null)

  return (
    <div className="rpt-prompt-field">
      <div className="rpt-prompt-field-label">{fieldKey}</div>
      {rows.map((row, index) => {
        const areaKey = `${fieldKey}#${index}`
        return (
          <div
            key={index}
            className="rpt-prompt-row"
            draggable={!readOnly}
            onDragStart={() => {
              dragFrom.current = index
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              const from = dragFrom.current
              dragFrom.current = null
              if (from != null && from !== index) write(moveRow(rows, from, index))
            }}
          >
            <div className="rpt-prompt-row-head">
              <span className="rpt-prompt-drag" aria-hidden title={t('workflowEditor.prompt.reorder')}>
                ⠿
              </span>
              <select
                className="rpt-prompt-role"
                value={PROMPT_ROLES.includes(row.role as never) ? row.role : PROMPT_ROLES[0]}
                disabled={readOnly}
                aria-label={t('workflowEditor.prompt.role')}
                onChange={(e) => write(setRole(rows, index, e.target.value))}
              >
                {PROMPT_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(`workflowEditor.prompt.role.${r}`)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="rpt-prompt-row-remove"
                disabled={readOnly}
                title={t('workflowEditor.remove')}
                onClick={() => write(removeRow(rows, index))}
              >
                ✕
              </button>
            </div>
            <AutoTextarea
              value={row.content}
              readOnly={readOnly}
              onFocusEl={(el) => {
                activeEl.current = el
                activeKey.current = areaKey
              }}
              onChange={(v) => write(setContent(rows, index, v))}
            />
            <PlaceholderChips
              readOnly={readOnly}
              placeholders={placeholders}
              onInsert={(chip) => {
                const el = activeEl.current
                const caret = el && activeKey.current === areaKey ? el.selectionStart : null
                write(setContent(rows, index, insertAtCaret(row.content, chip, caret)))
              }}
              label={t('workflowEditor.prompt.insert')}
            />
          </div>
        )
      })}
      <button
        type="button"
        className="rpt-prompt-add"
        disabled={readOnly}
        onClick={() => write(addRow(rows))}
      >
        {t('workflowEditor.prompt.addRow')}
      </button>
    </div>
  )
}

/** Auto-growing monospace textarea. */
function AutoTextarea({
  value,
  readOnly,
  onChange,
  onFocusEl
}: {
  value: string
  readOnly: boolean
  onChange: (v: string) => void
  onFocusEl: (el: HTMLTextAreaElement) => void
}): React.JSX.Element {
  const ref = React.useRef<HTMLTextAreaElement | null>(null)
  const resize = (el: HTMLTextAreaElement | null): void => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }
  React.useEffect(() => {
    resize(ref.current)
  }, [value])
  return (
    <textarea
      ref={ref}
      className="rpt-prompt-textarea"
      value={value}
      disabled={readOnly}
      rows={2}
      onFocus={(e) => onFocusEl(e.currentTarget)}
      onChange={(e) => {
        onChange(e.target.value)
        resize(e.currentTarget)
      }}
    />
  )
}

/** The insertable placeholder chips (spec §6). */
function PlaceholderChips({
  readOnly,
  onInsert,
  label,
  placeholders
}: {
  readOnly: boolean
  onInsert: (chip: string) => void
  label: string
  placeholders: readonly string[]
}): React.JSX.Element {
  return (
    <div className="rpt-prompt-chips">
      <span className="rpt-prompt-chips-label">{label}</span>
      {placeholders.map((chip) => (
        <button
          key={chip}
          type="button"
          className="rpt-prompt-chip"
          disabled={readOnly}
          // preventDefault on mousedown so clicking a chip doesn't blur the textarea before we read its caret.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onInsert(chip)}
        >
          {chip}
        </button>
      ))}
    </div>
  )
}
