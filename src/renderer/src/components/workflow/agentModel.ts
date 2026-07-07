// Pure agent-derivation model for the one-canvas editor (agent & memory UX WP-D; spec §1/§4).
// An AGENT is a named GroupDecl whose member chain is rooted at a trigger node — this module derives
// everything the agent card / group frame / Agents ▾ render from the doc + the WP-A catalog hints:
// agent detection, the on/off proxy state over member triggers, the status sentence (as i18n KEY +
// PARAMS — never concatenated English, so zh renders natively), the prompt excerpt (via the
// `promptFields` descriptor hint), run attribution (via StoredRunRecord.triggerNodeIds), and the
// one-click-grouping closure walk. NO React / @xyflow/react imports — vitest-pure like groupModel.ts;
// imports only shared workflow modules + the local editor shapes.
import { describeTrigger } from '../../../../shared/workflow/trace'
import type { StoredRunRecord } from '../../../../shared/workflow/trace'
import { isTriggerOp, TABLE_STATS } from '../../../../shared/workflow/attachments'
import type { TriggerAttachment, TriggerSource } from '../../../../shared/workflow/attachments'
import type { GroupDecl } from '../../../../shared/workflow/types'
import type { EditorEdge, EditorNode, EditorNodeType } from './editorModel'

/** Trigger detection keyed off the WP-A catalog `isTrigger` hint, with the `trigger.*` name prefix
 *  kept ONLY as a fallback for a stale/absent catalog entry (same rule FlowCanvas uses). */
export const isTriggerType = (type: string, types: Map<string, EditorNodeType>): boolean =>
  types.get(type)?.isTrigger ?? type.startsWith('trigger.')

/** The group's member TRIGGER nodes (doc order). */
export const agentTriggers = (
  nodes: EditorNode[],
  group: GroupDecl,
  types: Map<string, EditorNodeType>
): EditorNode[] => {
  const members = new Set(group.nodeIds)
  return nodes.filter((n) => members.has(n.id) && isTriggerType(n.type, types))
}

/** The agent UI contract (spec §1): a named group whose member chain is rooted at a trigger node —
 *  concretely, a group with ≥1 member trigger. Anything matching gets the full agent card;
 *  everything else keeps the plain module card. */
export const isAgentGroup = (
  nodes: EditorNode[],
  group: GroupDecl,
  types: Map<string, EditorNodeType>
): boolean => agentTriggers(nodes, group, types).length > 0

/** The agent's on/off proxy state over ALL member triggers' `disabled` flags (spec §4):
 *  'on' = every trigger enabled, 'off' = every trigger disabled, 'mixed' = some of each (the card
 *  renders mixed as off + an indicator dot; toggling always writes ALL members). */
export type AgentEnabledState = 'on' | 'off' | 'mixed'

export const agentEnabledState = (
  nodes: EditorNode[],
  group: GroupDecl,
  types: Map<string, EditorNodeType>
): AgentEnabledState => {
  const triggers = agentTriggers(nodes, group, types)
  if (triggers.length === 0) return 'on'
  const disabledCount = triggers.filter((t) => t.disabled === true).length
  if (disabledCount === 0) return 'on'
  if (disabledCount === triggers.length) return 'off'
  return 'mixed'
}

/** Reconstitute a trigger node's WP2.1 attachment from its type + (unvalidated) config so the shared
 *  describeTrigger can caption it. A renderer-side mirror of main's triggerAttachmentOf
 *  (triggerNodes.ts) — NOT imported (renderer must not import main); the shapes are pinned by the
 *  trigger config schemas, and a malformed config returns null (caller falls back to the type). */
export const triggerAttachmentOfNode = (node: EditorNode): TriggerAttachment | null => {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  if (node.type === 'trigger.manual') return { kind: 'trigger', trigger: 'manual' }
  if (node.type === 'trigger.cadence') {
    const n = cfg.everyNFloors
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return null
    return { kind: 'trigger', trigger: 'cadence', everyNFloors: n }
  }
  if (node.type === 'trigger.state') {
    const raw = cfg.source as Record<string, unknown> | undefined
    const op = cfg.op
    const value = cfg.value
    if (!raw || typeof op !== 'string' || !isTriggerOp(op)) return null
    if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean')
      return null
    let source: TriggerSource
    if (raw.scope === 'vars' && typeof raw.path === 'string' && raw.path) {
      source = { scope: 'vars', path: raw.path }
    } else if (
      raw.scope === 'table' &&
      typeof raw.table === 'string' &&
      raw.table &&
      (TABLE_STATS as readonly string[]).includes(raw.stat as string)
    ) {
      source = { scope: 'table', table: raw.table, stat: raw.stat as (typeof TABLE_STATS)[number] }
    } else {
      return null
    }
    return { kind: 'trigger', trigger: 'state', source, op, value }
  }
  return null
}

