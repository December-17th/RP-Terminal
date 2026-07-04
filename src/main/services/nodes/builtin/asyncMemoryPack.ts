import { WorkflowDoc } from '../../../../shared/workflow/types'
import type { AgentPackRecord } from '../../agentPackStore'

// Built-in agent pack: Async Table Memory — THE FLAGSHIP (agent-packs plan WP2.4; ADR 0009's motivating
// case; ADR 0003's coordination story end-to-end).
//
// ── What this is, and how it differs from `builtin.table-memory` ─────────────────────────────────
// `builtin.table-memory` (tableMemoryPack.ts) runs its table-maintenance chain SYNCHRONOUSLY as a
// post-response BRANCH, at `turn-committed`, EVERY turn — a side LLM call on the player's critical path
// (deferred by the phase boundary, but still one call per maintenance floor, in-band with the turn).
//
// This pack, `builtin.async-memory`, runs the SAME maintenance chain HEADLESSLY (ADR 0003): it attaches
// as a TRIGGER, so the compaction is decoupled from the turn — it fires when the unsummarized backlog
// crosses a threshold and runs as its own engine run, PARALLEL to play, communicating with turns ONLY
// through committed state (the table rows + the maintenance progress pointer). While the compactor is
// in flight (or if it never runs), turns are never blocked: the inline trimmer reads the COMMITTED
// pointer and, if it has not advanced, simply carries the full history (fail-soft).
//
// The two packs are ALTERNATIVES the user picks between — NOT stackable. Both ship DEFAULT OFF. Enabling
// BOTH is possible (each has its own per-pack gate, ADR 0009) but not a supported combination: the two
// maintenance chains would double-summarize the same floors, and this pack's inline trimmer would feed
// TRIMMED floors into the every-turn pack's in-turn `context.history` (`recent`) node — see the friction
// note in the WP report. The phase-3 settings UI (WP3.x) is where the "one memory system at a time"
// choice is surfaced; here we only document it in the manifests.
//
// ── The three attachments (ADR 0009: one pack, one graph, many attachments) ──────────────────────
// 1. HEADLESS COMPACTOR (a `trigger` attachment). The maintenance chain — gate→read/refresh/recent→
//    frame→side llm→sql→tableapply — adapted from tableMemoryPack's fragment, but attached OFF the main
//    path as a headless run. When the backlog trigger fires, headlessRunService runs the fragment; the
//    chain's OWN `input.context` node (`mctx`) reads a fresh committed Context (buildGenContext off the
//    RunContext), and the chain writes table rows and advances the progress pointer
//    (table.gate.advanceProgress) on commit.
//      · The chain declares NO `context-ready` ENTRY attachments (it feeds itself from `mctx`). This is
//        DELIBERATE: an entry would splice the chain into every TURN (as a fail-open branch) and the
//        compaction would run in-band with the reply — exactly what "async" avoids. With no entry,
//        compose.ts finds the chain unreachable from any open entry seed and does NOT splice it into a
//        turn; it runs ONLY headlessly (runSubgraph executes the whole topo order). See the `mctx` node
//        comment for the load-bearing detail.
//      · No `turn-committed` / `write.floor` ordering edge here (there is no turn to order after —
//        headless runs read the COMMITTED floor set from disk directly). The gate re-reads the floor
//        count from disk anyway (tableNodes.ts:252-254), so the ordering edge tableMemoryPack needs is
//        moot headlessly.
//      · The gate's `every: 3` is kept as the chain's own per-run cadence knob; the TRIGGER threshold N
//        (below) is the separate "when do we even run" gate. A run may find fewer than `every` floors
//        due and no-op the chain — harmless (fail-open).
//
// 2. INLINE HISTORY TRIMMER (an `inline` entry at `context-ready`). The `context.trimProcessed` node
//    (contextNodes.ts) wired INLINE — the main flow is routed THROUGH it (compose.ts inline reroute), so
//    its output Context replaces the anchor value for assemble/llm/parse/write. It slices `gen.floors`
//    to the floors AFTER the committed progress pointer, so the prompt carries only the not-yet-
//    summarized tail (the summarized head rides the table export instead). Fail-soft: pointer not
//    advanced → full history (see contextNodes.ts:context.trimProcessed for the exact pointer math).
//    INLINE (not branch) because trimming TRANSFORMS the message flow (ADR 0009 pins exactly this).
//
// 3. BRANCH INJECTOR (a `rejoin` at `prompt-assembly`, `entries` lane). The `table.export` node projects
//    the memory tables into pre-qualified LorebookEntry[] and rejoins on the placement-carrying `entries`
//    anchor lane (WP1.6b) — the SAME wiring tableMemoryPack uses (tableMemoryPack.ts:164-172): the
//    summarized memory rides the real world-info placement/depth machinery. This is what makes trimming
//    the raw history safe: the dropped floors' facts re-enter the prompt as the table projection.
//
// Decisions: ADR 0003 (headless runs are turn-decoupled + state-mediated — the trimmer/pointer fail-soft
// story), ADR 0009 (one pack, one graph, many attachments — the gate is per-pack), ADR 0002 (fragments
// attach at checkpoints; disabling gates every entry as one act). Glossary: root CONTEXT.md. Composition
// rules: shared/workflow/compose.ts. Checkpoint anchors + lanes: shared/workflow/checkpoints.ts. Trigger
// grammar: shared/workflow/attachments.ts. The maintenance chain is lifted from tableMemoryPack.ts (the
// reference pack) — kept node-for-node identical there where it makes sense, minus the turn-committed
// ordering edges the headless path does not need.

