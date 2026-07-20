import { WorkflowDoc } from '../../../../shared/workflow/types'
// Single source of truth for the maintainer framing prompt (execution-plan M5c-1): the built-in default
// Memory Maintenance config and this seeded doc share it so they can never drift.
import { MAINTAINER_SYSTEM_PROMPT } from '../../memory/maintainerDefaults'
export { MAINTAINER_SYSTEM_PROMPT }

/**
 * The merged default doc (agent & memory UX WP-C; spec §3.2–§3.3): the narrator spine PLUS the
 * SQL-table memory system, mode-switchable in place. This IS the app's default: it is BOTH the
 * TEMPLATE for the seeded, EDITABLE "Default" workflow doc that `workflowService.seedDefaultMemoryWorkflow`
 * writes into a profile (plan §0.3), AND — normalized to id 'default' with the seed marker stripped —
 * the invisible read-only builtin fallback (`workflowStore.BUILTIN_DEFAULT_DOC`). The old narrator-only
 * `DEFAULT_GRAPH` builtin has been deleted; a plain narrator spine survives only as the test fixture
 * `test/fixtures/narratorSpineDoc.ts` (NARRATOR_SPINE_DOC).
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
 * Ships with `selected: 'every_turn'`: memory maintenance runs every N floors out of the box (a bound
 * table template with a 'summary' table is still required — until one is bound, recall's trim/export
 * fail-soft and the maintenance chain has nothing to write). The group `note` tells the user what to
 * set up; the exposed Mode enum switches to `async` or `off`. Because the memory group is trigger-rooted
 * (`isTrigger` nodes are excluded from the turn phase), a TURN run of this doc is trace-equivalent to the
 * narrator spine (NARRATOR_SPINE_DOC) regardless of mode — pinned by
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
          { key: 'every_turn', label: 'Every X turns' },
          { key: 'async', label: 'Async backlog' },
          { key: 'off', label: 'Off' }
        ],
        selected: 'every_turn'
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
        // Memory fills are side calls prone to transient empty streams (Gemini) — default a full
        // retry budget (owner directive 2026-07-14: memory fill/refill default = 5).
        retries: 5,
        // ONE inline-`{history}` user row (NOT a standalone `{history}` row): the transcript is
        // flattened into text so the composed prompt ends on a `user` turn. A standalone `{history}`
        // row splices the floors role-preserving and ends on the last floor's `assistant` reply, which
        // makes OpenAI-compatible Gemini endpoints return an empty completion (0 tokens).
        messages: [
          { role: 'system', content: MAINTAINER_SYSTEM_PROMPT },
          { role: 'user', content: '【本批剧情】\n{history}' }
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
 * A turn run stays trace-equivalent to the narrator spine (NARRATOR_SPINE_DOC) regardless of mode — the
 * memory group is trigger-rooted and excluded from the turn phase — pinned by
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
          { key: 'every_turn', label: 'Every X turns' },
          { key: 'async', label: 'Async backlog' },
          { key: 'off', label: 'Off' }
        ],
        selected: 'every_turn'
      },
      position: { x: 2240, y: 700 }
    },
    {
      id: 'maintain',
      type: 'memory.maintain',
      config: {
        stream: false,
        // Same full retry budget as the fill agent above (owner directive 2026-07-14: default 5).
        retries: 5,
        advance_progress: true,
        lastNFloors: 6,
        max_rows: 30,
        // ONE inline-`{history}` user row (NOT a standalone `{history}` row): the transcript is
        // flattened into text so the composed prompt ends on a `user` turn. A standalone `{history}`
        // row splices the floors role-preserving and ends on the last floor's `assistant` reply, which
        // makes OpenAI-compatible Gemini endpoints return an empty completion (0 tokens).
        messages: [
          { role: 'system', content: MAINTAINER_SYSTEM_PROMPT },
          { role: 'user', content: '【本批剧情】\n{history}' }
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
