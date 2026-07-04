// Trigger evaluator + headless runner for agent packs (agent-packs plan WP2.2; ADR 0003/0004).
//
// WHAT THIS DOES. At every COMMIT BOUNDARY (a turn commits, or a headless run commits — ADR 0004
// "evaluate at exactly two moments"), it evaluates every gate-open pack's trigger attachments
// against COMMITTED state and runs the fragments whose triggers fire, each as its own headless
// engine run. Headless runs communicate with turns ONLY through durable state (ADR 0003): they read
// committed state, write committed state, and NEVER block a turn — the turn boundary schedules
// evaluation fire-and-forget (generationService).
//
// ── LOCKS (controller decision 2; plan Amendments "after WP1.5") ─────────────────────────────────
// This runner takes NO outer table:/vars: lock around its critical sections. The write services
// (floorService.saveFloor → vars:<chat>, table.apply → table:<chat>) already serialize each write
// operation under their own per-op lock (WP1.5). asyncLock is NON-REENTRANT: wrapping a section here
// in withLock(varsLockKey/tableLockKey) and then calling saveFloor/applySqlBatch (same key) INSIDE
// would DEADLOCK (asyncLock.ts REENTRANCY warning). Read-modify-write interleaving across awaits is
// tolerated BY DESIGN: the state-mediated pattern (ADR 0003) requires headless effects to be
// idempotent-ish and progress-pointer-guarded (e.g. the table.gate cadence advances a MAX pointer),
// not transactionally isolated. So we rely on the services' own locks; we never nest one.
//
// ── FAIL-OPEN / nodeModes are IRRELEVANT here ────────────────────────────────────────────────────
// The engine's branch-vs-inline fail-open policy (WP1.3) protects a TURN's reply from a failing
// branch fragment. A headless run has no reply to protect — it IS the whole run — so nodeModes do
// not apply; a headless fragment failing simply produces a failed trace and writes nothing. We catch
// everything so a failure never surfaces to any chat flow (ADR 0003).

import { AttachmentDecl, TriggerAttachment } from '../../shared/workflow/attachments'
import { WorkflowDoc, NodeInstance, Edge } from '../../shared/workflow/types'
import { getPath } from '../../shared/objectPath'
import { summarizeRun, describeTrigger, RunOrigin } from '../../shared/workflow/trace'
import { runSubgraph } from './workflowEngine'
import { builtinRegistry } from './nodes/builtin'
import { RunContext } from './nodes/types'
import { notifyWorkflowTrace } from './workflowEvents'
import { appendRun } from './runHistoryStore'
import { randomUUID } from 'crypto'
import { enabledFragmentsFor } from './agentPackService'
import { getChat } from './chatService'
import { getFloor } from './floorService'
import { buildGenContext } from './generation/genContext'
import { getTablesStatus } from './tableStatusService'
import {
  getTriggerState,
  setTriggerLastValue,
  setTriggerLastFireFloor
} from './agentPackTriggerStore'
import {
  getDocTriggerState,
  setDocTriggerLastValue,
  setDocTriggerLastFireFloor
} from './workflowTriggerStore'
import { resolveWorkflowDoc } from './workflowService'
import { isTriggerNodeType, triggerAttachmentOf } from './nodes/builtin/triggerNodes'
import { log } from './logService'

/** What started an evaluation pass: a player turn, or a prior headless run's commit (ADR 0004 — the
 *  two commit boundaries). Cadence/state read the same committed state either way; `cause` only feeds
 *  the depth accounting (headless-caused runs carry depth+1, turn-caused runs start at 0). */
export type EvalCause = 'turn' | 'headless'

/** Per-chain depth cap (ADR 0004 consequence 2: "a per-chain depth cap prevents two packs from
 *  ping-ponging forever"). A RUNTIME constant, NOT per-pack config. Runs started from cause
 *  'headless' carry depth+1; at depth >= this cap we log + skip evaluation entirely, breaking any
 *  trigger→run→trigger chain. The plan (WP2.2, ADR 0004) pins the default at 3. */
export const HEADLESS_DEPTH_CAP = 3

/** Per-chat in-flight guard (turn-boundary reentrancy). A turn landing MID headless-chain must not
 *  double-schedule an evaluation pass for the same chat: the chain's own commit re-evaluates anyway,
 *  so a concurrent turn-caused pass would run the same packs twice against the same committed state.
 *  We flip this true for the duration of a chat's evaluate+run pass and skip a re-entrant pass. Keyed
 *  per chat so different chats never contend. */
const evaluatingChats = new Set<string>()

// ── Trigger evaluation ───────────────────────────────────────────────────────────────────────────

/** A pack whose trigger(s) fired at this boundary, with its fragment doc (deduped per pack — decision
 *  1: multiple firing triggers on one pack run the pack ONCE). `firedTriggers` are the descriptions of
 *  every trigger that fired (OR-dedupe may fire several on one pack — WP2.3 joins them for the run
 *  record's trigger caption). */
interface FiredPack {
  packId: string
  doc: WorkflowDoc
  firedTriggers: string[]
}

/** The latest committed floor's `variables` tree (incl. MVU stat_data), for a `vars`-scoped trigger.
 *  Reads the LAST floor by index (floor_count − 1); `{}` when the chat has no floors yet. This is the
 *  "latest committed floor-var state" the grammar (attachments.ts) points a vars path at. */
