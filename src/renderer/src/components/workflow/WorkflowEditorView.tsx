// Composition root for the node-workflow editor (Phase 4 task 6): top bar (workflow picker, save,
// clone, import/export, validation status) + a three-column body (node palette / FlowCanvas /
// NodeConfigPanel). Everything is store-driven — this component only wires window.api dialogs and
// the local "is the error list open" UI toggle; all workflow state lives in useWorkflowEditorStore.
//
// No beforeunload-style unsaved-changes guard here: panel switching is in-app (no page navigation
// to intercept), and the `dirty`/`unsaved` chip in the top bar is the guard the user sees instead.
import React, { useEffect, useMemo, useState } from 'react'
import { useWorkflowEditorStore } from '../../stores/workflowEditorStore'
import { useEffectiveGraphStore } from '../../stores/effectiveGraphStore'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { useUiStore } from '../../stores/uiStore'
import { useOptionalT, useT } from '../../i18n'
import { describeTrigger } from '../../../../shared/workflow/trace'
import type { AttachmentDecl } from '../../../../shared/workflow/attachments'
import FlowCanvas from './FlowCanvas'
import EffectiveCanvas from './EffectiveCanvas'
import NodeConfigPanel from './NodeConfigPanel'
import { ownerOfNodeId, nodeOwnerMap, readComposition } from './effectiveProjection'
import { ownerPackOfEdit, type FragmentEdit } from './packEditRouting'

const BUILTIN_WORKFLOW_ID = 'default'

type EditorMode = 'normal' | 'effective'

/** Renders `status` translated when it matches a known workflowEditor.* key (including the
 *  connect.* rejection reasons the store writes as `connect.<reason>`); otherwise shows the raw
 *  string as-is (save() writes raw IPC error text into status on failure). */
function StatusLine({ status }: { status: string | null }): React.JSX.Element | null {
  const t = useT()
  if (!status) return null
  const knownKeys = [
    'saved',
    'saveFailed',
    'connect.incompatible',
    'connect.occupied',
    'connect.self',
    'connect.missing-port'
  ]
  const text = knownKeys.includes(status) ? t(`workflowEditor.${status}`) : status
  return (
    <div style={{ fontSize: 11.5, color: 'var(--rpt-text-secondary)', padding: '2px 10px' }}>
      {text}
    </div>
  )
}