/** The pack id + version — stable identity for the library (agentPackStore PK is id-per-profile). */
export const ASYNC_MEMORY_PACK_ID = 'builtin.async-memory'
export const ASYNC_MEMORY_PACK_VERSION = 1

// ── Trigger threshold (the backlog N) ────────────────────────────────────────────────────────────
//
// This is the DEFAULT for the auto-derived System trigger-param `sys.trigger.3.value` (the backlog N;
// the trigger is attachment index 3). As of WP3.2 override materialization is LIVE
// (agentPackMaterialize.materializeFragment runs in enabledFragmentsFor), so a user override for that
// id replaces this constant on both the turn and headless paths; with no override the constant stands.
//
// N = 6 chosen deliberately: the maintenance gate cadence is `every: 3` (below), so a threshold of TWO
// cadence windows' worth of backlog (2 × 3 = 6) means the compactor runs after roughly two maintenance
// windows have aged in, batching the side LLM call rather than firing it as eagerly as the every-turn
// pack — the whole POINT of going async (fewer, larger, off-critical-path compactions). It is a floor,
// not a target: once the backlog is ≥ 6 the trigger fires each boundary until the chain drains it.
export const ASYNC_MEMORY_BACKLOG_N = 6

// ── Trigger table binding (the watched sqlName) ──────────────────────────────────────────────────
//
// This is the DEFAULT for the auto-derived System trigger-param `sys.trigger.3.table` (the watched
// table). As of WP3.2 a user can override which table the compactor watches per scope — THE usability
// blocker from WP2.4 (a generic memory pack can't know a chat's template ahead of time). With no
// override this conventional 'summary' sqlName stands. Consequences of the default + the honest gap:
//   · Chats whose template DOES have this table: the trigger fires on its unprocessed backlog.
//   · Chats without it: the trigger reads `undefined` (readSource → the table is absent from
//     getTablesStatus), and `undefined gte N` is false → the compactor never fires for that chat. The
//     inline trimmer + branch injector still work (they operate over ALL tables generically), so the
//     pack degrades to "projects memory + trims to whatever pointer exists" without the auto-compaction.
// The real fix is the same System trigger-param materialization as N: WHICH table (or "any table's
// backlog", a future op) the pack watches becomes a settable binding. Surfaced in the WP report as the
// #1 phase-3 settings requirement for this pack to be usable across arbitrary templates.
export const ASYNC_MEMORY_WATCH_TABLE = 'summary'

