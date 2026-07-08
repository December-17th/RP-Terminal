import { z } from 'zod'
import { getPath } from '../../../../shared/objectPath'
import { log } from '../../logService'
import { NodeImpl } from '../types'

/**
 * Control-flow built-in nodes (Phase 2b-2 task 4): branch/gate a graph on a predicate over
 * some upstream value (spec §5 Signal gating, §11 node-state for `changed`). No node here
 * produces domain data — they only fire Signal outputs that the engine's gating (spec §5)
 * prunes dead branches from.
 */

/** The comparison ops `evalPredicate` understands (spec §5 predicate table). */
export const PREDICATE_OPS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'truthy',
  'falsy',
  'contains'
] as const

export type PredicateOp = (typeof PREDICATE_OPS)[number]

/** Evaluates one predicate op against a subject + optional comparison value.
 *  - eq/neq: deep equality via JSON.stringify (null-normalized), so `undefined` and `null`
 *    compare equal and objects/arrays compare by structure, not reference.
 *  - gt/gte/lt/lte: both sides coerced with `Number(...)` (numeric strings included).
 *  - truthy/falsy: plain JS truthiness of the subject.
 *  - contains: string subject → substring match (`value` stringified); array subject → some
 *    element deep-equal to `value`; anything else → false. */
export function evalPredicate(subject: unknown, op: PredicateOp, value?: unknown): boolean {
  switch (op) {
    case 'eq':
      return JSON.stringify(subject ?? null) === JSON.stringify(value ?? null)
    case 'neq':
      return JSON.stringify(subject ?? null) !== JSON.stringify(value ?? null)
    case 'gt':
      return Number(subject) > Number(value)
    case 'gte':
      return Number(subject) >= Number(value)
    case 'lt':
      return Number(subject) < Number(value)
    case 'lte':
      return Number(subject) <= Number(value)
    case 'truthy':
      return !!subject
    case 'falsy':
      return !subject
    case 'contains':
      if (typeof subject === 'string') return subject.includes(String(value))
      if (Array.isArray(subject)) {
        const target = JSON.stringify(value ?? null)
        return subject.some((el) => JSON.stringify(el ?? null) === target)
      }
      return false
  }
}

const ifConfigSchema = z.object({
  path: z.string().optional(),
  op: z.enum(PREDICATE_OPS),
  value: z.unknown().optional()
})

/** Branches on a predicate over `inputs.value` (optionally drilled into via `config.path`,
 *  bracket-aware MVU-style path): fires exactly one of `then`/`else` (spec §5). */
