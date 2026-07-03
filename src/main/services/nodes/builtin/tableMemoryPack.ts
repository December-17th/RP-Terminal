import { WorkflowDoc } from '../../../../shared/workflow/types'
import type { AgentPackRecord } from '../../agentPackStore'

// Built-in agent pack: SQL Table Memory (agent-packs plan WP1.6 — the ABI dogfood).
//
// This re-expresses the NON-NARRATOR parts of the shipped monolithic table-memory workflow
// (docs/workflows/table-memory-default.rptflow) as a kind:'fragment' WorkflowDoc plus the
// attachments that splice it back onto the builtin narrator spine (defaultGraph.ts: the SAME
// ctx → assemble → llm → parse → apply → write spine the monolith embeds verbatim).
//
// Decisions: ADR 0002 (fragments attach at checkpoints; disabling gates the entry edge),
// ADR 0009 (one pack, one graph, many attachments — the gate is per-pack). Glossary: root
// CONTEXT.md. Composition rules: shared/workflow/compose.ts. Checkpoint anchors:
// shared/workflow/checkpoints.ts.
//
// ── How the monolith decomposes (verified edge-by-edge against the .rptflow) ─────────────────────
// The monolith's 44 edges split into three buckets:
//  • 18 NARRATOR-INTERNAL edges — byte-identical to DEFAULT_GRAPH (the narrator spine).
//  • 15 FRAGMENT-INTERNAL edges — between two table nodes; they move here UNCHANGED (below).
//  • 11 BOUNDARY edges (narrator ↔ table node) — re-expressed as the attachments below.
//
// The table nodes read the turn Context (`ctx.gen`) and the just-persisted floor (`write.floor`)
// from the narrator, and contribute the projected table rows back into the prompt. Mapped to the
// v1 checkpoints:
//  • `context-ready` (anchor = input.context.gen : Context, a SOURCE) — the monolith's eight
//    `ctx.gen → <tablenode>.gen` edges. Each becomes a BRANCH entry seeding one table node's `gen`
//    input. Branch (not inline): the table maintenance path never transforms the message flow; it
//    reads Context and writes tables as a side effect. Failure/disable must NOT block the reply
//    (the monolith routes side-call and apply failures to util.log — fail-open by construction).
//  • `turn-committed` (anchor = output.writeFloor.floor : Any, a SOURCE) — the monolith's
//    `write.floor → gate.floor` and `write.floor → refresh.after` edges. Both are ORDERING-ONLY in
//    the node impls (tableNodes.ts:227-230 gate.floor "value ignored"; the gate re-reads the floor
//    count from disk). They sequence the maintenance pass AFTER the reply floor is persisted — so
//    they are entries at turn-committed, the post-commit checkpoint. Branch, same rationale.
//  • `prompt-assembly` (anchor node = prompt.assemble, a SINK; `entries` LANE — WP1.6b) — the
//    monolith's `export.entries → assemble.entries` edge, reproduced exactly via the rejoin's
//    anchor-lane selector. See the finding note below for the WP1.6 → WP1.6b history.
//
// ── ABI finding (WP1.6) → RESOLVED by WP1.6b anchor lanes ────────────────────────────────────────
// The monolith injects the table projection via `export.entries → assemble.entries`: the `entries`
// port carries a pre-qualified LorebookEntry[] (block + PLACEMENT), concatenated onto the scanned
// world-info matches so table rows ride the exact placement/depth machinery
// (generationNodes.ts:65-93). WP1.1 had pinned the `prompt-assembly` checkpoint to
// prompt.assemble's `block` INPUT (Text) only, so this edge was initially inexpressible — the
// WP1.6 dogfood's headline finding. Controller decision (WP1.6b): `prompt-assembly` stays ONE
// checkpoint but exposes TWO named anchor LANES — `block` (Text, default) and `entries` (the
// placement-carrying lane) — selected per rejoin via RejoinAttachment.anchor
// (checkpoints.ts CheckpointSpec.anchors; compose.ts splices to the selected lane, fan-in guarded
// PER lane). The rejoin below uses the `entries` lane, restoring the monolith's EXACT wiring:
// composed graph ≡ monolith on all 44 edges (test/workflow/tableMemoryPackEquivalence.test.ts).

/** The pack id + version — stable identity for the library (agentPackStore PK is id-per-profile). */
export const TABLE_MEMORY_PACK_ID = 'builtin.table-memory'
export const TABLE_MEMORY_PACK_VERSION = 1

