// Schema-driven node config side panel for the node-workflow editor (Phase 4 task 5). Renders
// FROM useWorkflowEditorStore (selectedNodeId/nodes/nodeTypes/readOnly) and dispatches back via
// setNodeConfig/setMainOutput — same store-driven contract as FlowCanvas.tsx. Each control is
// derived from the node type's configSchema via schemaForm.ts's pure fieldsFromSchema walker.
import React, { useState } from 'react'
import { useWorkflowEditorStore } from '../../stores/workflowEditorStore'
import { useT } from '../../i18n'
import { fieldsFromSchema, type FieldSpec } from './schemaForm'

interface NodeConfigPanelProps {
  profileId: string
}

/** Renders one control for `field`, bound to `config[field.key]`, writing the FULL updated
 *  config object back via `onChange` on every edit (setNodeConfig always takes the whole
 *  object — there is no per-key patch action). */
function FieldControl({
  field,
  value,
  onChange,
  readOnly
}: {
  field: FieldSpec
  value: unknown
  onChange: (value: unknown) => void
  readOnly: boolean
}): React.JSX.Element {
  if (field.kind === 'string') {
    return (
      <textarea
        rows={3}
        value={typeof value === 'string' ? value : ''}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: '100%', resize: 'vertical' }}
      />
    )
  }

  if (field.kind === 'number') {
    return (
      <input
        type="number"
        value={typeof value === 'number' ? value : ''}
        disabled={readOnly}
        onChange={(e) => {
          if (e.target.value === '') {
            onChange(undefined)
            return
          }
          const n = Number(e.target.value)
          onChange(Number.isNaN(n) ? undefined : n)
        }}
        style={{ width: '100%' }}
      />
    )
  }

  if (field.kind === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={value === true}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.checked)}
      />
    )
  }

  if (field.kind === 'enum') {
    return (
      <select
        value={typeof value === 'string' ? value : ''}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        style={{ width: '100%' }}
      >
        {!field.required && <option value="">--</option>}
        {field.options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    )
  }

  if (field.kind === 'objectArray') {
    const items = Array.isArray(value) ? (value as Record<string, unknown>[]) : []

    const updateItem = (index: number, itemValue: Record<string, unknown>): void => {
      const next = items.slice()
      next[index] = itemValue
      onChange(next)
    }
    const addItem = (): void => {
      onChange([...items, {}])
    }
    const removeItem = (index: number): void => {
      onChange(items.filter((_, i) => i !== index))
    }
    const moveItem = (index: number, delta: number): void => {
      const target = index + delta
      if (target < 0 || target >= items.length) return
      const next = items.slice()
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      onChange(next)
    }

    return (
      <div>
        {items.map((item, index) => (
          <div
            key={index}
            style={{
              border: '1px solid var(--rpt-border)',
              borderRadius: 6,
              padding: 6,
              marginBottom: 6
            }}
          >
            {field.itemFields.map((itemField) => (
              <div key={itemField.key} style={{ marginBottom: 4 }}>
                <label style={{ fontSize: 10.5, color: 'var(--rpt-text-secondary)' }}>
                  {itemField.key}
                </label>
                <FieldControl
                  field={itemField}
                  value={item[itemField.key]}
                  onChange={(v) => {
                    const nextItem = { ...item }
                    if (v === undefined) delete nextItem[itemField.key]
                    else nextItem[itemField.key] = v
                    updateItem(index, nextItem)
                  }}
                  readOnly={readOnly}
                />
              </div>
            ))}
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                type="button"
                disabled={readOnly || index === 0}
                onClick={() => moveItem(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                disabled={readOnly || index === items.length - 1}
                onClick={() => moveItem(index, 1)}
              >
                ↓
              </button>
              <button type="button" disabled={readOnly} onClick={() => removeItem(index)}>
                remove
              </button>
            </div>
          </div>
        ))}
        <button type="button" disabled={readOnly} onClick={addItem}>
          add
        </button>
      </div>
    )
  }

  // json fallback: freeform textarea, parsed on blur, keeping the last valid value on error.
  return <JsonFieldControl value={value} onChange={onChange} readOnly={readOnly} />
}

function JsonFieldControl({
  value,
  onChange,
  readOnly
}: {
  value: unknown
  onChange: (value: unknown) => void
  readOnly: boolean
}): React.JSX.Element {
  const [text, setText] = useState(() => (value === undefined ? '' : JSON.stringify(value)))
  const [error, setError] = useState<string | null>(null)

  return (
    <div>
      <textarea
        rows={3}
        value={text}
        disabled={readOnly}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text.trim() === '') {
            setError(null)
            onChange(undefined)
            return
          }
          try {
            const parsed = JSON.parse(text)
            setError(null)
            onChange(parsed)
          } catch {
            setError('Invalid JSON')
          }
        }}
        style={{ width: '100%', resize: 'vertical' }}
      />
      {error && <div style={{ color: 'var(--rpt-danger)', fontSize: 10.5 }}>{error}</div>}
    </div>
  )
}

