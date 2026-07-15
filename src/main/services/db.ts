import Database from 'better-sqlite3'
import path from 'path'
import { getAppDir, ensureDir } from './storageService'
import { classifyStatement } from './tableSql'

let db: Database.Database | null = null

/**
 * Relational schema for session/state data only. Portable, user-shareable
 * artifacts — presets, lorebooks, regex — are intentionally NOT stored here;
 * they live as JSON files in their native format (see preset/lorebook services).
 * JSON blobs are used for cards/settings where a Zod schema owns the shape.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar_path TEXT,
  password_hash TEXT,
  created_at TEXT NOT NULL,
  last_active TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  card TEXT NOT NULL,
  avatar_path TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_characters_profile ON characters(profile_id);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- JSON array of active lorebook ids; NULL means "default to the character's own lorebook".
  lorebook_ids TEXT,
  -- Active FSM mode (Explore/Dialogue/Combat); NULL is treated as 'explore'.
  mode TEXT,
  -- Cached L2 world-info matched for the current mode: {mode, entries}. Reused across
  -- turns within a mode and re-matched only on a mode transition (Phase H inc 2 / Phase G).
  cached_world_info TEXT
);
CREATE INDEX IF NOT EXISTS idx_chats_profile ON chats(profile_id);

CREATE TABLE IF NOT EXISTS floors (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  floor INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  user_content TEXT NOT NULL,
  user_timestamp TEXT,
  response_content TEXT NOT NULL,
  response_model TEXT,
  response_provider TEXT,
  events TEXT NOT NULL DEFAULT '[]',
  variables TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (chat_id, floor)
);

-- One active combat encounter per chat (combatService). The data column holds the
-- serialized EncounterRecord (CombatState + ability catalog + card hook scripts);
-- ephemeral, deleted when the fight ends. See docs/combat-system-design.md §7.
CREATE TABLE IF NOT EXISTS combat_encounters (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  updated_at TEXT
);
-- Durable per-node scratchpad for workflow nodes, keyed by (chat_id, workflow_id, node_id) —
-- what makes "changed since last fire" (control.when) expressible. Workflow id is part of the
-- key because clones of the default graph keep node ids by design, so (chat_id, node_id) alone
-- collides across workflows. See the node-workflow spec §11.
CREATE TABLE IF NOT EXISTS node_state (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  data TEXT,
  updated_at TEXT,
  PRIMARY KEY (chat_id, workflow_id, node_id)
);

-- Floor-keyed append-only SQL op log for SQL-table memory (issue 03). Every applied write batch is
-- logged here (raw SQL) so the per-chat sandbox DB can be REBUILT by ordered replay when floors are
-- truncated (regenerate/swipe/delete). The table DATA lives in the per-chat sandbox file, NOT here --
-- this is only the replay journal. FK cascade (foreign_keys = ON below) clears it on chat deletion,
-- following the floors-table precedent.
CREATE TABLE IF NOT EXISTS table_ops (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  floor INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  sql TEXT NOT NULL,
  created_at TEXT,
  PRIMARY KEY (chat_id, floor, seq)
);
CREATE INDEX IF NOT EXISTS idx_table_ops_chat_floor ON table_ops(chat_id, floor);

-- Floor-keyed append-only journal of CARD/PANEL variable writes (manual-pass issue 02). stat_data is
-- rebuilt from model <UpdateVariable> blocks on re-evaluate; card writes are not re-derivable from
-- response text, so they are journaled here and REPLAYED after each floor's model fold. Kind 'patch'
-- carries JsonPatchOp[] JSON, 'replace' carries a whole stat_data object. FK cascade clears on chat
-- deletion (foreign_keys = ON below); floor truncation deletes at/after the cut (chatService).
CREATE TABLE IF NOT EXISTS vars_ops (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  floor INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('patch','replace')),
  payload TEXT NOT NULL,
  created_at TEXT,
  PRIMARY KEY (chat_id, floor, seq)
);
CREATE INDEX IF NOT EXISTS idx_vars_ops_chat_floor ON vars_ops(chat_id, floor);

-- Chat-level per-table maintenance-progress pointer for SQL-table memory (issue 07). last_floor is
-- the 0-based floor index up to which a table was last processed; the per-turn table.gate cadence AND
-- the manual backfill both advance it (MAX-semantics upsert), the Tables view reads it, floor
-- truncation clamps it, and template (re)assignment resets it. REPLACES the gate's per-workflow
-- node_state pointer. FK cascade (foreign_keys = ON below) clears it on chat deletion.
CREATE TABLE IF NOT EXISTS table_progress (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sql_name TEXT NOT NULL,
  last_floor INTEGER NOT NULL,
  PRIMARY KEY (chat_id, sql_name)
);

-- Resumable manual-refill progress for SQL-table memory (table-refill WS2; shujuku manualRefillProgress
-- analogue). ONE in-flight refill per chat: selected_json = JSON string[] of the sqlNames being
-- regenerated, from_floor = the pinned start cutpoint, completed_until = the last floor committed so far
-- (-1 before the first chunk), status = 'in_progress'. Written at refill start, advanced per committed
-- chunk, DELETED on clean finalize. An 'in_progress' row surviving a crash/abort ⇒ offer Resume (a new
-- refill from completed_until + 1). FK cascade clears it on chat deletion.
CREATE TABLE IF NOT EXISTS table_refill_progress (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  selected_json TEXT NOT NULL,
  from_floor INTEGER NOT NULL,
  completed_until INTEGER NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT
);

-- Agent-pack library (agent-packs plan WP1.4; ADR 0005/0006/0008/0009; glossary root CONTEXT.md).
-- The user-owned INSTALL of a pack, shared by all worlds (the "library"). Fragment docs live HERE,
-- NOT in the profile workflow dir, so listWorkflows (which only reads that dir) can never surface a
-- pack fragment in the turn-workflow selection UI. upstream_id records fork lineage (ADR 0006 --
-- copy-on-edit); builtin marks app-shipped packs (uninstallable). manifest/fragment are JSON blobs
-- (a Zod schema owns the shape at the service edge, mirroring the cards/settings blob precedent). The
-- library is profile-global: no chat/world FK here (activation, below, is what scopes a pack).
--
-- VERSION COEXISTENCE (WP4.6; ADR 0008): library identity is (id, version), so the PK is
-- (profile_id, id, version). Two installs of one id at DIFFERENT versions are DISTINCT rows that
-- coexist (recipes pin a version — "install 1.2 alongside 1.4"); a same-id+version reinstall dedupes
-- to the existing row. See the migration in getDb() that rebuilds a legacy (profile_id, id)-keyed
-- table into this shape, preserving every row (version becomes the stored version).
CREATE TABLE IF NOT EXISTS agent_packs (
  id TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  upstream_id TEXT,
  -- WP4.6: the SOURCE version a fork was copied from (ADR 0006 lineage is now (id, version), matching
  -- library identity). NULL for a root install or a legacy fork (upstream_id alone). upstream-diffing
  -- can resolve the exact source row from (upstream_id, upstream_version).
  upstream_version INTEGER,
  builtin INTEGER NOT NULL DEFAULT 0,
  manifest TEXT NOT NULL,
  fragment TEXT NOT NULL,
  created_at TEXT,
  PRIMARY KEY (profile_id, id, version)
);
CREATE INDEX IF NOT EXISTS idx_agent_packs_profile ON agent_packs(profile_id);

-- Per-world (per-chat exception) ACTIVATION of an installed pack (ADR 0005 — activation lives with
-- the world/chat, never in the pack; ADR 0009 — the gate is per-pack). A row with chat_id NULL is
-- the WORLD-scope gate for (pack, world); a row with a chat_id is the per-chat EXCEPTION that wins.
-- world_id is a character/world-card id (a chat's world = its chats.character_id; getChat resolves
-- it). No row for a (pack, world/chat) = gate CLOSED (packs are opt-in). denial is a JSON array of
-- closed entry indexes / denied capability ids (semantics arrive in a later WP; stored + threaded
-- to composition now as closedEntryIndexes). Not FK'd to agent_packs so a builtin seed's activation
-- can precede any migration reordering; the service prunes orphans on read/uninstall.
--
-- VERSION PINNING (WP4.6; ADR 0008 — recipes are reproducible, so "which version runs in this world"
-- is explicit). pin_version records the pack VERSION this activation runs; enabledFragmentsFor
-- composes ONLY that version's fragment even when the library holds several. It is a COLUMN, not part
-- of the PK: a (pack, world[, chat]) runs exactly ONE version at a time, and switching versions is an
-- UPDATE of pin_version (setActiveVersion), not a second row. Legacy rows (pre-WP4.6, no column) are
-- backfilled to the version currently installed for that id (the migration in getDb()).
CREATE TABLE IF NOT EXISTS agent_pack_activation (
  pack_id TEXT NOT NULL,
  world_id TEXT NOT NULL,
  chat_id TEXT,
  gate_open INTEGER NOT NULL DEFAULT 0,
  denial TEXT,
  pin_version INTEGER,
  PRIMARY KEY (pack_id, world_id, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_pack_activation_pack ON agent_pack_activation(pack_id);

-- Exposed-setting OVERRIDES for an installed pack, layered by scope (ADR 0005 — global default <
-- per-world < per-chat, nearest wins). scope encodes the tier as a single string: 'global' for the
-- library-wide default, or a world/chat id for the narrower tiers (the selection sidecar's
-- global/world encoding, widened with a chat tier — see agentPackStore.ts SCOPE encoding note).
-- Overrides materialize into fragment docs at resolve time (WP3.2). value is a JSON blob.
--
-- VERSION-AGNOSTIC (WP4.6; ADR 0005/0006): keyed by (pack_id, scope, setting_id) with NO version.
-- Overrides survive UPGRADES by being reapplied by STABLE setting id across versions — a version
-- switch (setActiveVersion) keeps them, and a setting id that a given version doesn't expose is
-- skipped-with-log at materialization (agentPackMaterialize). This is why coexisting versions of one
-- id share one override set, and switching which version runs never resets the user's settings.
CREATE TABLE IF NOT EXISTS agent_pack_overrides (
  pack_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  setting_id TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (pack_id, scope, setting_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_pack_overrides_pack ON agent_pack_overrides(pack_id);

-- Per-trigger evaluation baselines for the headless runner (agent-packs plan WP2.2; ADR 0004).
-- A trigger's fire decision at a commit boundary can depend on state RETAINED across boundaries:
--   * a changedBy state trigger diffs the current numeric source against its value AT THE LAST
--     EVALUATION (attachments.ts grammar: fire when current - lastValue >= delta), so last_value
--     holds that prior numeric reading;
--   * a cadence trigger fires every N floors, so last_fire_floor holds the 0-based floor index at
--     which it last fired (fire when currentFloorIndex - last_fire_floor >= N; -1 when never).
-- Keyed per (chat, pack, trigger index) -- baselines are PER CHAT (a pack is evaluated independently
-- in each chat it is gated open for). trigger_index is the position in the fragment's attachments
-- array, so re-authoring a pack's attachments correctly re-baselines. Both value columns are
-- nullable: absent = never evaluated / never fired (the first-evaluation baseline case).
--
-- VERSION-AGNOSTIC (WP4.6; ADR 0004): NO version in the key. changedBy baselines + cadence last-fires
-- are per-chat facts about the PACK (a running total the chat has seen), not about a version, so a
-- version switch (setActiveVersion) KEEPS them. The known caveat is unchanged: trigger_index is
-- positional, so a version whose attachments array reorders/differs re-associates baselines by index
-- (the documented sys.trigger.* stability caveat — WP2.2/WP3.2).
CREATE TABLE IF NOT EXISTS agent_pack_trigger_state (
  chat_id TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  trigger_index INTEGER NOT NULL,
  last_value REAL,
  last_fire_floor INTEGER,
  PRIMARY KEY (chat_id, pack_id, trigger_index)
);
CREATE INDEX IF NOT EXISTS idx_agent_pack_trigger_state_chat ON agent_pack_trigger_state(chat_id);

-- Per-trigger evaluation baselines for the DOC-DRIVEN headless path (one-canvas rebuild WP6.1; ADR
-- 0011). The SIBLING of agent_pack_trigger_state: SAME value columns + semantics (last_value for a
-- changedBy delta baseline, last_fire_floor for a cadence last-fire), DIFFERENT key. The doc path keys
-- by (chat_id, doc_id, node_id) — a STABLE STRING node id rather than the pack path's POSITIONAL
-- integer trigger_index, so re-ordering nodes never re-associates baselines. A separate table because
-- a string node id cannot go in the pack table's INTEGER trigger_index column, and the pack-era rows
-- must stay untouched while both paths coexist (WP6.1). Both value columns nullable = never evaluated.
CREATE TABLE IF NOT EXISTS workflow_trigger_state (
  chat_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  last_value REAL,
  last_fire_floor INTEGER,
  PRIMARY KEY (chat_id, doc_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_trigger_state_chat ON workflow_trigger_state(chat_id);

-- Persisted workflow run history (agent-packs plan WP2.3; ADR 0003 — the Runs timeline shows every
-- run, turn + headless/manual, attributed to pack + trigger). The LIVE trace broadcast
-- (workflowEvents) is ephemeral (renderer keeps only the latest per chat); this is the DURABLE,
-- ring-capped (last RUN_HISTORY_CAP per chat, pruned on insert — runHistoryStore) log the phase-3
-- timeline reads. seq is a per-chat monotonic sequence (the newest-first paging cursor). trace is the
-- FULL WorkflowRunTrace JSON as broadcast, stored FAITHFULLY (headless runs keep their synthetic
-- __headless_seed_* nodes; display filtering is WP3.3's job). pack_ids is a JSON string[] of the packs
-- that contributed nodes; trigger is the human-readable describeTrigger caption (headless/manual only,
-- NULL for turns). ok/aborted/duration_ms/started_at/origin are denormalized off the trace so the
-- timeline list can render without parsing the (large) trace blob. Chat-keyed only (no FK): run history
-- is decoupled from chat lifecycle by design (ADR 0003 — headless runs outlive the turn that tripped
-- them); the store prunes by ring cap, not by cascade.
CREATE TABLE IF NOT EXISTS workflow_run_history (
  chat_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  origin TEXT NOT NULL,
  pack_ids TEXT NOT NULL,
  trigger TEXT,
  -- Agent & memory UX WP-D: JSON array of the DOC trigger-node ids that fired this run (headless/
  -- manual doc-path only; NULL for turns + pre-WP-D rows) — the agent card's run attribution key.
  trigger_node_ids TEXT,
  ok INTEGER NOT NULL,
  aborted INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  trace TEXT NOT NULL,
  PRIMARY KEY (chat_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_workflow_run_history_chat ON workflow_run_history(chat_id, seq);
`

// Presets/lorebooks were briefly stored in SQL during early Phase F; they are now
// file-based, so drop the tables if an older DB still has them. The source JSON
// on disk is the surviving copy. `rpg_entities` was a forward-facing table that never
// had any reader/writer (WS-6) — always empty, so dropping it from old DBs is safe.
// (`pending_lore`, an unused `chats` column, is left in place: a NULL column is harmless
// and ALTER ... DROP COLUMN isn't worth the migration risk.)
const DROP_LEGACY = `
DROP TABLE IF EXISTS lorebook_entries;
DROP TABLE IF EXISTS lorebooks;
DROP TABLE IF EXISTS presets;
DROP TABLE IF EXISTS presets_legacy;
DROP TABLE IF EXISTS profile_state;
DROP TABLE IF EXISTS rpg_entities;
-- Legacy long-term-memory tables. episodic_memory was reserved, never written; memory_entries
-- backed the episodic-memory engine removed in the SQL-table-memory overhaul (2026-07-02) — it
-- never ran live (memory.enabled defaulted off), so its data is dropped rather than migrated. The
-- stale, unread chats.memory_state column is deliberately left in place (SQLite DROP COLUMN isn't
-- worth the migration risk; a NULL column is harmless — same call as pending_lore above).
DROP TABLE IF EXISTS episodic_memory;
DROP TABLE IF EXISTS memory_entries;
`

/** Add a column to a table if a pre-existing DB doesn't already have it (idempotent). */
const addColumnIfMissing = (
  database: Database.Database,
  table: string,
  column: string,
  ddl: string
): void => {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
}