/** One-line description of a trigger node for the status sentence: the LIVE badge description when
 *  the canvas has one (explainDocTriggers), else the shared describeTrigger over the node's config,
 *  else the bare type. Kept data-ish (describeTrigger's stable caption format), used as the {{desc}}
 *  PARAM of the localized sentence patterns. */
export const describeTriggerNode = (
  node: EditorNode,
  badgeDescription?: string
): string => {
  if (badgeDescription) return badgeDescription
  const att = triggerAttachmentOfNode(node)
  return att ? describeTrigger(att) : node.type
}

// ── status sentence (spec §1/§4: "agents report in prose") ────────────────────────────────────────

/** A relative-recency i18n fragment ("{{n}} min ago" …), rendered with its own t() call and passed
 *  into the sentence pattern as the {{ago}} param. */
export interface AgoSpec {
  key: string
  params?: Record<string, number>
}

/** How long ago `then` was, bucketed for display. Pure over explicit clock inputs. */
export const relativeAgo = (thenMs: number, nowMs: number): AgoSpec => {
  const d = Math.max(0, nowMs - thenMs)
  const minutes = Math.floor(d / 60_000)
  if (minutes < 1) return { key: 'workflowEditor.agent.ago.justNow' }
  if (minutes < 60) return { key: 'workflowEditor.agent.ago.minutes', params: { n: minutes } }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { key: 'workflowEditor.agent.ago.hours', params: { n: hours } }
  return { key: 'workflowEditor.agent.ago.days', params: { n: Math.floor(hours / 24) } }
}

/** The status sentence as an i18n KEY + PARAMS (spec cross-cutting rule: keyed patterns, never
 *  concatenated fragments). Render as
 *  `t(s.key, { desc: s.desc, ago: s.ago ? t(s.ago.key, s.ago.params) : '' })`. */
export interface AgentSentence {
  key: string
  desc: string
  ago?: AgoSpec
}

export const agentStatusSentence = (input: {
  /** Per-trigger one-liners (describeTriggerNode output), joined for multi-trigger agents. */
  descriptions: string[]
  state: AgentEnabledState
  /** trace.startedAt of the newest run attributed to this agent, if any. */
  lastRunAt?: number
  now: number
}): AgentSentence => {
  const desc = input.descriptions.filter(Boolean).join(' | ')
  if (input.state === 'off') return { key: 'workflowEditor.agent.sentence.off', desc }
  if (input.state === 'mixed') return { key: 'workflowEditor.agent.sentence.mixed', desc }
  if (input.lastRunAt != null)
    return {
      key: 'workflowEditor.agent.sentence.onRan',
      desc,
      ago: relativeAgo(input.lastRunAt, input.now)
    }
  return { key: 'workflowEditor.agent.sentence.onNever', desc }
}

// ── prompt excerpt (spec §1: derived via the WP-A promptFields hint) ──────────────────────────────

/** The authored prompt text of ONE node, via its type's `promptFields` hint: a string field is the
 *  prompt; a role-message array yields the first SYSTEM row's content (else the first row). Null for
 *  non-prompt-bearing nodes / empty prompts. */
export const promptTextOfNode = (
  node: EditorNode,
  types: Map<string, EditorNodeType>
): string | null => {
  const fields = types.get(node.type)?.promptFields
  if (!fields || fields.length === 0) return null
  const cfg = (node.config ?? {}) as Record<string, unknown>
  for (const field of fields) {
    const v = cfg[field]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (Array.isArray(v)) {
      const rows = v.filter(
        (r): r is { role?: unknown; content: string } =>
          !!r && typeof r === 'object' && typeof (r as { content?: unknown }).content === 'string'
      )
      const row = rows.find((r) => r.role === 'system') ?? rows[0]
      const content = row?.content.trim()
      if (content) return content
    }
  }
  return null
}

/** Collapse whitespace + truncate for the on-card excerpt. */
export const excerptOf = (text: string, maxLen = 160): string => {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= maxLen ? collapsed : `${collapsed.slice(0, maxLen - 1)}…`
}

/** The group's prompt excerpt: the first prompt-bearing member's prompt (member order), excerpted.
 *  Null when no member carries a prompt. */
export const promptExcerpt = (
  nodes: EditorNode[],
  group: GroupDecl,
  types: Map<string, EditorNodeType>,
  maxLen = 160
): string | null => {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const id of group.nodeIds) {
    const node = byId.get(id)
    if (!node) continue
    const text = promptTextOfNode(node, types)
    if (text) return excerptOf(text, maxLen)
  }
  return null
}

// ── run attribution (spec §1: runs keyed by trigger node id → mapped through membership) ──────────

/** The newest run attributed to this agent: records whose `triggerNodeIds` (WP-D additive field)
 *  intersect the group's membership, newest by trace.startedAt. Old records without the field simply
 *  don't attribute (fail-soft). */
