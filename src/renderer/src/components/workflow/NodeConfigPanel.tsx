// Schema-driven node config side panel for the node-workflow editor (Phase 4 task 5). Renders
// FROM useWorkflowEditorStore (selectedNodeId/nodes/nodeTypes/readOnly) and dispatches back via
// setNodeConfig/setMainOutput — same store-driven contract as FlowCanvas.tsx. Each control is
// derived from the node type's configSchema via schemaForm.ts's pure fieldsFromSchema walker.
import React, { useEffect, useState } from 'react'
import { useWorkflowEditorStore } from '../../stores/workflowEditorStore'
import { useOptionalT, useT } from '../../i18n'
import { fieldsFromSchema, type FieldSpec } from './schemaForm'

/** A sub-graph's promoted-parameter hint (`WorkflowDoc.meta.promotions`, plan §5) — shape
 *  mirrors `subgraphNodes.ts`'s Promotion, read off the referenced doc fetched lazily via
 *  `window.api.getWorkflow` (best-effort: summaries alone don't carry `meta`). */
interface PromotionHint {
  name: string
  label?: string
}

/** `subgraph.call`'s special-case panel section (plan §5): the referenced sub-graph's name
 *  (falling back to the raw id in a warning color when unknown), an "Open sub-graph" button,
 *  and a best-effort hint list of its promoted params (edited through the JSON `params` field
 *  below — v1 has no dedicated form UI for them). */