export const controlIf: NodeImpl = {
  type: 'control.if',
  title: 'If',
  inputs: [
    { name: 'value', type: 'Any' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [
    { name: 'then', type: 'Signal' },
    { name: 'else', type: 'Signal' }
  ],
  configSchema: ifConfigSchema,
  run: (_ctx, inputs, node) => {
    const cfg = node.config as z.infer<typeof ifConfigSchema>
    const subject = getPath(inputs.value, cfg.path || null)
    const result = evalPredicate(subject, cfg.op, cfg.value)
    return { signals: [result ? 'then' : 'else'] }
  }
}

const switchConfigSchema = z.object({
  path: z.string().optional(),
  cases: z.array(z.unknown()).max(4)
})

/** Matches `inputs.value` (optionally via `config.path`) against up to 4 configured `cases`
 *  by deep JSON equality, firing the FIRST matching `caseN` Signal output, else `default`
 *  (spec §5). */
export const controlSwitch: NodeImpl = {
  type: 'control.switch',
  title: 'Switch',
  inputs: [
    { name: 'value', type: 'Any' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [
    { name: 'case1', type: 'Signal' },
    { name: 'case2', type: 'Signal' },
    { name: 'case3', type: 'Signal' },
    { name: 'case4', type: 'Signal' },
    { name: 'default', type: 'Signal' }
  ],
  configSchema: switchConfigSchema,
  run: (_ctx, inputs, node) => {
    const cfg = node.config as z.infer<typeof switchConfigSchema>
    const subject = getPath(inputs.value, cfg.path || null)
    const target = JSON.stringify(subject ?? null)
    const idx = cfg.cases.findIndex((c) => JSON.stringify(c ?? null) === target)
    return { signals: [idx === -1 ? 'default' : `case${idx + 1}`] }
  }
}

const whenConfigSchema = z.object({
  path: z.string().optional(),
  op: z.enum([...PREDICATE_OPS, 'changed'] as const),
  value: z.unknown().optional()
})

/** Single-output gate: fires `fire` when the predicate over `inputs.value` (optionally via
 *  `config.path`) holds. The `changed` op is edge-triggered off durable node state (spec §11):
 *  it fires the first time this node ever sees a value, and again only when the value differs
 *  from what was last stored — state is left untouched on a non-firing tick. */
export const controlWhen: NodeImpl = {
  type: 'control.when',
  title: 'When',
  inputs: [
    { name: 'value', type: 'Any' },
    { name: 'when', type: 'Signal' }
  ],
  outputs: [{ name: 'fire', type: 'Signal' }],
  configSchema: whenConfigSchema,
  run: (ctx, inputs, node) => {
    const cfg = node.config as z.infer<typeof whenConfigSchema>
    const subject = getPath(inputs.value, cfg.path || null)

    if (cfg.op === 'changed') {
      const cur = JSON.stringify(subject ?? null)
      const prev = ctx.getNodeState(node.id) as { last?: string } | undefined
      const fired = prev?.last !== cur
      if (fired) ctx.setNodeState(node.id, { last: cur })
      return { signals: fired ? ['fire'] : [] }
    }

    const fired = evalPredicate(subject, cfg.op, cfg.value)
    return { signals: fired ? ['fire'] : [] }
  }
}

// ── control.mode ─────────────────────────────────────────────────────────────────────────────────
//
// Agent & memory UX WP-B (spec §3.1; plan §0.2 — the AUTHORITATIVE firing rule, a deliberate
// refinement of the spec's literal text). A generic mode selector placed AFTER triggers (triggers
// are inputless roots): each config option maps to one `when` slot — options[i] ↔ when{i+1} — and
// `fired` passes through ONLY the selected option's slot, making the modes structurally mutually
// exclusive (non-selected slots are dead ends). An imported system joins the exclusion by wiring
// its trigger into a free slot and adding an option (pure wiring; no app code).
//
// Firing rule (§0.2): `fired` fires iff
//   (the selected slot is WIRED and its key is present in `inputs` — the engine only creates a key
//    for a LIVE edge, so key-presence = "this slot fired")
//   OR (no whenN slot is wired at all — the true standalone config-driven gate case).
// An unwired selected slot in a wired graph is a DEAD END — which is exactly what makes an `off`
// option (a key with no wired slot) the master off-switch. The spec's literal "unwired selected
// slot fires unconditionally" would break `off` (a firing backlog trigger on another slot would
// un-gate the node); the refinement confines unconditional firing to the zero-wired-whens case.
//
// Engine interplay: when1..4 are Signal inputs, so if ANY slot is wired and NONE fired the engine
// gates the node off before run() (skipped, downstream dead) — run() only ever sees ≥1 live slot
// or zero wired slots. `wiredInputs` (NodeMeta, WP-B) supplies the wired-vs-unwired distinction.

/** One selectable mode: `key` is the stored value (`selected`), `label` the display text (the
 *  exposed-enum renderer falls back to `key` when absent — WP-C's options are key-only). */
const modeOptionSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1).optional()
})

const modeConfigSchema = z.object({
  /** Mode options in SLOT ORDER: options[i] corresponds to input when{i+1} (fixed 4-slot contract,
   *  matching control.switch's case1–4). An option whose slot is unwired (e.g. `off`) selects
   *  "nothing runs" — its slot is a dead end. */
  options: z
    .array(modeOptionSchema)
    .min(1)
    .max(4)
    .describe('Mode options in slot order: options[i] maps to input when{i+1}. 1–4 options.'),
  /** The selected option's key. A key not present in `options` fails soft to the first option
   *  (logged, trace-visible via the node's normal run). */
  selected: z
    .string()
    .min(1)
    .describe('The selected option key (must match an options[].key; falls back to the first).')
})

/** Mode selector (spec §3.1): passes through only the selected option's `when` slot; emits the
 *  selected key as Text whenever it runs. See the header comment for the exact firing rule. */
export const controlMode: NodeImpl = {
  type: 'control.mode',
  title: 'Mode',
  // WP-A dynamicEnum hint: `selected` is an enum whose options live in the sibling `options`
  // config array — the exposed-enum renderer resolves it from the node's current config.
  dynamicEnum: { path: 'selected', optionsPath: 'options', keyField: 'key', labelField: 'label' },
  inputs: [
    { name: 'when1', type: 'Signal' },
    { name: 'when2', type: 'Signal' },
    { name: 'when3', type: 'Signal' },
    { name: 'when4', type: 'Signal' }
  ],
  outputs: [
    { name: 'fired', type: 'Signal' },
    { name: 'selected', type: 'Text' }
  ],
  configSchema: modeConfigSchema,
  run: (_ctx, inputs, node) => {
    const cfg = node.config as z.infer<typeof modeConfigSchema>
    let selected = cfg.selected
    if (!cfg.options.some((o) => o.key === selected)) {
      // Fail-soft (plan WP-B): a stale selected key degrades to the first option, never a throw.
      log(
        'error',
        `control.mode ${node.id}: selected "${selected}" is not an option key; falling back to "${cfg.options[0].key}"`
      )
      selected = cfg.options[0].key
    }
    const slot = `when${cfg.options.findIndex((o) => o.key === selected) + 1}`
    const wired = node.wiredInputs ?? []
    const anyWhenWired = wired.some((p) => /^when[1-4]$/.test(p))
    // Key-presence = the slot's edge was LIVE this run (the engine creates the key even though a
    // Signal carries no value); a dead edge leaves the key absent.
    const selectedSlotFired = Object.prototype.hasOwnProperty.call(inputs, slot)
    const fires = (wired.includes(slot) && selectedSlotFired) || !anyWhenWired
    // `selected` Text is DATA, not a gate — emitted on every run (fail-soft-resolved key included).
    return { outputs: { selected }, signals: fires ? ['fired'] : [] }
  }
}
