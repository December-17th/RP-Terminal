import { WorkflowDoc } from '../../../../shared/workflow/types'

/**
 * The merged default doc (agent & memory UX WP-C; spec §3.2–§3.3): the narrator spine PLUS the
 * SQL-table memory system, mode-switchable in place. Code-built like DEFAULT_GRAPH, but NEVER run
 * as a builtin — it is the TEMPLATE for the seeded, EDITABLE "Default" workflow doc that
 * `workflowService.seedDefaultMemoryWorkflow` writes into a profile (plan §0.3). The code builtin
 * `DEFAULT_GRAPH` stays byte-untouched as the invisible fallback (parity-pinned).
 *
 * Wiring is grounded in the PROVEN fixtures (the spec's chain list is the design; the .rptflow
 * files are the proven wiring — plan WP-C task 1):
 *  · docs/workflows/memory-fill-async.rptflow — the turn path (ctx → trim → assemble/llm/parse/
 *    apply/write with table.export → assemble.entries) and the consolidated headless chain
 *    (history.recent → agent.llm → parse.extract(TableEdit) → table.apply(advance_progress), with
 *    table.read → agent.input and table.apply.error → util.log), INCLUDING the maintainer prompt
 *    taken VERBATIM (the proven zh prompt).
 *  · docs/workflows/memory-fill.rptflow — the cadence trigger's everyNFloors: 3 default.
 * The one structural change over memory-fill-async: BOTH triggers (cadence + backlog state) feed a
 * `control.mode` selector (WP-B), and the chain hangs off `mode.fired` instead of a trigger
 * directly — so the two memory modes plus `off` are mutually exclusive behind one exposed enum:
 *  · options[0] 'every_turn' ↔ when1 ← trigger.cadence
 *  · options[1] 'async'      ↔ when2 ← trigger.state (summary.unprocessed ≥ 6)
 *  · options[2] 'off'        ↔ when3 — deliberately UNWIRED: selecting it makes the selected slot
 *    a dead end (WP-B's §0.2 firing rule), which IS the master memory off-switch.
 *  · when4 is left free so an imported memory system can join the mutual exclusion by wiring its
 *    trigger into it and adding a fourth option (pure wiring; no app code — spec §3.2).
 *
 * Ships with `selected: 'off'`: an unconfigured profile must not burn side LLM calls (the cadence
 * trigger fires regardless of whether a table template is bound, and agent.llm would call the
 * model). The group `note` tells the user what to set up; flipping the exposed Mode enum turns
 * memory on. With mode off (and recall's trim/export fail-soft when no template is bound) a turn
 * run of this doc is trace-equivalent to DEFAULT_GRAPH — pinned by
 * test/workflow/defaultMemoryTemplate.test.ts.
 *
 * Doc CONTENT (name, group name, note, exposed labels) is user-editable document data, not app-UI
 * chrome — plain strings by design, NOT routed through i18n (the maintainer prompt stays zh, the
 * proven contract). The `meta.seeded` marker is the seeding idempotence key (plan §0.3): it
 * survives rename/edit, and deleting the doc tombstones the marker so it is never re-seeded.
 */

/** The seeding marker carried in `meta.seeded` (plan §0.3). */
export const DEFAULT_MEMORY_SEED_MARKER = 'default-memory-v1'

/** The v2 seeding marker (memory.maintain plan WP3): the seeded default now uses the ONE
 *  `memory.maintain` node in place of the five-node chain. The seeder SUPERSEDES a live v1 doc with
 *  v2 (owner decision: auto-replace); deletion of either marker still tombstones (never resurrected). */
export const DEFAULT_MEMORY_SEED_MARKER_V2 = 'default-memory-v2'

/** The maintainer prompt, VERBATIM from docs/workflows/memory-fill-async.rptflow (the proven zh
 *  prompt — plan WP-C task 1; kept a named export so tests can pin the verbatim copy). */
