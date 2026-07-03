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
import { summarizeRun } from '../../shared/workflow/trace'
import { runSubgraph } from './workflowEngine'
import { builtinRegistry } from './nodes/builtin'
import { RunContext } from './nodes/types'
import { notifyWorkflowTrace } from './workflowEvents'
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
 *  1: multiple firing triggers on one pack run the pack ONCE). */
interface FiredPack {
  packId: string
  doc: WorkflowDoc
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

/** Evaluate ONE trigger against committed state; returns whether it fires. Has the SIDE EFFECT of
 *  advancing the persisted baseline for the stateful kinds (changedBy lastValue, cadence
 *  lastFireFloor) — evaluation and baseline-advance are one step, matching the grammar's
 *  "since this trigger was last evaluated" semantics (attachments.ts). Non-stateful point ops and
 *  manual triggers persist nothing. Manual NEVER fires from a boundary (only runManual). */
const evaluateOneTrigger = (
  profileId: string,
  chatId: string,
  packId: string,
  triggerIndex: number,
  att: TriggerAttachment
): boolean => {
  if (att.trigger === 'manual') return false

  if (att.trigger === 'cadence') {
    const current = latestFloorIndex(profileId, chatId)
    if (current < 0) return false // no committed floor yet → nothing to fire on
    const prior = getTriggerState(chatId, packId, triggerIndex)?.lastFireFloor
    const lastFire = prior ?? -1 // never fired → -1, so N floors from floor 0 fires at index N−1
    // Fire when at least N floors have elapsed since the last fire. With lastFire −1 and N=3 this
    // first fires at floor index 2 (floors 0,1,2), matching computeTableProgress's nextExpected
    // (= last + freq) for a never-processed table.
    if (current - lastFire >= att.everyNFloors) {
      setTriggerLastFireFloor(chatId, packId, triggerIndex, current)
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
    const prior = getTriggerState(chatId, packId, triggerIndex)?.lastValue
    if (prior == null) {
      setTriggerLastValue(chatId, packId, triggerIndex, actual)
      return false // baseline-on-first-evaluation, no fire
    }
    if (actual - prior >= (att.value as number)) {
      setTriggerLastValue(chatId, packId, triggerIndex, actual) // advance the baseline on fire
      return true
    }
    return false
  }

  return comparePoint(att.op, actual, att.value)
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
    let didFire = false
    attachments.forEach((att, i) => {
      if (att.kind !== 'trigger') return
      // OR-dedupe (decision 1): once a pack has a firing trigger it runs once — but we still
      // evaluate the rest so their baselines (changedBy/cadence) advance this boundary.
      const fires = evaluateOneTrigger(profileId, chatId, frag.packId, i, att)
      if (fires) didFire = true
    })
    if (didFire) fired.push({ packId: frag.packId, doc: frag.doc })
  }

  // Deterministic order: pack id. Sequential — no parallel headless runs in v1.
  fired.sort((a, b) => a.packId.localeCompare(b.packId))
  for (const pack of fired) {
    await runHeadless(profileId, chatId, pack.packId, pack.doc, depth)
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
  depth: number
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

    // Broadcast the trace so the debug trace panel shows the headless run (persisted history is
    // WP2.3 — we do NOT build trace storage here). summarizeRun accepts the run structurally.
    notifyWorkflowTrace(
      summarizeRun(
        runnable,
        builtinRegistry.descriptors(),
        { ok: !result.aborted && !result.fatal, aborted: result.aborted, traces: result.traces, outputs: new Map() },
        { chatId, workflowId, startedAt, durationMs: Date.now() - startedAt }
      )
    )
    if (result.fatal)
      log('error', `headless run "${packId}" failed: ${result.fatal.message} (never surfaced to the chat)`)
  } catch (err) {
    // A failure here NEVER surfaces to any chat flow (ADR 0003) — log and move on.
    log('error', `headless run "${packId}" threw: ${err instanceof Error ? err.message : String(err)}`)
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
export const runManual = async (profileId: string, chatId: string, packId: string): Promise<void> => {
  const frag = enabledFragmentsFor(profileId, chatId).find((f) => f.packId === packId)
  if (!frag) {
    log('error', `runManual: pack "${packId}" is not gate-open for chat ${chatId} — nothing to run`)
    return
  }
  await runHeadless(profileId, chatId, packId, frag.doc, 0)
}
