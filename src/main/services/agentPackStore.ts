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
   *  install. Recorded so upstream-diffing stays possible; not yet consumed in this WP. */
  upstreamId: string | null
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
  manifest: pack.manifest,
  // Derive the display extras from the fragment (read-only; the fragment blob itself never leaves
  // main — see AgentPackSummary). `attachments` on a fragment doc is optional in the type but a
  // fragment always declares ≥1 (WP1.1 validation); default to [] defensively.
  attachments: pack.fragment.attachments ?? [],
  capabilities: deriveCapabilities(pack.fragment)
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

/** Replace a pack's stored fragment doc (agent-packs plan WP3.6b — fork write-through). Returns
 *  whether a row was updated (0 = no such pack in this profile). The service layer gates this to
 *  NON-builtin packs and validates the doc first; this wrapper is the raw SQL update. */
export const updatePackFragmentRow = (
  profileId: string,
  packId: string,
  fragment: WorkflowDoc
): boolean => {
  const info = getDb()
    .prepare('UPDATE agent_packs SET fragment = ? WHERE profile_id = ? AND id = ?')
    .run(JSON.stringify(fragment), profileId, packId)
  return info.changes > 0
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
      `INSERT INTO agent_pack_activation (pack_id, world_id, chat_id, gate_open, denial)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(pack_id, world_id, chat_id) DO UPDATE SET gate_open = excluded.gate_open, denial = excluded.denial`
    )
    .run(
      row.packId,
      row.worldId,
      row.chatId,
      row.gateOpen ? 1 : 0,
      row.denial.length ? JSON.stringify(row.denial) : null
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