export const MAINTAINER_SYSTEM_PROMPT =
  '你是数据库表格维护AI（database-table maintenance AI）。下面是记忆表格，每个表附带其定义与可执行的操作，随后是自上次维护以来的剧情。请根据这段剧情更新表格。\n\n将【本批剧情】整体视为一次交互进行维护：纪要表只允许新增恰好一行（概括整批），其余表按各自规则维护。\n\n【表格与规则】\n{{input}}\n\n规则：\n1. 只输出 SQL 语句，全部包裹在一个 <TableEdit>…</TableEdit> 标签内。标签内不要写任何解释或注释。\n2. 仅允许对上面列出的表执行 INSERT / UPDATE / DELETE，禁止其它操作。\n3. 严格遵循每个表的【插入规则】【更新规则】【删除规则】（表为空时遵循【初始化规则】）。\n4. 只在确有变化时更新；若本批没有任何需要写入的变化，输出一个空的 <TableEdit></TableEdit>。\n5. 表格是历史档案，不是创作工具：只记录剧情中已经明确发生的事实。禁止编造、推测、预告或推进任何新剧情、新事件、新对话；禁止把"计划""预测""可能发生的事"写入任何表；没有把握的内容一律不写。'

/** Build a fresh merged-default doc (the seeded "Default"). A builder — not a shared constant —
 *  so every seed gets its own object graph (createWorkflowFromDoc replaces the placeholder id). */
