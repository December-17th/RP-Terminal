// Schema-driven node config side panel for the node-workflow editor (Phase 4 task 5). Renders
// FROM useWorkflowEditorStore (selectedNodeId/nodes/nodeTypes/readOnly) and dispatches back via
// setNodeConfig/setMainOutput — same store-driven contract as FlowCanvas.tsx. Each control is
// derived from the node type's configSchema via schemaForm.ts's pure fieldsFromSchema walker.
import React, { useEffect, useState } from 'react'
import { useWorkflowEditorStore } from '../../stores/workflowEditorStore'
import { useOptionalT, useT } from '../../i18n'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { editorToDoc } from './editorModel'
import { fieldsFromSchema, type FieldSpec } from './schemaForm'
import { groupOfNode } from './groupModel'
import {
  agentEnabledState,
  agentTriggers,
  describeTriggerNode,
  isAgentGroup
} from './agentModel'
import {
  dynamicEnumOptions,
  resolveSelection,
  visibleTabs,
  type DetailsTab,
  type PanelSelection
} from './detailsPanelModel'
import PromptEditor, { type PromptFieldSpec } from './PromptEditor'
import MemoryMaintainPanel from './MemoryMaintainPanel'
import LorebookPickerSheet from './LorebookPickerSheet'
import { useWorkflowTraceStore } from '../../stores/workflowTraceStore'
import { formatTraceSeconds, type StoredRunRecord } from '../../../../shared/workflow/trace'
import type { NodeTypeInfo } from '../../stores/workflowEditorStore'
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
import './workflowEditor.css'

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

  if (!workflowId)
    return <div className="rpt-wfe-subgraph-warn">{t('workflowEditor.subgraphNotSet')}</div>

  return (
    <div className="rpt-wfe-subgraph-info">
      <div className="rpt-wfe-subgraph-info-head">
        <span className={`rpt-wfe-subgraph-name${summary ? '' : ' is-unknown'}`}>
          {summary?.name ?? workflowId}
        </span>
        <button
          type="button"
          onClick={() => void open(profileId, workflowId)}
          className="rpt-wfe-subgraph-open-btn"
        >
          {t('workflowEditor.openSubgraph')}
        </button>
      </div>
      {promotions.length > 0 && (
        <div className="rpt-wfe-promotions">
          {t('workflowEditor.promotionsHint')}
          <ul className="rpt-wfe-promotions-list">
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
        className="rpt-wfe-field-textarea"
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
        className="rpt-wfe-field-control"
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
        className="rpt-wfe-field-control"
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
          <div key={index} className="rpt-wfe-array-item">
            {field.itemFields.map((itemField) => (
              <div key={itemField.key} className="rpt-wfe-array-item-field">
                <label className="rpt-wfe-field-sublabel">{itemField.key}</label>
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
            <div className="rpt-wfe-array-item-actions">
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
        className="rpt-wfe-field-textarea"
      />
      {error && <div className="rpt-wfe-invalid-json">{t('workflowEditor.invalidJson')}</div>}
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
  nodeTypes: NodeTypeInfo[]
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
  // WP-E (plan §0.5): a dynamicEnum field's options live in a sibling config array, not a static zod
  // enum — resolve them here so an exposed `control.mode.selected` renders as a real dropdown.
  const dynEnum =
    typeInfo?.dynamicEnum && typeInfo.dynamicEnum.path === entry.path ? typeInfo.dynamicEnum : undefined
  const dynOptions = dynEnum ? dynamicEnumOptions(config, dynEnum) : null
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
    <div className="rpt-wfe-exposed-row">
      <div className="rpt-wfe-exposed-row-head">
        <input
          type="text"
          value={entry.label}
          disabled={readOnly}
          onChange={(e) => onRelabel(e.target.value)}
          className="rpt-wfe-exposed-label-input"
        />
        <button
          type="button"
          disabled={readOnly}
          title={t('workflowEditor.module.exposedRemove')}
          onClick={onRemove}
          className="rpt-wfe-exposed-remove-btn"
        >
          ✕
        </button>
      </div>
      <div className="rpt-wfe-exposed-path">
        {entry.node}.{entry.path}
      </div>
      {dynOptions ? (
        <select
          value={typeof value === 'string' ? value : ''}
          disabled={readOnly || !member}
          onChange={(e) => write(e.target.value === '' ? undefined : e.target.value)}
          style={{ width: '100%' }}
        >
          {!dynOptions.some((o) => o.key === value) && <option value="">--</option>}
          {dynOptions.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      ) : field ? (
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
          className="rpt-wfe-field-control"
        />
      )}
    </div>
  )
}

/** The "Export module…" affordance on the module panel (WP6.5): a previewless direct save (the panel
 *  IS the review — no wizard). When a chat is active AND has a table template, an "include table schema"
 *  checkbox lets the author bundle the WHOLE active template (the v0 unit) so the module ships portable.
 *  The (unsaved) editor doc + this group id go to the export IPC; a toast reports the saved path. */
function ExportModuleButton({
  profileId,
  groupId
}: {
  profileId: string
  groupId: string
}): React.JSX.Element {
  const t = useT()
  const doc = useWorkflowEditorStore((s) => s.doc)
  const nodes = useWorkflowEditorStore((s) => s.nodes)
  const edges = useWorkflowEditorStore((s) => s.edges)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const [templateId, setTemplateId] = useState<string | null>(null)
  const [includeTemplate, setIncludeTemplate] = useState(false)
  const [busy, setBusy] = useState(false)

  // Does the active chat have a table template assigned? Only then offer the checkbox (the WHOLE
  // active template is the v0 bundle unit — getChatTableTemplate gives the id, we fetch the template
  // itself at export time so the panel stays cheap).
  useEffect(() => {
    let cancelled = false
    setTemplateId(null)
    setIncludeTemplate(false)
    if (!activeChatId) return
    void window.api
      .getChatTableTemplate(profileId, activeChatId)
      .then((id) => {
        if (!cancelled) setTemplateId((id as string | null) ?? null)
      })
      .catch(() => {
        if (!cancelled) setTemplateId(null)
      })
    return () => {
      cancelled = true
    }
  }, [profileId, activeChatId])

  const onExport = async (): Promise<void> => {
    if (!doc || busy) return
    setBusy(true)
    try {
      // Fold the live editor nodes/edges into the doc so the export sees UNSAVED edits (the group
      // members may have been added/moved since the last save).
      const liveDoc = editorToDoc(doc, nodes, edges)
      let template: unknown = null
      if (includeTemplate && templateId) {
        template = await window.api.getTableTemplate(profileId, templateId)
      }
      const result = await window.api.exportModuleDialog(profileId, liveDoc, groupId, template)
      if ('saved' in result) {
        useToastStore.getState().push(t('workflowEditor.module.exportSaved', { path: result.saved }))
      } else if ('ok' in result && !result.ok) {
        useToastStore.getState().push(t('workflowEditor.module.exportFailed'))
      }
    } catch {
      useToastStore.getState().push(t('workflowEditor.module.exportFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rpt-wfe-export-module">
      {templateId && (
        <label className="rpt-wfe-export-check">
          <input
            type="checkbox"
            checked={includeTemplate}
            onChange={(e) => setIncludeTemplate(e.target.checked)}
          />
          {t('workflowEditor.module.includeTemplate')}
        </label>
      )}
      <button type="button" onClick={() => void onExport()} disabled={busy} className="rpt-wfe-btn-xs">
        {t('workflowEditor.module.export')}
      </button>
    </div>
  )
}

/** The MODULE panel (WP6.3), shown when a group is selected: editable name, collapse toggle,
 *  Ungroup, the exposed-settings list, and the WP6.5 "Export module…" affordance. */
function ModulePanel({ group, profileId }: { group: GroupDecl; profileId: string }): React.JSX.Element {
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
      <div className="rpt-wfe-module-name-wrap">
        <input
          type="text"
          value={group.name}
          disabled={readOnly}
          placeholder={t('workflowEditor.module.namePh')}
          onChange={(e) => renameGroup(group.id, e.target.value)}
          className="rpt-wfe-module-name-input"
        />
      </div>
      <div className="rpt-wfe-module-actions">
        <button
          type="button"
          disabled={readOnly}
          onClick={() => toggleGroupCollapsed(group.id)}
          className="rpt-wfe-btn-xs"
        >
          {group.collapsed
            ? t('workflowEditor.module.expand')
            : t('workflowEditor.module.collapse')}
        </button>
        <button
          type="button"
          disabled={readOnly}
          onClick={() => ungroup(group.id)}
          className="rpt-wfe-btn-xs"
        >
          {t('workflowEditor.module.ungroup')}
        </button>
      </div>

      <div className="rpt-wfe-module-exposed-head">{t('workflowEditor.module.exposedTitle')}</div>
      {exposed.length === 0 ? (
        <div className="rpt-wfe-module-exposed-empty">{t('workflowEditor.module.exposedEmpty')}</div>
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

      {!readOnly && <ExportModuleButton profileId={profileId} groupId={group.id} />}
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
      <div className="rpt-wfe-assemble-head">{t('workflowEditor.assemblePreview.title')}</div>
      <button type="button" onClick={() => void run()} disabled={loading} className="rpt-wfe-btn-xs">
        {loading ? t('workflowEditor.assemblePreview.loading') : t('workflowEditor.assemblePreview.button')}
      </button>
      {error && (
        <div className="rpt-wfe-assemble-error">{t('workflowEditor.assemblePreview.error')}</div>
      )}
      {data && total && (
        <>
          <div className="rpt-wfe-assemble-total">
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

/** WP-E: the SINGLE-NODE details context — a four-tab shell (Settings / Prompt / Runs / Docs, spec §6)
 *  over one node. Keyed by node id at the call site so the tab + local control state resets on a node
 *  switch. Prompt fields (node-type `promptFields`) are routed to the Prompt tab, not the settings form. */
function NodeDetailsInner({
  profileId,
  node
}: {
  profileId: string
  node: EditorNode
}): React.JSX.Element {
  const t = useT()
  const tOpt = useOptionalT()
  const doc = useWorkflowEditorStore((s) => s.doc)
  const nodeTypes = useWorkflowEditorStore((s) => s.nodeTypes)
  const readOnly = useWorkflowEditorStore((s) => s.readOnly)
  const sessionType = useWorkflowEditorStore((s) => s.sessionType)
  const setNodeConfig = useWorkflowEditorStore((s) => s.setNodeConfig)
  const setNodePanel = useWorkflowEditorStore((s) => s.setNodePanel)
  const setNodeDisabled = useWorkflowEditorStore((s) => s.setNodeDisabled)
  const setMainOutput = useWorkflowEditorStore((s) => s.setMainOutput)
  const exposeSetting = useWorkflowEditorStore((s) => s.exposeSetting)
  const unexposeSetting = useWorkflowEditorStore((s) => s.unexposeSetting)
  const [tab, setTab] = useState<DetailsTab>('settings')

  const groups = doc?.groups ?? []
  const typeInfo = nodeTypes.find((nt) => nt.type === node.type)
  const config = node.config ?? {}
  const allFields = fieldsFromSchema(typeInfo?.configSchema)
  // WP-H (spec §7): a node with a `lore: Lore` input AND a `lorebook` config field gets the dedicated
  // Lorebook row (mode + picker) instead of the generic enum control. Detected structurally — nothing
  // hardcoded to agent.llm (v1's only such node, but any future one inherits the row).
  const hasLoreRow =
    (typeInfo?.inputs ?? []).some((p) => p.name === 'lore' && p.type === 'Lore') &&
    allFields.some((f) => f.key === 'lorebook')
  // Prompt fields (WP-A hint) leave the settings scroll and render in the Prompt tab's editor instead;
  // `lorebook` leaves it for the dedicated row.
  const promptKeys = new Set(typeInfo?.promptFields ?? [])
  const fields = allFields.filter((f) => !promptKeys.has(f.key) && !(hasLoreRow && f.key === 'lorebook'))
  const promptFieldSpecs: PromptFieldSpec[] = (typeInfo?.promptFields ?? []).map((key) => ({
    key,
    isArray: allFields.find((f) => f.key === key)?.kind === 'objectArray'
  }))
  const tabs = visibleTabs({ kind: 'node', nodeId: node.id }, promptFieldSpecs.length > 0)

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
    <div className="rpt-details-panel">
      <div className="rpt-details-head">
        <strong>{nodeTitle}</strong>
        <div className="rpt-wfe-node-type-id">{node.type}</div>
      </div>
      <TabRail tabs={tabs} active={tab} onSelect={setTab} />

      {tab === 'prompt' && (
        <>
          <PromptEditor
            fields={promptFieldSpecs}
            config={config}
            readOnly={readOnly}
            onChange={updateField}
          />
          {/* memory.maintain (WP2): under the scaffold prompt, the per-table maintenance-rule editor
              (writes to the bound template) + the composed-prompt preview. */}
          {node.type === 'memory.maintain' && (
            <MemoryMaintainPanel profileId={profileId} config={config} />
          )}
        </>
      )}

      {tab === 'runs' && <NodeRunsTab nodeId={node.id} />}

      {tab === 'docs' && (
        <div>
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
          <div style={{ fontSize: 10.5, color: 'var(--rpt-text-tertiary)' }}>
            {t('workflowEditor.ports')}
          </div>
          {(typeInfo?.inputs ?? []).map((port) => (
            <div key={`in-${port.name}`} style={{ fontSize: 10.5, marginBottom: 3 }}>
              <span style={{ color: 'var(--rpt-text-primary)' }}>
                → {port.name}{' '}
                <span style={{ color: 'var(--rpt-text-tertiary)' }}>({port.type})</span>
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
                {port.name} →{' '}
                <span style={{ color: 'var(--rpt-text-tertiary)' }}>({port.type})</span>
              </span>
              {portDesc(port.name) && (
                <div style={{ color: 'var(--rpt-text-secondary)', paddingLeft: 14 }}>
                  {portDesc(port.name)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'settings' && (
        <div>
      {/* Enabled toggle (WP6.4a): at the top of every node's panel. A disabled node never runs (the
          engine skips it + its exclusive downstream); a disabled trigger never fires. */}
      <label className="rpt-wfe-check-row">
        <input
          type="checkbox"
          checked={node.disabled !== true}
          disabled={readOnly}
          onChange={(e) => setNodeDisabled(node.id, !e.target.checked)}
        />
        {t('workflowEditor.enabled')}
      </label>

      {/* Main-output marking is a TURN-doc concept: exactly one node produces the assistant reply
          (validate.ts enforces it). A fragment is spliced into a narrator at a checkpoint and never
          run alone, so it carries no main output — validate.ts SKIPS the main-output rule for
          kind:'fragment'. In a fragment session (WP4.4) we hide the affordance so a user can't mark
          one (which would be meaningless + could confuse a later run-as-turn of the fork). */}
      {typeInfo?.isMainOutputCapable && sessionType !== 'fragment' && (
        <label className="rpt-wfe-check-row-tight">
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
      <label className="rpt-wfe-check-row-mt">
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
        <div className="rpt-wfe-panel-label-wrap">
          <label className="rpt-wfe-field-sublabel">{t('workflowEditor.panelLabel')}</label>
          <input
            type="text"
            value={node.panel.label ?? ''}
            disabled={readOnly}
            placeholder={t('workflowEditor.panelLabelPh')}
            onChange={(e) =>
              setNodePanel(node.id, { show: true, label: e.target.value || undefined })
            }
            className="rpt-wfe-field-control"
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

      {/* WP-H (spec §7): the Lorebook row — mode select + the per-world entry picker. */}
      {hasLoreRow && (
        <LorebookRow
          profileId={profileId}
          node={node}
          config={config}
          readOnly={readOnly}
          onModeChange={(mode) => updateField('lorebook', mode)}
        />
      )}

      <div>
        <div className="rpt-wfe-muted-label">{t('workflowEditor.config')}</div>
        {fields.map((field) => (
          // Keyed by node id + field so switching between two nodes of the SAME type remounts the
          // controls — JsonFieldControl holds local text state that must never leak across nodes.
          <div key={`${node.id}:${field.key}`} className="rpt-wfe-config-field">
            <div className="rpt-wfe-config-field-head">
              <label className="rpt-wfe-config-field-label">
                {field.key}
                {field.required ? ' *' : ''}
              </label>
              {memberGroup && (
                <label
                  className="rpt-wfe-expose-toggle"
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
        </div>
      )}
    </div>
  )
}

/** WP-E: the panel's vertical icon tab rail (spec §6). Renders nothing when there are no tabs (the
 *  nothing / plain-group contexts). Labels are localized; the short glyph is decorative. */
const TAB_GLYPH: Record<DetailsTab, string> = {
  settings: '⚙',
  prompt: '✎',
  runs: '▷',
  docs: 'ℹ'
}
function TabRail({
  tabs,
  active,
  onSelect
}: {
  tabs: DetailsTab[]
  active: DetailsTab
  onSelect: (tab: DetailsTab) => void
}): React.JSX.Element | null {
  const t = useT()
  if (tabs.length === 0) return null
  return (
    <div className="rpt-details-tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={tab === active}
          className={`rpt-details-tab${tab === active ? ' active' : ''}`}
          onClick={() => onSelect(tab)}
          title={t(`workflowEditor.details.tab.${tab}`)}
        >
          <span aria-hidden>{TAB_GLYPH[tab]}</span>
          <span className="rpt-details-tab-label">{t(`workflowEditor.details.tab.${tab}`)}</span>
        </button>
      ))}
    </div>
  )
}

/** WP-E Runs tab: this node's slice of the active chat's last run of THE OPEN doc (status, ms, output
 *  preview). Reuses the same trace-store + workflowId gate FlowCanvas uses — a trace from another doc
 *  would mislead. Empty when there's no matching trace. */
function NodeRunsTab({ nodeId }: { nodeId: string }): React.JSX.Element {
  const t = useT()
  const currentId = useWorkflowEditorStore((s) => s.currentId)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const trace = useWorkflowTraceStore((s) => (activeChatId ? s.traces[activeChatId] : undefined))
  const slice =
    trace && trace.workflowId === currentId ? trace.nodes.find((n) => n.nodeId === nodeId) : undefined
  if (!slice) {
    return (
      <div style={{ fontSize: 11, color: 'var(--rpt-text-secondary)' }}>
        {t('workflowEditor.details.noRuns')}
      </div>
    )
  }
  return (
    <div style={{ fontSize: 11 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <span className={`rpt-node-trace-chip is-${slice.status}`}>
          {slice.status === 'failed'
            ? t('workflow.trace.status.failed')
            : slice.ms !== undefined
              ? formatTraceSeconds(slice.ms)
              : t(`workflow.trace.status.${slice.status}`)}
        </span>
      </div>
      {slice.error && (
        <div style={{ color: 'var(--rpt-danger)', marginBottom: 6 }}>{slice.error.message}</div>
      )}
      {slice.outputs &&
        Object.entries(slice.outputs).map(([port, preview]) => (
          <div key={port} style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 10, color: 'var(--rpt-text-tertiary)' }}>{port}</div>
            <pre className="rpt-assemble-preview-text">{preview}</pre>
          </div>
        ))}
    </div>
  )
}

/** WP-E Runs tab for an AGENT (spec §6): the agent's own runs — the active chat's run history filtered
 *  to records whose trigger-node ids intersect the group's membership (WP-D attribution). */
function AgentRunsTab({ profileId, memberIds }: { profileId: string; memberIds: Set<string> }): React.JSX.Element {
  const t = useT()
  const activeChatId = useChatStore((s) => s.activeChatId)
  const [records, setRecords] = useState<StoredRunRecord[]>([])
  useEffect(() => {
    let cancelled = false
    if (!activeChatId) {
      setRecords([])
      return
    }
    void (async () => {
      const page = (await window.api.listAgentPackRuns(profileId, activeChatId)) as StoredRunRecord[]
      if (!cancelled) setRecords(page ?? [])
    })()
    return () => {
      cancelled = true
    }
  }, [profileId, activeChatId])
  const mine = records.filter((r) => r.triggerNodeIds?.some((id) => memberIds.has(id)))
  if (mine.length === 0) {
    return (
      <div style={{ fontSize: 11, color: 'var(--rpt-text-secondary)' }}>
        {t('workflowEditor.details.noRuns')}
      </div>
    )
  }
  return (
    <div style={{ fontSize: 11 }}>
      {mine.slice(0, 10).map((r) => (
        <div
          key={r.runId}
          style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}
        >
          <span className={`rpt-node-trace-chip is-${r.trace.ok ? 'ran' : 'failed'}`}>
            {r.trace.ok ? formatTraceSeconds(r.trace.durationMs) : t('workflow.trace.status.failed')}
          </span>
          {r.trigger && (
            <span style={{ color: 'var(--rpt-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.trigger}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

/** WP-E: the AGENT details context (spec §6) — the four-tab shell over a trigger-rooted group. Settings
 *  = the on/off proxy switch, trigger timing, the author `note`, exposed settings (generic; dynamicEnum
 *  aware), Show-on-canvas + Export module. Prompt = the first prompt-bearing member's editor. Runs =
 *  membership-attributed runs. Docs = the member overview. Keyed by group id at the call site. */
function AgentDetails({ group, profileId }: { group: GroupDecl; profileId: string }): React.JSX.Element {
  const t = useT()
  const tOpt = useOptionalT()
  const nodes = useWorkflowEditorStore((s) => s.nodes)
  const nodeTypes = useWorkflowEditorStore((s) => s.nodeTypes)
  const readOnly = useWorkflowEditorStore((s) => s.readOnly)
  const renameGroup = useWorkflowEditorStore((s) => s.renameGroup)
  const setGroupTriggersDisabled = useWorkflowEditorStore((s) => s.setGroupTriggersDisabled)
  const toggleGroupCollapsed = useWorkflowEditorStore((s) => s.toggleGroupCollapsed)
  const setNodeConfig = useWorkflowEditorStore((s) => s.setNodeConfig)
  const exposeSetting = useWorkflowEditorStore((s) => s.exposeSetting)
  const unexposeSetting = useWorkflowEditorStore((s) => s.unexposeSetting)
  const [tab, setTab] = useState<DetailsTab>('settings')

  const types = new Map<string, NodeTypeInfo>(nodeTypes.map((nt) => [nt.type, nt]))
  const state = agentEnabledState(nodes, group, types)
  const triggers = agentTriggers(nodes, group, types)
  const memberIds = new Set(group.nodeIds)
  // The first prompt-bearing member routes the Prompt tab (spec §1 card excerpt uses the same member).
  const promptMember = group.nodeIds
    .map((id) => nodes.find((n) => n.id === id))
    .find((n): n is EditorNode => !!n && promptTextOfNodeHasPrompt(n, types))
  const promptFieldSpecs: PromptFieldSpec[] = promptMember
    ? (types.get(promptMember.type)?.promptFields ?? []).map((key) => ({
        key,
        isArray:
          fieldsFromSchema(types.get(promptMember.type)?.configSchema).find((f) => f.key === key)
            ?.kind === 'objectArray'
      }))
    : []
  const tabs = visibleTabs({ kind: 'agent', groupId: group.id }, promptFieldSpecs.length > 0)
  const exposed = group.exposed ?? []

  return (
    <div className="rpt-details-panel">
      <div className="rpt-details-head" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          className={`rpt-node-trigger-switch${state === 'on' ? ' on' : ''}${state === 'mixed' ? ' rpt-agent-switch-mixed' : ''}`}
          role="switch"
          aria-checked={state === 'on'}
          aria-label={t('workflowEditor.enabled')}
          disabled={readOnly}
          onClick={() => setGroupTriggersDisabled(group.id, state === 'on')}
        >
          <span className="rpt-node-trigger-switch-knob" aria-hidden />
        </button>
        <input
          type="text"
          value={group.name}
          disabled={readOnly}
          onChange={(e) => renameGroup(group.id, e.target.value)}
          style={{ flex: 1, fontSize: 12.5, fontWeight: 600 }}
        />
      </div>
      <TabRail tabs={tabs} active={tab} onSelect={setTab} />

      {tab === 'prompt' &&
        (promptMember ? (
          <PromptEditor
            fields={promptFieldSpecs}
            config={promptMember.config ?? {}}
            readOnly={readOnly}
            onChange={(field, value) => {
              const next = { ...(promptMember.config ?? {}) }
              if (value === undefined) delete next[field]
              else next[field] = value
              setNodeConfig(promptMember.id, next)
            }}
          />
        ) : (
          <div style={{ fontSize: 11, color: 'var(--rpt-text-secondary)' }}>
            {t('workflowEditor.details.noPrompt')}
          </div>
        ))}

      {tab === 'runs' && <AgentRunsTab profileId={profileId} memberIds={memberIds} />}

      {tab === 'docs' && (
        <div style={{ fontSize: 11 }}>
          <div style={{ fontSize: 10.5, color: 'var(--rpt-text-tertiary)', marginBottom: 4 }}>
            {t('workflowEditor.module.members', { n: group.nodeIds.length })}
          </div>
          {group.nodeIds.map((id) => {
            const member = nodes.find((n) => n.id === id)
            if (!member) return null
            const title =
              tOpt(`workflowEditor.nodeTitle.${member.type}`) ||
              types.get(member.type)?.title ||
              member.type
            return (
              <div key={id} style={{ marginBottom: 3 }}>
                <span style={{ color: 'var(--rpt-text-primary)' }}>{title}</span>{' '}
                <span style={{ color: 'var(--rpt-text-tertiary)' }}>{member.type}</span>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'settings' && (
        <div>
          {/* Trigger timing (spec §6): the localized/stable per-trigger caption. */}
          <div style={{ fontSize: 11, color: 'var(--rpt-agent)', margin: '8px 0' }}>
            {triggers.map((tn) => describeTriggerNode(tn)).join(' | ') || t('workflowEditor.details.noTrigger')}
          </div>

          {group.note && (
            <div
              style={{
                fontSize: 11,
                lineHeight: 1.5,
                color: 'var(--rpt-warning)',
                border: '1px solid var(--rpt-warning)',
                borderRadius: 6,
                padding: '6px 8px',
                margin: '8px 0'
              }}
            >
              {group.note}
            </div>
          )}

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

          <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '10px 0' }}>
            <span style={{ fontSize: 11, color: 'var(--rpt-text-secondary)' }}>
              {t('workflowEditor.module.members', { n: group.nodeIds.length })}
            </span>
            {group.collapsed && !readOnly && (
              <button
                type="button"
                onClick={() => toggleGroupCollapsed(group.id)}
                style={{ fontSize: 11 }}
              >
                {t('workflowEditor.details.showOnCanvas')}
              </button>
            )}
          </div>

          {!readOnly && <ExportModuleButton profileId={profileId} groupId={group.id} />}
        </div>
      )}
    </div>
  )
}

/** Small helper: does this node carry any authored prompt text via its type's promptFields? */
function promptTextOfNodeHasPrompt(node: EditorNode, types: Map<string, NodeTypeInfo>): boolean {
  const fields = types.get(node.type)?.promptFields
  return !!fields && fields.length > 0
}

/** WP-E: the NOTHING-selected context (spec §6): the workflow name/description + the validation error
 *  list (moved here from the toolbar toggle's popover). */
function NothingPanel(): React.JSX.Element {
  const t = useT()
  const tOpt = useOptionalT()
  const doc = useWorkflowEditorStore((s) => s.doc)
  const errors = useWorkflowEditorStore((s) => s.errors)
  const select = useWorkflowEditorStore((s) => s.select)
  return (
    <div className="rpt-details-panel">
      <div className="rpt-details-head">
        <strong>{doc?.name ?? t('workflowEditor.noSelection')}</strong>
      </div>
      {doc?.description && (
        <div style={{ fontSize: 11, color: 'var(--rpt-text-secondary)', lineHeight: 1.55, margin: '6px 0' }}>
          {doc.description}
        </div>
      )}
      <div style={{ fontSize: 10.5, color: 'var(--rpt-text-tertiary)', margin: '8px 0 4px' }}>
        {errors.length === 0 ? t('workflowEditor.valid') : `${t('workflowEditor.invalid')} (${errors.length})`}
      </div>
      {errors.map((err, i) => {
        // Localized label for the error CODE (tOpt → '' on miss); the raw message keeps the specifics.
        const label = tOpt(`workflowEditor.err.${err.code}`)
        return (
          <div
            key={i}
            onClick={() => err.nodeId && select(err.nodeId)}
            style={{
              cursor: err.nodeId ? 'pointer' : 'default',
              fontSize: 11,
              color: 'var(--rpt-danger)',
              marginBottom: 3
            }}
          >
            {label ? `${label} — ` : ''}
            {err.message}
            {err.nodeId ? ` (${err.nodeId})` : ''}
          </div>
        )
      })}
    </div>
  )
}

/** WP-H (spec §7): the Lorebook row on a lore-capable node's Settings tab. Shows the mode select
 *  ('main' = standard matching over the agent's history; 'custom' = exactly the per-world picks), or
 *  "wired on canvas" (disabled) when a `lore` edge exists in the doc — the wire beats config. Custom
 *  mode gets the "Choose entries…" picker (needs an active chat: picks are per-WORLD, and the world
 *  comes from the active chat's character) plus a no-picks-yet fallback hint. */
function LorebookRow({
  profileId,
  node,
  config,
  readOnly,
  onModeChange
}: {
  profileId: string
  node: EditorNode
  config: Record<string, unknown>
  readOnly: boolean
  onModeChange: (mode: string | undefined) => void
}): React.JSX.Element {
  const t = useT()
  const edges = useWorkflowEditorStore((s) => s.edges)
  const currentId = useWorkflowEditorStore((s) => s.currentId)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const chats = useChatStore((s) => s.chats)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickCount, setPickCount] = useState<number | null>(null)

  const wired = edges.some((e) => e.target === node.id && e.targetPort === 'lore')
  const mode = config.lorebook === 'custom' ? 'custom' : 'main'
  const worldId = activeChatId
    ? (chats.find((c) => c.id === activeChatId)?.character_id ?? null)
    : null

  // The stored pick count for the current world (drives the no-picks hint). Refetched when the
  // picker closes (it may have just saved).
  useEffect(() => {
    let cancelled = false
    setPickCount(null)
    if (mode !== 'custom' || !worldId || !currentId || pickerOpen) return
    void (async () => {
      const picks = await window.api.getLorePicks(profileId, worldId, currentId, node.id)
      if (!cancelled) setPickCount((picks ?? []).length)
    })()
    return () => {
      cancelled = true
    }
  }, [profileId, worldId, currentId, node.id, mode, pickerOpen])

  return (
    <div style={{ margin: '8px 0' }}>
      <div style={{ fontSize: 10.5, color: 'var(--rpt-text-tertiary)', marginBottom: 3 }}>
        {t('workflowEditor.lore.rowLabel')}
      </div>
      {wired ? (
        <div style={{ fontSize: 11, color: 'var(--rpt-text-secondary)' }}>
          {t('workflowEditor.lore.wiredOnCanvas')}
        </div>
      ) : (
        <>
          <select
            value={mode}
            disabled={readOnly}
            onChange={(e) => onModeChange(e.target.value === 'custom' ? 'custom' : undefined)}
            style={{ width: '100%', fontSize: 11.5 }}
          >
            <option value="main">{t('workflowEditor.lore.mode.main')}</option>
            <option value="custom">{t('workflowEditor.lore.mode.custom')}</option>
          </select>
          {mode === 'custom' && (
            <div style={{ marginTop: 5 }}>
              {worldId && currentId ? (
                <>
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => setPickerOpen(true)}
                    style={{ fontSize: 11.5 }}
                  >
                    {t('workflowEditor.lore.choose')}
                    {pickCount != null && pickCount > 0 ? ` (${pickCount})` : ''}
                  </button>
                  {pickCount === 0 && (
                    <div style={{ fontSize: 10.5, color: 'var(--rpt-warning)', marginTop: 3 }}>
                      {t('workflowEditor.lore.noPicksHint')}
                    </div>
                  )}
                </>
              ) : (
                <div style={{ fontSize: 10.5, color: 'var(--rpt-text-secondary)' }}>
                  {t('workflowEditor.lore.needsChat')}
                </div>
              )}
            </div>
          )}
        </>
      )}
      {pickerOpen && worldId && currentId && (
        <LorebookPickerSheet
          profileId={profileId}
          worldId={worldId}
          docId={currentId}
          nodeId={node.id}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
}

/** WP-E: the universal details panel dispatcher (spec §6). Routes the current selection to the agent /
 *  node / nothing context; a plain (non-agent) group keeps the legacy ModulePanel. */
export default function NodeConfigPanel({ profileId }: NodeConfigPanelProps): React.JSX.Element {
  const selectedNodeId = useWorkflowEditorStore((s) => s.selectedNodeId)
  const selectedGroupId = useWorkflowEditorStore((s) => s.selectedGroupId)
  const doc = useWorkflowEditorStore((s) => s.doc)
  const nodes = useWorkflowEditorStore((s) => s.nodes)
  const nodeTypes = useWorkflowEditorStore((s) => s.nodeTypes)

  const groups = doc?.groups ?? []
  const selectedGroup = selectedGroupId ? groups.find((g) => g.id === selectedGroupId) : undefined
  const types = new Map<string, NodeTypeInfo>(nodeTypes.map((nt) => [nt.type, nt]))
  const sel: PanelSelection = resolveSelection(
    selectedGroupId,
    selectedNodeId,
    !!selectedGroup && isAgentGroup(nodes, selectedGroup, types)
  )

  if (sel.kind === 'agent' && selectedGroup)
    return <AgentDetails key={selectedGroup.id} group={selectedGroup} profileId={profileId} />
  if (sel.kind === 'group' && selectedGroup)
    return <ModulePanel group={selectedGroup} profileId={profileId} />
  if (sel.kind === 'node') {
    const node = nodes.find((n) => n.id === selectedNodeId)
    if (node) return <NodeDetailsInner key={node.id} node={node} profileId={profileId} />
  }
  return <NothingPanel />
}
