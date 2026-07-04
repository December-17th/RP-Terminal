// Agent-pack library + activation + override persistence (agent-packs plan WP1.4).
//
// Decisions:
//  - ADR 0005 (install globally, activate per world, override per chat — nearest scope wins).
//  - ADR 0006 (forks are copy-on-edit; the store records upstream lineage on every install).
//  - ADR 0008 (recipes pin versions — VERSION COEXISTENCE, WP4.6): library identity is (id, version),
//    so two versions of one id are distinct rows that coexist; a world's activation PINS one version.
//  - ADR 0009 (one pack, one graph, many attachments — the gate is per-pack).
// Glossary: root CONTEXT.md (Install, Library, Activation, Override, Gate).
//
// This is the SQLite surface. It mirrors the other main stores' stance (nodeStateService,
// tableDbService, chatService): a thin set of `getDb()` wrappers around PURE helpers. The native
// better-sqlite3 binary can't load under plain Node, so the SQL wrappers are runtime-validated only;
// the PURE resolution logic (dedupe, gate resolution, override layering, fragment building) is
// exported and unit-tested directly (test/agentPackStore.test.ts), exactly as tableOps/tableDb do.
//
// Fragment docs are stored HERE (agent_packs.fragment), NEVER in the profile workflow dir, so
// workflowService.listWorkflows (which only globs that dir — workflowService.ts:88-117) can never
// surface a pack fragment in the turn-workflow selection UI. Verified for the WP report.

import { getDb } from './db'
import { WorkflowDoc } from '../../shared/workflow/types'
import { AttachmentDecl } from '../../shared/workflow/attachments'
import { deriveCapabilities, CapabilityId } from '../../shared/workflow/capabilities'
import type { PackManifest } from '../../shared/workflow/packManifest'

// ── Types ──────────────────────────────────────────────────────────────────────────────────────

// The manifest types (ExposedSetting, PackManifest) moved to the SHARED layer in WP4.1 so the pack
// ENVELOPE schema (shared/workflow/packEnvelope.ts) can serialize them without importing main. They
// are re-exported here so every existing `import { PackManifest } from './agentPackStore'` keeps
// compiling — the store is still the main-side home of the manifest.
export type { ExposedSetting, PackManifest } from '../../shared/workflow/packManifest'

/** One installed pack (an Install, glossary): the library row. The fragment is a kind:'fragment'
 *  WorkflowDoc (never run alone; composed into the effective graph). */
export interface AgentPackRecord {
  id: string
  version: number
  /** Fork lineage (ADR 0006): the pristine install this was copy-on-edited from, or null for a root
   *  install. Recorded so upstream-diffing stays possible. */
  upstreamId: string | null
  /** The SOURCE VERSION this fork was copied from (WP4.6 — lineage is now (id, version), matching
   *  library identity). null for a root install or a legacy fork that recorded only upstreamId. */
  upstreamVersion: number | null
  builtin: boolean
  manifest: PackManifest
  fragment: WorkflowDoc
}

/** A summary for the list side (no fragment blob — cheap for the future settings UI list). The
 *  Agents workspace pack card (agent-packs plan WP3.1) needs a little more than the raw manifest:
 *  the fragment's ATTACHMENTS (to render the read-only "before reply / after reply / headless"
 *  badges) and its derived CAPABILITIES (the chip row). Both are DERIVED read-only from the stored
 *  fragment here (never sent as the whole fragment blob), so the renderer stays a pure consumer of
 *  the typed IPC surface and never sees pack internals. */
export interface AgentPackSummary {
  id: string
  version: number
  upstreamId: string | null
  /** The source version this fork was copied from (WP4.6), or null (root install / legacy fork). */
  upstreamVersion: number | null
  builtin: boolean
  manifest: PackManifest
  /** The fragment's attachment declarations (entry / rejoin / trigger) — the structure the card's
   *  badges render from (WP3.1). Read-only display data; a subset of the fragment, not the graph. */
  attachments: AttachmentDecl[]
  /** The capabilities derived from the fragment's node types + attachments (ADR 0007 mechanical
   *  table; shared/workflow/capabilities.deriveCapabilities). The card's capability chips. */
  capabilities: CapabilityId[]
  /** The RESOLVED gate state for the (world, chat) the list was requested in, or undefined when the
   *  list was requested with no world context (WP3.1: the Agents card needs the persisted gate to
   *  render the toggle on load — there is no separate read-gate endpoint). Nearest-scope-wins
   *  (chat over world; default CLOSED). Read-only; the toggle still writes via setAgentPackGate. */
  gateOpen?: boolean
  /** Every installed version of THIS id in the library, ascending (WP4.6 version coexistence). Same
   *  on every summary that shares the id (the lineage the UI groups by, alongside forks — ADR 0008
   *  consequence: "the library UI must group by lineage"). Additive: existing consumers ignore it. */
  versions: number[]
  /** The version PINNED to run in the (world, chat) the list was requested in — present only with a
   *  world context AND when this id has an open gate there (WP4.6). Lets the UI mark which coexisting
   *  version is active without a second call. Undefined with no world / no open gate. Additive. */
  activeVersion?: number
}

