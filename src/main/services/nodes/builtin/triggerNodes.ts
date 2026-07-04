import { z } from 'zod'
import { NodeImpl } from '../types'
import {
  TRIGGER_OPS,
  TABLE_STATS,
  TriggerAttachment
} from '../../../../shared/workflow/attachments'
import { NodeInstance } from '../../../../shared/workflow/types'

/**
 * Trigger nodes (one-canvas rebuild plan WP6.1; ADR 0011). A trigger node is a graph ROOT — no
 * inputs, one `Signal` output — that starts its downstream chain (an "agent"). Three v1 kinds mirror
 * the WP2.1 trigger grammar EXACTLY (attachments.ts TriggerAttachment): `trigger.state` (a comparison
 * over committed state), `trigger.cadence` (every N floors), `trigger.manual` (fired by an explicit
 * user action). The config on each node is the SAME shape as the corresponding TriggerAttachment body
 * minus the `kind`/`trigger` discriminants (those are carried by the node TYPE instead) — so a
 * trigger node and a WP2.1 trigger attachment describe/evaluate identically. `triggerAttachmentOf`
 * (below) reconstitutes the TriggerAttachment from a node so the headless evaluator + describeTrigger
 * reuse the WP2.1 machinery without duplication.
 *
 * ── HOW A TRIGGER GATES ITS CHAIN (the engine mechanism, grounded in workflowEngine.ts) ────────────
 * The trigger's ONE `Signal` output feeds the chain. Two coexisting execution paths:
 *  · TURN run (runWorkflow): trigger.* nodes are EXCLUDED at run start — never executed, their
 *    outgoing edges pre-seeded dead. The engine's existing prune rules (runNodes: `allDead` for a
 *    node whose every incoming edge is dead, `gatedOff` for a Signal-gated node whose Signal edges
 *    are all dead) then skip the whole downstream chain. So a trigger-rooted chain never runs in a
 *    turn WITHOUT any per-node special-casing (workflowEngine.ts computeExcluded + the dead-edge
 *    seed). A doc with NO trigger nodes seeds nothing → byte-identical turn behavior.
 *  · HEADLESS run (headlessRunService, WP6.1 doc path): when a trigger fires, its downstream closure
 *    runs headlessly. The trigger node's run() FIRES its `fired` Signal so a chain node with a
 *    `Signal` gate input (WP6.2's consolidated nodes) is un-gated and runs.
 */

// ── state trigger config ───────────────────────────────────────────────────────────────────────────
// Mirrors StateTrigger minus kind/trigger: a TriggerSource + op + value. TriggerSourceSchema here is
// the same discriminated union docSchema.ts declares for the attachment; kept local so this node file
// owns its config schema (the engine parses it before run()).
const TriggerSourceSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('vars'), path: z.string().min(1) }),
  z.object({ scope: z.literal('table'), table: z.string().min(1), stat: z.enum(TABLE_STATS) })
])

export const triggerStateConfig = z.object({
  source: TriggerSourceSchema,
  op: z.enum(TRIGGER_OPS),
  value: z.union([z.number(), z.string(), z.boolean()])
})

export const triggerCadenceConfig = z.object({
  everyNFloors: z.number().int().min(1)
})

// manual has no params.
export const triggerManualConfig = z.object({})

/** The Signal a trigger node fires when it runs (headless closure). Named `fired`. */
const FIRED = 'fired'

/** Whether a node type is a trigger root (any of the three trigger.* kinds). Grounds the engine's
 *  turn-exclusion + the headless doc scan — the single source of truth for "is this a trigger". */
export const TRIGGER_NODE_TYPES = ['trigger.state', 'trigger.cadence', 'trigger.manual'] as const
export const isTriggerNodeType = (type: string): boolean =>
  (TRIGGER_NODE_TYPES as readonly string[]).includes(type)

/** Reconstitute the WP2.1 TriggerAttachment a trigger node encodes, so the headless evaluator and
 *  describeTrigger reuse the existing machinery (attachments.ts) instead of a parallel one. Returns
 *  null for a non-trigger node or a malformed config (evaluator then simply skips it — a malformed
 *  doc never ran validation, or was hand-authored). */
export const triggerAttachmentOf = (node: NodeInstance): TriggerAttachment | null => {
  const cfg = node.config ?? {}
  if (node.type === 'trigger.manual') return { kind: 'trigger', trigger: 'manual' }
  if (node.type === 'trigger.cadence') {
    const r = triggerCadenceConfig.safeParse(cfg)
    if (!r.success) return null
    return { kind: 'trigger', trigger: 'cadence', everyNFloors: r.data.everyNFloors }
  }
  if (node.type === 'trigger.state') {
    const r = triggerStateConfig.safeParse(cfg)
    if (!r.success) return null
    return { kind: 'trigger', trigger: 'state', source: r.data.source, op: r.data.op, value: r.data.value }
  }
  return null
}

/** `trigger.state` — roots a chain; fires when a comparison over committed state holds. Timing config
 *  only in a turn (excluded); evaluated headlessly at commit boundaries. */
export const triggerState: NodeImpl = {
  type: 'trigger.state',
  title: 'State Trigger',
  inputs: [],
  outputs: [{ name: FIRED, type: 'Signal' }],
  isTrigger: true,
  configSchema: triggerStateConfig,
  // When executed (a headless closure seeded by a firing state trigger) it simply fires its signal —
  // the fire DECISION was already made by the evaluator; the node's job is only to un-gate the chain.
  run: () => ({ outputs: {}, signals: [FIRED] })
}

/** `trigger.cadence` — roots a chain; fires every N floors. */
export const triggerCadence: NodeImpl = {
  type: 'trigger.cadence',
  title: 'Cadence Trigger',
  inputs: [],
  outputs: [{ name: FIRED, type: 'Signal' }],
  isTrigger: true,
  configSchema: triggerCadenceConfig,
  run: () => ({ outputs: {}, signals: [FIRED] })
}

/** `trigger.manual` — roots a chain; fired only by an explicit user action (runManual), never at a
 *  boundary. */
export const triggerManual: NodeImpl = {
  type: 'trigger.manual',
  title: 'Manual Trigger',
  inputs: [],
  outputs: [{ name: FIRED, type: 'Signal' }],
  isTrigger: true,
  configSchema: triggerManualConfig,
  run: () => ({ outputs: {}, signals: [FIRED] })
}