function SubgraphCallInfo({
  profileId,
  workflowId
}: {
  profileId: string
  workflowId: string | undefined
}): React.JSX.Element {
  const t = useT()
  const workflows = useWorkflowEditorStore((s) => s.workflows)
  const open = useWorkflowEditorStore((s) => s.open)
  const [promotions, setPromotions] = useState<PromotionHint[]>([])

  const summary = workflows.find((w) => w.id === workflowId)

  useEffect(() => {
    setPromotions([])
    if (!workflowId) return
    let cancelled = false
    void window.api
      .getWorkflow(profileId, workflowId)
      .then((doc: unknown) => {
        if (cancelled) return
        const raw = (doc as { meta?: { promotions?: unknown } } | null)?.meta?.promotions
        if (Array.isArray(raw)) {
          setPromotions(
            raw.filter(
              (p): p is PromotionHint => !!p && typeof p === 'object' && typeof p.name === 'string'
            )
          )
        }
      })
      .catch(() => {
        // best-effort — an unresolvable/deleted sub-graph just shows no promotion hints.
      })
    return () => {
      cancelled = true
    }
  }, [profileId, workflowId])

  if (!workflowId) return <div style={{ fontSize: 11, color: 'var(--rpt-warning)' }}>{t('workflowEditor.subgraphNotSet')}</div>

  return (
    <div style={{ margin: '6px 0 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            fontSize: 12,
            color: summary ? 'var(--rpt-text-primary)' : 'var(--rpt-warning)'
          }}
        >
          {summary?.name ?? workflowId}
        </span>
        <button
          type="button"
          onClick={() => void open(profileId, workflowId)}
          style={{ fontSize: 11, padding: '1px 8px' }}
        >
          {t('workflowEditor.openSubgraph')}
        </button>
      </div>
      {promotions.length > 0 && (
        <div style={{ fontSize: 10.5, color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
          {t('workflowEditor.promotionsHint')}
          <ul style={{ margin: '2px 0 0', paddingLeft: 16 }}>
            {promotions.map((p) => (
              <li key={p.name}>{p.label ? `${p.name} — ${p.label}` : p.name}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

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
  const t = useT()
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
                {t('workflowEditor.remove')}
              </button>
            </div>
          </div>
        ))}
        <button type="button" disabled={readOnly} onClick={addItem}>
          {t('workflowEditor.add')}
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
  const t = useT()
  const [text, setText] = useState(() => (value === undefined ? '' : JSON.stringify(value)))
  const [error, setError] = useState<boolean>(false)

  return (
    <div>
      <textarea
        rows={3}
        value={text}
        disabled={readOnly}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text.trim() === '') {
            setError(false)
            onChange(undefined)
            return
          }
          try {
            const parsed = JSON.parse(text)
            setError(false)
            onChange(parsed)
          } catch {
            setError(true)
          }
        }}
        style={{ width: '100%', resize: 'vertical' }}
      />
      {error && (
        <div style={{ color: 'var(--rpt-danger)', fontSize: 10.5 }}>
          {t('workflowEditor.invalidJson')}
        </div>
      )}
    </div>
  )
}

export default function NodeConfigPanel({
  profileId
}: NodeConfigPanelProps): React.JSX.Element {
  const t = useT()
  const tOpt = useOptionalT()
  const selectedNodeId = useWorkflowEditorStore((s) => s.selectedNodeId)
  const nodes = useWorkflowEditorStore((s) => s.nodes)
  const nodeTypes = useWorkflowEditorStore((s) => s.nodeTypes)
  const storeReadOnly = useWorkflowEditorStore((s) => s.readOnly)
  const lockedNodeIds = useWorkflowEditorStore((s) => s.lockedNodeIds)
  const setNodeConfig = useWorkflowEditorStore((s) => s.setNodeConfig)
  const setNodePanel = useWorkflowEditorStore((s) => s.setNodePanel)
  const setMainOutput = useWorkflowEditorStore((s) => s.setMainOutput)

  // A locked node (Effective mode's pack nodes — agent-packs plan WP3.6a; ADR 0010) is read-only even
  // when the doc is editable: pack nodes are locked this stage, with a "fork to edit" affordance
  // (fork routing is WP3.6b). Locking here mirrors the model-layer guard (lockedNodeIds) so the UI
  // can never present an edit that the store would silently drop.
  const locked = selectedNodeId != null && lockedNodeIds.has(selectedNodeId)
  const readOnly = storeReadOnly || locked

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

  // Localized title/description with the catalog's English title as the fallback; per-port
  // descriptions try the node-specific key first, then the shared `common.<port>` entry.
  const nodeTitle = tOpt(`workflowEditor.nodeTitle.${node.type}`) || typeInfo?.title || node.type
  const nodeDesc = tOpt(`workflowEditor.nodeDesc.${node.type}`)
  const portDesc = (port: string): string =>
    tOpt(`workflowEditor.portDesc.${node.type}.${port}`) ||
    tOpt(`workflowEditor.portDesc.common.${port}`)

  return (
    <div>
      <div>
        <strong>{nodeTitle}</strong>
        <div style={{ fontSize: 10.5, color: 'var(--rpt-text-tertiary)' }}>{node.type}</div>
      </div>

      {nodeDesc && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--rpt-text-secondary)',
            lineHeight: 1.55,
            margin: '6px 0'
          }}
        >
          {nodeDesc}
        </div>
      )}

      {/* Pack node lock affordance (agent-packs plan WP3.6a; ADR 0010): this node belongs to a pack;
          editing it forks the pack (WP3.6b). Config below renders READ-ONLY until then. */}
      {locked && (
        <div
          style={{
            border: '1px solid var(--rpt-agent-region-border)',
            background: 'var(--rpt-agent-region)',
            borderRadius: 8,
            padding: '8px 10px',
            margin: '6px 0'
          }}
        >
          <div style={{ fontSize: 11.5, color: 'var(--rpt-agent-region-text)', fontWeight: 600 }}>
            {t('workflowEffective.packNodeTitle')}
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--rpt-text-secondary)',
              lineHeight: 1.5,
              margin: '4px 0 8px'
            }}
          >
            {t('workflowEffective.forkToEdit')}
          </div>
          <button type="button" disabled title={t('workflowEffective.forkComing')} style={{ fontSize: 12 }}>
            {t('workflowEffective.forkButton')}
          </button>
        </div>
      )}

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

      {/* Opt-in output panel (spec D4): show this node's completed output as a collapsible
          section in the chat, labeled below. */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
        <input
          type="checkbox"
          checked={node.panel?.show === true}
          disabled={readOnly}
          onChange={(e) =>
            setNodePanel(
              node.id,
              e.target.checked ? { show: true, label: node.panel?.label } : undefined
            )
          }
        />
        {t('workflowEditor.panelShow')}
      </label>
      {node.panel?.show && (
        <div style={{ margin: '4px 0 6px' }}>
          <label style={{ fontSize: 10.5, color: 'var(--rpt-text-secondary)' }}>
            {t('workflowEditor.panelLabel')}
          </label>
          <input
            type="text"
            value={node.panel.label ?? ''}
            disabled={readOnly}
            placeholder={t('workflowEditor.panelLabelPh')}
            onChange={(e) =>
              setNodePanel(node.id, { show: true, label: e.target.value || undefined })
            }
            style={{ width: '100%' }}
          />
        </div>
      )}

      {node.type === 'subgraph.call' && (
        <SubgraphCallInfo
          profileId={profileId}
          workflowId={typeof config.workflow_id === 'string' ? config.workflow_id : undefined}
        />
      )}

      <div>
        <div style={{ fontSize: 10.5, color: 'var(--rpt-text-tertiary)' }}>
          {t('workflowEditor.config')}
        </div>
        {fields.map((field) => (
          // Keyed by node id + field so switching between two nodes of the SAME type remounts the
          // controls — JsonFieldControl holds local text state that must never leak across nodes.
          <div key={`${node.id}:${field.key}`} style={{ marginBottom: 8 }}>
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
          <div key={`in-${port.name}`} style={{ fontSize: 10.5, marginBottom: 3 }}>
            <span style={{ color: 'var(--rpt-text-primary)' }}>
              → {port.name} <span style={{ color: 'var(--rpt-text-tertiary)' }}>({port.type})</span>
            </span>
            {portDesc(port.name) && (
              <div style={{ color: 'var(--rpt-text-secondary)', paddingLeft: 14 }}>
                {portDesc(port.name)}
              </div>
            )}
          </div>
        ))}
        {(typeInfo?.outputs ?? []).map((port) => (
          <div key={`out-${port.name}`} style={{ fontSize: 10.5, marginBottom: 3 }}>
            <span style={{ color: 'var(--rpt-text-primary)' }}>
              {port.name} → <span style={{ color: 'var(--rpt-text-tertiary)' }}>({port.type})</span>
            </span>
            {portDesc(port.name) && (
              <div style={{ color: 'var(--rpt-text-secondary)', paddingLeft: 14 }}>
                {portDesc(port.name)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