/** An activation row (ADR 0005/0009): the per-(pack, world) gate, with an optional per-chat
 *  exception when chatId is non-null. No row = gate CLOSED (packs are opt-in). */
export interface ActivationRow {
  packId: string
  worldId: string
  /** null = the world-scope gate row; non-null = the per-chat exception (wins over the world row). */
  chatId: string | null
  gateOpen: boolean
  /** Closed entry indexes / denied capability ids (semantics land in a later WP). */
  denial: number[]
  /** The pack VERSION this activation runs (WP4.6 version coexistence, ADR 0008 — recipes pin a
   *  version). null = unpinned (a legacy row for an uninstalled pack, or a gate written before any
   *  version resolved); resolution falls back to the sole/highest installed version. Switching which
   *  version runs is an UPDATE of this field (setActiveVersion), never a second row. */
  pinVersion: number | null
}

/** Override scope encoding (ADR 0005 three tiers). `'global'` is the library-wide default; a world
 *  id or chat id names the narrower tiers. This mirrors the workflow selection sidecar's
 *  global/world encoding (workflowService.ts:207-244), widened with the chat tier the sidecar
 *  lacks — the one place ADR 0005's model needed a small extension over the existing sidecar (flagged
 *  in the WP report). Because a world id and a chat id are both opaque strings, callers pass the
 *  scope pre-encoded; resolution is told which world/chat to look up (resolveOverrides). */
export type OverrideScope = 'global' | { world: string } | { chat: string }

/** Encode an OverrideScope to the single string stored in agent_pack_overrides.scope. */
export const encodeScope = (scope: OverrideScope): string =>
  scope === 'global' ? 'global' : 'world' in scope ? `world:${scope.world}` : `chat:${scope.chat}`

export interface OverrideRow {
  packId: string
  scope: string
  settingId: string
  value: unknown
}

// ── Pure helpers (unit-tested directly under the sqlite mock) ─────────────────────────────────────

/** Parse a raw agent_packs DB row into an AgentPackRecord. Corrupt JSON blobs throw — a pack whose
 *  fragment/manifest is unparseable is a real defect, not a fall-through case (unlike a stale
 *  workflow id), and install() only ever writes validated JSON. */
export const rowToPack = (row: {
  id: string
  version: number
  upstream_id: string | null
  upstream_version?: number | null
  builtin: number
  manifest: string
  fragment: string
}): AgentPackRecord => ({
  id: row.id,
  version: row.version,
  upstreamId: row.upstream_id ?? null,
  upstreamVersion: row.upstream_version ?? null,
  builtin: row.builtin === 1,
  manifest: JSON.parse(row.manifest) as PackManifest,
  fragment: JSON.parse(row.fragment) as WorkflowDoc
})

export const packToSummary = (pack: AgentPackRecord): AgentPackSummary => ({
  id: pack.id,
  version: pack.version,
  upstreamId: pack.upstreamId,
  upstreamVersion: pack.upstreamVersion,
  builtin: pack.builtin,
  manifest: pack.manifest,
  // Derive the display extras from the fragment (read-only; the fragment blob itself never leaves
  // main — see AgentPackSummary). `attachments` on a fragment doc is optional in the type but a
  // fragment always declares ≥1 (WP1.1 validation); default to [] defensively.
  attachments: pack.fragment.attachments ?? [],
  capabilities: deriveCapabilities(pack.fragment),
  // Default the grouped lineage to this record's own version; the service overrides it with the full
  // installed-version set for the id (it holds the whole library list — packToSummary sees one row).
  versions: [pack.version]
})

/** Resolve the gate for a (pack, world, chat): a chat-scope row wins over the world-scope row; with
 *  no matching row the gate is CLOSED (packs are opt-in — glossary: Activation). Returns the
 *  resolved gate + the denial set that goes with the winning row (needed for closedEntryIndexes) +
 *  the PINNED version the winning row runs (WP4.6 — which of coexisting versions composes; null when
 *  no row or an unpinned legacy row, letting the caller fall back to the sole installed version). */
