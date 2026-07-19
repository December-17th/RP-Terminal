import { WorkflowDoc, NodeInstance, Edge } from '../../../shared/workflow/types'
import { computePhases } from '../workflowEngine'
import { buildDefaultMemoryDocV2 } from '../nodes/builtin/defaultMemoryTemplate'

/**
 * THE PREDICATE for the direct Classic orchestration (Classic Narrator first execution plan,
 * Milestone 3).
 *
 * Milestone 3 as written says "remove `runWorkflow` from synchronous Classic generation". Milestone 2's
 * evidence (test/workflow/classicTurnInventory.test.ts, its final case) proved that doing so
 * UNCONDITIONALLY is a capability REGRESSION, not a no-op:
 *  · production resolves a SAVED, USER-EDITABLE doc, so a node the user wires downstream of `write`
 *    lands in the detached post phase and genuinely RUNS there;
 *  · an open agent-pack gate splices extra nodes into the very graph the turn executes.
 * So this is a TWO-PATH design: Classic runs the direct orchestration only when the resolved doc's
 * turn phase is structurally identical to the seeded default AND nothing was composed into it.
 * Everything else keeps the existing `runWorkflow` path, completely unchanged. Preserving capability
 * outranks the literal exit criterion; which surface survives is Milestone 6's decision, not this one's.
 *
 * WHY A STRUCTURAL COMPARISON. There is no provenance signal for "unedited". `createWorkflowFromDoc`
 * stamps only a fresh id; `meta.seeded = 'default-memory-v2'` is a seeding IDEMPOTENCE marker that
 * survives every edit; `saveWorkflow` rewrites the doc verbatim with no version/hash/dirty flag. The
 * only reliable signal is comparing the doc against `buildDefaultMemoryDocV2()` (a pure builder).
 *
 * WHAT IS COMPARED, AND WHY THAT SCOPE:
 *  · every node, keyed by id: `type`, `disabled`, `isMainOutput`, and `panel`. `panel` is compared
 *    because a user who added an output panel to a spine node must fall back rather than lose it.
 *  · `config` ONLY for nodes in the reference's TURN PHASE (the `computePhases` pre closure — the
 *    engine's own definition, imported rather than re-derived). The seeded doc's most user-visible
 *    knobs (`control.mode.selected`, `trigger.cadence.everyNFloors`, the memory node's settings) are
 *    trigger-rooted and therefore OUTSIDE the turn phase: whole-doc equality would demote every user
 *    who merely switched memory Mode onto the workflow path for no behavioral reason.
 *  · the whole edge set. The post nodes must match the reference's post nodes structurally, which is
 *    what makes them provably inert on a turn — classicTurnInventory.test.ts pins that the reference's
 *    post group is trigger-rooted and never reached. A node the user hangs off `write` changes the
 *    node set and therefore falls back, which is exactly the capability Milestone 2 flagged.
 * IGNORED: doc-level id/name/description/meta/version, node `position`, and `groups` — all cosmetic or
 * identity fields that cannot change what a turn executes.
 *
 * FAIL-CLOSED. Any mismatch, any unrecognised shape, any composition ⇒ `false` ⇒ the unchanged
 * `runWorkflow` path. If `defaultMemoryTemplate.ts` changes without this comparator being revisited,
 * every user silently lands back on `runWorkflow` — correct, but invisible. That rot is caught by
 * test/generation/classicShape.test.ts's pinning case, which fails when the template moves.
 */

/** Stable JSON for a config object — key-order-insensitive so a re-serialized doc still matches. */
const stableJson = (value: unknown): string => {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
}

/** The comparable identity of one node. `withConfig` is true only inside the turn phase. */
const nodeKey = (n: NodeInstance, withConfig: boolean): string =>
  stableJson({
    type: n.type,
    disabled: n.disabled === true,
    isMainOutput: n.isMainOutput === true,
    panel: n.panel ?? null,
    ...(withConfig ? { config: n.config ?? {} } : {})
  })

const edgeKey = (e: Edge): string => `${e.from.node}:${e.from.port}->${e.to.node}:${e.to.port}`

const sameEdgeSet = (a: Edge[], b: Edge[]): boolean => {
  if (a.length !== b.length) return false
  const left = a.map(edgeKey).sort()
  const right = b.map(edgeKey).sort()
  return left.every((k, i) => k === right[i])
}

/** The reference doc + its turn-phase closure, built once (the builder is pure and the result is
 *  never mutated here — only read). */
let reference: { doc: WorkflowDoc; preIds: Set<string> } | null = null
const referenceShape = (): { doc: WorkflowDoc; preIds: Set<string> } => {
  if (!reference) {
    const doc = buildDefaultMemoryDocV2()
    reference = { doc, preIds: computePhases(doc).preIds }
  }
  return reference
}

/** The reference doc's turn-phase node ids — exported for the pinning test and for the direct
 *  orchestration's trace synthesis. */
export const classicTurnPhaseIds = (): Set<string> => new Set(referenceShape().preIds)

/**
 * Is this resolved effective doc structurally identical to the seeded default, with nothing composed
 * into it? True ⇒ the direct Classic orchestration reproduces it exactly. False ⇒ run `runWorkflow`.
 */
export const isClassicDirectShape = (doc: WorkflowDoc): boolean => {
  // 1. Pack composition. `composeEffectiveGraph` returns the narrator BY IDENTITY when no gate is open
  //    and stamps `meta.composition` only when it actually splices — so this is the zero-cost, reliable
  //    test for "an agent pack changed the graph".
  if ((doc.meta as { composition?: unknown } | undefined)?.composition) return false
  if (doc.kind === 'subgraph' || doc.kind === 'fragment') return false

  const ref = referenceShape()
  if (doc.nodes.length !== ref.doc.nodes.length) return false

  // 2. Doc shape, node by node (ids must match too — the direct path addresses stages by the
  //    reference's ids, and a renamed node is an edited graph either way).
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  for (const refNode of ref.doc.nodes) {
    const node = byId.get(refNode.id)
    if (!node) return false
    const inTurnPhase = ref.preIds.has(refNode.id)
    if (nodeKey(node, inTurnPhase) !== nodeKey(refNode, inTurnPhase)) return false
  }

  // 3. The wiring. Compared whole: the turn phase's own edges are what the direct path reproduces, and
  //    the rest is what keeps the post group provably inert (see the header).
  return sameEdgeSet(doc.edges, ref.doc.edges)
}