const latestFloorVars = (profileId: string, chatId: string): Record<string, unknown> => {
  const chat = getChat(profileId, chatId)
  if (!chat || chat.floor_count <= 0) return {}
  const floor = getFloor(profileId, chatId, chat.floor_count - 1)
  return (floor?.variables as Record<string, unknown> | undefined) ?? {}
}

/** The 0-based index of the latest committed floor (floor_count − 1); −1 for an empty chat. Matches
 *  tableProgressService's `currentFloor` convention (getAllFloors().length − 1). */
const latestFloorIndex = (profileId: string, chatId: string): number => {
  const chat = getChat(profileId, chatId)
  return (chat?.floor_count ?? 0) - 1
}

/** Read a state trigger's numeric/primitive source value from committed state. Returns undefined when
 *  the path/stat is absent (the evaluator's concern per the grammar — a missing vars path reads
 *  undefined, a missing table reads undefined). */
const readSource = (
  profileId: string,
  chatId: string,
  source: Extract<TriggerAttachment, { trigger: 'state' }>['source']
): unknown => {
  if (source.scope === 'vars') {
    return getPath(latestFloorVars(profileId, chatId), source.path)
  }
  // table scope: pull the closed maintenance stat from the chat's table status.
  const status = getTablesStatus(profileId, chatId)[source.table]
  if (!status) return undefined
  return status[source.stat]
}

/** Point-comparison ops (everything but changedBy). Numeric ops require both sides numeric at eval
 *  time (validation pins the literal numeric; the SOURCE could still be non-numeric — then no fire). */
const comparePoint = (op: string, actual: unknown, want: number | string | boolean): boolean => {
  switch (op) {
    case 'eq':
      return actual === want
    case 'ne':
      return actual !== want
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (typeof actual !== 'number' || typeof want !== 'number') return false
      return op === 'gt'
        ? actual > want
        : op === 'gte'
          ? actual >= want
          : op === 'lt'
            ? actual < want
            : actual <= want
    }
    default:
      return false
  }
}

/** The per-trigger baseline accessor `evaluateTriggerCore` reads/writes — the ONLY difference between
 *  the pack path (keyed (chat, pack, trigger index) → agentPackTriggerStore) and the doc path (keyed
 *  (chat, doc, node id) → workflowTriggerStore). Extracting it keeps the changedBy/cadence evaluation
 *  logic ONE implementation, characterization-identical across both paths. */
interface TriggerBaselineAccessor {
  get: () => { lastValue: number | null; lastFireFloor: number | null } | null
  setLastValue: (value: number) => void
  setLastFireFloor: (floor: number) => void
}

/** The store-agnostic trigger evaluation core (WP2.2 semantics, unchanged — the pack path wraps this
 *  with the pack store, the WP6.1 doc path with the doc store). Evaluates ONE trigger against committed
 *  state; returns whether it fires; has the SIDE EFFECT of advancing the stateful baselines
 *  (changedBy lastValue, cadence lastFireFloor) via `acc`. Manual never fires from a boundary. */
const evaluateTriggerCore = (
  profileId: string,
  chatId: string,
  att: TriggerAttachment,
  acc: TriggerBaselineAccessor
): boolean => {
  if (att.trigger === 'manual') return false

  if (att.trigger === 'cadence') {
    const current = latestFloorIndex(profileId, chatId)
    if (current < 0) return false // no committed floor yet → nothing to fire on
    const prior = acc.get()?.lastFireFloor
    const lastFire = prior ?? -1 // never fired → -1, so N floors from floor 0 fires at index N−1
    // Fire when at least N floors have elapsed since the last fire. With lastFire −1 and N=3 this
    // first fires at floor index 2 (floors 0,1,2), matching computeTableProgress's nextExpected
    // (= last + freq) for a never-processed table.
    if (current - lastFire >= att.everyNFloors) {
      acc.setLastFireFloor(current)
      return true
    }
    return false
  }

  // state trigger
  const actual = readSource(profileId, chatId, att.source)

  if (att.op === 'changedBy') {
    // Delta op: fire on (current − valueAtLastEvaluation) >= delta. Numeric-only (validation pins a
    // numeric literal + a numeric source is required at eval time). First-ever evaluation has no
    // prior value → baseline to current, no fire (attachments.ts grammar).
    if (typeof actual !== 'number') return false
    const prior = acc.get()?.lastValue
    if (prior == null) {
      acc.setLastValue(actual)
      return false // baseline-on-first-evaluation, no fire
    }
    if (actual - prior >= (att.value as number)) {
      acc.setLastValue(actual) // advance the baseline on fire
      return true
    }
    return false
  }

  return comparePoint(att.op, actual, att.value)
}

/** Evaluate ONE trigger against committed state; returns whether it fires. Has the SIDE EFFECT of
 *  advancing the persisted baseline for the stateful kinds (changedBy lastValue, cadence
 *  lastFireFloor) — evaluation and baseline-advance are one step, matching the grammar's
 *  "since this trigger was last evaluated" semantics (attachments.ts). Non-stateful point ops and
 *  manual triggers persist nothing. Manual NEVER fires from a boundary (only runManual).
 *  (Pack path: wraps `evaluateTriggerCore` with the pack-keyed store.) */
const evaluateOneTrigger = (
  profileId: string,
  chatId: string,
  packId: string,
  triggerIndex: number,
  att: TriggerAttachment
): boolean =>
  evaluateTriggerCore(profileId, chatId, att, {
    get: () => getTriggerState(chatId, packId, triggerIndex),
    setLastValue: (v) => setTriggerLastValue(chatId, packId, triggerIndex, v),
    setLastFireFloor: (f) => setTriggerLastFireFloor(chatId, packId, triggerIndex, f)
  })