/** WP4.6 version-coexistence migration: rebuild a LEGACY `agent_packs` (PK `id` only, one version per
 *  id) into the (profile_id, id, version) shape, PRESERVING every row. SQLite cannot ALTER a PRIMARY
 *  KEY in place, so the only faithful path is create-new / copy / drop / rename — done inside a single
 *  transaction (all-or-nothing). Detection: the legacy table has a single-column PK (`id`, pk=1) and
 *  `version` is a non-PK column; the new table has a 3-column composite PK. We detect the legacy shape
 *  by "`version` has pk-ordinal 0" (not part of the key). Idempotent: a no-op once migrated (version
 *  is in the PK) or when the table doesn't yet exist (a fresh DB — SCHEMA creates the new shape).
 *
 *  agent_pack_activation is migrated in the SAME step: its rows must be backfilled with pin_version =
 *  the version currently installed for that (profile, pack) — the ONLY version a legacy DB held, so
 *  the pin is unambiguous. We add the pin_version column (addColumnIfMissing handles the DDL) and
 *  UPDATE the null pins from the just-migrated agent_packs. Activation is not profile-scoped in its
 *  own row (pack_id is globally unique in a legacy DB since id was the PK), so the backfill joins on
 *  pack_id alone — correct for legacy data where a pack_id maps to exactly one version. */