export const buildDefaultMemoryDoc = (): WorkflowDoc => ({
  id: 'default-memory-template',
  name: 'Default',
  version: 1,
  schemaVersion: 1,
  description:
    'The default generation pipeline plus SQL-table memory, switchable in place: the Table memory ' +
    'group maintains memory tables headlessly (every N floors, on backlog, or off — the Mode ' +
    'setting), and recall projects the tables into the prompt on every turn (fail-soft when no ' +
    'table template is bound).',
  meta: { seeded: DEFAULT_MEMORY_SEED_MARKER },
  nodes: [
    // ── Narrator spine + turn-coupled recall (memory-fill-async.rptflow, verbatim wiring) ──────
    { id: 'ctx', type: 'input.context', position: { x: 0, y: 380 } },
    { id: 'trim', type: 'context.trimProcessed', position: { x: 200, y: 540 } },
    { id: 'export', type: 'table.export', position: { x: 280, y: 200 } },
    { id: 'assemble', type: 'prompt.assemble', position: { x: 560, y: 380 } },
    { id: 'llm', type: 'llm.sample', position: { x: 840, y: 380 } },
    { id: 'parse', type: 'parse.response', position: { x: 1120, y: 380 } },
    { id: 'apply', type: 'apply.state', position: { x: 1400, y: 380 } },
    { id: 'write', type: 'output.writeFloor', isMainOutput: true, position: { x: 1680, y: 380 } },

    // ── The Table memory agent (grouped, collapsed) — beside the spine, after write ────────────
    {
      id: 'trigger-cadence',
      type: 'trigger.cadence',
      config: { everyNFloors: 3 },
      position: { x: 1960, y: 620 }
    },
    {
      id: 'trigger-state',
      type: 'trigger.state',
      config: {
        source: { scope: 'table', table: 'summary', stat: 'unprocessed' },
        op: 'gte',
        value: 6
      },
      position: { x: 1960, y: 780 }
    },
    {
      id: 'mode',
      type: 'control.mode',
      config: {
        options: [
          { key: 'every_turn', label: 'Every turn' },
          { key: 'async', label: 'Async backlog' },
          { key: 'off', label: 'Off' }
        ],
        selected: 'off'
      },
      position: { x: 2240, y: 700 }
    },
    {
      id: 'history',
      type: 'history.recent',
      config: { lastNFloors: 6 },
      position: { x: 2520, y: 620 }
    },
    { id: 'read', type: 'table.read', config: { max_rows: 30 }, position: { x: 2520, y: 780 } },
    {
      id: 'agent',
      type: 'agent.llm',
      config: {
        stream: false,
        retries: 1,
        messages: [
          { role: 'system', content: MAINTAINER_SYSTEM_PROMPT },
          { role: 'user', content: '【本批剧情】' },
          { role: 'user', content: '{history}' }
        ]
      },
      position: { x: 2800, y: 700 }
    },
    {
      id: 'sql',
      type: 'parse.extract',
      config: { mode: 'tag', tag: 'TableEdit' },
      position: { x: 3080, y: 700 }
    },
    {
      id: 'tableapply',
      type: 'table.apply',
      config: { advance_progress: true },
      position: { x: 3360, y: 700 }
    },
    {
      id: 'log-apply',
      type: 'util.log',
      config: { label: 'default-memory/apply' },
      position: { x: 3640, y: 860 }
    }
  ],
  edges: [
    // Turn path (memory-fill-async verbatim: trim inline on the narrator spine).
    { from: { node: 'ctx', port: 'gen' }, to: { node: 'trim', port: 'gen' } },

    { from: { node: 'trim', port: 'gen' }, to: { node: 'export', port: 'gen' } },

    { from: { node: 'trim', port: 'gen' }, to: { node: 'assemble', port: 'gen' } },
    { from: { node: 'export', port: 'entries' }, to: { node: 'assemble', port: 'entries' } },

    { from: { node: 'trim', port: 'gen' }, to: { node: 'llm', port: 'gen' } },
    { from: { node: 'assemble', port: 'sendMessages' }, to: { node: 'llm', port: 'sendMessages' } },
    { from: { node: 'assemble', port: 'params' }, to: { node: 'llm', port: 'params' } },

    { from: { node: 'trim', port: 'gen' }, to: { node: 'parse', port: 'gen' } },
    { from: { node: 'llm', port: 'raw' }, to: { node: 'parse', port: 'raw' } },
    { from: { node: 'assemble', port: 'sendMessages' }, to: { node: 'parse', port: 'sendMessages' } },
    { from: { node: 'llm', port: 'rawUsage' }, to: { node: 'parse', port: 'rawUsage' } },

    { from: { node: 'trim', port: 'gen' }, to: { node: 'apply', port: 'gen' } },
    { from: { node: 'parse', port: 'parsed' }, to: { node: 'apply', port: 'parsed' } },
    { from: { node: 'parse', port: 'mvu' }, to: { node: 'apply', port: 'mvu' } },
    { from: { node: 'llm', port: 'raw' }, to: { node: 'apply', port: 'raw' } },

    { from: { node: 'trim', port: 'gen' }, to: { node: 'write', port: 'gen' } },
    { from: { node: 'llm', port: 'raw' }, to: { node: 'write', port: 'raw' } },
    { from: { node: 'assemble', port: 'sendMessages' }, to: { node: 'write', port: 'sendMessages' } },
    { from: { node: 'apply', port: 'variables' }, to: { node: 'write', port: 'variables' } },
    { from: { node: 'parse', port: 'parsed' }, to: { node: 'write', port: 'parsed' } },
    { from: { node: 'parse', port: 'metrics' }, to: { node: 'write', port: 'metrics' } },

    // Triggers → mode slots (options[i] ↔ when{i+1}; when3 = 'off' deliberately unwired; when4 free).
    { from: { node: 'trigger-cadence', port: 'fired' }, to: { node: 'mode', port: 'when1' } },
    { from: { node: 'trigger-state', port: 'fired' }, to: { node: 'mode', port: 'when2' } },

    // The consolidated chain, gated by the SELECTED mode (memory-fill-async's chain with
    // trigger.fired replaced by mode.fired at every gate).
    { from: { node: 'mode', port: 'fired' }, to: { node: 'history', port: 'when' } },

    { from: { node: 'ctx', port: 'gen' }, to: { node: 'read', port: 'gen' } },
    { from: { node: 'mode', port: 'fired' }, to: { node: 'read', port: 'when' } },

    { from: { node: 'mode', port: 'fired' }, to: { node: 'agent', port: 'when' } },
    { from: { node: 'history', port: 'messages' }, to: { node: 'agent', port: 'history' } },
    { from: { node: 'read', port: 'block' }, to: { node: 'agent', port: 'input' } },

    { from: { node: 'agent', port: 'text' }, to: { node: 'sql', port: 'text' } },
    { from: { node: 'mode', port: 'fired' }, to: { node: 'sql', port: 'when' } },

    { from: { node: 'ctx', port: 'gen' }, to: { node: 'tableapply', port: 'gen' } },
    { from: { node: 'sql', port: 'first' }, to: { node: 'tableapply', port: 'sql' } },
    { from: { node: 'sql', port: 'found' }, to: { node: 'tableapply', port: 'when' } },

    { from: { node: 'tableapply', port: 'error' }, to: { node: 'log-apply', port: 'value' } }
  ],
  groups: [
    {
      id: 'group-1',
      name: 'Table memory',
      nodeIds: [
        'trigger-cadence',
        'trigger-state',
        'mode',
        'history',
        'read',
        'agent',
        'sql',
        'tableapply',
        'log-apply'
      ],
      collapsed: true,
      exposed: [
        { node: 'mode', path: 'selected', label: 'Mode' },
        { node: 'trigger-cadence', path: 'everyNFloors', label: 'Cadence (floors)' },
        { node: 'trigger-state', path: 'value', label: 'Backlog threshold' },
        { node: 'agent', path: 'api_preset_id', label: 'API preset' }
      ],
      note:
        "Setup needed before turning memory on: bind a table template with a 'summary' table in " +
        'the Tables view (the backlog trigger watches summary.unprocessed), and optionally set an ' +
        'API preset on the Agent node so maintenance runs on a cheaper connection. Modes: ' +
        'every_turn = maintain every N floors; async = maintain when the un-summarized backlog ' +
        'reaches the threshold; off = memory maintenance disabled.'
    }
  ]
})