export default function WorkflowEditorView({
  profileId
}: {
  profileId: string
}): React.JSX.Element {
  const t = useT()
  const tOpt = useOptionalT()
  const workflows = useWorkflowEditorStore((s) => s.workflows)
  const currentId = useWorkflowEditorStore((s) => s.currentId)
  const doc = useWorkflowEditorStore((s) => s.doc)
  const setDocName = useWorkflowEditorStore((s) => s.setDocName)
  const dirty = useWorkflowEditorStore((s) => s.dirty)
  const readOnly = useWorkflowEditorStore((s) => s.readOnly)
  const errors = useWorkflowEditorStore((s) => s.errors)
  const status = useWorkflowEditorStore((s) => s.status)
  const nodeTypes = useWorkflowEditorStore((s) => s.nodeTypes)
  const init = useWorkflowEditorStore((s) => s.init)
  const open = useWorkflowEditorStore((s) => s.open)
  const save = useWorkflowEditorStore((s) => s.save)
  const cloneAndEdit = useWorkflowEditorStore((s) => s.cloneAndEdit)
  const select = useWorkflowEditorStore((s) => s.select)
  const setLockedNodeIds = useWorkflowEditorStore((s) => s.setLockedNodeIds)
  const setPackEditRouter = useWorkflowEditorStore((s) => s.setPackEditRouter)
  const routePackEdit = useEffectiveGraphStore((s) => s.routePackEdit)

  const [showErrors, setShowErrors] = useState(false)

  // ── Effective mode (agent-packs plan WP3.6a; ADR 0010) ─────────────────────────────────────────
  // The Agents "Open in Workflow Studio" hand-off (WP3.2) can request Effective mode via uiStore; we
  // seed the initial mode from it once, then clear the request so a later manual open starts Normal.
  const requestedMode = useUiStore((s) => s.workflowEditorInitialMode)
  const consumeInitialMode = useUiStore((s) => s.consumeWorkflowEditorInitialMode)
  const [mode, setMode] = useState<EditorMode>(requestedMode === 'effective' ? 'effective' : 'normal')
  useEffect(() => {
    if (requestedMode) consumeInitialMode()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- consume once on mount for the initial request
  }, [])
  const activeChatId = useChatStore((s) => s.activeChatId)
  const chats = useChatStore((s) => s.chats)
  const worldId = useMemo(
    () => chats.find((c) => c.id === activeChatId)?.character_id ?? null,
    [chats, activeChatId]
  )
  const effDoc = useEffectiveGraphStore((s) => s.doc)
  const effPacks = useEffectiveGraphStore((s) => s.packs)
  const effLoading = useEffectiveGraphStore((s) => s.loading)
  const effError = useEffectiveGraphStore((s) => s.error)
  const fetchEffective = useEffectiveGraphStore((s) => s.fetch)
  const clearEffective = useEffectiveGraphStore((s) => s.clear)

  // Trigger captions per pack, for detached (trigger-only) region placeholders. Built from each
  // pack's trigger attachments (listAgentPacks carries them) via the shared describeTrigger.
  const [triggerCaptions, setTriggerCaptions] = useState<Record<string, string>>({})

  useEffect(() => {
    void init(profileId)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per profileId, init is stable
  }, [profileId])

  // Entering Effective mode: (1) load the resolved narrator into the editor store so narrator-node
  // edits write through the EXISTING save path; (2) fetch the live projection; (3) build trigger
  // captions. Leaving it clears the projection. Requires an active chat (guarded by the empty state).
  useEffect(() => {
    if (mode !== 'effective' || !activeChatId) {
      if (mode !== 'effective') clearEffective()
      return
    }
    let cancelled = false
    void (async () => {
      // Load the narrator doc that the effective graph composes over (the chat's resolved workflow),
      // so its unprefixed nodes are the editor store's editable draft (write-through target).
      const narratorId = await window.api.resolveWorkflowId(profileId, activeChatId)
      if (cancelled) return
      await open(profileId, narratorId)
      await fetchEffective(profileId, activeChatId, worldId)
      // Trigger captions from the pack manifests' attachments.
      const list = (await window.api.listAgentPacks(profileId, worldId, activeChatId)) as {
        id: string
        attachments: AttachmentDecl[]
      }[]
      if (cancelled) return
      const caps: Record<string, string> = {}
      for (const p of list ?? []) {
        const trigs = (p.attachments ?? []).filter(
          (a): a is Extract<AttachmentDecl, { kind: 'trigger' }> => a.kind === 'trigger'
        )
        if (trigs.length) caps[p.id] = trigs.map((tr) => describeTrigger(tr)).join(' · ')
      }
      setTriggerCaptions(caps)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open/fetch stable; re-run on the deps below
  }, [mode, profileId, activeChatId, worldId])

  // Keep the editor store's PACK-node lock in sync with the current projection (WP3.6a: pack nodes are
  // locked at the model layer this stage; WP3.6b routes their edits through a fork). Narrator nodes
  // (unprefixed) stay editable. Cleared when leaving Effective mode.
  useEffect(() => {
    if (mode !== 'effective' || !effDoc) {
      setLockedNodeIds(new Set())
      return
    }
    const owners = nodeOwnerMap(readComposition(effDoc))
    const locked = new Set<string>()
    for (const n of effDoc.nodes) {
      if (owners.has(n.id) || ownerOfNodeId(n.id).kind === 'pack') locked.add(n.id)
    }
    setLockedNodeIds(locked)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setLockedNodeIds stable
  }, [mode, effDoc])

  // Install the PACK-EDIT ROUTER (WP3.6b; ADR 0006). In Effective mode a locked pack node's edit is
  // handed to this router (via the editor store) instead of being dropped: it resolves the edit's
  // OWNER pack from the current projection composition, then routes it to fork-on-first-edit /
  // write-through (effectiveGraphStore.routePackEdit). Cleared when leaving Effective mode so Normal
  // mode never routes (locked-node edits there stay no-ops). The projection is recomposed by
  // routePackEdit itself, so this router is fire-and-forget from the store's perspective.
  useEffect(() => {
    if (mode !== 'effective') {
      setPackEditRouter(null)
      return
    }
    setPackEditRouter((edit: FragmentEdit) => {
      // Resolve owner from the live projection (owner map authoritative; id-parse fallback). Read the
      // freshest doc at call time so a recompose between install and edit is reflected.
      const currentDoc = useEffectiveGraphStore.getState().doc
      const owners = nodeOwnerMap(currentDoc ? readComposition(currentDoc) : undefined)
      const ownerOf = (id: string): string | null => {
        const mapped = owners.get(id)
        if (mapped) return mapped
        const parsed = ownerOfNodeId(id)
        return parsed.kind === 'pack' ? parsed.packId : null
      }
      const packId = ownerPackOfEdit(edit, ownerOf)
      if (packId) void routePackEdit(packId, edit)
    })
    return () => setPackEditRouter(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setters stable; re-install on mode change
  }, [mode])

  useEffect(() => {
    if (!currentId && workflows.length > 0) {
      const fallback = workflows.some((w) => w.id === BUILTIN_WORKFLOW_ID)
        ? BUILTIN_WORKFLOW_ID
        : workflows[0].id
      void open(profileId, fallback)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open/profileId intentionally excluded to avoid re-triggering on store identity churn
  }, [workflows, currentId])

  const onImport = async (): Promise<void> => {
    const result = await window.api.importWorkflowDialog(profileId)
    if (result === null) return
    if (!result.ok) {
      useToastStore.getState().push(`${t('workflowEditor.importFailed')}: ${result.error}`)
      return
    }
    await init(profileId)
  }

  const onExport = (): void => {
    if (!currentId) return
    const name = workflows.find((w) => w.id === currentId)?.name ?? currentId
    void window.api.exportWorkflowDialog(profileId, currentId, name)
  }

  // Save the currently-open doc, then (in Effective mode) re-fetch the projection so a narrator
  // write-through re-composes live (ADR 0010: recompose from sources after every write-through). In
  // Normal mode this is exactly the existing save — no behavior change.
  const onSave = async (): Promise<void> => {
    await save(profileId)
    if (mode === 'effective' && activeChatId) {
      await fetchEffective(profileId, activeChatId, worldId)
    }
  }

  return (
    <div className="rpt-workflow-editor" style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderBottom: '1px solid var(--rpt-border)',
          flex: '0 0 auto'
        }}
      >
        {/* Normal / Effective mode toggle (agent-packs plan WP3.6a; ADR 0010). Effective renders the
            live composition (narrator + gate-open packs) for the active chat. */}
        <div className="rpt-eff-modeswitch" role="tablist" aria-label={t('workflowEffective.mode')}>
          {(['normal', 'effective'] as EditorMode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={`rpt-eff-modeswitch-btn${mode === m ? ' active' : ''}`}
              onClick={() => setMode(m)}
              style={{ fontSize: 12 }}
            >
              {t(`workflowEffective.mode.${m}`)}
            </button>
          ))}
        </div>

        <select
          value={currentId ?? ''}
          onChange={(e) => void open(profileId, e.target.value)}
          disabled={mode === 'effective'}
          title={mode === 'effective' ? t('workflowEffective.pickerLocked') : undefined}
          style={{ fontSize: 12.5 }}
        >
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>

        {/* Rename the open workflow (doc metadata; persists on Save). Read-only for the builtin. */}
        <input
          type="text"
          value={doc?.name ?? ''}
          disabled={readOnly || mode === 'effective'}
          placeholder={t('workflowEditor.namePh')}
          title={t('workflowEditor.nameTitle')}
          onChange={(e) => setDocName(e.target.value)}
          style={{ fontSize: 12.5, width: 170 }}
        />

        <button
          type="button"
          disabled={readOnly || !dirty}
          onClick={() => void onSave()}
          style={{ fontSize: 12.5 }}
          title={mode === 'effective' ? t('workflowEffective.saveNarrator') : undefined}
        >
          {t('workflowEditor.save')}
        </button>

        {dirty && (
          <span
            style={{
              fontSize: 11,
              padding: '1px 8px',
              borderRadius: 10,
              border: '1px solid var(--rpt-warning)',
              color: 'var(--rpt-warning)'
            }}
          >
            {t('workflowEditor.unsaved')}
          </span>
        )}

        <button
          type="button"
          onClick={() => void cloneAndEdit(profileId)}
          style={{ fontSize: 12.5 }}
        >
          {t('workflowEditor.cloneToEdit')}
        </button>

        <button type="button" onClick={() => void onImport()} style={{ fontSize: 12.5 }}>
          {t('workflowEditor.import')}
        </button>

        <button type="button" disabled={!currentId} onClick={onExport} style={{ fontSize: 12.5 }}>
          {t('workflowEditor.export')}
        </button>

        <span style={{ flex: 1 }} />

        <button
          type="button"
          onClick={() => setShowErrors((v) => !v)}
          style={{
            fontSize: 11,
            padding: '2px 9px',
            borderRadius: 10,
            border: `1px solid ${errors.length === 0 ? 'var(--rpt-success)' : 'var(--rpt-danger)'}`,
            color: errors.length === 0 ? 'var(--rpt-success)' : 'var(--rpt-danger)',
            background: 'transparent'
          }}
        >
          {errors.length === 0
            ? t('workflowEditor.valid')
            : `${t('workflowEditor.invalid')} (${errors.length})`}
        </button>
      </div>

      {showErrors && errors.length > 0 && (
        <div
          style={{
            flex: '0 0 auto',
            borderBottom: '1px solid var(--rpt-border)',
            padding: '6px 10px',
            fontSize: 11.5
          }}
        >
          <div style={{ color: 'var(--rpt-text-tertiary)', marginBottom: 4 }}>
            {t('workflowEditor.errors')}
          </div>
          {errors.map((err, i) => {
            // Localized label for the error CODE; the raw message keeps the specifics (port
            // names etc.) as the detail.
            const label = tOpt(`workflowEditor.err.${err.code}`)
            return (
              <div
                key={i}
                onClick={() => err.nodeId && select(err.nodeId)}
                style={{
                  cursor: err.nodeId ? 'pointer' : 'default',
                  color: 'var(--rpt-danger)',
                  padding: '2px 0'
                }}
              >
                {label ? `${label} — ` : ''}
                {err.message}
                {err.nodeId ? ` (${err.nodeId})` : ''}
              </div>
            )
          })}
        </div>
      )}

      {readOnly && (
        <div
          style={{
            flex: '0 0 auto',
            padding: '5px 10px',
            fontSize: 11.5,
            color: 'var(--rpt-warning)',
            borderBottom: '1px solid var(--rpt-border)'
          }}
        >
          {t('workflowEditor.readOnlyBuiltin')}
        </div>
      )}

      <StatusLine status={status} />

      {mode === 'effective' ? (
        <EffectiveBody
          profileId={profileId}
          hasChat={!!activeChatId}
          loading={effLoading}
          error={effError}
          doc={effDoc}
          packCount={effPacks.length}
          triggerCaptions={triggerCaptions}
        />
      ) : (
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div
          style={{
            width: 180,
            flex: '0 0 180px',
            overflowY: 'auto',
            borderRight: '1px solid var(--rpt-border)',
            padding: 6
          }}
        >
          <div
            style={{
              fontSize: 10.5,
              color: 'var(--rpt-text-tertiary)',
              marginBottom: 6
            }}
          >
            {t('workflowEditor.palette')}
          </div>
          {nodeTypes.map((nt) => {
            const title = tOpt(`workflowEditor.nodeTitle.${nt.type}`) || nt.title
            const desc = tOpt(`workflowEditor.nodeDesc.${nt.type}`)
            return (
              <div
                key={nt.type}
                draggable
                title={desc}
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/rpt-node-type', nt.type)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                style={{
                  border: '1px solid var(--rpt-border)',
                  borderRadius: 6,
                  padding: '5px 8px',
                  marginBottom: 5,
                  cursor: 'grab',
                  background: 'var(--rpt-bg-elevated)'
                }}
              >
                <div style={{ fontSize: 12, color: 'var(--rpt-text-primary)' }}>{title}</div>
                <div style={{ fontSize: 10, color: 'var(--rpt-text-tertiary)' }}>{nt.type}</div>
                {desc && (
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--rpt-text-secondary)',
                      marginTop: 3,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden'
                    }}
                  >
                    {desc}
                  </div>
                )}
              </div>
            )
          })}

          {/* Reusable sub-graph packages the author can drop as one subgraph.call node,
              preconfigured with workflow_id (sub-graph nodes v1 plan §5). Excludes the doc
              currently open (no self-reference from the palette; the run-time recursion guard
              would refuse it anyway). */}
          {workflows.some((w) => w.kind === 'subgraph' && w.id !== currentId) && (
            <>
              <div
                style={{
                  fontSize: 10.5,
                  color: 'var(--rpt-text-tertiary)',
                  margin: '10px 0 6px',
                  borderTop: '1px solid var(--rpt-border)',
                  paddingTop: 8
                }}
              >
                {t('workflowEditor.subgraphs')}
              </div>
              {workflows
                .filter((w) => w.kind === 'subgraph' && w.id !== currentId)
                .map((w) => (
                  <div
                    key={w.id}
                    style={{
                      border: '1px solid var(--rpt-border)',
                      borderRadius: 6,
                      padding: '5px 8px',
                      marginBottom: 5,
                      background: 'var(--rpt-bg-elevated)'
                    }}
                  >
                    <div style={{ fontSize: 12, color: 'var(--rpt-text-primary)' }}>{w.name}</div>
                    {/* Two draggable type chips: drop as a plain subgraph.call, or as a
                        subgraph.loop — both carry the same workflow_id payload. */}
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      {(['subgraph.call', 'subgraph.loop'] as const).map((nodeType) => (
                        <div
                          key={nodeType}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData('application/rpt-node-type', nodeType)
                            e.dataTransfer.setData('application/rpt-subgraph-id', w.id)
                            e.dataTransfer.effectAllowed = 'move'
                          }}
                          style={{
                            border: '1px solid var(--rpt-border)',
                            borderRadius: 4,
                            padding: '2px 6px',
                            cursor: 'grab',
                            fontSize: 10,
                            color: 'var(--rpt-text-tertiary)',
                            background: 'var(--rpt-bg-tertiary)'
                          }}
                        >
                          {t(`workflowEditor.nodeTitle.${nodeType}`)}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
            </>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <FlowCanvas profileId={profileId} />
        </div>

        <div
          style={{
            width: 280,
            flex: '0 0 280px',
            overflowY: 'auto',
            borderLeft: '1px solid var(--rpt-border)',
            padding: 8
          }}
        >
          <NodeConfigPanel profileId={profileId} />
        </div>
      </div>
      )}
    </div>
  )
}

/** The Effective-mode body (agent-packs plan WP3.6a; ADR 0010): the projection canvas + the config
 *  panel (narrator nodes editable/write-through; pack nodes read-only with a "fork to edit"
 *  affordance — handled inside NodeConfigPanel). No node palette (a projection is not authored by
 *  dragging in new nodes). Designed empty/loading/error states, never a blank div. */
function EffectiveBody({
  profileId,
  hasChat,
  loading,
  error,
  doc,
  packCount,
  triggerCaptions
}: {
  profileId: string
  hasChat: boolean
  loading: boolean
  error: boolean
  doc: unknown
  packCount: number
  triggerCaptions: Record<string, string>
}): React.JSX.Element {
  const t = useT()

  if (!hasChat) {
    return (
      <div className="rpt-eff-empty-state">
        <div className="rpt-eff-empty-icon" aria-hidden>
          ◎
        </div>
        <h2 className="rpt-eff-empty-title">{t('workflowEffective.noChatTitle')}</h2>
        <p className="rpt-eff-empty-body">{t('workflowEffective.noChatBody')}</p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        {error ? (
          <div className="rpt-eff-empty-state">
            <p className="rpt-eff-empty-body">{t('workflowEffective.loadError')}</p>
          </div>
        ) : loading && !doc ? (
          <div className="rpt-eff-empty-state">
            <p className="rpt-eff-empty-body">{t('workflowEffective.loading')}</p>
          </div>
        ) : (
          <EffectiveCanvas profileId={profileId} triggerCaptions={triggerCaptions} />
        )}
        {/* A quiet caption so the user knows this is a live projection, not a saved doc (ADR 0001). */}
        <div className="rpt-eff-projection-note">
          {t('workflowEffective.projectionNote', { n: packCount })}
        </div>
      </div>

      <div
        style={{
          width: 280,
          flex: '0 0 280px',
          overflowY: 'auto',
          borderLeft: '1px solid var(--rpt-border)',
          padding: 8
        }}
      >
        <NodeConfigPanel profileId={profileId} />
      </div>
    </div>
  )
}