// ── READ-ONLY trigger explanation (agent-packs plan WP3.5 — the "why?" popover) ─────────────────────
//
// The Agents "Why?" popover answers "why isn't this pack running?" for a gate-open pack whose triggers
// have not fired. It needs the SAME evaluation `evaluateOneTrigger` does, but as a PURE READ: it must
// NOT advance any baseline (changedBy lastValue) or fire (cadence lastFireFloor) — calling it twice must
// leave the trigger store untouched. So it reuses the read-only halves (readSource, latestFloorIndex,
// getTriggerState, comparePoint) WITHOUT the setters. The controller decision (WP3.3 friction) routes
// explain-why through LIVE state + history rather than a stored skip-reason; this is the live half.
//
// GROUNDING against evaluateOneTrigger (behavior parity, read-only): for each kind we compute the same
// fire decision it would, but report the numbers that make it scannable instead of mutating:
//   · cadence  → floorsUntilDue = everyNFloors − (current − lastFire); met when ≤ 0. lastFireFloor is
//     the persisted floor (null → never fired, treated as −1 like the evaluator).
//   · changedBy → baseline = getTriggerState.lastValue (null → not yet baselined, never fires this pass);
//     current = the numeric source; met when (current − baseline) ≥ delta. First-ever (null baseline)
//     reports met:false with no baseline (matches the evaluator's baseline-on-first-eval, no-fire).
//   · point ops → current = the source value; met = comparePoint(op, current, value); required = value.

/** One trigger's explanation for the popover (agent-packs plan WP3.5). All fields are READ-ONLY
 *  derivations against committed state — assembling this NEVER advances a baseline or fires. */
export interface TriggerExplanation {
  /** The human-readable trigger description (describeTrigger) — the same caption the timeline shows. */
  description: string
  /** state | cadence | manual — lets the renderer pick the right sentence template. */
  kind: 'state' | 'cadence' | 'manual'
  /** Whether the trigger WOULD fire against committed state right now (manual → always false). */
  met: boolean
  /** The current source reading (state) — a number/string/boolean, or undefined when the path is absent. */
  current?: number | string | boolean
  /** The comparison value / everyNFloors the trigger requires (state + cadence). */
  required?: number | string | boolean
  /** changedBy only: the retained baseline (valueAtLastEvaluation); absent when not yet baselined. */
  baseline?: number
  /** cadence only: the floor this trigger last fired at (from the store); absent when it never fired. */
  lastFireFloor?: number
  /** cadence only: how many more floors until it is due (≤ 0 when due now). */
  floorsUntilDue?: number
}

/** Explain ONE trigger read-only (agent-packs plan WP3.5): compute the same fire decision
 *  `evaluateOneTrigger` would, but report the scannable numbers and NEVER mutate the trigger store. */
const explainOneTrigger = (
  profileId: string,
  chatId: string,
  packId: string,
  triggerIndex: number,
  att: TriggerAttachment
): TriggerExplanation => {
  const description = describeTrigger(att)

  if (att.trigger === 'manual') {
    return { description, kind: 'manual', met: false }
  }

  if (att.trigger === 'cadence') {
    const current = latestFloorIndex(profileId, chatId)
    const prior = getTriggerState(chatId, packId, triggerIndex)?.lastFireFloor
    const lastFire = prior ?? -1
    // Mirror evaluateOneTrigger: no committed floor yet (current < 0) never fires. floorsUntilDue is
    // how many more floors before (current − lastFire) >= everyNFloors; ≤ 0 means due now.
    const met = current >= 0 && current - lastFire >= att.everyNFloors
    const floorsUntilDue = att.everyNFloors - (current - lastFire)
    return {
      description,
      kind: 'cadence',
      met,
      required: att.everyNFloors,
      ...(prior != null ? { lastFireFloor: prior } : {}),
      floorsUntilDue
    }
  }

  // state trigger
  const actual = readSource(profileId, chatId, att.source)
  const currentPrimitive =
    typeof actual === 'number' || typeof actual === 'string' || typeof actual === 'boolean'
      ? actual
      : undefined

  if (att.op === 'changedBy') {
    const prior = getTriggerState(chatId, packId, triggerIndex)?.lastValue
    // First-ever evaluation (null baseline) or a non-numeric source → not met (matches the evaluator's
    // baseline-on-first-eval + numeric-only rule). When baselined, met on (current − baseline) >= delta.
    const met =
      typeof actual === 'number' && prior != null && actual - prior >= (att.value as number)
    return {
      description,
      kind: 'state',
      met,
      required: att.value,
      ...(currentPrimitive !== undefined ? { current: currentPrimitive } : {}),
      ...(prior != null ? { baseline: prior } : {})
    }
  }

  return {
    description,
    kind: 'state',
    met: comparePoint(att.op, actual, att.value),
    required: att.value,
    ...(currentPrimitive !== undefined ? { current: currentPrimitive } : {})
  }
}

/** Explain a gate-open pack's trigger attachments read-only (agent-packs plan WP3.5). Resolves the
 *  pack's MATERIALIZED fragment (via enabledFragmentsFor — the same override path turns + headless use,
 *  so an N=10 override is reflected as required:10) and returns one TriggerExplanation per trigger
 *  attachment. READ-ONLY: it advances no baseline and fires nothing — calling it twice leaves the
 *  trigger store untouched. Returns [] when the pack is not gate-open for the chat (nothing to explain
 *  — the popover then answers from gate state instead). */