export const resolveGate = (
  rows: ActivationRow[],
  worldId: string,
  chatId: string | null
): { open: boolean; denial: number[]; pinVersion: number | null } => {
  const forWorld = rows.filter((r) => r.worldId === worldId)
  const chatRow = chatId == null ? undefined : forWorld.find((r) => r.chatId === chatId)
  const worldRow = forWorld.find((r) => r.chatId == null)
  const winner = chatRow ?? worldRow
  return winner
    ? { open: winner.gateOpen, denial: winner.denial, pinVersion: winner.pinVersion }
    : { open: false, denial: [], pinVersion: null }
}

/** Pick the record that a resolved gate's pin selects from a set of same-id installs (WP4.6). The
 *  pinned version if present + installed; else the HIGHEST installed version (the sensible default
 *  when a legacy/unpinned row resolved, or a pin points at an uninstalled version). Returns undefined
 *  only when the set is empty. Pure — the service passes it the same-id records + the resolved pin. */
export const pickPinnedRecord = (
  sameIdRecords: AgentPackRecord[],
  pinVersion: number | null
): AgentPackRecord | undefined => {
  if (sameIdRecords.length === 0) return undefined
  if (pinVersion != null) {
    const exact = sameIdRecords.find((r) => r.version === pinVersion)
    if (exact) return exact
  }
  return [...sameIdRecords].sort((a, b) => b.version - a.version)[0]
}

/** Nearest-scope-wins override resolution (ADR 0005: global default < world < chat). Later tiers
 *  overwrite earlier ones per setting id; a setting present only at a broad tier survives. Returns a
 *  flat { settingId → value } map. */
export const layerOverrides = (
  rows: OverrideRow[],
  worldId: string | null,
  chatId: string | null
): Record<string, unknown> => {
  const tier = (scope: string): number => {
    if (scope === 'global') return 0
    if (worldId != null && scope === `world:${worldId}`) return 1
    if (chatId != null && scope === `chat:${chatId}`) return 2
    return -1 // a scope for some OTHER world/chat — not in this resolution path
  }
  const out: Record<string, unknown> = {}
  // Apply in ascending tier order so the nearest scope overwrites last (wins).
  for (const r of [...rows].filter((r) => tier(r.scope) >= 0).sort((a, b) => tier(a.scope) - tier(b.scope))) {
    out[r.settingId] = r.value
  }
  return out
}

/** The scope an override's resolved value came FROM — the provenance chip (agent-packs plan WP3.2;
 *  mirrors ADR 0005's three tiers). `default` = no override at any applicable tier (the setting's
 *  built-in default is in effect). */
export type Provenance = 'default' | 'global' | 'world' | 'chat'

/** One setting's resolved override with its winning scope (nearest-wins), for the settings UI's
 *  provenance chip + reset-to-default. `value` is undefined + `provenance:'default'` when no override
 *  applies. `worldValue`/`chatValue` expose the per-scope raw overrides (present only when set) so the
 *  UI can show "clearing chat reveals world" without re-deriving client-side. */
export interface ResolvedOverride {
  value: unknown
  provenance: Provenance
  /** The raw override value at global scope, if one exists (undefined otherwise). */
  globalValue?: unknown
  /** The raw override value at the world scope, if one exists. */
  worldValue?: unknown
  /** The raw override value at the chat scope, if one exists. */
  chatValue?: unknown
}

/** Nearest-scope-wins resolution WITH provenance (agent-packs plan WP3.2). Same tier order as
 *  layerOverrides (global < world < chat) but returns, per setting id, the winning value AND the scope
 *  it came from, plus each applicable scope's raw value. The UI reads this for the provenance chip and
 *  to show what a reset-to-default would reveal (clearing chat → world → global → default). Pure. */