export const migrateAgentPacksToVersioned = (database: Database.Database): void => {
  const cols = database.prepare(`PRAGMA table_info(agent_packs)`).all() as Array<{
    name: string
    pk: number
  }>
  if (cols.length === 0) return // no table yet — SCHEMA will create the new shape

  const versionCol = cols.find((c) => c.name === 'version')
  const alreadyVersioned = versionCol != null && versionCol.pk > 0
  if (alreadyVersioned) return // already the (profile_id, id, version) shape — nothing to do

  // Legacy shape: rebuild preserving rows, inside one transaction.
  database.transaction(() => {
    database.exec(`
      CREATE TABLE agent_packs_new (
        id TEXT NOT NULL,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        upstream_id TEXT,
        upstream_version INTEGER,
        builtin INTEGER NOT NULL DEFAULT 0,
        manifest TEXT NOT NULL,
        fragment TEXT NOT NULL,
        created_at TEXT,
        PRIMARY KEY (profile_id, id, version)
      );
      INSERT INTO agent_packs_new (id, profile_id, version, upstream_id, builtin, manifest, fragment, created_at)
        SELECT id, profile_id, version, upstream_id, builtin, manifest, fragment, created_at FROM agent_packs;
      DROP TABLE agent_packs;
      ALTER TABLE agent_packs_new RENAME TO agent_packs;
      CREATE INDEX IF NOT EXISTS idx_agent_packs_profile ON agent_packs(profile_id);
    `)
  })()
}

