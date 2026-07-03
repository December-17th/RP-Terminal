import { WorkflowDoc, NodeDescriptor, NodeInstance, PortType, portCompatible } from './types'
import { topoOrder, GraphCycleError } from './graph'
import { CHECKPOINTS, resolveAnchorLane } from './checkpoints'
import {
  isCheckpointId,
  isTriggerOp,
  isTableStat,
  isWellFormedVarsPath,
  AttachmentDecl,
  TriggerAttachment
} from './attachments'

export interface ValidationError {
  code: string
  message: string
  nodeId?: string
}

export type ValidationResult = { ok: true } | { ok: false; errors: ValidationError[] }

type PortLookup = { nodeMissing: true } | { nodeMissing: false; type?: PortType }

/** Validate a workflow document against a map of known node descriptors (spec §12 validation
 *  gate). Branches on `doc.kind` (sub-graph nodes v1 plan §2; agent-packs plan WP1.1): a 'turn'
 *  doc (default, absent kind) must have exactly one main-output node and must NOT contain boundary
 *  nodes (`subgraph.input`/`subgraph.output` only mean something inside a sub-graph run — their
 *  seeds would be undefined in a normal turn); a 'subgraph' doc skips the main-output rule
 *  (it's invoked via `subgraph.call`, never run directly) but requires each boundary slot name
 *  to be used by at most one node per direction; a 'fragment' doc (an agent pack's executable
 *  part; ADR 0002/0009) likewise skips the main-output rule — it's spliced into a narrator at
 *  checkpoints, never run alone — and additionally must declare ≥1 valid attachment (see
 *  validateFragmentAttachments). */