export const explainTriggers = (
  profileId: string,
  chatId: string,
  packId: string
): TriggerExplanation[] => {
  const frag = enabledFragmentsFor(profileId, chatId).find((f) => f.packId === packId)
  if (!frag) return []
  const attachments: AttachmentDecl[] = frag.doc.attachments ?? []
  const out: TriggerExplanation[] = []
  attachments.forEach((att, i) => {
    if (att.kind !== 'trigger') return
    out.push(explainOneTrigger(profileId, chatId, packId, i, att))
  })
  return out
}

/** Evaluate every gate-open pack's triggers against committed state and run the packs whose triggers
 *  fire — sequentially, in deterministic pack-id order (decision 1: no parallel headless runs in v1;
 *  write-lock pressure + trace clarity — a documented v1 simplification). OR-deduped per pack per
 *  boundary (any firing trigger runs the pack ONCE). Depth cap (ADR 0004): a run started from cause
 *  'headless' carries depth+1; at depth >= HEADLESS_DEPTH_CAP we log + skip evaluation entirely,
 *  breaking the chain. Guarded per-chat against reentrancy so a turn landing mid-chain does not
 *  double-schedule (the chain's own commit re-evaluates).
 *
 *  Resolves when the whole pass (evaluate + every fired run) has settled. The TURN boundary calls
 *  this fire-and-forget (never awaited on the turn's critical path — ADR 0003); a headless run's own
 *  commit awaits it so the chain is sequential and the depth cap is honored. */
export const evaluateTriggers = async (
  profileId: string,
  chatId: string,
  cause: EvalCause,
  depth: number
): Promise<void> => {
  if (depth >= HEADLESS_DEPTH_CAP) {
    log(
      'info',
      `headless: depth cap (${HEADLESS_DEPTH_CAP}) reached for chat ${chatId} (cause: ${cause}) — skipping trigger evaluation (breaking the chain)`
    )
    return
  }

  if (evaluatingChats.has(chatId)) {
    // A pass is already in flight for this chat. Skip so a turn landing MID headless-chain does not
    // double-schedule: the running chain re-evaluates against committed state on its own commit
    // (evaluatePass, below), so no pack is missed. NOTE the chain's OWN recursion does NOT come
    // through here — runHeadless calls evaluatePass directly (already inside this guarded region);
    // only an OUTER entry (a turn boundary, or a manual/programmatic call) hits this guard.
    return
  }
  evaluatingChats.add(chatId)
  try {
    await evaluatePass(profileId, chatId, depth)
  } finally {
    evaluatingChats.delete(chatId)
  }
}

/** The actual evaluate-and-run pass (guard-free). Called by evaluateTriggers (once the per-chat
 *  in-flight guard is set) AND by runHeadless for chain continuation (already inside the guarded
 *  region — re-taking the guard would wrongly break the chain at depth 1). The DEPTH CAP still
 *  applies to the chain: runHeadless passes depth+1 and this returns early at the cap. */
const evaluatePass = async (profileId: string, chatId: string, depth: number): Promise<void> => {
  if (depth >= HEADLESS_DEPTH_CAP) {
    log(
      'info',
      `headless: depth cap (${HEADLESS_DEPTH_CAP}) reached for chat ${chatId} — skipping trigger evaluation (breaking the chain)`
    )
    return
  }
  const fragments = enabledFragmentsFor(profileId, chatId)
  const fired: FiredPack[] = []
  for (const frag of fragments) {
    const attachments: AttachmentDecl[] = frag.doc.attachments ?? []
    const firedTriggers: string[] = []
    attachments.forEach((att, i) => {
      if (att.kind !== 'trigger') return
      // OR-dedupe (decision 1): once a pack has a firing trigger it runs once — but we still
      // evaluate the rest so their baselines (changedBy/cadence) advance this boundary. Collect each
      // firing trigger's description for the run record's caption (WP2.3).
      const fires = evaluateOneTrigger(profileId, chatId, frag.packId, i, att)
      if (fires) firedTriggers.push(describeTrigger(att))
    })
    if (firedTriggers.length) fired.push({ packId: frag.packId, doc: frag.doc, firedTriggers })
  }

  // Deterministic order: pack id. Sequential — no parallel headless runs in v1.
  fired.sort((a, b) => a.packId.localeCompare(b.packId))
  for (const pack of fired) {
    // Multiple firing triggers → join their descriptions (OR-dedupe ran the pack once).
    await runHeadless(profileId, chatId, pack.packId, pack.doc, depth, {
      origin: 'headless',
      trigger: pack.firedTriggers.join(' | ')
    })
  }
}

// ── Headless run ─────────────────────────────────────────────────────────────────────────────────

/** slot names on subgraph.input (subgraphNodes.ts:53): `gen`/`in1..in4`. We feed a source
 *  checkpoint's value into a fragment entry port through a synthetic subgraph.input seed node on one
 *  of these slots (see runHeadless). prompt-assembly is a rejoin SINK, never an entry, so it has no
 *  seed here. */
const CHECKPOINT_SEED_SLOT: Record<string, string> = {
  'context-ready': 'gen',
  'turn-committed': 'in1',
  'reply-parsed': 'in2'
}

