// Schema-driven node config side panel for the node-workflow editor (Phase 4 task 5). Renders
// FROM useWorkflowEditorStore (selectedNodeId/nodes/nodeTypes/readOnly) and dispatches back via
// setNodeConfig/setMainOutput — same store-driven contract as FlowCanvas.tsx. Each control is
// derived from the node type's configSchema via schemaForm.ts's pure fieldsFromSchema walker.
import React, { useEffect, useState } from 'react'
import { useWorkflowEditorStore } from '../../stores/workflowEditorStore'
import { useEffectiveGraphStore } from '../../stores/effectiveGraphStore'
import { useUiStore } from '../../stores/uiStore'
import { useOptionalT, useT } from '../../i18n'
import { useChatStore } from '../../stores/chatStore'
import { fieldsFromSchema, type FieldSpec } from './schemaForm'
import { ownerOfNodeId, nodeOwnerMap, readComposition } from './effectiveProjection'
import { groupOfNode } from './groupModel'
import {
  tokenTotal,
  sectionLabelKey,
  sourceChip,
  type NextPromptPreviewData,
  type PreviewSectionData
} from '../workspace/previewDisplay'
import { getPath } from '../../../../shared/objectPath'
import type { EditorNode } from './editorModel'
import type { GroupDecl } from '../../../../shared/workflow/types'

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

/** One row of a module's exposed settings (WP6.3): an inline-editable label + the live control for
 *  the member's config at that path, plus a remove (unexpose) button. Reuses schemaForm's field
 *  renderer (FieldControl) when the path resolves to a top-level schema field; otherwise a plain
 *  text input. Nested paths beyond top-level schema fields are not exposable in v1 (the store only
 *  ever writes fieldKey paths), so the resolution here is by top-level key. */
function ExposedSettingRow({
  entry,
  nodes,
  nodeTypes,
  readOnly,
  onRelabel,
  onRemove,
  onWrite
}: {
  entry: { node: string; path: string; label: string }
  nodes: EditorNode[]
  nodeTypes: { type: string; configSchema?: Record<string, unknown> }[]
  readOnly: boolean
  onRelabel: (label: string) => void
  onRemove: () => void
  onWrite: (nodeId: string, config: Record<string, unknown>) => void
}): React.JSX.Element {
  const t = useT()
  const member = nodes.find((n) => n.id === entry.node)
  const typeInfo = member ? nodeTypes.find((nt) => nt.type === member.type) : undefined
  const fields = fieldsFromSchema(typeInfo?.configSchema)
  const field = fields.find((f) => f.key === entry.path)
  const config = member?.config ?? {}
  // A stale path (field renamed/removed) resolves to undefined and renders as an empty control —
  // the documented skip-with-log stance; we never crash on it.
  const value = getPath(config, entry.path)

  const write = (v: unknown): void => {
    if (!member) return
    const next = { ...config }
    if (v === undefined) delete next[entry.path]
    else next[entry.path] = v
    onWrite(member.id, next)
  }

  return (
    <div
      style={{
        border: '1px solid var(--rpt-border)',
        borderRadius: 6,
        padding: 6,
        marginBottom: 6
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <input
          type="text"
          value={entry.label}
          disabled={readOnly}
          onChange={(e) => onRelabel(e.target.value)}
          style={{ flex: 1, fontSize: 11.5 }}
        />
        <button
          type="button"
          disabled={readOnly}
          title={t('workflowEditor.module.exposedRemove')}
          onClick={onRemove}
          style={{ fontSize: 11 }}
        >
          ✕
        </button>
      </div>
      <div style={{ fontSize: 10, color: 'var(--rpt-text-tertiary)' }}>
        {entry.node}.{entry.path}
      </div>
      {field ? (
        <FieldControl
          field={field}
          value={value}
          onChange={write}
          readOnly={readOnly || !member}
        />
      ) : (
        <input
          type="text"
          value={typeof value === 'string' ? value : value === undefined ? '' : String(value)}
          disabled={readOnly || !member}
          onChange={(e) => write(e.target.value === '' ? undefined : e.target.value)}
          style={{ width: '100%' }}
        />
      )}
    </div>
  )
}

/** The MODULE panel (WP6.3), shown when a group is selected: editable name, collapse toggle,
 *  Ungroup, and the exposed-settings list. */
function ModulePanel({ group }: { group: GroupDecl }): React.JSX.Element {
  const t = useT()
  const nodes = useWorkflowEditorStore((s) => s.nodes)
  const nodeTypes = useWorkflowEditorStore((s) => s.nodeTypes)
  const readOnly = useWorkflowEditorStore((s) => s.readOnly)
  const renameGroup = useWorkflowEditorStore((s) => s.renameGroup)
  const toggleGroupCollapsed = useWorkflowEditorStore((s) => s.toggleGroupCollapsed)
  const ungroup = useWorkflowEditorStore((s) => s.ungroup)
  const exposeSetting = useWorkflowEditorStore((s) => s.exposeSetting)
  const unexposeSetting = useWorkflowEditorStore((s) => s.unexposeSetting)
  const setNodeConfig = useWorkflowEditorStore((s) => s.setNodeConfig)

  const exposed = group.exposed ?? []

  return (
    <div>
      <div>
        <strong>{t('workflowEditor.module.title')}</strong>
      </div>
      <div style={{ margin: '8px 0' }}>
        <input
          type="text"
          value={group.name}
          disabled={readOnly}
          placeholder={t('workflowEditor.module.namePh')}
          onChange={(e) => renameGroup(group.id, e.target.value)}
          style={{ width: '100%', fontSize: 12.5 }}
        />
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <button
          type="button"
          disabled={readOnly}
          onClick={() => toggleGroupCollapsed(group.id)}
          style={{ fontSize: 12 }}
        >
          {group.collapsed
            ? t('workflowEditor.module.expand')
            : t('workflowEditor.module.collapse')}
        </button>
        <button
          type="button"
          disabled={readOnly}
          onClick={() => ungroup(group.id)}
          style={{ fontSize: 12 }}
        >
          {t('workflowEditor.module.ungroup')}
        </button>
      </div>

      <div style={{ fontSize: 10.5, color: 'var(--rpt-text-tertiary)', marginBottom: 6 }}>
        {t('workflowEditor.module.exposedTitle')}
      </div>
      {exposed.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--rpt-text-secondary)' }}>
          {t('workflowEditor.module.exposedEmpty')}
        </div>
      ) : (
        exposed.map((entry) => (
          <ExposedSettingRow
            key={`${entry.node}:${entry.path}`}
            entry={entry}
            nodes={nodes}
            nodeTypes={nodeTypes}
            readOnly={readOnly}
            onRelabel={(label) => exposeSetting(group.id, { ...entry, label })}
            onRemove={() => unexposeSetting(group.id, entry.node, entry.path)}
            onWrite={(nodeId, config) => setNodeConfig(nodeId, config)}
          />
        ))
      )}
    </div>
  )
}