export default function NodeConfigPanel({
  profileId: _profileId
}: NodeConfigPanelProps): React.JSX.Element {
  const t = useT()
  const selectedNodeId = useWorkflowEditorStore((s) => s.selectedNodeId)
  const nodes = useWorkflowEditorStore((s) => s.nodes)
  const nodeTypes = useWorkflowEditorStore((s) => s.nodeTypes)
  const readOnly = useWorkflowEditorStore((s) => s.readOnly)
  const setNodeConfig = useWorkflowEditorStore((s) => s.setNodeConfig)
  const setMainOutput = useWorkflowEditorStore((s) => s.setMainOutput)

  const node = nodes.find((n) => n.id === selectedNodeId)

  if (!node) {
    return <div>{t('workflowEditor.noSelection')}</div>
  }

  const typeInfo = nodeTypes.find((nt) => nt.type === node.type)
  const config = node.config ?? {}
  const fields = fieldsFromSchema(typeInfo?.configSchema)

  const updateField = (key: string, value: unknown): void => {
    const next = { ...config }
    if (value === undefined) delete next[key]
    else next[key] = value
    setNodeConfig(node.id, next)
  }

  return (
    <div>
      <div>
        <strong>{typeInfo?.title ?? node.type}</strong>
        <div style={{ fontSize: 10.5, color: 'var(--rpt-text-tertiary)' }}>{node.type}</div>
      </div>

      {typeInfo?.isMainOutputCapable && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="checkbox"
            checked={node.isMainOutput === true}
            disabled={readOnly}
            onChange={() => setMainOutput(node.id)}
          />
          {t('workflowEditor.mainOutput')}
        </label>
      )}

      <div>
        <div style={{ fontSize: 10.5, color: 'var(--rpt-text-tertiary)' }}>
          {t('workflowEditor.config')}
        </div>
        {fields.map((field) => (
          <div key={field.key} style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 10.5, color: 'var(--rpt-text-secondary)' }}>
              {field.key}
              {field.required ? ' *' : ''}
            </label>
            <FieldControl
              field={field}
              value={config[field.key]}
              onChange={(v) => updateField(field.key, v)}
              readOnly={readOnly}
            />
          </div>
        ))}
      </div>

      <div>
        <div style={{ fontSize: 10.5, color: 'var(--rpt-text-tertiary)' }}>
          {t('workflowEditor.ports')}
        </div>
        {(typeInfo?.inputs ?? []).map((port) => (
          <div key={`in-${port.name}`} style={{ fontSize: 10.5 }}>
            in: {port.name} ({port.type})
          </div>
        ))}
        {(typeInfo?.outputs ?? []).map((port) => (
          <div key={`out-${port.name}`} style={{ fontSize: 10.5 }}>
            out: {port.name} ({port.type})
          </div>
        ))}
      </div>
    </div>
  )
}