/**
 * Execute a pack's fragment as its own headless engine run, then broadcast its trace and re-evaluate
 * triggers (the headless commit boundary — ADR 0004). Failures NEVER propagate to any chat flow: we
 * catch everything (ADR 0003).
 *
 * ── HOW ENTRY ATTACHMENTS ARE FED (the runSubgraph fit) ──────────────────────────────────────────
 * runSubgraph is the no-main-output engine path, but it seeds ONLY `subgraph.input` nodes
 * (subgraphNodes.ts:70 reads ctx.subgraphSeeds?.[cfg.slot]); a fragment's entry ports are ORDINARY
 * input ports on ordinary nodes (attachments.ts EntryAttachment.entryPort, e.g. tableMemoryPack's
 * `{node:'export', port:'gen'}`), which runSubgraph cannot reach directly. So we ADAPT the fragment
 * into a runnable subgraph doc: per distinct SOURCE checkpoint used by an entry, we add ONE
 * synthetic `subgraph.input` node and wire its `value` output into every entry port at that
 * checkpoint, then seed the slot with the checkpoint's real value:
 *   · context-ready → a FRESH Context (buildGenContext — a committed-state read, no side effects);
 *   · turn-committed → the latest committed floor (getFloor at floor_count−1).
 * Rejoin attachments are IGNORED (decision 3: no narrator to rejoin into headlessly — headless
 * communicates through durable state only, ADR 0003). A fragment node with no feedable entry input
 * still runs if the graph reaches it (roots) — runSubgraph runs the whole topo order. This mirrors
 * the subgraph boundary-seed convention (subgraph.input carries a slot) rather than forcing the
 * fragment's authored entryPort convention through a path that cannot express it.
 */