/**
 * One-time backfill for the `table_ops.target_table` column (WS1). Rows logged before the column
 * existed carry NULL; classify each with the write-path classifier and store the target table, or
 * `'*'` when the raw SQL no longer classifies (the always-replay defensive tail). Since only
 * `validateBatch`-gated statements were ever logged, practically every row resolves. Idempotent —
 * scoped to `target_table IS NULL`, so a second run is a no-op. `source` is deliberately left NULL for
 * legacy rows: provenance is not reconstructable (a pre-WS1 structural re-baseline is indistinguishable
 * from organic floor-0 ops — documented residual risk behind the refill baseline gate).
 */
export const migrateTableOpsTargetTable = (database: Database.Database): void => {
  const rows = database
    .prepare('SELECT rowid AS rid, sql FROM table_ops WHERE target_table IS NULL')
    .all() as Array<{ rid: number; sql: string }>
  if (!rows.length) return
  const upd = database.prepare('UPDATE table_ops SET target_table = ? WHERE rowid = ?')
  const run = database.transaction((batch: Array<{ rid: number; sql: string }>) => {
    for (const r of batch) {
      let table = '*'
      try {
        table = classifyStatement(r.sql).table
      } catch {
        table = '*'
      }
      upd.run(table, r.rid)
    }
  })
  run(rows)
}