/** The fragment: the maintenance chain (headless-triggered) + the inline trimmer + the export injector.
 *  Node ids mirror tableMemoryPack's where the node is the same, so a reader comparing the two packs can
 *  line them up. The zh maintainer prompt + the `every: 3` cadence are copied verbatim from the
 *  reference pack (docs/workflows/table-memory-default.rptflow). */
export const ASYNC_MEMORY_FRAGMENT: WorkflowDoc = {
  id: 'builtin.async-memory.fragment',
  name: 'Async Table Memory',
  version: ASYNC_MEMORY_PACK_VERSION,
  schemaVersion: 1,
  kind: 'fragment',
  description:
    'Async memory: compacts old exchanges into SQL memory tables in the background (a headless side ' +
    'LLM call triggered by unsummarized backlog), trims the prompt history to the not-yet-summarized ' +
    'tail, and injects the table export in place of the dropped floors.',
  nodes: [
    // (2) INLINE trimmer — the main flow routes through this at context-ready.
    { id: 'trim', type: 'context.trimProcessed', position: { x: 480, y: 200 } },

    // (3) Prompt-side projection — rejoins at prompt-assembly (entries lane), same as tableMemoryPack.
    { id: 'export', type: 'table.export', position: { x: 280, y: 360 } },

    // (1) HEADLESS maintenance chain — reads a fresh committed Context; writes tables + advances the
    // progress pointer. The chain starts with its OWN `input.context` node (`mctx`): `input.context`
    // reads profileId/chatId/userAction straight off the RunContext (generationNodes.ts:22-30), so it
    // needs NO input port and therefore NO context-ready ENTRY attachment. That is load-bearing: with no
    // entry attachment (and nothing wiring it to the trimmer/export entries), the maintenance chain is
    // NOT reachable from any open entry seed, so composeEffectiveGraph does NOT splice it into a TURN
    // (compose.ts reachableFrom the open-entry seeds). It runs ONLY in the HEADLESS run — where
    // runSubgraph executes the whole topo order regardless of connectivity — so the compaction never
    // fires in-band with the reply. (The trimmer + export still splice; they DO have context-ready
    // entries. Headlessly they also run but harmlessly — their outputs feed nothing.)
    { id: 'mctx', type: 'input.context', position: { x: 1680, y: 380 } },
    { id: 'gate', type: 'table.gate', config: { every: 3 }, position: { x: 1960, y: 380 } },
    { id: 'read', type: 'table.read', config: { max_rows: 30 }, position: { x: 2240, y: 300 } },
    { id: 'refresh', type: 'context.refresh', position: { x: 1960, y: 560 } },
    {
      id: 'recent',
      type: 'context.history',
      config: { count: 6 },
      position: { x: 2240, y: 460 }
    },
    { id: 'sideParams', type: 'context.params', position: { x: 2240, y: 600 } },
    {
      id: 'frame',
      type: 'prompt.messages',
      config: {
        messages: [
          {
            role: 'system',
            content:
              '你是数据库表格维护AI（database-table maintenance AI）。下面是记忆表格，每个表附带其定义与可执行的操作，随后是自上次维护以来的剧情。请根据这段剧情更新表格。\n\n将【本批剧情】整体视为一次交互进行维护：纪要表只允许新增恰好一行（概括整批），其余表按各自规则维护。\n\n【表格与规则】\n{{in1}}\n\n【本批剧情】\n{{in2}}\n\n规则：\n1. 只输出 SQL 语句，全部包裹在一个 <TableEdit>…</TableEdit> 标签内。标签内不要写任何解释或注释。\n2. 仅允许对上面列出的表执行 INSERT / UPDATE / DELETE，禁止其它操作。\n3. 严格遵循每个表的【插入规则】【更新规则】【删除规则】（表为空时遵循【初始化规则】）。\n4. 只在确有变化时更新；若本批没有任何需要写入的变化，输出一个空的 <TableEdit></TableEdit>。\n5. 表格是历史档案，不是创作工具：只记录剧情中已经明确发生的事实。禁止编造、推测、预告或推进任何新剧情、新事件、新对话；禁止把"计划""预测""可能发生的事"写入任何表；没有把握的内容一律不写。'
          }
        ]
      },
      position: { x: 2520, y: 380 }
    },
    {
      id: 'side',
      type: 'llm.sample',
      config: { stream: false, retries: 1 },
      position: { x: 2800, y: 380 }
    },
    {
      id: 'sql',
      type: 'parse.extract',
      config: { mode: 'tag', tag: 'TableEdit' },
      position: { x: 3080, y: 380 }
    },
    { id: 'tableapply', type: 'table.apply', position: { x: 3360, y: 380 } },
    {
      id: 'log-side',
      type: 'util.log',
      config: { label: 'async-memory/side-call' },
      position: { x: 3080, y: 600 }
    },
    {
      id: 'log-apply',
      type: 'util.log',
      config: { label: 'async-memory/apply' },
      position: { x: 3640, y: 600 }
    }
  ],
  // The maintenance chain's INTERNAL edges — copied from tableMemoryPack, MINUS the two `write.floor →`
  // ordering edges (no turn to order after headlessly; the gate re-reads the floor count from disk),
  // PLUS `mctx.gen → <node>.gen` for every maintenance node that reads Context (replacing the seven
  // context-ready ENTRY attachments the every-turn pack used — see the `mctx` node comment for why the
  // chain must NOT declare those entries here). `refresh` takes mctx.gen as its `gen` (the bundle to
  // re-read from) exactly as tableMemoryPack fed it ctx.gen.
  edges: [
    { from: { node: 'mctx', port: 'gen' }, to: { node: 'gate', port: 'gen' } },
    { from: { node: 'mctx', port: 'gen' }, to: { node: 'read', port: 'gen' } },
    { from: { node: 'mctx', port: 'gen' }, to: { node: 'refresh', port: 'gen' } },
    { from: { node: 'mctx', port: 'gen' }, to: { node: 'sideParams', port: 'gen' } },
    { from: { node: 'mctx', port: 'gen' }, to: { node: 'frame', port: 'gen' } },
    { from: { node: 'mctx', port: 'gen' }, to: { node: 'side', port: 'gen' } },
    { from: { node: 'mctx', port: 'gen' }, to: { node: 'tableapply', port: 'gen' } },

    { from: { node: 'gate', port: 'tables' }, to: { node: 'read', port: 'tables' } },
    { from: { node: 'gate', port: 'due' }, to: { node: 'read', port: 'when' } },

    { from: { node: 'refresh', port: 'gen' }, to: { node: 'recent', port: 'gen' } },
    { from: { node: 'gate', port: 'span' }, to: { node: 'recent', port: 'span' } },

    { from: { node: 'read', port: 'block' }, to: { node: 'frame', port: 'in1' } },
    { from: { node: 'recent', port: 'transcript' }, to: { node: 'frame', port: 'in2' } },

    { from: { node: 'frame', port: 'messages' }, to: { node: 'side', port: 'sendMessages' } },
    { from: { node: 'sideParams', port: 'params' }, to: { node: 'side', port: 'params' } },
    { from: { node: 'gate', port: 'due' }, to: { node: 'side', port: 'when' } },

    { from: { node: 'side', port: 'raw' }, to: { node: 'sql', port: 'text' } },
    { from: { node: 'gate', port: 'due' }, to: { node: 'sql', port: 'when' } },

    { from: { node: 'sql', port: 'first' }, to: { node: 'tableapply', port: 'sql' } },
    { from: { node: 'sql', port: 'found' }, to: { node: 'tableapply', port: 'when' } },

    { from: { node: 'side', port: 'error' }, to: { node: 'log-side', port: 'value' } },
    { from: { node: 'tableapply', port: 'error' }, to: { node: 'log-apply', port: 'value' } }
  ],
  attachments: [
    // ── (2) INLINE trimmer at context-ready: the main flow routes THROUGH `trim`. `gen` in → `gen`
    //    out (compose.ts inline reroute: ctx.gen → trim.gen, and every old ctx.gen consumer now reads
    //    trim.gen). This is the ONLY inline attachment — trimming transforms the message flow (ADR 0009). ─
    {
      kind: 'entry',
      checkpoint: 'context-ready',
      mode: 'inline',
      entryPort: { node: 'trim', port: 'gen' },
      outPort: { node: 'trim', port: 'gen' }
    },

    // ── (3) prompt-assembly rejoin, `entries` LANE — the memory table export (identical to
    //    tableMemoryPack's injector). `export` reads the Context via its own context-ready BRANCH entry. ─
    {
      kind: 'entry',
      checkpoint: 'context-ready',
      mode: 'branch',
      entryPort: { node: 'export', port: 'gen' }
    },
    {
      kind: 'rejoin',
      checkpoint: 'prompt-assembly',
      anchor: 'entries',
      rejoinPort: { node: 'export', port: 'entries' }
    },

    // ── (1) HEADLESS maintenance chain: NO context-ready entry attachments. The chain reads Context
    //    through its OWN `mctx` (input.context) node, so it does NOT compose into a turn (see the `mctx`
    //    node comment) — it runs ONLY in the headless run the trigger below starts. The runHeadless
    //    adapter still seeds the context-ready `gen` slot (the trimmer/export DO declare it) and runs the
    //    whole fragment topo order, so `mctx` and the chain execute; `mctx`'s buildGenContext reads the
    //    full committed floor set from disk (the compaction wants the FULL history to summarize). ────────

    // ── THE TRIGGER (ADR 0003/0004): fire the headless compactor when the unsummarized backlog on the
    //    watched table reaches N. `table`/`unprocessed`/`gte N` — a committed-state read at commit
    //    boundaries only. N + the watched sqlName are FIXED here in v0 (future System trigger-params —
    //    see the constants above). ─────────────────────────────────────────────────────────────────────
    {
      kind: 'trigger',
      trigger: 'state',
      source: { scope: 'table', table: ASYNC_MEMORY_WATCH_TABLE, stat: 'unprocessed' },
      op: 'gte',
      value: ASYNC_MEMORY_BACKLOG_N
    }
  ]
}

