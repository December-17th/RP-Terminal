// The Agents ▾ master dropdown (agent & memory UX WP-F; spec §5): a toolbar popover with one row per
// AGENT (a named group rooted at a trigger — the contract §1). Each row = on/off switch · name ·
// `imported` provenance chip · the prose status sentence · inline dropdowns for the agent's exposed
// ENUM settings (the memory mode is flippable here) · a locate button that pans the canvas to it.
// All derivation is the pure agentModel/detailsPanelModel; this file only wires the store + view.
import React from 'react'
import { useT } from '../../i18n'
import { useWorkflowEditorStore } from '../../stores/workflowEditorStore'
import { useChatStore } from '../../stores/chatStore'
import type { NodeTypeInfo } from '../../stores/workflowEditorStore'
import type { EditorNode } from './editorModel'
import type { GroupDecl } from '../../../../shared/workflow/types'
import type { StoredRunRecord } from '../../../../shared/workflow/trace'
import { getPath } from '../../../../shared/objectPath'
import {
  agentEnabledState,
  agentStatusSentence,
  agentTriggers,
  describeTriggerNode,
  isAgentGroup,
  modeGatedTriggerIds,
  newestRunForGroup,
  type AgentSentence
} from './agentModel'
import { exposedEnumOptions } from './detailsPanelModel'

export default function AgentsDropdown({ profileId }: { profileId: string }): React.JSX.Element | null {
  const t = useT()
  const doc = useWorkflowEditorStore((s) => s.doc)
  const nodes = useWorkflowEditorStore((s) => s.nodes)
  const nodeTypes = useWorkflowEditorStore((s) => s.nodeTypes)
  const [open, setOpen] = React.useState(false)

  const types = React.useMemo(
    () => new Map<string, NodeTypeInfo>(nodeTypes.map((nt) => [nt.type, nt])),
    [nodeTypes]
  )
  const agentGroups = React.useMemo(
    () => (doc?.groups ?? []).filter((g) => isAgentGroup(nodes, g, types)),
    [doc, nodes, types]
  )

  // Run history for the status sentences (recency), fetched once per chat.
  const activeChatId = useChatStore((s) => s.activeChatId)
  const [records, setRecords] = React.useState<StoredRunRecord[]>([])
  React.useEffect(() => {
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

  if (agentGroups.length === 0) return null

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ fontSize: 12.5 }}
        aria-expanded={open}
      >
        {t('workflowEditor.agents.button', { n: agentGroups.length })} ▾
      </button>
      {open && (
        <>
          <div className="rpt-agents-dropdown-scrim" onClick={() => setOpen(false)} />
          <div className="rpt-agents-dropdown" role="menu">
            {agentGroups.map((g) => (
              <AgentRow key={g.id} group={g} nodes={nodes} types={types} records={records} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function AgentSentenceText({ sentence }: { sentence: AgentSentence }): React.JSX.Element {
  const t = useT()
  return (
    <>
      {t(sentence.key, {
        desc: sentence.desc,
        ago: sentence.ago ? t(sentence.ago.key, sentence.ago.params) : ''
      })}
    </>
  )
}

function AgentRow({
  group,
  nodes,
  types,
  records
}: {
  group: GroupDecl
  nodes: EditorNode[]
  types: Map<string, NodeTypeInfo>
  records: StoredRunRecord[]
}): React.JSX.Element {
  const t = useT()
  const readOnly = useWorkflowEditorStore((s) => s.readOnly)
  const setGroupTriggersDisabled = useWorkflowEditorStore((s) => s.setGroupTriggersDisabled)
  const setNodeConfig = useWorkflowEditorStore((s) => s.setNodeConfig)
  const requestPanToGroup = useWorkflowEditorStore((s) => s.requestPanToGroup)

  const edges = useWorkflowEditorStore((s) => s.edges)

  const state = agentEnabledState(nodes, group, types)
  // Owner manual-pass fix: the sentence composes from EFFECTIVE triggers (enabled AND not gated by
  // the current control.mode selection); when the switch is on but the mode gates every trigger, the
  // mode-gated variant renders ALL descriptions (what the agent WOULD do). Derives from store
  // nodes+edges, so flipping the inline mode dropdown below updates this row immediately.
  const gated = modeGatedTriggerIds(nodes, edges, types)
  const triggers = agentTriggers(nodes, group, types)
  const effective = triggers.filter((tn) => tn.disabled !== true && !gated.has(tn.id))
  const allModeGated = state === 'on' && triggers.length > 0 && effective.length === 0
  const descriptions = (allModeGated || state !== 'on' ? triggers : effective).map((tn) =>
    describeTriggerNode(tn)
  )
  const newest = newestRunForGroup(records, new Set(group.nodeIds))
  const sentence = agentStatusSentence({
    descriptions,
    state,
    ...(allModeGated ? { allModeGated: true } : {}),
    ...(newest ? { lastRunAt: newest.trace.startedAt } : {}),
    now: Date.now()
  })

  // Exposed ENUM settings render inline (spec §5: "inline enum dropdowns for exposed enum settings").
  const enumSettings = (group.exposed ?? [])
    .map((entry) => {
      const member = nodes.find((n) => n.id === entry.node)
      if (!member) return null
      const typeInfo = types.get(member.type)
      const config = member.config ?? {}
      const options = exposedEnumOptions(config, typeInfo?.configSchema, typeInfo?.dynamicEnum, entry.path)
      if (!options) return null
      return { entry, member, config, options }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  return (
    <div className="rpt-agents-row">
      <div className="rpt-agents-row-head">
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
        <span className="rpt-agents-row-name">{group.name}</span>
        {group.origin === 'import' && (
          <span className="rpt-agents-row-chip">{t('workflowEditor.agents.imported')}</span>
        )}
        <button
          type="button"
          className="rpt-agents-row-locate"
          title={t('workflowEditor.agents.locate')}
          onClick={() => requestPanToGroup(group.id)}
        >
          ⌖
        </button>
      </div>
      <div className={`rpt-agents-row-sentence${state === 'off' || allModeGated ? ' off' : ''}`}>
        <AgentSentenceText sentence={sentence} />
      </div>
      {enumSettings.map(({ entry, member, config, options }) => {
        const value = getPath(config, entry.path)
        return (
          <div key={`${entry.node}:${entry.path}`} className="rpt-agents-row-setting">
            <label>{entry.label}</label>
            <select
              value={typeof value === 'string' ? value : ''}
              disabled={readOnly}
              onChange={(e) => {
                const next = { ...config }
                if (e.target.value === '') delete next[entry.path]
                else next[entry.path] = e.target.value
                setNodeConfig(member.id, next)
              }}
            >
              {!options.some((o) => o.key === value) && <option value="">--</option>}
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        )
      })}
    </div>
  )
}