/** The fragment: the monolith's table nodes + their 15 internal edges, with 11 attachments standing
 *  in for the boundary edges. Node ids are kept identical to the monolith's table-node ids so the
 *  composed graph's `pack:<id>:<nodeId>` ids map 1:1 back to the originals for the equivalence test.
 *  The `every: 3` gate cadence and the zh maintainer prompt are copied verbatim from the .rptflow. */
export const TABLE_MEMORY_FRAGMENT: WorkflowDoc = {
  id: 'builtin.table-memory.fragment',
  name: 'SQL Table Memory',
  version: TABLE_MEMORY_PACK_VERSION,
  schemaVersion: 1,
  kind: 'fragment',
  description:
    'Projects a chat\'s SQL memory tables into the prompt and, after the reply commits, runs a ' +
    'side LLM call to update those tables. The non-narrator half of the shipped table-memory ' +
    'workflow, re-expressed as an agent pack.',
  nodes: [
    // Prompt-side projection (reads Context, contributes back at prompt-assembly).
    { id: 'export', type: 'table.export', position: { x: 280, y: 200 } },

    // Post-response maintenance chain (reads Context + the committed floor; writes tables).
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
      config: { label: 'table-memory/side-call' },
      position: { x: 3080, y: 600 }
    },
    {
      id: 'log-apply',
      type: 'util.log',
      config: { label: 'table-memory/apply' },
      position: { x: 3640, y: 600 }
    }
  ],
  // The 15 fragment-INTERNAL edges — both ends are table nodes; copied verbatim from the monolith.
  edges: [
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
    // ── context-ready branch entries: one per `ctx.gen → <tablenode>.gen` boundary edge ──────────
    { kind: 'entry', checkpoint: 'context-ready', mode: 'branch', entryPort: { node: 'export', port: 'gen' } },
    { kind: 'entry', checkpoint: 'context-ready', mode: 'branch', entryPort: { node: 'gate', port: 'gen' } },
    { kind: 'entry', checkpoint: 'context-ready', mode: 'branch', entryPort: { node: 'read', port: 'gen' } },
    { kind: 'entry', checkpoint: 'context-ready', mode: 'branch', entryPort: { node: 'refresh', port: 'gen' } },
    { kind: 'entry', checkpoint: 'context-ready', mode: 'branch', entryPort: { node: 'sideParams', port: 'gen' } },
    { kind: 'entry', checkpoint: 'context-ready', mode: 'branch', entryPort: { node: 'frame', port: 'gen' } },
    { kind: 'entry', checkpoint: 'context-ready', mode: 'branch', entryPort: { node: 'side', port: 'gen' } },
    { kind: 'entry', checkpoint: 'context-ready', mode: 'branch', entryPort: { node: 'tableapply', port: 'gen' } },

    // ── turn-committed branch entries: the two `write.floor → …` ordering edges ───────────────────
    { kind: 'entry', checkpoint: 'turn-committed', mode: 'branch', entryPort: { node: 'gate', port: 'floor' } },
    { kind: 'entry', checkpoint: 'turn-committed', mode: 'branch', entryPort: { node: 'refresh', port: 'after' } },

    // ── prompt-assembly rejoin, `entries` LANE (WP1.6b): the monolith's exact injection edge ──────
    // export.entries (pre-qualified LorebookEntry[]) → assemble.entries, riding the real world-info
    // placement/depth machinery — identical to the monolith's `export.entries → assemble.entries`.
    {
      kind: 'rejoin',
      checkpoint: 'prompt-assembly',
      anchor: 'entries',
      rejoinPort: { node: 'export', port: 'entries' }
    }
  ]
}

/** The built-in pack record seeded into every profile's library (agent-packs plan WP1.6). Gate is
 *  CLOSED by default (no activation row = closed; packs are opt-in). builtin=true → uninstallable. */
export const buildTableMemoryPack = (): AgentPackRecord => ({
  id: TABLE_MEMORY_PACK_ID,
  version: TABLE_MEMORY_PACK_VERSION,
  upstreamId: null,
  builtin: true,
  manifest: {
    name: 'SQL Table Memory',
    creator: 'RP Terminal',
    description:
      'Projects your chat\'s memory tables into the prompt and updates them after each reply via a ' +
      'side model call. The built-in table-memory system, packaged as an agent pack.'
  },
  fragment: TABLE_MEMORY_FRAGMENT
})

/** Every built-in pack the app seeds. One today; the array is the extension point. */
export const BUILTIN_PACKS: readonly (() => AgentPackRecord)[] = [buildTableMemoryPack]