/** The built-in pack record seeded into every profile's library. Gate is CLOSED by default (no
 *  activation row = closed; packs are opt-in). builtin=true → uninstallable. */
export const buildAsyncMemoryPack = (): AgentPackRecord => ({
  id: ASYNC_MEMORY_PACK_ID,
  version: ASYNC_MEMORY_PACK_VERSION,
  upstreamId: null,
  upstreamVersion: null,
  builtin: true,
  manifest: {
    name: 'Async Table Memory',
    creator: 'RP Terminal',
    description:
      'Runs memory-table maintenance in the background instead of every turn: compacts old exchanges ' +
      'into your memory tables via a headless side model call when the backlog builds up, then trims ' +
      'the prompt to the not-yet-summarized history and injects the tables in place of the old floors. ' +
      'An alternative to the every-turn “SQL Table Memory” pack — pick one, not both.',
    // ── Creator-exposed settings (agent-packs plan WP3.2) ────────────────────────────────────────
    // The backlog N (the trigger threshold) + the watched table are AUTO-DERIVED System trigger params
    // (sys.trigger.3.value / sys.trigger.3.table — the trigger is attachment index 3); they need NO
    // manifest entry (deriveSystemSettings reads them off the trigger attachment). The ONE genuinely
    // creator-exposed knob is the inline trimmer's table SCOPE — which table's committed pointer the
    // prompt trims against. Its DEFAULT is unset in the fragment (config.table absent = the safe min
    // over all tables), so the default here is '' meaning "all tables". Materialization writes the
    // resolved value into `trim`'s config.table (contextNodes.trimProcessed reads config.table).
    // THE WATCHED-TABLE usability blocker from WP2.4 is solved by the auto-derived sys.trigger.3.table,
    // NOT this — this narrows the TRIM, not the trigger.
    exposedSettings: [
      {
        id: 'trim.tableScope',
        label: {
          en: 'History trim scope (table)',
          zh: '历史裁剪范围（表格）'
        },
        type: 'string',
        default: '',
        target: { nodeId: 'trim', path: 'table' }
      }
    ]
  },
  fragment: ASYNC_MEMORY_FRAGMENT
})