export const layerOverridesWithProvenance = (
  rows: OverrideRow[],
  worldId: string | null,
  chatId: string | null
): Record<string, ResolvedOverride> => {
  const out: Record<string, ResolvedOverride> = {}
  const ensure = (id: string): ResolvedOverride =>
    (out[id] ??= { value: undefined, provenance: 'default' })
  for (const r of rows) {
    if (r.scope === 'global') {
      const e = ensure(r.settingId)
      e.globalValue = r.value
    } else if (worldId != null && r.scope === `world:${worldId}`) {
      const e = ensure(r.settingId)
      e.worldValue = r.value
    } else if (chatId != null && r.scope === `chat:${chatId}`) {
      const e = ensure(r.settingId)
      e.chatValue = r.value
    }
    // scopes for OTHER worlds/chats are ignored (not in this resolution path).
  }
  // Resolve nearest-wins per setting: chat > world > global > default.
  for (const e of Object.values(out)) {
    if ('chatValue' in e && e.chatValue !== undefined) {
      e.value = e.chatValue
      e.provenance = 'chat'
    } else if ('worldValue' in e && e.worldValue !== undefined) {
      e.value = e.worldValue
      e.provenance = 'world'
    } else if ('globalValue' in e && e.globalValue !== undefined) {
      e.value = e.globalValue
      e.provenance = 'global'
    } else {
      e.provenance = 'default'
    }
  }
  return out
}

// ── SQL wrappers (runtime-validated only; the sqlite mock returns empty rows under Node) ──────────

const packColumns = 'id, version, upstream_id, upstream_version, builtin, manifest, fragment'

/** All installed packs for a profile (Library), builtin last-writer-agnostic (sorted by name). */
export const listPackRecords = (profileId: string): AgentPackRecord[] => {
  const rows = getDb()
    .prepare(`SELECT ${packColumns} FROM agent_packs WHERE profile_id = ?`)
    .all(profileId) as Parameters<typeof rowToPack>[0][]
  return rows.map(rowToPack)
}

/** Read ONE installed pack row by (id, version) — the version-specific accessor (WP4.6). When
 *  `version` is omitted, returns the HIGHEST installed version of the id (the "latest" convenience the
 *  fork/fragment paths use, which operate on a single logical pack). Null when the id is not installed
 *  (at that version). */
export const getPackRecord = (
  profileId: string,
  packId: string,
  version?: number
): AgentPackRecord | null => {
  const db = getDb()
  const row =
    version != null
      ? (db
          .prepare(`SELECT ${packColumns} FROM agent_packs WHERE profile_id = ? AND id = ? AND version = ?`)
          .get(profileId, packId, version) as Parameters<typeof rowToPack>[0] | undefined)
      : (db
          .prepare(
            `SELECT ${packColumns} FROM agent_packs WHERE profile_id = ? AND id = ? ORDER BY version DESC LIMIT 1`
          )
          .get(profileId, packId) as Parameters<typeof rowToPack>[0] | undefined)
  return row ? rowToPack(row) : null
}

/** All installed versions of an id in a profile, ascending (WP4.6 — the grouped lineage the UI needs
 *  + install()'s dedupe probe). Empty when the id is not installed. */
export const listPackVersions = (profileId: string, packId: string): number[] => {
  const rows = getDb()
    .prepare('SELECT version FROM agent_packs WHERE profile_id = ? AND id = ? ORDER BY version ASC')
    .all(profileId, packId) as { version: number }[]
  return rows.map((r) => r.version)
}

/** Read the raw identity of an installed (id, version) — cheap dedupe probe for install(): does THIS
 *  EXACT version exist? (WP4.6: a different version is now install-alongside, not a dedupe.) Null when
 *  that exact (id, version) is not installed. */
export const getPackIdentity = (
  profileId: string,
  packId: string,
  version: number
): { id: string; version: number } | null => {
  const row = getDb()
    .prepare('SELECT id, version FROM agent_packs WHERE profile_id = ? AND id = ? AND version = ?')
    .get(profileId, packId, version) as { id: string; version: number } | undefined
  return row ?? null
}