/**
 * The v2 merged-default doc (memory.maintain plan WP3): IDENTICAL to v1 — same narrator spine, same
 * turn-coupled recall, same triggers + `control.mode` selector, same exposed settings + note — EXCEPT
 * the five-node maintenance chain (`history / read / agent / sql / tableapply`) collapses into ONE
 * `memory.maintain` node gated by `mode.fired`, with its `error` routed to `util.log`. The per-table
 * maintenance rules move OUT of node config into the bound table template (edited by the node panel);
 * the node's `messages` is only the scaffold prompt (the same verbatim maintainer prompt, `{{input}}`
 * substituting the rendered tables block).
 *
 * With mode off (the ship default), a turn run stays trace-equivalent to DEFAULT_GRAPH — pinned by
 * defaultMemoryTemplate.test.ts, same as v1.
 */
export const buildDefaultMemoryDocV2 = (): WorkflowDoc => ({
  id: 'default-memory-template',
  name: 'Default',
  version: 1,
  schemaVersion: 1,
  description:
    'The default generation pipeline plus SQL-table memory, switchable in place: the Table memory ' +
    'group maintains memory tables headlessly (every N floors, on backlog, or off — the Mode ' +
    'setting), and recall projects the tables into the prompt on every turn (fail-soft when no ' +
    'table template is bound).',
  meta: { seeded: DEFAULT_MEMORY_SEED_MARKER_V2 },
  nodes: [
    // ── Narrator spine + turn-coupled recall (unchanged from v1) ───────────────────────────────
    { id: 'ctx', type: 'input.context', position: { x: 0, y: 380 } },
    { id: 'trim', type: 'context.trimProcessed', position: { x: 200, y: 540 } },
    { id: 'export', type: 'table.export', position: { x: 280, y: 200 } },
    { id: 'assemble', type: 'prompt.assemble', position: { x: 560, y: 380 } },
    { id: 'llm', type: 'llm.sample', position: { x: 840, y: 380 } },
    { id: 'parse', type: 'parse.response', position: { x: 1120, y: 380 } },
    { id: 'apply', type: 'apply.state', position: { x: 1400, y: 380 } },
    { id: 'write', type: 'output.writeFloor', isMainOutput: true, position: { x: 1680, y: 380 } },

    // ── The Table memory agent — ONE node now (memory.maintain) ────────────────────────────────
    {
      id: 'trigger-cadence',
      type: 'trigger.cadence',
      config: { everyNFloors: 3 },
      position: { x: 1960, y: 620 }
    },
    {
      id: 'trigger-state',
      type: 'trigger.state',
      config: {
        source: { scope: 'table', table: 'summary', stat: 'unprocessed' },
        op: 'gte',
        value: 6
      },
      position: { x: 1960, y: 780 }
    },
    {
      id: 'mode',
      type: 'control.mode',
      config: {
        options: [
          { key: 'every_turn', label: 'Every turn' },
          { key: 'async', label: 'Async backlog' },
          { key: 'off', label: 'Off' }
        ],
        selected: 'off'
      },
      position: { x: 2240, y: 700 }
    },
    {
      id: 'maintain',
      type: 'memory.maintain',
      config: {
        stream: false,
        retries: 1,
        advance_progress: true,
        lastNFloors: 6,
        max_rows: 30,
        messages: [
          { role: 'system', content: MAINTAINER_SYSTEM_PROMPT },
          { role: 'user', content: '【本批剧情】' },
          { role: 'user', content: '{history}' }
        ]
      },
      position: { x: 2560, y: 700 }
    },
    {
      id: 'log-apply',
      type: 'util.log',
      config: { label: 'default-memory/maintain' },
      position: { x: 2880, y: 860 }
    }
  ],
  edges: [
    // Turn path (unchanged from v1: trim inline on the narrator spine).
    { from: { node: 'ctx', port: 'gen' }, to: { node: 'trim', port: 'gen' } },

    { from: { node: 'trim', port: 'gen' }, to: { node: 'export', port: 'gen' } },

    { from: { node: 'trim', port: 'gen' }, to: { node: 'assemble', port: 'gen' } },
    { from: { node: 'export', port: 'entries' }, to: { node: 'assemble', port: 'entries' } },

    { from: { node: 'trim', port: 'gen' }, to: { node: 'llm', port: 'gen' } },
    { from: { node: 'assemble', port: 'sendMessages' }, to: { node: 'llm', port: 'sendMessages' } },
    { from: { node: 'assemble', port: 'params' }, to: { node: 'llm', port: 'params' } },

    { from: { node: 'trim', port: 'gen' }, to: { node: 'parse', port: 'gen' } },
    { from: { node: 'llm', port: 'raw' }, to: { node: 'parse', port: 'raw' } },
    { from: { node: 'assemble', port: 'sendMessages' }, to: { node: 'parse', port: 'sendMessages' } },
    { from: { node: 'llm', port: 'rawUsage' }, to: { node: 'parse', port: 'rawUsage' } },

    { from: { node: 'trim', port: 'gen' }, to: { node: 'apply', port: 'gen' } },
    { from: { node: 'parse', port: 'parsed' }, to: { node: 'apply', port: 'parsed' } },
    { from: { node: 'parse', port: 'mvu' }, to: { node: 'apply', port: 'mvu' } },
    { from: { node: 'llm', port: 'raw' }, to: { node: 'apply', port: 'raw' } },

    { from: { node: 'trim', port: 'gen' }, to: { node: 'write', port: 'gen' } },
    { from: { node: 'llm', port: 'raw' }, to: { node: 'write', port: 'raw' } },
    { from: { node: 'assemble', port: 'sendMessages' }, to: { node: 'write', port: 'sendMessages' } },
    { from: { node: 'apply', port: 'variables' }, to: { node: 'write', port: 'variables' } },
    { from: { node: 'parse', port: 'parsed' }, to: { node: 'write', port: 'parsed' } },
    { from: { node: 'parse', port: 'metrics' }, to: { node: 'write', port: 'metrics' } },

    // Triggers → mode slots (options[i] ↔ when{i+1}; when3 = 'off' deliberately unwired; when4 free).
    { from: { node: 'trigger-cadence', port: 'fired' }, to: { node: 'mode', port: 'when1' } },
    { from: { node: 'trigger-state', port: 'fired' }, to: { node: 'mode', port: 'when2' } },

    // The consolidated node, gated by the SELECTED mode; its failures route to util.log.
    { from: { node: 'mode', port: 'fired' }, to: { node: 'maintain', port: 'when' } },
    { from: { node: 'maintain', port: 'error' }, to: { node: 'log-apply', port: 'value' } }
  ],
  groups: [
    {
      id: 'group-1',
      name: 'Table memory',
      nodeIds: ['trigger-cadence', 'trigger-state', 'mode', 'maintain', 'log-apply'],
      collapsed: true,
      exposed: [
        { node: 'mode', path: 'selected', label: 'Mode' },
        { node: 'trigger-cadence', path: 'everyNFloors', label: 'Cadence (floors)' },
        { node: 'trigger-state', path: 'value', label: 'Backlog threshold' },
        { node: 'maintain', path: 'api_preset_id', label: 'API preset' }
      ],
      note:
        "Setup needed before turning memory on: bind a table template with a 'summary' table in " +
        'the Tables view (the backlog trigger watches summary.unprocessed), and optionally set an ' +
        'API preset on the Memory node so maintenance runs on a cheaper connection. Edit each ' +
        "table's maintenance rules in the Memory node's panel. Modes: every_turn = maintain every " +
        'N floors; async = maintain when the un-summarized backlog reaches the threshold; off = ' +
        'memory maintenance disabled.'
    }
  ]
})