/** One preview section row (WP6.4a): source chip + est. tokens + expandable text. Reuses the pure
 *  previewDisplay.ts helpers (sourceChip / sectionLabelKey) so the labels match the Agents Preview pane. */
function PreviewSectionRow({ section }: { section: PreviewSectionData }): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const chip = sourceChip(section.source)
  return (
    <div className="rpt-assemble-preview-section">
      <div className="rpt-assemble-preview-section-head">
        <span className="rpt-assemble-preview-label">{t(sectionLabelKey(section.id))}</span>
        <span className="rpt-assemble-preview-chip">
          {chip.isPack ? chip.name : t(chip.labelKey)}
        </span>
        <span className="rpt-assemble-preview-tokens">
          {section.estimated ? `~${section.tokens}` : section.tokens}
        </span>
        <button
          type="button"
          className="rpt-assemble-preview-expand"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? t('preview.collapse') : t('preview.expand')}
        </button>
      </div>
      {open && <pre className="rpt-assemble-preview-text">{section.text}</pre>}
    </div>
  )
}

/** Part E (WP6.4a): the "Preview next prompt" section shown on a `prompt.assemble` node when a chat is
 *  active. Button → previewNextPrompt IPC → a compact per-section list (label, source chip, est. tokens,
 *  expandable text) reusing the previewDisplay.ts helpers. Loading/error inline. Hidden with no chat. */