export const newestRunForGroup = (
  records: StoredRunRecord[],
  memberIds: ReadonlySet<string>
): StoredRunRecord | null => {
  let newest: StoredRunRecord | null = null
  for (const r of records) {
    if (!r.triggerNodeIds?.some((id) => memberIds.has(id))) continue
    if (!newest || r.trace.startedAt > newest.trace.startedAt) newest = r
  }
  return newest
}

// ── one-click grouping closure (spec §4) ──────────────────────────────────────────────────────────

/** Ancestors (via incoming edges) of every isMainOutput node, INCLUDING the output node itself —
 *  "the narrator path": everything that produces the player-facing reply. */
const mainOutputAncestors = (nodes: EditorNode[], edges: EditorEdge[]): Set<string> => {
  const inAdj = new Map<string, string[]>()
  for (const e of edges) {
    const list = inAdj.get(e.target)
    if (list) list.push(e.source)
    else inAdj.set(e.target, [e.source])
  }
  const out = new Set<string>()
  const stack = nodes.filter((n) => n.isMainOutput).map((n) => n.id)
  while (stack.length) {
    const cur = stack.pop()!
    if (out.has(cur)) continue
    out.add(cur)
    for (const parent of inAdj.get(cur) ?? []) if (!out.has(parent)) stack.push(parent)
  }
  return out
}

/** The one-click-grouping walk (spec §4 "Collapse chain into module"): the trigger's downstream
 *  closure, EXCLUDING narrator-shared nodes, PLUS sibling triggers wired into the same chain.
 *
 *  Interpretation (the plan's one-liner "excluding nodes reachable from any non-member root" taken
 *  literally would also exclude chain nodes that read a Context feeder like input.context —
 *  contradicting the WP-C reference group, which INCLUDES table.read/table.apply fed by ctx.gen).
 *  As implemented, "narrator-shared" = an ANCESTOR OF THE MAIN OUTPUT (the reply-producing path):
 *   1. Walk forward from the trigger; a node that is a main-output ancestor is neither included nor
 *      traversed (a chain that wires INTO the narrator spine stops at the splice point — the spine
 *      stays out of the group).
 *   2. Absorb sibling triggers whose out-edges ALL land inside the closure (the WP-C doc's second
 *      trigger feeding the shared control.mode — mirrors the headless OR-dedupe chain grouping).
 *  Context feeders (input.context) are upstream, never downstream — the forward walk cannot reach
 *  them, so they stay out without a special case. Pinned against the WP-C template in
 *  test/workflow/agentModel.test.ts. */
export const downstreamClosure = (
  nodes: EditorNode[],
  edges: EditorEdge[],
  triggerId: string,
  types: Map<string, EditorNodeType>
): Set<string> => {
  const narrator = mainOutputAncestors(nodes, edges)
  const outAdj = new Map<string, string[]>()
  for (const e of edges) {
    const list = outAdj.get(e.source)
    if (list) list.push(e.target)
    else outAdj.set(e.source, [e.target])
  }

  const closure = new Set<string>([triggerId])
  const stack = [triggerId]
  while (stack.length) {
    const cur = stack.pop()!
    for (const next of outAdj.get(cur) ?? []) {
      if (closure.has(next) || narrator.has(next)) continue
      closure.add(next)
      stack.push(next)
    }
  }

  // Sibling-trigger absorption: another trigger whose every out-edge targets a closure member roots
  // the SAME chain (e.g. the WP-C backlog trigger into control.mode.when2) — group them together.
  for (const n of nodes) {
    if (n.id === triggerId || closure.has(n.id) || !isTriggerType(n.type, types)) continue
    const outs = outAdj.get(n.id) ?? []
    if (outs.length > 0 && outs.every((t) => closure.has(t))) closure.add(n.id)
  }

  return closure
}

/** Every ungrouped trigger chain in the doc, for the import auto-group pass: one closure per
 *  UNGROUPED trigger, deduped (a closure absorbed into an earlier one — sibling triggers — is not
 *  emitted twice), each filtered to ungrouped members and required to have ≥2 of them. */
export const ungroupedTriggerChains = (
  nodes: EditorNode[],
  edges: EditorEdge[],
  groups: GroupDecl[],
  types: Map<string, EditorNodeType>
): Set<string>[] => {
  const grouped = new Set(groups.flatMap((g) => g.nodeIds))
  const claimed = new Set<string>()
  const out: Set<string>[] = []
  for (const n of nodes) {
    if (!isTriggerType(n.type, types) || grouped.has(n.id) || claimed.has(n.id)) continue
    const closure = downstreamClosure(nodes, edges, n.id, types)
    const free = new Set([...closure].filter((id) => !grouped.has(id)))
    if (free.size < 2) continue
    for (const id of free) claimed.add(id)
    out.push(free)
  }
  return out
}
