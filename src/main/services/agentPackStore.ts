// Agent-pack library + activation + override persistence (agent-packs plan WP1.4).
//
// Decisions:
//  - ADR 0005 (install globally, activate per world, override per chat — nearest scope wins).
//  - ADR 0006 (forks are copy-on-edit; the store records upstream lineage on every install).
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

// ── Types ──────────────────────────────────────────────────────────────────────────────────────

/** Minimal v0 manifest (agent-packs plan WP1.4 — "schema can be a minimal v0 type for now"). The
 *  full exposed-setting schema is a later WP; this pins only what the list/settings read side needs.
 *  `exposedSettings` maps a stable setting id → its default value shape (unknown until Phase 4). */
export interface PackManifest {
  name: string
  description?: string
  creator?: string
  /** Stable-id → default value. Overrides layer on top of these (resolveOverrides). */
  exposedSettings?: Record<string, unknown>
}

/** One installed pack (an Install, glossary): the library row. The fragment is a kind:'fragment'
 *  WorkflowDoc (never run alone; composed into the effective graph). */
export interface AgentPackRecord {
  id: string
  version: number
  /** Fork lineage (ADR 0006): the pristine install this was copy-on-edited from, or null for a root
   *  install. Recorded so upstream-diffing stays possible; not yet consumed in this WP. */
  upstreamId: string | null
  builtin: boolean
  manifest: PackManifest
  fragment: WorkflowDoc
}

/** A summary for the list side (no fragment blob — cheap for the future settings UI list). */
export interface AgentPackSummary {
  id: string
  version: number
  upstreamId: string | null
  builtin: boolean
  manifest: PackManifest
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
  builtin: number
  manifest: string
  fragment: string
}): AgentPackRecord => ({
  id: row.id,
  version: row.version,
  upstreamId: row.upstream_id ?? null,
  builtin: row.builtin === 1,
  manifest: JSON.parse(row.manifest) as PackManifest,
  fragment: JSON.parse(row.fragment) as WorkflowDoc
})

export const packToSummary = (pack: AgentPackRecord): AgentPackSummary => ({
  id: pack.id,
  version: pack.version,
  upstreamId: pack.upstreamId,
  builtin: pack.builtin,
  manifest: pack.manifest
})

/** Resolve the gate for a (pack, world, chat): a chat-scope row wins over the world-scope row; with
 *  no matching row the gate is CLOSED (packs are opt-in — glossary: Activation). Returns the
 *  resolved gate + the denial set that goes with the winning row (needed for closedEntryIndexes). */
export const resolveGate = (
  rows: ActivationRow[],
  worldId: string,
  chatId: string | null
): { open: boolean; denial: number[] } => {
  const forWorld = rows.filter((r) => r.worldId === worldId)
  const chatRow = chatId == null ? undefined : forWorld.find((r) => r.chatId === chatId)
  const worldRow = forWorld.find((r) => r.chatId == null)
  const winner = chatRow ?? worldRow
  return winner ? { open: winner.gateOpen, denial: winner.denial } : { open: false, denial: [] }
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

// ── SQL wrappers (runtime-validated only; the sqlite mock returns empty rows under Node) ──────────

const packColumns = 'id, version, upstream_id, builtin, manifest, fragment'

/** All installed packs for a profile (Library), builtin last-writer-agnostic (sorted by name). */
export const listPackRecords = (profileId: string): AgentPackRecord[] => {
  const rows = getDb()
    .prepare(`SELECT ${packColumns} FROM agent_packs WHERE profile_id = ?`)
    .all(profileId) as Parameters<typeof rowToPack>[0][]
  return rows.map(rowToPack)
}

export const getPackRecord = (profileId: string, packId: string): AgentPackRecord | null => {
  const row = getDb()
    .prepare(`SELECT ${packColumns} FROM agent_packs WHERE profile_id = ? AND id = ?`)
    .get(profileId, packId) as Parameters<typeof rowToPack>[0] | undefined
  return row ? rowToPack(row) : null
}

/** Read the raw (id, version) of an installed pack — cheap dedupe probe for install(). */
export const getPackIdentity = (
  profileId: string,
  packId: string
): { id: string; version: number } | null => {
  const row = getDb()
    .prepare('SELECT id, version FROM agent_packs WHERE profile_id = ? AND id = ?')
    .get(profileId, packId) as { id: string; version: number } | undefined
  return row ?? null
}

export const insertPack = (profileId: string, pack: AgentPackRecord): void => {
  getDb()
    .prepare(
      `INSERT INTO agent_packs (id, profile_id, version, upstream_id, builtin, manifest, fragment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      pack.id,
      profileId,
      pack.version,
      pack.upstreamId,
      pack.builtin ? 1 : 0,
      JSON.stringify(pack.manifest),
      JSON.stringify(pack.fragment),
      new Date().toISOString()
    )
}

/** Delete a pack row + all its activation/override rows (uninstall). Returns whether it existed. */
export const deletePack = (profileId: string, packId: string): boolean => {
  const info = getDb()
    .prepare('DELETE FROM agent_packs WHERE profile_id = ? AND id = ?')
    .run(profileId, packId)
  getDb().prepare('DELETE FROM agent_pack_activation WHERE pack_id = ?').run(packId)
  getDb().prepare('DELETE FROM agent_pack_overrides WHERE pack_id = ?').run(packId)
  return info.changes > 0
}

/** Every activation row for a pack (world + chat rows). */
export const listActivationRows = (packId: string): ActivationRow[] => {
  const rows = getDb()
    .prepare(
      'SELECT pack_id, world_id, chat_id, gate_open, denial FROM agent_pack_activation WHERE pack_id = ?'
    )
    .all(packId) as {
    pack_id: string
    world_id: string
    chat_id: string | null
    gate_open: number
    denial: string | null
  }[]
  return rows.map((r) => ({
    packId: r.pack_id,
    worldId: r.world_id,
    chatId: r.chat_id ?? null,
    gateOpen: r.gate_open === 1,
    denial: parseDenial(r.denial)
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
 *  index, so the world row (chat_id NULL) and chat rows coexist under the PK. */
export const upsertGate = (
  packId: string,
  worldId: string,
  chatId: string | null,
  open: boolean
): void => {
  // chat_id NULL can't participate in ON CONFLICT (NULLs aren't equal), so branch: the world row is
  // matched by an explicit IS NULL update-or-insert; chat rows use the composite PK conflict.
  const db = getDb()
  if (chatId == null) {
    const info = db
      .prepare(
        'UPDATE agent_pack_activation SET gate_open = ? WHERE pack_id = ? AND world_id = ? AND chat_id IS NULL'
      )
      .run(open ? 1 : 0, packId, worldId)
    if (info.changes === 0) {
      db.prepare(
        'INSERT INTO agent_pack_activation (pack_id, world_id, chat_id, gate_open, denial) VALUES (?, ?, NULL, ?, NULL)'
      ).run(packId, worldId, open ? 1 : 0)
    }
  } else {
    db.prepare(
      `INSERT INTO agent_pack_activation (pack_id, world_id, chat_id, gate_open, denial)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(pack_id, world_id, chat_id) DO UPDATE SET gate_open = excluded.gate_open`
    ).run(packId, worldId, chatId, open ? 1 : 0)
  }
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