function AssemblePreview({ profileId }: { profileId: string }): React.JSX.Element | null {
  const t = useT()
  const activeChatId = useChatStore((s) => s.activeChatId)
  const [data, setData] = useState<NextPromptPreviewData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  if (!activeChatId) return null

  const run = async (): Promise<void> => {
    setLoading(true)
    setError(false)
    try {
      const p = (await window.api.previewNextPrompt(profileId, activeChatId, '')) as NextPromptPreviewData
      if (p.error) {
        setError(true)
        setData(null)
      } else {
        setData(p)
      }
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  const total = data ? tokenTotal(data.sections) : null

  return (
    <div className="rpt-assemble-preview">
      <div style={{ fontSize: 10.5, color: 'var(--rpt-text-tertiary)', marginBottom: 4 }}>
        {t('workflowEditor.assemblePreview.title')}
      </div>
      <button type="button" onClick={() => void run()} disabled={loading} style={{ fontSize: 12 }}>
        {loading ? t('workflowEditor.assemblePreview.loading') : t('workflowEditor.assemblePreview.button')}
      </button>
      {error && (
        <div style={{ color: 'var(--rpt-danger)', fontSize: 10.5, marginTop: 4 }}>
          {t('workflowEditor.assemblePreview.error')}
        </div>
      )}
      {data && total && (
        <>
          <div style={{ fontSize: 10.5, color: 'var(--rpt-text-secondary)', margin: '6px 0 4px' }}>
            {total.estimated
              ? t('preview.totalTokensEst', { n: total.total })
              : t('preview.totalTokens', { n: total.total })}
          </div>
          {data.sections.map((s) => (
            <PreviewSectionRow key={s.id} section={s} />
          ))}
        </>
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
  const selectedGroupId = useWorkflowEditorStore((s) => s.selectedGroupId)
  const doc = useWorkflowEditorStore((s) => s.doc)
  const nodes = useWorkflowEditorStore((s) => s.nodes)
  const nodeTypes = useWorkflowEditorStore((s) => s.nodeTypes)
  const storeReadOnly = useWorkflowEditorStore((s) => s.readOnly)
  const sessionType = useWorkflowEditorStore((s) => s.sessionType)
  const lockedNodeIds = useWorkflowEditorStore((s) => s.lockedNodeIds)
  const setNodeConfig = useWorkflowEditorStore((s) => s.setNodeConfig)
  const setNodePanel = useWorkflowEditorStore((s) => s.setNodePanel)
  const setNodeDisabled = useWorkflowEditorStore((s) => s.setNodeDisabled)
  const setMainOutput = useWorkflowEditorStore((s) => s.setMainOutput)
  const exposeSetting = useWorkflowEditorStore((s) => s.exposeSetting)
  const unexposeSetting = useWorkflowEditorStore((s) => s.unexposeSetting)

  const groups = doc?.groups ?? []
  // A group is selected → render the MODULE panel instead of a node panel (selection is mutually
  // exclusive, so selectedNodeId is null here).
  const selectedGroup = selectedGroupId ? groups.find((g) => g.id === selectedGroupId) : undefined
  if (selectedGroup) return <ModulePanel group={selectedGroup} />

  // A locked node is a PACK node in Effective mode (agent-packs plan WP3.6a; ADR 0010). WP3.6b makes
  // pack-node config LIVE: editing routes through fork-on-first-edit / write-through (ADR 0006), so a
  // locked pack node is NOT read-only for config — the store's setNodeConfig/removeNode/etc. route the
  // edit to the fork instead of mutating the draft. It stays read-only ONLY when the doc itself is
  // read-only (the builtin narrator) or the pack node is a DETACHED (trigger-only) placeholder — those
  // stay non-editable this WP (attachment/trigger wiring is manifest surgery; tooltip explains).
  const isPackNode = selectedNodeId != null && lockedNodeIds.has(selectedNodeId)
  const effDoc = useEffectiveGraphStore((s) => s.doc)
  const effPacks = useEffectiveGraphStore((s) => s.packs)
  const forkedPacks = useEffectiveGraphStore((s) => s.forkedPacks)
  const forkPackExplicit = useEffectiveGraphStore((s) => s.forkPackExplicit)
  const openWorkflowEditor = useUiStore((s) => s.openWorkflowEditor)

  // Resolve this pack node's owner + whether it is detached (trigger-only) and whether its pack is
  // already forked this world/session (→ write-through, no re-fork; the panel messaging differs).
  const ownerPackId = React.useMemo(() => {
    if (!isPackNode || selectedNodeId == null) return null
    const owners = nodeOwnerMap(effDoc ? readComposition(effDoc) : undefined)
    const mapped = owners.get(selectedNodeId)
    if (mapped) return mapped
    const parsed = ownerOfNodeId(selectedNodeId)
    return parsed.kind === 'pack' ? parsed.packId : null
  }, [isPackNode, selectedNodeId, effDoc])
  const packDetached = React.useMemo(
    () => (ownerPackId ? (effPacks.find((p) => p.packId === ownerPackId)?.triggerOnly ?? false) : false),
    [ownerPackId, effPacks]
  )
  const alreadyForked = ownerPackId != null && forkedPacks[ownerPackId] != null

  // Detached (trigger-only) placeholder pack nodes stay non-editable this WP (their wiring is
  // manifest-level). Everything else on a pack node is now editable (routes through the fork).
  const packNonEditable = isPackNode && packDetached
  const readOnly = storeReadOnly || packNonEditable

  const node = nodes.find((n) => n.id === selectedNodeId)

  if (!node) {
    return <div>{t('workflowEditor.noSelection')}</div>
  }

  const typeInfo = nodeTypes.find((nt) => nt.type === node.type)
  const config = node.config ?? {}
  const fields = fieldsFromSchema(typeInfo?.configSchema)

  // WP6.3: if this node belongs to a group, each config field can be EXPOSED on the group's module
  // panel. The toggle mirrors whether {node, path: fieldKey} is already in the group's exposed list.
  const memberGroup = groupOfNode(groups, node.id)
  const exposedPaths = new Set(
    (memberGroup?.exposed ?? []).filter((e) => e.node === node.id).map((e) => e.path)
  )
  const toggleExpose = (fieldKey: string, on: boolean): void => {
    if (!memberGroup) return
    if (on) exposeSetting(memberGroup.id, { node: node.id, path: fieldKey, label: fieldKey })
    else unexposeSetting(memberGroup.id, node.id, fieldKey)
  }

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

      {/* Enabled toggle (WP6.4a): at the top of every node's panel. A disabled node never runs (the
          engine skips it + its exclusive downstream); a disabled trigger never fires. */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, margin: '6px 0' }}>
        <input
          type="checkbox"
          checked={node.disabled !== true}
          disabled={readOnly}
          onChange={(e) => setNodeDisabled(node.id, !e.target.checked)}
        />
        {t('workflowEditor.enabled')}
      </label>

      {/* Pack node affordance (agent-packs plan WP3.6a/WP3.6b; ADR 0006 + 0010): this node belongs to a
          pack. Editing its config forks the pack on the FIRST edit (or writes through if this world
          already forked it). The button forks WITHOUT an edit, for users who want to fork first.
          A detached (trigger-only) placeholder node is non-editable this WP (wiring is manifest-level). */}
      {isPackNode && (
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
            {packNonEditable
              ? t('workflowEffective.detachedNonEditable')
              : alreadyForked
                ? t('workflowEffective.editingFork')
                : t('workflowEffective.editForks')}
          </div>
          {!alreadyForked && !packNonEditable && (
            <button
              type="button"
              onClick={() => ownerPackId && void forkPackExplicit(ownerPackId)}
              title={t('workflowEffective.forkButtonTitle')}
              style={{ fontSize: 12 }}
            >
              {t('workflowEffective.forkButton')}
            </button>
          )}
          {/* Once this world owns a fork, offer full fragment editing (WP4.4): drag/rewire/add-node in a
              dedicated Studio session, which config-edit-in-projection can't do. Points at the fork id. */}
          {alreadyForked && ownerPackId && (
            <button
              type="button"
              onClick={() =>
                openWorkflowEditor({ fragmentPackId: forkedPacks[ownerPackId] ?? ownerPackId })
              }
              title={t('workflowEffective.editFragmentTitle')}
              style={{ fontSize: 12 }}
            >
              {t('workflowEffective.editFragment')}
            </button>
          )}
        </div>
      )}

      {/* Main-output marking is a TURN-doc concept: exactly one node produces the assistant reply
          (validate.ts enforces it). A fragment is spliced into a narrator at a checkpoint and never
          run alone, so it carries no main output — validate.ts SKIPS the main-output rule for
          kind:'fragment'. In a fragment session (WP4.4) we hide the affordance so a user can't mark
          one (which would be meaningless + could confuse a later run-as-turn of the fork). */}
      {typeInfo?.isMainOutputCapable && sessionType !== 'fragment' && (
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

      {node.type === 'prompt.assemble' && <AssemblePreview profileId={profileId} />}

      <div>
        <div style={{ fontSize: 10.5, color: 'var(--rpt-text-tertiary)' }}>
          {t('workflowEditor.config')}
        </div>
        {fields.map((field) => (
          // Keyed by node id + field so switching between two nodes of the SAME type remounts the
          // controls — JsonFieldControl holds local text state that must never leak across nodes.
          <div key={`${node.id}:${field.key}`} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <label style={{ fontSize: 10.5, color: 'var(--rpt-text-secondary)', flex: 1 }}>
                {field.key}
                {field.required ? ' *' : ''}
              </label>
              {memberGroup && (
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 3,
                    fontSize: 10,
                    color: 'var(--rpt-text-tertiary)'
                  }}
                  title={t('workflowEditor.module.exposeToggle')}
                >
                  <input
                    type="checkbox"
                    aria-label={t('workflowEditor.module.exposeToggle')}
                    checked={exposedPaths.has(field.key)}
                    disabled={readOnly}
                    onChange={(e) => toggleExpose(field.key, e.target.checked)}
                  />
                </label>
              )}
            </div>
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