export const insertPack = (profileId: string, pack: AgentPackRecord): void => {
  getDb()
    .prepare(
      `INSERT INTO agent_packs (id, profile_id, version, upstream_id, upstream_version, builtin, manifest, fragment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      pack.id,
      profileId,
      pack.version,
      pack.upstreamId,
      pack.upstreamVersion,
      pack.builtin ? 1 : 0,
      JSON.stringify(pack.manifest),
      JSON.stringify(pack.fragment),
      new Date().toISOString()
    )
}

/** Replace a pack's stored fragment doc (agent-packs plan WP3.6b — fork write-through). Returns
 *  whether a row was updated (0 = no such pack in this profile). The service layer gates this to
 *  NON-builtin packs and validates the doc first; this wrapper is the raw SQL update. */
export const updatePackFragmentRow = (
  profileId: string,
  packId: string,
  fragment: WorkflowDoc,
  version: number
): boolean => {
  const info = getDb()
    .prepare('UPDATE agent_packs SET fragment = ? WHERE profile_id = ? AND id = ? AND version = ?')
    .run(JSON.stringify(fragment), profileId, packId, version)
  return info.changes > 0
}

/** Delete ONE installed (id, version) library row (WP4.6 version-aware uninstall). Returns whether it
 *  existed. Does NOT touch the version-agnostic activation/override/trigger rows — those are cleaned by
 *  deletePackVersionAgnosticRows only when the LAST version of the id is removed (see the service's
 *  uninstall cascade: drop the row, then if listPackVersions is now empty, clean the shared rows). */
export const deletePackVersion = (profileId: string, packId: string, version: number): boolean => {
  const info = getDb()
    .prepare('DELETE FROM agent_packs WHERE profile_id = ? AND id = ? AND version = ?')
    .run(profileId, packId, version)
  return info.changes > 0
}

/** Delete a pack's VERSION-AGNOSTIC activation + override rows (WP4.6). Called by the uninstall
 *  cascade ONLY after the id's LAST version is gone — activation/overrides are keyed by pack_id with
 *  no version, so they belong to the id as a whole; while any version remains they must survive (a
 *  version switch keeps the world's gate + settings). Trigger state (a third pack_id-keyed table in a
 *  different module) is pruned by the service alongside this. */
export const deletePackVersionAgnosticRows = (packId: string): void => {
  getDb().prepare('DELETE FROM agent_pack_activation WHERE pack_id = ?').run(packId)
  getDb().prepare('DELETE FROM agent_pack_overrides WHERE pack_id = ?').run(packId)
}

/** Every activation row for a pack (world + chat rows). */
export const listActivationRows = (packId: string): ActivationRow[] => {
  const rows = getDb()
    .prepare(
      'SELECT pack_id, world_id, chat_id, gate_open, denial, pin_version FROM agent_pack_activation WHERE pack_id = ?'
    )
    .all(packId) as {
    pack_id: string
    world_id: string
    chat_id: string | null
    gate_open: number
    denial: string | null
    pin_version: number | null
  }[]
  return rows.map((r) => ({
    packId: r.pack_id,
    worldId: r.world_id,
    chatId: r.chat_id ?? null,
    gateOpen: r.gate_open === 1,
    denial: parseDenial(r.denial),
    pinVersion: r.pin_version ?? null
  }))
}

const parseDenial = (raw: string | null): number[] => {
  if (raw == null) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []
  } catch {
    return []
  }
}

/** Upsert the gate row for (pack, world, chat). chat_id NULL = the world-scope row. Preserves any
 *  existing denial set (setGate flips only the gate). SQLite treats NULL as distinct in a UNIQUE
 *  index, so the world row (chat_id NULL) and chat rows coexist under the PK.
 *
 *  WP4.6: `pinVersion` records which version this activation runs. It is written on INSERT and on
 *  UPDATE (opening a gate re-pins to the toggled version) — the ONLY version installed in the common
 *  case, or the specific one the UI toggled when several coexist. A null pin (caller has no version
 *  context) leaves an existing pin untouched on update, and inserts null (resolution falls back to the
 *  highest installed version). */
export const upsertGate = (
  packId: string,
  worldId: string,
  chatId: string | null,
  open: boolean,
  pinVersion: number | null = null
): void => {
  // chat_id NULL can't participate in ON CONFLICT (NULLs aren't equal), so branch: the world row is
  // matched by an explicit IS NULL update-or-insert; chat rows use the composite PK conflict. On
  // UPDATE, keep the existing pin when pinVersion is null (COALESCE(new, existing)).
  const db = getDb()
  if (chatId == null) {
    const info = db
      .prepare(
        'UPDATE agent_pack_activation SET gate_open = ?, pin_version = COALESCE(?, pin_version) WHERE pack_id = ? AND world_id = ? AND chat_id IS NULL'
      )
      .run(open ? 1 : 0, pinVersion, packId, worldId)
    if (info.changes === 0) {
      db.prepare(
        'INSERT INTO agent_pack_activation (pack_id, world_id, chat_id, gate_open, denial, pin_version) VALUES (?, ?, NULL, ?, NULL, ?)'
      ).run(packId, worldId, open ? 1 : 0, pinVersion)
    }
  } else {
    db.prepare(
      `INSERT INTO agent_pack_activation (pack_id, world_id, chat_id, gate_open, denial, pin_version)
       VALUES (?, ?, ?, ?, NULL, ?)
       ON CONFLICT(pack_id, world_id, chat_id) DO UPDATE SET gate_open = excluded.gate_open, pin_version = COALESCE(excluded.pin_version, agent_pack_activation.pin_version)`
    ).run(packId, worldId, chatId, open ? 1 : 0, pinVersion)
  }
}

/** Re-pin which version an activation runs (WP4.6 setActiveVersion): UPDATE pin_version on every
 *  activation row for (pack, world) — the world-scope row AND any per-chat exceptions — so a world
 *  switches versions as a unit. Does NOT create a row (no activation = nothing to re-pin; the caller
 *  guards). Returns the number of rows re-pinned. */
export const setActivePinVersion = (packId: string, worldId: string, version: number): number => {
  const info = getDb()
    .prepare('UPDATE agent_pack_activation SET pin_version = ? WHERE pack_id = ? AND world_id = ?')
    .run(version, packId, worldId)
  return info.changes
}

// ── Fork support (ADR 0006; agent-packs plan WP3.6a — phase-4 machinery pulled forward) ───────────
//
// A fork is a copy-on-edit: a NEW library row with `upstream_id = <source id>`, the editing world's
// activation REPOINTED to the fork, and the source's overrides COPIED so settings carry over. These
// wrappers are the SQL side of that operation; the service (agentPackService.forkPack) orchestrates
// them + the id/manifest derivation. Runtime-validated only under the sqlite mock (like the rest of
// this store); the id-derivation + repoint LOGIC the service layers on top is unit-tested there.

/** Insert a raw pre-built activation row (used by fork repoint to copy the source's rows to the
 *  fork id under the same world/chat, preserving gate + denial). */
export const insertActivationRow = (row: ActivationRow): void => {
  getDb()
    .prepare(
      `INSERT INTO agent_pack_activation (pack_id, world_id, chat_id, gate_open, denial, pin_version)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(pack_id, world_id, chat_id) DO UPDATE SET gate_open = excluded.gate_open, denial = excluded.denial, pin_version = excluded.pin_version`
    )
    .run(
      row.packId,
      row.worldId,
      row.chatId,
      row.gateOpen ? 1 : 0,
      row.denial.length ? JSON.stringify(row.denial) : null,
      row.pinVersion
    )
}

/** Delete every activation row for (pack, world) — both the world-scope row and any per-chat
 *  exceptions — WITHOUT touching other worlds. Used to close the SOURCE pack's activation in the
 *  editing world after repointing it to the fork (ADR 0006: other worlds untouched). */
export const deleteActivationForWorld = (packId: string, worldId: string): void => {
  getDb()
    .prepare('DELETE FROM agent_pack_activation WHERE pack_id = ? AND world_id = ?')
    .run(packId, worldId)
}

/** Insert a raw pre-encoded override row (used by fork to copy the source's overrides to the fork id
 *  so settings carry over — ADR 0006). `value` is stored as JSON, matching upsertOverride. */
export const insertOverrideRow = (packId: string, scope: string, settingId: string, value: unknown): void => {
  getDb()
    .prepare(
      `INSERT INTO agent_pack_overrides (pack_id, scope, setting_id, value)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(pack_id, scope, setting_id) DO UPDATE SET value = excluded.value`
    )
    .run(packId, scope, settingId, JSON.stringify(value))
}

/** Every override row for a pack. */
export const listOverrideRows = (packId: string): OverrideRow[] => {
  const rows = getDb()
    .prepare('SELECT pack_id, scope, setting_id, value FROM agent_pack_overrides WHERE pack_id = ?')
    .all(packId) as { pack_id: string; scope: string; setting_id: string; value: string }[]
  return rows.map((r) => ({
    packId: r.pack_id,
    scope: r.scope,
    settingId: r.setting_id,
    value: safeParse(r.value)
  }))
}

const safeParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

export const upsertOverride = (
  packId: string,
  scope: string,
  settingId: string,
  value: unknown
): void => {
  getDb()
    .prepare(
      `INSERT INTO agent_pack_overrides (pack_id, scope, setting_id, value)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(pack_id, scope, setting_id) DO UPDATE SET value = excluded.value`
    )
    .run(packId, scope, settingId, JSON.stringify(value))
}

export const deleteOverride = (packId: string, scope: string, settingId: string): boolean => {
  const info = getDb()
    .prepare(
      'DELETE FROM agent_pack_overrides WHERE pack_id = ? AND scope = ? AND setting_id = ?'
    )
    .run(packId, scope, settingId)
  return info.changes > 0
}