export function validateWorkflow(
  doc: WorkflowDoc,
  descriptors: Map<string, NodeDescriptor>
): ValidationResult {
  const errors: ValidationError[] = []
  const nodeById = new Map<string, NodeInstance>(doc.nodes.map((n) => [n.id, n]))
  const isSubgraph = doc.kind === 'subgraph'
  const isFragment = doc.kind === 'fragment'
  // Both subgraph and fragment docs are never run directly, so neither carries a main-output node.
  const skipMainOutputRule = isSubgraph || isFragment

  const hasDupNodeIds = nodeById.size !== doc.nodes.length
  if (hasDupNodeIds) errors.push({ code: 'DUP_NODE_ID', message: 'duplicate node ids' })

  for (const n of doc.nodes) {
    if (!descriptors.has(n.type))
      errors.push({ code: 'UNKNOWN_TYPE', message: `unknown node type "${n.type}"`, nodeId: n.id })
  }

  const portOf = (nodeId: string, port: string, dir: 'inputs' | 'outputs'): PortLookup => {
    const n = nodeById.get(nodeId)
    if (!n) return { nodeMissing: true }
    const spec = descriptors.get(n.type)?.[dir].find((p) => p.name === port)
    return { nodeMissing: false, type: spec?.type }
  }

  const fanInCounts = new Map<string, { nodeId: string; port: string; count: number }>()
  for (const e of doc.edges) {
    const out = portOf(e.from.node, e.from.port, 'outputs')
    const inp = portOf(e.to.node, e.to.port, 'inputs')
    if (out.nodeMissing || inp.nodeMissing) {
      errors.push({ code: 'EDGE_NODE', message: 'edge references a missing node' })
      continue
    }
    if (out.type === undefined) {
      errors.push({
        code: 'EDGE_PORT',
        message: `no output port "${e.from.port}" on ${e.from.node}`
      })
      continue
    }
    if (inp.type === undefined) {
      errors.push({ code: 'EDGE_PORT', message: `no input port "${e.to.port}" on ${e.to.node}` })
      continue
    }
    if (!portCompatible(out.type, inp.type))
      errors.push({
        code: 'PORT_TYPE',
        message: `${out.type} → ${inp.type} incompatible`,
        nodeId: e.to.node
      })

    const fanInKey = JSON.stringify([e.to.node, e.to.port])
    const entry = fanInCounts.get(fanInKey)
    if (entry) entry.count++
    else fanInCounts.set(fanInKey, { nodeId: e.to.node, port: e.to.port, count: 1 })
  }

  for (const { nodeId, port, count } of fanInCounts.values()) {
    if (count < 2) continue
    errors.push({
      code: 'FANIN',
      message: `input port "${port}" on ${nodeId} has multiple incoming edges`,
      nodeId
    })
  }

  // A 'subgraph' or 'fragment' doc is never run directly (a subgraph is invoked via subgraph.call;
  // a fragment is spliced into a narrator) — both skip the exactly-one-main-output rule entirely.
  if (!skipMainOutputRule) {
    const mains = doc.nodes.filter((n) => n.isMainOutput)
    if (mains.length !== 1)
      errors.push({
        code: 'MAIN_OUTPUT',
        message: `expected exactly 1 main-output node, found ${mains.length}`
      })
  }

  if (!isSubgraph) {
    // Boundary nodes are meaningless in a turn graph — their seeds (ctx.subgraphSeeds) would be
    // undefined, since a turn is never invoked by subgraph.call.
    for (const n of doc.nodes) {
      if (n.type === 'subgraph.input' || n.type === 'subgraph.output')
        errors.push({
          code: 'BOUNDARY_IN_TURN',
          message: `${n.type} is only valid inside a sub-graph doc (kind: 'subgraph')`,
          nodeId: n.id
        })
    }
  } else {
    // Each boundary slot name must be claimed by at most one node per direction — two
    // subgraph.input nodes both mapped to slot 'in1' would both read the same seed with no way
    // for the caller to tell which is which.
    const seenIn = new Map<string, string>()
    const seenOut = new Map<string, string>()
    for (const n of doc.nodes) {
      const slot = (n.config as { slot?: unknown } | undefined)?.slot
      if (typeof slot !== 'string') continue
      if (n.type === 'subgraph.input') {
        const prior = seenIn.get(slot)
        if (prior)
          errors.push({
            code: 'DUP_BOUNDARY_SLOT',
            message: `input slot "${slot}" is claimed by both ${prior} and ${n.id}`,
            nodeId: n.id
          })
        else seenIn.set(slot, n.id)
      } else if (n.type === 'subgraph.output') {
        const prior = seenOut.get(slot)
        if (prior)
          errors.push({
            code: 'DUP_BOUNDARY_SLOT',
            message: `output slot "${slot}" is claimed by both ${prior} and ${n.id}`,
            nodeId: n.id
          })
        else seenOut.set(slot, n.id)
      }
    }
  }

  if (isFragment) validateFragmentAttachments(doc, descriptors, errors)

  // topoOrder's node-id-keyed maps undercount indegree when ids collide, so the cycle check is
  // unreliable with duplicate ids — the doc is already invalid via DUP_NODE_ID, skip it.
  if (!hasDupNodeIds) {
    try {
      topoOrder(doc)
    } catch (err) {
      if (err instanceof GraphCycleError)
        errors.push({ code: 'CYCLE', message: 'graph has a cycle' })
      else throw err
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true }
}

/** Fragment-specific rules (agent-packs plan WP1.1; ADR 0002/0009), run only for kind 'fragment'.
 *  Appends to the shared `errors` list — never touches 'turn'/'subgraph' validation.
 *
 *  1. A fragment MUST declare at least one attachment (ADR 0009: a fragment is defined by where it
 *     joins the turn; with no attachment it is unreachable — NO_ATTACHMENT).
 *  2. Every entry/rejoin attachment MUST name a known v1 checkpoint (ADR 0002: checkpoint names are
 *     the compatibility surface — UNKNOWN_CHECKPOINT). Trigger stubs carry no checkpoint (WP2.1).
 *  3. An INLINE entry wires the main flow THROUGH the fragment, so the fragment must be able to
 *     produce a value that fits back into the checkpoint: at least one node output port must be
 *     portCompatible with the checkpoint's value type (INLINE_TYPE). Branch entries and rejoins are
 *     not load-bearing on the main path, so they are exempt from this check here (their contributed
 *     value type is enforced at composition time, WP1.2).
 *  4. A rejoin's anchor-lane SELECTOR (WP1.6b), when present, must name one of the checkpoint's
 *     anchor ports (checkpoints.ts CheckpointSpec.anchors — UNKNOWN_ANCHOR otherwise). Absent =
 *     the default lane, always valid.
 *  5. A TRIGGER attachment (WP2.1; ADR 0003/0004) is validated by `validateTrigger` below —
 *     state-condition path/op/source, cadence N ≥ 1 integer, manual (no params). Triggers carry no
 *     checkpoint (they attach OFF the main path), so they skip the checkpoint rules 2–4. A fragment
 *     with ONLY trigger attachments is valid (a pure headless pack — glossary: Headless Run). */
function validateFragmentAttachments(
  doc: WorkflowDoc,
  descriptors: Map<string, NodeDescriptor>,
  errors: ValidationError[]
): void {
  const attachments: AttachmentDecl[] = doc.attachments ?? []
  if (attachments.length === 0) {
    errors.push({
      code: 'NO_ATTACHMENT',
      message: 'a fragment doc must declare at least one attachment'
    })
    return
  }

  // Output PortTypes this fragment can produce — the candidates an inline entry rejoins with.
  const producibleTypes = new Set<PortType>()
  for (const n of doc.nodes)
    for (const p of descriptors.get(n.type)?.outputs ?? []) producibleTypes.add(p.type)

  for (const att of attachments) {
    if (att.kind === 'trigger') {
      validateTrigger(att, errors)
      continue
    }

    if (!isCheckpointId(att.checkpoint)) {
      errors.push({
        code: 'UNKNOWN_CHECKPOINT',
        message: `attachment names unknown checkpoint "${att.checkpoint}"`
      })
      continue
    }

    if (att.kind === 'rejoin' && att.anchor !== undefined) {
      // WP1.6b: the selector must name one of this checkpoint's anchor lanes.
      if (!resolveAnchorLane(CHECKPOINTS[att.checkpoint], att.anchor))
        errors.push({
          code: 'UNKNOWN_ANCHOR',
          message: `rejoin at "${att.checkpoint}" names unknown anchor port "${att.anchor}"`
        })
    }

    if (att.kind === 'entry' && att.mode === 'inline') {
      const want = CHECKPOINTS[att.checkpoint].valueType
      const canProduce = [...producibleTypes].some((have) => portCompatible(have, want))
      if (!canProduce)
        errors.push({
          code: 'INLINE_TYPE',
          message: `inline entry at "${att.checkpoint}" needs an output compatible with ${want}, but the fragment produces none`
        })
    }
  }
}

/** Validate ONE trigger attachment (WP2.1; ADR 0003/0004). Appends to `errors`. The grammar is
 *  documented in attachments.ts's header; the rules enforced here:
 *   - `state`: `source` must be a well-formed pointer (a non-empty `vars` path — TRIGGER_PATH; a
 *     `table` source with a known stat — the discriminated-union type + docSchema already close the
 *     stat set, so an out-of-set stat can only arrive from a hand-authored/cast doc), `op` must be
 *     from the closed set (TRIGGER_OP), and `value` must be a primitive of the right kind for the op
 *     (numeric for gt/gte/lt/lte/changedBy — TRIGGER_VALUE).
 *   - `cadence`: `everyNFloors` must be an integer ≥ 1 (CADENCE_N).
 *   - `manual`: no parameters — always valid.
 *  An unknown `trigger` discriminant (only reachable from a cast/hand-authored doc; the type + zod
 *  both close it) is UNKNOWN_TRIGGER. */
function validateTrigger(att: TriggerAttachment, errors: ValidationError[]): void {
  const kind = (att as { trigger?: unknown }).trigger
  if (kind === 'manual') return

  if (kind === 'cadence') {
    const n = (att as { everyNFloors?: unknown }).everyNFloors
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1)
      errors.push({
        code: 'CADENCE_N',
        message: `cadence trigger everyNFloors must be an integer ≥ 1, got ${JSON.stringify(n)}`
      })
    return
  }

  if (kind === 'state') {
    const src = (att as { source?: unknown }).source as
      | { scope?: unknown; path?: unknown; stat?: unknown }
      | undefined
    if (!src || typeof src !== 'object') {
      errors.push({ code: 'TRIGGER_SOURCE', message: 'state trigger needs a source' })
    } else if (src.scope === 'vars') {
      if (typeof src.path !== 'string' || !isWellFormedVarsPath(src.path))
        errors.push({
          code: 'TRIGGER_PATH',
          message: `state trigger vars path is empty or malformed: ${JSON.stringify(src.path)}`
        })
    } else if (src.scope === 'table') {
      // The TableStat set is closed by the type + docSchema; guard the cast/hand-authored path.
      if (!isTableStat(String(src.stat)))
        errors.push({
          code: 'TRIGGER_SOURCE',
          message: `state trigger table stat is unknown: ${JSON.stringify(src.stat)}`
        })
    } else {
      errors.push({
        code: 'TRIGGER_SOURCE',
        message: `state trigger has an unknown source scope: ${JSON.stringify(src.scope)}`
      })
    }

    const op = (att as { op?: unknown }).op
    if (typeof op !== 'string' || !isTriggerOp(op)) {
      errors.push({
        code: 'TRIGGER_OP',
        message: `state trigger op must be one of eq/ne/gt/gte/lt/lte/changedBy, got ${JSON.stringify(op)}`
      })
    } else {
      // Numeric ops (ordered comparisons + the changedBy delta) require a numeric literal value.
      const numericOp = op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte' || op === 'changedBy'
      const value = (att as { value?: unknown }).value
      const valueOk =
        typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean'
      if (!valueOk)
        errors.push({
          code: 'TRIGGER_VALUE',
          message: `state trigger value must be a number, string, or boolean, got ${JSON.stringify(value)}`
        })
      else if (numericOp && typeof value !== 'number')
        errors.push({
          code: 'TRIGGER_VALUE',
          message: `state trigger op "${op}" needs a numeric value, got ${JSON.stringify(value)}`
        })
    }
    return
  }

  errors.push({
    code: 'UNKNOWN_TRIGGER',
    message: `trigger attachment has an unknown kind: ${JSON.stringify(kind)}`
  })
}
