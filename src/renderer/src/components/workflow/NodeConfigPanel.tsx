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
  if (selectedGroup) return <ModulePanel group={selectedGroup} profileId={profileId} />

  const readOnly = storeReadOnly

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
        <div className="rpt-wfe-node-type-id">{node.type}</div>
      </div>

      {nodeDesc && <div className="rpt-wfe-node-desc">{nodeDesc}</div>}

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

      <div>
        <div className="rpt-wfe-muted-label">{t('workflowEditor.ports')}</div>
        {(typeInfo?.inputs ?? []).map((port) => (
          <div key={`in-${port.name}`} className="rpt-wfe-port-row">
            <span className="rpt-wfe-port-name">
              → {port.name} <span className="rpt-wfe-port-type">({port.type})</span>
            </span>
            {portDesc(port.name) && (
              <div className="rpt-wfe-port-desc">{portDesc(port.name)}</div>
            )}
          </div>
        ))}
        {(typeInfo?.outputs ?? []).map((port) => (
          <div key={`out-${port.name}`} className="rpt-wfe-port-row">
            <span className="rpt-wfe-port-name">
              {port.name} → <span className="rpt-wfe-port-type">({port.type})</span>
            </span>
            {portDesc(port.name) && (
              <div className="rpt-wfe-port-desc">{portDesc(port.name)}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