export const runHeadless = async (
  profileId: string,
  chatId: string,
  packId: string,
  fragment: WorkflowDoc,
  depth: number,
  annotation: { origin: RunOrigin; trigger?: string } = { origin: 'headless' }
): Promise<void> => {
  const workflowId = `headless:${packId}`
  const startedAt = Date.now()
  const controller = new AbortController()

  try {
    const attachments: AttachmentDecl[] = fragment.attachments ?? []

    // Which SOURCE checkpoints have at least one entry, and the entry ports at each. Only source
    // checkpoints seed a value (prompt-assembly is a rejoin sink — no entries land there).
    const seedNodes: NodeInstance[] = []
    const seedEdges: Edge[] = []
    const seeds: Record<string, unknown> = {}
    const seededCheckpoints = new Set<string>()

    for (const att of attachments) {
      if (att.kind !== 'entry' || !att.entryPort) continue
      const slot = CHECKPOINT_SEED_SLOT[att.checkpoint]
      if (!slot) continue // a non-source checkpoint entry — nothing to seed (shouldn't occur)
      if (!seededCheckpoints.has(att.checkpoint)) {
        seededCheckpoints.add(att.checkpoint)
        const inputId = `__headless_seed_${slot}`
        seedNodes.push({ id: inputId, type: 'subgraph.input', config: { slot } })
        // Resolve the checkpoint's real value once (lazily per checkpoint).
        if (att.checkpoint === 'context-ready') {
          // A fresh Context. No user action headlessly → empty string (context.action reads it; a
          // headless maintenance pass does not answer a pending message — ADR 0003).
          seeds[slot] = buildGenContext(profileId, chatId, '')
        } else if (att.checkpoint === 'turn-committed') {
          const idx = latestFloorIndex(profileId, chatId)
          seeds[slot] = idx >= 0 ? getFloor(profileId, chatId, idx) : undefined
        }
      }
      const inputId = `__headless_seed_${slot}`
      seedEdges.push({
        from: { node: inputId, port: 'value' },
        to: { node: att.entryPort.node, port: att.entryPort.port }
      })
    }

    // The runnable doc: the fragment as a subgraph (skips the main-output rule; runSubgraph runs the
    // whole topo order in one pass), plus the synthetic seed nodes/edges. Deep-clone so the stored
    // fragment is never mutated.
    const runnable: WorkflowDoc = {
      ...structuredClone(fragment),
      kind: 'subgraph',
      nodes: [...structuredClone(fragment.nodes), ...seedNodes],
      edges: [...structuredClone(fragment.edges), ...seedEdges]
    }

    const ctx: RunContext = {
      profileId,
      chatId,
      workflowId,
      userAction: '',
      signal: controller.signal,
      streamMain: () => {}, // no chat message to stream — headless writes durable state only
      emitPanel: () => {},
      getNodeState: () => undefined,
      setNodeState: () => {}
    }

    const result = await runSubgraph(runnable, builtinRegistry, ctx, seeds)

    // Broadcast the trace so the debug trace panel shows the headless run. summarizeRun accepts the
    // run structurally. NOTE the trace's node set includes the synthetic `__headless_seed_*` adapter
    // nodes — we store it FAITHFULLY (WP2.3); filtering them from the timeline DISPLAY is WP3.3's job.
    const trace = summarizeRun(
      runnable,
      builtinRegistry.descriptors(),
      {
        ok: !result.aborted && !result.fatal,
        aborted: result.aborted,
        traces: result.traces,
        outputs: new Map()
      },
      { chatId, workflowId, startedAt, durationMs: Date.now() - startedAt }
    )
    notifyWorkflowTrace(trace)
    // Persist to durable run history for the phase-3 Runs timeline (WP2.3). origin is 'headless' or
    // 'manual' (threaded from the caller); packIds is the single pack that ran; trigger is the joined
    // description(s) of the firing trigger(s) ('manual' for a manual run). A persistence failure NEVER
    // surfaces to any chat flow (ADR 0003) — caught + logged, the run is unaffected.
    try {
      appendRun(profileId, {
        runId: randomUUID(),
        seq: 0, // assigned by the store
        origin: annotation.origin,
        packIds: [packId],
        ...(annotation.trigger ? { trigger: annotation.trigger } : {}),
        trace
      })
    } catch (err) {
      log(
        'error',
        `run-history persist (${annotation.origin}) failed — ${err instanceof Error ? err.message : String(err)}`
      )
    }
    if (result.fatal)
      log(
        'error',
        `headless run "${packId}" failed: ${result.fatal.message} (never surfaced to the chat)`
      )
  } catch (err) {
    // A failure here NEVER surfaces to any chat flow (ADR 0003) — log and move on.
    log(
      'error',
      `headless run "${packId}" threw: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  // The headless COMMIT boundary (ADR 0004): re-evaluate triggers with depth+1 so a deliberate chain
  // can continue, bounded by the depth cap. We call evaluatePass DIRECTLY (not evaluateTriggers): we
  // are already inside the guarded region the outer evaluateTriggers set, and re-taking the per-chat
  // in-flight guard here would wrongly break the chain at depth 1. Awaited so the chain is sequential
  // (the top-level pass only settles when the whole chain has).
  await evaluatePass(profileId, chatId, depth + 1)
}

// ── Manual trigger (thin export for WP3.x) ─────────────────────────────────────────────────────────

/** Run a pack's fragment on an explicit user action, bypassing trigger evaluation (manual triggers
 *  NEVER fire from a boundary — only here). A thin export for the WP3.x "run now" control; it runs
 *  the fragment exactly like a headless run (depth 0 → its commit re-evaluates other packs' triggers
 *  normally). No-op + logs if the pack is not gate-open for the chat. */
export const runManual = async (
  profileId: string,
  chatId: string,
  packId: string
): Promise<void> => {
  const frag = enabledFragmentsFor(profileId, chatId).find((f) => f.packId === packId)
  if (!frag) {
    log('error', `runManual: pack "${packId}" is not gate-open for chat ${chatId} — nothing to run`)
    return
  }
  await runHeadless(profileId, chatId, packId, frag.doc, 0, { origin: 'manual', trigger: 'manual' })
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// DOC-DRIVEN headless path (one-canvas rebuild WP6.1; ADR 0011)
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// The pack path above (evaluateTriggers/runHeadless/runManual) stays working UNCHANGED — both paths
// coexist until WP6.2/6.5. This half reads the chat's ACTIVE workflow doc (resolveWorkflowDoc, NOT the
// effective/pack path), scans it for `trigger.*` NODES, evaluates their configs against committed
// state (reusing evaluateTriggerCore — characterization-identical to the pack path), and runs the
// fired trigger's downstream CLOSURE headlessly. Baselines persist keyed (chat_id, doc_id, node_id) in
// the sibling workflow_trigger_state table (pack-era rows untouched).

/** Per-chat in-flight guard for the DOC path — the sibling of `evaluatingChats`, kept SEPARATE so the
 *  two coexisting paths never suppress each other's evaluation (a doc-path pass in flight must not skip
 *  a pack-path pass, and vice-versa). Reentrancy within the doc path (its own chain continuation) is
 *  handled by calling evaluateDocPass directly, exactly as the pack path does. */
const evaluatingDocChats = new Set<string>()

/** The nodes a fired trigger's chain executes headlessly (WP6.1). Computed in two steps:
 *   1. FORWARD reachability from the trigger — the chain's body (the nodes the trigger's signal drives).
 *   2. Pull in the INPUT PROVIDERS of that body: the ancestors of the forward set, so a chain node that
 *      reads context from a root like `input.context` (a graph ROOT — never downstream of the trigger,
 *      but self-seeds off RunContext) or from any other upstream feeder is present in the runnable doc.
 *      Ancestor expansion STOPS AT other trigger nodes (they root their OWN agents — a different chain)
 *      by never crossing into them.
 *  The result is exactly the agent's chain: its trigger, its body, and the feeders those body nodes
 *  need. A node shared with the narrator (also a narrator ancestor) lands in here too and is run
 *  headlessly against committed state — the documented v0 shared-node rule; turn runs are unaffected
 *  (they exclude the trigger and run the narrator normally). */
const forwardClosure = (doc: WorkflowDoc, startId: string): Set<string> => {
  const outAdj = new Map<string, string[]>(doc.nodes.map((n) => [n.id, []]))
  const inAdj = new Map<string, string[]>(doc.nodes.map((n) => [n.id, []]))
  for (const e of doc.edges) {
    outAdj.get(e.from.node)?.push(e.to.node)
    inAdj.get(e.to.node)?.push(e.from.node)
  }
  const isOtherTrigger = (id: string): boolean =>
    id !== startId && isTriggerNodeType(doc.nodes.find((n) => n.id === id)?.type ?? '')

  // 1. Forward reachability (the body).
  const closure = new Set<string>([startId])
  const fwd = [startId]
  while (fwd.length) {
    const cur = fwd.pop()!
    for (const next of outAdj.get(cur) ?? []) {
      if (!closure.has(next)) {
        closure.add(next)
        fwd.push(next)
      }
    }
  }

  // 2. Ancestor input-providers of the body (stopping at other triggers — a different chain).
  const back = [...closure]
  while (back.length) {
    const cur = back.pop()!
    for (const parent of inAdj.get(cur) ?? []) {
      if (closure.has(parent) || isOtherTrigger(parent)) continue
      closure.add(parent)
      back.push(parent)
    }
  }
  return closure
}

/** A fired trigger node with its reconstituted attachment (for describeTrigger) and its closure. */
interface FiredTrigger {
  nodeId: string
  att: TriggerAttachment
  closure: Set<string>
}

/** Group fired triggers into CHAINS by closure overlap (OR-dedupe per chain — decision: two triggers
 *  wired into ONE chain run it ONCE). Two fired triggers share a chain iff their forward closures
 *  intersect (they feed a common downstream node). Returns one group per distinct chain, each carrying
 *  the UNION closure of its triggers + every trigger's description. A simple union-find over the fired
 *  set (fired sets are small — a handful of agents per doc). */
const groupFiredIntoChains = (
  fired: FiredTrigger[]
): { closure: Set<string>; triggerNodeIds: string[]; descriptions: string[]; seedNodeIds: string[] }[] => {
  const groups: FiredTrigger[][] = []
  for (const f of fired) {
    // Find an existing group whose union closure overlaps this trigger's closure.
    const hit = groups.find((g) =>
      g.some((m) => [...f.closure].some((id) => m.closure.has(id)))
    )
    if (hit) hit.push(f)
    else groups.push([f])
  }
  return groups.map((g) => {
    const closure = new Set<string>()
    for (const m of g) for (const id of m.closure) closure.add(id)
    return {
      closure,
      triggerNodeIds: g.map((m) => m.nodeId),
      descriptions: g.map((m) => describeTrigger(m.att)),
      // The trigger nodes whose signal must be seeded firing for this chain run.
      seedNodeIds: g.map((m) => m.nodeId)
    }
  })
}

/** Evaluate every enabled `trigger.*` node in the chat's active doc against committed state and run the
 *  fired triggers' chains headlessly (WP6.1). OR-deduped per CHAIN, depth-capped (shared HEADLESS_DEPTH_CAP
 *  with the pack path), guarded per-chat against reentrancy. A DISABLED trigger node is skipped entirely
 *  (never evaluated, never fired — the agent's off-switch). Fire-and-forget from the turn boundary
 *  (never awaited on the turn's critical path — ADR 0003); a doc-headless commit awaits its own
 *  re-evaluation so a deliberate chain stays sequential + bounded. */
export const evaluateDocTriggers = async (
  profileId: string,
  chatId: string,
  cause: EvalCause,
  depth: number
): Promise<void> => {
  if (depth >= HEADLESS_DEPTH_CAP) {
    log(
      'info',
      `headless(doc): depth cap (${HEADLESS_DEPTH_CAP}) reached for chat ${chatId} (cause: ${cause}) — skipping trigger evaluation`
    )
    return
  }
  if (evaluatingDocChats.has(chatId)) return
  evaluatingDocChats.add(chatId)
  try {
    await evaluateDocPass(profileId, chatId, depth)
  } finally {
    evaluatingDocChats.delete(chatId)
  }
}

/** The guard-free doc evaluate-and-run pass (called by evaluateDocTriggers under the guard, and by
 *  runDocHeadless for chain continuation — already inside the guarded region). */
const evaluateDocPass = async (profileId: string, chatId: string, depth: number): Promise<void> => {
  if (depth >= HEADLESS_DEPTH_CAP) return
  const { id: docId, doc } = resolveWorkflowDoc(profileId, chatId)

  const fired: FiredTrigger[] = []
  for (const node of doc.nodes) {
    if (!isTriggerNodeType(node.type)) continue
    if (node.disabled === true) continue // a disabled trigger never fires (the off-switch)
    const att = triggerAttachmentOf(node)
    if (!att) continue // malformed config (never validated / hand-authored) → skip
    // OR-dedupe happens per chain below; here we still EVALUATE every trigger so its baseline advances.
    const fires = evaluateTriggerCore(profileId, chatId, att, {
      get: () => getDocTriggerState(chatId, docId, node.id),
      setLastValue: (v) => setDocTriggerLastValue(chatId, docId, node.id, v),
      setLastFireFloor: (f) => setDocTriggerLastFireFloor(chatId, docId, node.id, f)
    })
    if (fires) fired.push({ nodeId: node.id, att, closure: forwardClosure(doc, node.id) })
  }

  if (!fired.length) return

  // OR-dedupe per chain, then run each chain once. Deterministic order by the first trigger node id.
  const chains = groupFiredIntoChains(fired)
  chains.sort((a, b) => a.triggerNodeIds[0].localeCompare(b.triggerNodeIds[0]))
  for (const chain of chains) {
    await runDocHeadless(profileId, chatId, docId, doc, chain, depth)
  }
}

/** Execute ONE fired chain's closure headlessly (WP6.1). Builds a runnable subgraph doc containing
 *  ONLY the chain's closure nodes + edges (nodes reachable from the chain's fired trigger(s)), so
 *  other triggers' chains and the narrator chain do NOT run — the closure is exactly the reachable set.
 *  The fired trigger nodes run inside it and fire their signal, un-gating the chain. Context inputs
 *  inside the chain (e.g. input.context nodes) self-seed via the RunContext (profileId/chatId), exactly
 *  as the pack path's own input.context does. Failures NEVER surface to any chat flow (ADR 0003).
 *
 *  SHARED-NODE decision (a chain node that is also a narrator ancestor): v0 runs it inside the closure
 *  too — the closure is defined purely by reachability from the fired trigger, and a node reachable
 *  from the trigger IS part of the agent chain even if the narrator also wires it. Turn runs are
 *  unaffected (they exclude the trigger + run the narrator normally); the headless closure just runs
 *  its own copy of the shared node against committed state. Documented as the v0 rule. */
const runDocHeadless = async (
  profileId: string,
  chatId: string,
  docId: string,
  doc: WorkflowDoc,
  chain: { closure: Set<string>; triggerNodeIds: string[]; descriptions: string[]; seedNodeIds: string[] },
  depth: number,
  annotation: { origin: RunOrigin; trigger?: string } = {
    origin: 'headless',
    trigger: undefined
  }
): Promise<void> => {
  const workflowId = `headless-doc:${docId}`
  const startedAt = Date.now()
  const controller = new AbortController()
  const triggerCaption = annotation.trigger ?? chain.descriptions.join(' | ')

  try {
    // The runnable closure doc: only the reachable nodes + the edges among them, run as a subgraph
    // (skips the main-output rule; runSubgraph runs the whole topo order in one pass). Deep-clone so
    // the stored doc is never mutated. The fired trigger nodes stay in — their run() fires the signal.
    const closureNodes = doc.nodes.filter((n) => chain.closure.has(n.id))
    const closureEdges = doc.edges.filter(
      (e) => chain.closure.has(e.from.node) && chain.closure.has(e.to.node)
    )
    const runnable: WorkflowDoc = {
      ...structuredClone(doc),
      id: docId,
      kind: 'subgraph',
      nodes: structuredClone(closureNodes),
      edges: structuredClone(closureEdges),
      // A closure carries no attachments (doc-path triggers are NODES, not attachments).
      attachments: undefined
    }

    const ctx: RunContext = {
      profileId,
      chatId,
      workflowId,
      userAction: '',
      signal: controller.signal,
      streamMain: () => {}, // no chat message to stream — headless writes durable state only
      emitPanel: () => {},
      getNodeState: () => undefined,
      setNodeState: () => {}
    }

    const result = await runSubgraph(runnable, builtinRegistry, ctx, {})

    const trace = summarizeRun(
      runnable,
      builtinRegistry.descriptors(),
      {
        ok: !result.aborted && !result.fatal,
        aborted: result.aborted,
        traces: result.traces,
        outputs: new Map()
      },
      { chatId, workflowId, startedAt, durationMs: Date.now() - startedAt }
    )
    notifyWorkflowTrace(trace)
    // Run history: origin (headless/manual), packIds [] (module attribution arrives with WP6.3), trigger
    // = the joined firing-trigger descriptions. A persist failure never surfaces to any chat flow.
    try {
      appendRun(profileId, {
        runId: randomUUID(),
        seq: 0,
        origin: annotation.origin,
        packIds: [],
        ...(triggerCaption ? { trigger: triggerCaption } : {}),
        trace
      })
    } catch (err) {
      log(
        'error',
        `run-history persist (doc ${annotation.origin}) failed — ${err instanceof Error ? err.message : String(err)}`
      )
    }
    if (result.fatal)
      log(
        'error',
        `headless(doc) chain "${chain.triggerNodeIds.join(',')}" failed: ${result.fatal.message} (never surfaced to the chat)`
      )
  } catch (err) {
    log(
      'error',
      `headless(doc) chain "${chain.triggerNodeIds.join(',')}" threw: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  // The headless COMMIT boundary (ADR 0004): re-evaluate the doc's triggers with depth+1 so a chain can
  // continue, bounded by the shared depth cap. Called directly (already inside the guarded region).
  await evaluateDocPass(profileId, chatId, depth + 1)
}

/** Run ONE `trigger.manual` node's chain on an explicit user action, bypassing evaluation (manual
 *  triggers never fire from a boundary — only here). The WP6.x "run now" hook for the one-canvas UI.
 *  No-op + logs if the node is not a manual trigger in the chat's active doc. */
export const runManualDoc = async (
  profileId: string,
  chatId: string,
  docId: string,
  triggerNodeId: string
): Promise<void> => {
  const { id: activeId, doc } = resolveWorkflowDoc(profileId, chatId)
  if (activeId !== docId) {
    log(
      'error',
      `runManualDoc: doc "${docId}" is not the active workflow for chat ${chatId} (active: ${activeId}) — nothing to run`
    )
    return
  }
  const node = doc.nodes.find((n) => n.id === triggerNodeId)
  if (!node || node.type !== 'trigger.manual') {
    log(
      'error',
      `runManualDoc: node "${triggerNodeId}" is not a manual trigger in doc ${docId} — nothing to run`
    )
    return
  }
  if (node.disabled === true) {
    log('error', `runManualDoc: trigger "${triggerNodeId}" is disabled — nothing to run`)
    return
  }
  const chain = {
    closure: forwardClosure(doc, triggerNodeId),
    triggerNodeIds: [triggerNodeId],
    descriptions: ['manual'],
    seedNodeIds: [triggerNodeId]
  }
  await runDocHeadless(profileId, chatId, docId, doc, chain, 0, {
    origin: 'manual',
    trigger: 'manual'
  })
}
