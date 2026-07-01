import { z } from 'zod'
import { getPath } from '../../../../shared/objectPath'
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