export const getDb = (): Database.Database => {
  if (db) return db
  ensureDir(getAppDir())
  db = new Database(path.join(getAppDir(), 'rpterminal.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // node_state pre-migration: the 2-column-PK shape shipped 2026-07-01 and never ran live
  // (no selection surface existed), so a legacy table is dropped rather than migrated —
  // CREATE IF NOT EXISTS below rebuilds it keyed (chat_id, workflow_id, node_id).
  const nodeStateCols = db.prepare(`PRAGMA table_info(node_state)`).all() as Array<{ name: string }>
  if (nodeStateCols.length > 0 && !nodeStateCols.some((c) => c.name === 'workflow_id')) {
    db.exec('DROP TABLE node_state')
  }
  // WP4.6: rebuild a legacy (profile_id, id)-keyed agent_packs into (profile_id, id, version) BEFORE
  // SCHEMA — CREATE TABLE IF NOT EXISTS can't alter an existing table's PK, so the migration must run
  // first (it preserves every row). A no-op on a fresh DB or an already-migrated one.
  migrateAgentPacksToVersioned(db)
  db.exec(SCHEMA)
  db.exec(DROP_LEGACY)
  // Lightweight forward migrations for DBs created before a column existed.
  addColumnIfMissing(db, 'chats', 'lorebook_ids', 'lorebook_ids TEXT')
  addColumnIfMissing(db, 'chats', 'mode', 'mode TEXT')
  addColumnIfMissing(db, 'chats', 'cached_world_info', 'cached_world_info TEXT')
  addColumnIfMissing(db, 'chats', 'pending_lore', 'pending_lore TEXT')
  // Session-tier workflow override (node-workflow spec §12); null = inherit world/global/builtin.
  addColumnIfMissing(db, 'chats', 'workflow_id', 'workflow_id TEXT')
  // SQL-table-memory: the assigned table-template id (null = table memory off for this chat).
  // The table DATA lives in a separate per-chat sandbox DB, not here (tableDbService).
  addColumnIfMissing(db, 'chats', 'table_template_id', 'table_template_id TEXT')
  // Decentralized-save-system (§B3): denormalized session summary maintained by floorService, so the
  // launcher (getChats/buildSession) renders from the index without opening any per-chat session DB.
  addColumnIfMissing(db, 'chats', 'floor_count', 'floor_count INTEGER')
  addColumnIfMissing(db, 'chats', 'last_floor', 'last_floor INTEGER')
  addColumnIfMissing(db, 'chats', 'last_floor_ts', 'last_floor_ts TEXT')
  addColumnIfMissing(db, 'chats', 'last_user_preview', 'last_user_preview TEXT')
  addColumnIfMissing(db, 'chats', 'last_response_preview', 'last_response_preview TEXT')
  // Per-chat migration marker (§B5): 0 = chat-scoped state still lives in the central tables and must
  // be migrated into profiles/<id>/chats/<chatId>/session.sqlite; 1 = migrated (or born decentralized).
  // Pre-existing chats default to 0 (migrated on next startup); createChat writes 1 for new chats.
  addColumnIfMissing(db, 'chats', 'session_migrated', 'session_migrated INTEGER NOT NULL DEFAULT 0')
  // TH-2 swipes: alternate responses per floor + the active index.
  addColumnIfMissing(db, 'floors', 'swipes', 'swipes TEXT')
  addColumnIfMissing(db, 'floors', 'swipe_id', 'swipe_id INTEGER')
  // The full prompt (message array) sent for this floor — lossless inspection/replay.
  addColumnIfMissing(db, 'floors', 'request', 'request TEXT')
  // Per-turn cache/token metrics (turn + cumulative snapshot) — see token-cache-meter-design.md.
  addColumnIfMissing(db, 'floors', 'metrics', 'metrics TEXT')
  // Display-only plot-recall directive (recall's plot_block), rendered in the collapsible plot panel.
  addColumnIfMissing(db, 'floors', 'plot_block', 'plot_block TEXT')
  // WP4.6: pin_version records which pack version an activation runs (version-coexistence). Add it to
  // a pre-WP4.6 activation table, then BACKFILL null pins from the just-migrated agent_packs: a legacy
  // DB held exactly one version per pack id, so that version is the unambiguous pin for its rows. A
  // fresh DB gets pin_version from SCHEMA already; a fresh install never has null pins (setGate writes
  // one). NULL pins that survive (activation for an uninstalled pack) are handled at resolve time.
  addColumnIfMissing(db, 'agent_pack_activation', 'pin_version', 'pin_version INTEGER')
  // WP4.6: fork lineage gained the source VERSION (upstream_version). A DB migrated to the versioned
  // agent_packs shape but predating this column gets it here (the migration's create-new path already
  // includes it; this covers the already-versioned-but-older case). Null for existing rows.
  addColumnIfMissing(db, 'agent_packs', 'upstream_version', 'upstream_version INTEGER')
  // Agent & memory UX WP-D: run attribution for agent cards — the firing trigger node ids (JSON).
  // Pre-WP-D rows keep NULL and simply don't attribute (fail-soft).
  addColumnIfMissing(db, 'workflow_run_history', 'trigger_node_ids', 'trigger_node_ids TEXT')
  // Table-refill WS1: op-log attribution. `target_table` = the single table a statement writes (the
  // filtered-cut key; `'*'` = unclassifiable/always-replay). `source` = write-path provenance
  // (maintain/backfill/edit/baseline/refill; NULL for legacy rows). Both are added here (fresh or
  // legacy DB), THEN the target-table index and the backfill are run — the index references
  // `target_table`, so it must be created after the column exists (SCHEMA runs before this block).
  addColumnIfMissing(db, 'table_ops', 'target_table', 'target_table TEXT')
  addColumnIfMissing(db, 'table_ops', 'source', 'source TEXT')
  // Table-refill P1: `from_floor` = the START floor of the maintainer batch that produced an op (ops are
  // attributed to the batch's LAST floor via `floor`, so a multi-floor span's start was previously lost).
  // A refill widens its cutpoint down to `MIN(COALESCE(from_floor, floor))` so it can never bisect a
  // stored span. Nullable; legacy rows stay NULL = "treat as a single-floor op" (COALESCE → `floor`).
  addColumnIfMissing(db, 'table_ops', 'from_floor', 'from_floor INTEGER')
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_table_ops_chat_table_floor ON table_ops(chat_id, target_table, floor)'
  )
  migrateTableOpsTargetTable(db)
  db.exec(`
    UPDATE agent_pack_activation
       SET pin_version = (SELECT version FROM agent_packs WHERE agent_packs.id = agent_pack_activation.pack_id)
     WHERE pin_version IS NULL
       AND EXISTS (SELECT 1 FROM agent_packs WHERE agent_packs.id = agent_pack_activation.pack_id)
  `)
  return db
}

/** Run `fn` inside a single SQLite transaction (all-or-nothing; rolls back if it throws). */
export const transact = <T>(fn: () => T): T => getDb().transaction(fn)()

/** Close and forget the memoized central DB handle. For TEST teardown only (production keeps one
 *  handle for the app's lifetime) — lets a suite point getAppDir at a fresh temp dir per test and
 *  release the file so it can be removed on Windows. Idempotent. */
export const closeDb = (): void => {
  if (db) {
    try {
      db.close()
    } catch {
      /* ignore */
    }
    db = null
  }
}
