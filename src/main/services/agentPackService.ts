// Agent-pack library service (agent-packs plan WP1.4): install/uninstall, per-world gate, exposed-
// setting overrides, and the enabled-fragments provider that WP1.3's composition seam consumes.
//
// Decisions:
//  - ADR 0005 (install globally, activate per world, override per chat — nearest scope wins).
//  - ADR 0006 (forks are copy-on-edit; install records upstream lineage).
//  - ADR 0008 (recipes dedupe into the library on import — install() dedupes id+version, anticipating
//    the recipe path that lands full copies which must collapse to the existing install).
//  - ADR 0009 (one pack, one graph, many attachments — the gate is per-pack).
// Glossary: root CONTEXT.md (Install, Library, Activation, Override, Gate).
//
// Import direction (breaks the cycle): this service imports workflowService ONLY to call the
// exported `setEnabledFragmentsProvider` seam on init. workflowService must NEVER import back here
// (it depends on this service's selection/resolution), which is exactly why WP1.3 added the module-
// level provider hook instead of a direct import (workflowService.ts:299-323).

import { ComposeFragment, CompositionMeta } from '../../shared/workflow/compose'
import { ComposeWarning } from '../../shared/workflow/compose'
import { setEnabledFragmentsProvider, resolveEffectiveDoc, validateWorkflowDoc } from './workflowService'
import { getChat } from './chatService'
import { log } from './logService'
import { BUILTIN_PACKS } from './nodes/builtin/tableMemoryPack'
import { materializeFragment, deriveSystemSettings, SystemSetting } from './agentPackMaterialize'
import { deleteTriggerStateForPack } from './agentPackTriggerStore'
import { WorkflowDoc } from '../../shared/workflow/types'
import {
  AgentPackRecord,
  AgentPackSummary,
  OverrideScope,
  encodeScope,
  getPackRecord,
  getPackIdentity,
  insertPack,
  deletePack,
  listPackRecords,
  packToSummary,
  listActivationRows,
  upsertGate,
  resolveGate,
  listOverrideRows,
  upsertOverride,
  deleteOverride,
  layerOverrides,
  layerOverridesWithProvenance,
  ResolvedOverride,
  insertActivationRow,
  deleteActivationForWorld,
  insertOverrideRow,
  updatePackFragmentRow,
  PackManifest
} from './agentPackStore'

// ── Built-in pack seeding (agent-packs plan WP1.6) ──────────────────────────────────────────────
//
// The app ships its own packs (SQL Table Memory today; BUILTIN_PACKS is the extension point). They
// are seeded into every profile's library lazily + idempotently: `install()` already dedupes by
// (id, version), so re-seeding is a cheap no-op after the first time. We seed at the read entry
// points that need packs (list / enabledFragmentsFor) rather than a one-shot app-init hook because
// the library is PER-PROFILE (agent_packs.profile_id) and main has no single "profile selected"
// seam — the same lazy-ensure idiom workflowService uses for its per-profile dirs.
//
// Gate stays CLOSED by default: seeding installs the library row but writes NO activation row, and
// "no row = gate closed" (packs are opt-in — agentPackStore.resolveGate). Phase-1 acceptance is
// equivalence when the gate is opened, clean removal when it is closed.

const seededProfiles = new Set<string>()

/** Ensure this profile's library contains every built-in pack (idempotent). Cheap after the first
 *  call: an in-process guard skips the DB probe, and install() dedupes even without it. */
export const seedBuiltinPacks = (profileId: string): void => {
  if (seededProfiles.has(profileId)) return
  for (const build of BUILTIN_PACKS) install(profileId, build())
  seededProfiles.add(profileId)
}

// ── Read side ─────────────────────────────────────────────────────────────────────────────────

/** The installed packs (Library) with manifest summaries — builtin flag + fork lineage, plus (WP3.1)
 *  each fragment's derived attachments + capabilities. When a `worldId` is supplied (the active
 *  chat's world), each summary also carries the RESOLVED gate state for that (world, chat) so the
 *  Agents card can render its toggle on load without a separate read endpoint (read-only; the toggle
 *  still writes via setGate). With no worldId, `gateOpen` is left undefined. */
export const list = (
  profileId: string,
  worldId?: string | null,
  chatId?: string | null
): AgentPackSummary[] => {
  seedBuiltinPacks(profileId)
  return listPackRecords(profileId)
    .map((pack) => {
      const summary = packToSummary(pack)
      if (worldId != null) {
        summary.gateOpen = resolveGate(
          listActivationRows(pack.id),
          worldId,
          chatId ?? null
        ).open
      }
      return summary
    })
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
}

/** The SOURCE fragment doc for an installed pack, or null when it is not installed (agent-packs plan
 *  WP3.6b). The renderer's Effective-mode edit routing fetches this to apply an edit to a COPY before
 *  forking / writing through — the fragment blob is otherwise kept out of the list payload. */
export const getPackFragment = (profileId: string, packId: string): WorkflowDoc | null =>
  getPackRecord(profileId, packId)?.fragment ?? null

// ── Install / uninstall ─────────────────────────────────────────────────────────────────────────

export type InstallResult = { installed: boolean; pack: AgentPackSummary }

/** Install a pack into the library. Dedupe (ADR 0008): if a pack with the SAME id AND version is
 *  already installed, this is a no-op returning the existing row — the recipe-import path lands full
 *  copies that must collapse into the single install, and re-importing the same artifact must not
 *  duplicate it. (A same-id DIFFERENT-version pack is an upgrade — out of this WP's scope; we treat
 *  it as install-refused-as-dup for now rather than silently overwriting, and log it.) */
export const install = (profileId: string, pack: AgentPackRecord): InstallResult => {
  const existing = getPackIdentity(profileId, pack.id)
  if (existing) {
    if (existing.version !== pack.version)
      log(
        'error',
        `agentPack install: ${pack.id} already installed at v${existing.version}, ignoring v${pack.version} (upgrade is a later WP)`
      )
    const current = getPackRecord(profileId, pack.id)!
    return { installed: false, pack: packToSummary(current) }
  }
  insertPack(profileId, pack)
  return { installed: true, pack: packToSummary(pack) }
}

/** The structured outcome of an uninstall (agent-packs plan WP4.3b). The renderer branches on `code`:
 *   · `not-found`     — no such pack in this profile (a stale id; treat as already-gone).
 *   · `builtin`       — a built-in pack; refused (they ship with the app, uninstallable). Honest — the
 *     version-conflict recovery must render this when the installed conflicting pack IS a builtin.
 *   · ok:true         — the library row + its activation/override/trigger-state rows were removed. */
export type UninstallResult = { ok: true } | { ok: false; code: 'not-found' | 'builtin' }

/** Uninstall a pack (agent-packs plan WP4.3b — now exposed over IPC). Builtin packs are UNINSTALLABLE
 *  (they ship with the app) — refused + logged. On success, deletePack removes the library row AND its
 *  activation + override rows (agentPackStore.deletePack); the trigger-state baselines live in a
 *  SEPARATE store keyed by pack_id, which deletePack cannot reach, so we prune them here too — no row
 *  from any of the four pack-keyed tables outlives the install. */
export const uninstall = (profileId: string, packId: string): UninstallResult => {
  const pack = getPackRecord(profileId, packId)
  if (!pack) return { ok: false, code: 'not-found' }
  if (pack.builtin) {
    log('error', `agentPack uninstall: ${packId} is a built-in pack and cannot be uninstalled`)
    return { ok: false, code: 'builtin' }
  }
  deletePack(profileId, packId) // drops the library row + activation + override rows
  deleteTriggerStateForPack(packId) // + the per-(chat, trigger) baselines deletePack can't reach
  return { ok: true }
}

// ── Fork (copy-on-edit, ADR 0006; agent-packs plan WP3.6a) ────────────────────────────────────────
//
// PHASE-4 MACHINERY PULLED FORWARD. ADR 0010 (the editable effective graph) needs the fork operation
// earlier than phase 4 planned: editing a pack node in the Workflow view's Effective mode must
// copy-on-edit into a fork (that routing is WP3.6b; this WP delivers the operation the export wizard +
// WP3.6b consume). See the master-plan Amendments log (2026-07-03 owner request after WP3.1).
//
// FORK ID SCHEME (documented contract): `<sourceId>.fork-<n>`, where n is the smallest integer ≥ 1
// such that `<sourceId>.fork-<n>` is not already an installed id in the profile. So the first fork of
// `builtin.table-memory` is `builtin.table-memory.fork-1`, the next `builtin.table-memory.fork-2`.
// The scheme is readable, collision-free within a profile, and makes lineage visible in the id itself
// (upstream_id records it authoritatively). Forking a FORK derives from the fork's id the same way
// (`...fork-1.fork-1`) and flattens the display name to the ROOT base (see deriveForkManifest).
//
// REPOINT SEMANTICS (ADR 0006 — only the editing world moves): the fork copies the SOURCE's activation
// rows FOR THE EDITING WORLD (the world-scope row + any per-chat exceptions in that world) to the fork
// id, then DELETES the source's activation in that world. Other worlds' activation of the source is
// UNTOUCHED, and the source library row stays installed (builtin sources stay installed — they are
// uninstallable anyway). Overrides are COPIED wholesale from source → fork so settings carry over.

/** The next free fork id for `sourceId` in `profileId`: `<sourceId>.fork-<n>` with the smallest n ≥ 1
 *  not already installed. Pure over the installed-id set (the caller passes it) so it is unit-testable. */
export const nextForkId = (sourceId: string, installedIds: ReadonlySet<string>): { id: string; n: number } => {
  let n = 1
  while (installedIds.has(`${sourceId}.fork-${n}`)) n++
  return { id: `${sourceId}.fork-${n}`, n }
}

/** Derive the fork's manifest from the source's. Copies the manifest, records structured LOCALE-NEUTRAL
 *  fork provenance (`fork: { base, n }`) so the UI localizes the word "fork", and sets a neutral default
 *  `name`. When forking a FORK, `base` flattens to the root base (`sourceManifest.fork.base`) so the
 *  chain does not accrete "(fork) (fork)". Pure — unit-testable. */
export const deriveForkManifest = (source: PackManifest, n: number): PackManifest => {
  const base = source.fork?.base ?? source.name
  return {
    ...source,
    // Neutral default name (the UI prefers the structured `fork` form; this is the fallback + what a
    // non-fork-aware consumer sees). Kept ASCII-simple; the localized label lives in the renderer.
    name: `${base} (fork ${n})`,
    fork: { base, n }
  }
}

export interface ForkResult {
  ok: boolean
  pack?: AgentPackSummary
  error?: string
}

/** Fork an installed pack for a specific world (ADR 0006). Copies the pack row under a new id with
 *  `upstream_id = packId`, `builtin = false`, the derived fork manifest, and `editedFragment ?? source
 *  fragment`; repoints ONLY `worldId`'s activation to the fork (copies the world's gate/denial rows,
 *  removes the source's activation in that world); copies the source's overrides so settings carry
 *  over. Returns the new pack summary. The source (incl. a builtin) stays installed.
 *
 *  This is the phase-4 fork machinery pulled forward for ADR 0010 — WP3.6b (pack-edit routing) and the
 *  export wizard consume it; WP3.6a delivers it + the service/store tests, not yet a UI edit path. */
export const forkPack = (
  profileId: string,
  packId: string,
  worldId: string,
  editedFragment?: WorkflowDoc
): ForkResult => {
  const source = getPackRecord(profileId, packId)
  if (!source) return { ok: false, error: `pack ${packId} not installed` }

  const installedIds = new Set(listPackRecords(profileId).map((p) => p.id))
  const { id: forkId, n } = nextForkId(packId, installedIds)

  const fork: AgentPackRecord = {
    id: forkId,
    version: source.version,
    upstreamId: packId,
    builtin: false,
    manifest: deriveForkManifest(source.manifest, n),
    fragment: editedFragment ?? source.fragment
  }
  insertPack(profileId, fork)

  // Repoint the EDITING WORLD's activation: copy the source's rows for this world to the fork, then
  // remove the source's activation in this world. Other worlds' rows on the source are never read.
  const sourceActivation = listActivationRows(packId).filter((r) => r.worldId === worldId)
  for (const row of sourceActivation) {
    insertActivationRow({ ...row, packId: forkId })
  }
  deleteActivationForWorld(packId, worldId)

  // Copy overrides so settings carry over (ADR 0006). Overrides are keyed by (packId, scope, settingId);
  // we copy every scope verbatim (global/world/chat) onto the fork — the fork keeps the same stable
  // setting ids, so a resolve on the fork yields the same values.
  for (const ov of listOverrideRows(packId)) {
    insertOverrideRow(forkId, ov.scope, ov.settingId, ov.value)
  }

  return { ok: true, pack: packToSummary(fork) }
}

// ── Fragment write-through (ADR 0006; agent-packs plan WP3.6b) ────────────────────────────────────
//
// The SUBSEQUENT-edit half of "the edit IS the fork" (ADR 0006): once a world already owns a fork,
// further pack-node edits write through to the fork's fragment doc directly (like narrator
// write-through), instead of forking again. This replaces a NON-builtin pack's fragment; a BUILTIN
// pack is REFUSED (builtins are edited by FORKING them, never in place — forking a builtin produces a
// non-builtin fork, which is the writable target). The doc is validated (structure + graph + node
// config, and the fragment-kind rule: ≥1 attachment) before the write; an invalid doc is refused with
// a structured error the renderer can toast (never a partial/corrupt write).

export interface UpdateFragmentResult {
  ok: boolean
  /** Present on ok — the refreshed summary (attachments/capabilities re-derived from the new doc). */
  pack?: AgentPackSummary
  /** Present on failure. `code` lets the renderer pick the localized toast; `error` is the detail. */
  code?: 'not-found' | 'builtin' | 'invalid'
  error?: string
}

/** Replace a non-builtin pack's fragment doc (fork write-through, ADR 0006). Refuses a builtin
 *  (edit-via-fork only) and an invalid fragment (validated with validateWorkflowDoc — the same gate
 *  save/import use, which enforces the fragment-kind ≥1-attachment rule). Returns the refreshed
 *  summary on success. Does NOT touch activation or overrides — only the fragment blob changes. */
export const updatePackFragment = (
  profileId: string,
  packId: string,
  fragment: WorkflowDoc
): UpdateFragmentResult => {
  const source = getPackRecord(profileId, packId)
  if (!source) return { ok: false, code: 'not-found', error: `pack ${packId} not installed` }
  if (source.builtin)
    return {
      ok: false,
      code: 'builtin',
      error: `pack ${packId} is builtin; edit it by forking (updatePackFragment refuses builtins)`
    }

  const validated = validateWorkflowDoc(fragment)
  if (!validated.ok) return { ok: false, code: 'invalid', error: validated.error }

  updatePackFragmentRow(profileId, packId, validated.doc)
  return { ok: true, pack: packToSummary({ ...source, fragment: validated.doc }) }
}

// ── Gate (Activation) ─────────────────────────────────────────────────────────────────────────

/** Set the gate for a pack in a world, optionally as a per-chat exception (chatId non-null). */
export const setGate = (
  packId: string,
  worldId: string,
  chatId: string | null,
  open: boolean
): void => upsertGate(packId, worldId, chatId, open)

/** Resolve the gate for a pack in a (world, chat): chat row wins over world row; default CLOSED. */
export const getGate = (
  packId: string,
  worldId: string,
  chatId: string | null
): boolean => resolveGate(listActivationRows(packId), worldId, chatId).open

// ── Overrides ─────────────────────────────────────────────────────────────────────────────────
//
// WP3.2: overrides are stored + resolved here AND applied to fragment docs. The override →
// fragment-doc materialization (agentPackMaterialize.materializeFragment) runs inside
// enabledFragmentsFor (the turn + headless composition provider), so a resolved exposed-setting or
// System trigger param takes real effect. resolveOverridesWithProvenance (below) is the settings-UI
// read side: it reports not just the resolved value but WHICH scope it came from (the provenance chip).

export const setOverride = (
  packId: string,
  scope: OverrideScope,
  settingId: string,
  value: unknown
): void => upsertOverride(packId, encodeScope(scope), settingId, value)

export const clearOverride = (
  packId: string,
  scope: OverrideScope,
  settingId: string
): boolean => deleteOverride(packId, encodeScope(scope), settingId)

/** Resolve the effective overrides for a pack in a (world, chat), nearest-scope-wins (ADR 0005:
 *  global default < world < chat). Read side for the future settings UI. */
export const resolveOverrides = (
  packId: string,
  worldId: string | null,
  chatId: string | null
): Record<string, unknown> => layerOverrides(listOverrideRows(packId), worldId, chatId)

/** Resolve overrides WITH provenance (agent-packs plan WP3.2): per setting id, the winning value + the
 *  scope it came from + each scope's raw value. The detail panel reads this for the provenance chip and
 *  reset-to-default (clearing chat reveals world). Nearest-scope-wins, same as resolveOverrides. */
export const resolveOverridesWithProvenance = (
  packId: string,
  worldId: string | null,
  chatId: string | null
): Record<string, ResolvedOverride> =>
  layerOverridesWithProvenance(listOverrideRows(packId), worldId, chatId)

// ── Settings schema for the detail panel (agent-packs plan WP3.2) ────────────────────────────────
//
// The detail panel needs, per pack: the CREATOR-exposed settings (manifest.exposedSettings), the
// AUTO-DERIVED System trigger params (deriveSystemSettings over the fragment), and — for the pack
// being viewed in a (world, chat) — each setting's RESOLVED value + provenance. We assemble it here so
// the renderer is a pure consumer of typed IPC (never re-derives from the fragment blob, which stays
// main-side). `hasTriggers` lets the renderer decide whether to show the System group at all.

/** One setting the detail panel renders (schema + resolved state). `kind` splits creator-exposed
 *  ('pack') from auto-derived System trigger params ('system'); the renderer groups on it. */
export interface PackSettingView {
  id: string
  kind: 'pack' | 'system'
  /** Creator label (string | per-locale map) for a pack setting; a labelKind token for a system one. */
  label?: string | Record<string, string>
  labelKind?: SystemSetting['labelKind']
  /** The control type. Pack: the ExposedSetting.type; System: derived from the trigger literal. */
  type: 'number' | 'string' | 'boolean' | 'enum'
  default: unknown
  min?: number
  max?: number
  options?: string[]
  /** The currently-resolved value (override or default) + which scope it came from (provenance chip). */
  resolved: ResolvedOverride
}

export interface PackSettingsResult {
  packId: string
  hasTriggers: boolean
  /** Creator-exposed settings (rendered in the "Pack settings" group; empty → group hidden). */
  packSettings: PackSettingView[]
  /** Auto-derived System trigger params (rendered in the "System" group; only present when the pack
   *  has non-manual triggers). */
  systemSettings: PackSettingView[]
}

/** Assemble the detail panel's settings model for a pack in a (world, chat) — creator-exposed +
 *  auto-derived System trigger params, each with its resolved value + provenance (agent-packs plan
 *  WP3.2). Returns null when the pack is not installed. Reads the fragment main-side only. */
export const getPackSettings = (
  profileId: string,
  packId: string,
  worldId: string | null,
  chatId: string | null
): PackSettingsResult | null => {
  seedBuiltinPacks(profileId)
  const pack = getPackRecord(profileId, packId)
  if (!pack) return null
  const prov = layerOverridesWithProvenance(listOverrideRows(packId), worldId, chatId)
  const resolvedFor = (id: string, dflt: unknown): ResolvedOverride =>
    prov[id] ?? { value: dflt, provenance: 'default' }

  const packSettings: PackSettingView[] = (pack.manifest.exposedSettings ?? []).map((s) => {
    const r = resolvedFor(s.id, s.default)
    // When no override applies, surface the schema default as the effective value (the control needs it).
    const resolved: ResolvedOverride =
      r.provenance === 'default' ? { ...r, value: s.default } : r
    return {
      id: s.id,
      kind: 'pack',
      label: s.label,
      type: s.type,
      default: s.default,
      ...(s.min != null ? { min: s.min } : {}),
      ...(s.max != null ? { max: s.max } : {}),
      ...(s.options ? { options: s.options } : {}),
      resolved
    }
  })

  const system = deriveSystemSettings(pack.fragment)
  const systemSettings: PackSettingView[] = system.map((s) => {
    const r = resolvedFor(s.id, s.defaultValue)
    const resolved: ResolvedOverride =
      r.provenance === 'default' ? { ...r, value: s.defaultValue } : r
    return {
      id: s.id,
      kind: 'system',
      labelKind: s.labelKind,
      type: s.valueType, // number | string | boolean (System params never enum in v1)
      default: s.defaultValue,
      ...(s.labelKind === 'trigger-cadence' ? { min: 1 } : {}),
      resolved
    }
  })

  return { packId, hasTriggers: system.length > 0, packSettings, systemSettings }
}

// ── Enabled fragments (the WP1.3 composition provider) ────────────────────────────────────────

/** Resolve a chat's world id (its world card). A chat's world IS its `character_id` — the world card
 *  the chat is a session of (chatService.getChat → ChatSession.character_id; chatService.ts:58-64,
 *  90-98). No chat (or unknown) → null, which yields no open gates (every pack stays closed). */
const worldOfChat = (profileId: string, chatId: string): string | null =>
  getChat(profileId, chatId)?.character_id ?? null

/** The enabled pack fragments to compose for a chat's turn (glossary: Effective Graph). A pack
 *  contributes iff its gate resolves OPEN for this chat's world/chat; each contributes exactly one
 *  ComposeFragment carrying its fragment doc + the denial set as `closedEntryIndexes`.
 *
 *  Duplicate-packId guard: composeEffectiveGraph keys `meta.composition.packs` by packId and prefixes
 *  every spliced node `pack:<packId>:` — two fragments with the SAME packId would silently overwrite
 *  each other's composition metadata and collide on node ids (WP1.3 friction). The library PK already
 *  makes id collisions impossible for a single profile, but we assert it here anyway: on a duplicate
 *  we KEEP the first and DROP + LOG the rest, never emit a colliding fragment list. */
export const enabledFragmentsFor = (profileId: string, chatId: string): ComposeFragment[] => {
  seedBuiltinPacks(profileId)
  const worldId = worldOfChat(profileId, chatId)
  if (worldId == null) return []

  const seen = new Set<string>()
  const fragments: ComposeFragment[] = []
  for (const pack of listPackRecords(profileId)) {
    if (seen.has(pack.id)) {
      log('error', `agentPack enabledFragmentsFor: duplicate packId ${pack.id} — dropping duplicate`)
      continue
    }
    const { open, denial } = resolveGate(listActivationRows(pack.id), worldId, chatId)
    if (!open) continue
    seen.add(pack.id)
    // MATERIALIZE (agent-packs plan WP3.2): apply this (world, chat)'s resolved overrides to the
    // fragment BEFORE it enters composition (compose.ts consumes doc as-is) — so exposed-setting
    // node config + System trigger params take real effect on the turn path. materializeFragment is
    // pure + deep-clones; with no overrides it deep-equals pack.fragment (zero behavior change).
    // The HEADLESS path inherits this automatically: evaluatePass/runHeadless/runManual all read the
    // ComposeFragment.doc this returns, so both call sites route through one materialization.
    const overrides = layerOverrides(listOverrideRows(pack.id), worldId, chatId)
    const doc = materializeFragment(pack, overrides)
    fragments.push({
      packId: pack.id,
      doc,
      gateOpen: true,
      ...(denial.length ? { closedEntryIndexes: denial } : {})
    })
  }
  return fragments
}

// ── Effective-graph projection (ADR 0010; agent-packs plan WP3.6a) ────────────────────────────────
//
// The Workflow view's EFFECTIVE mode renders the LIVE composition for the active chat (ADR 0010): the
// narrator composed with every gate-open pack. This is a THIN wrapper over resolveEffectiveDoc (the
// SAME projection the engine runs — never a persisted artifact, ADR 0001) plus the composition meta
// and each pack's manifest, so the renderer can group + attribute + label without re-deriving anything.

/** One pack's presence in the effective graph, for the projection's grouped rendering. */
export interface EffectivePackInfo {
  packId: string
  /** The pack's display name (from its manifest) for the region label. */
  name: string
  /** Fork provenance (ADR 0006), present ONLY on fork entries: the structured LOCALE-NEUTRAL marker so
   *  the region header localizes the word "fork" (WP3.6b, Part C). `base` = the root display name. */
  fork?: { base: string; n: number }
  /** Lineage (ADR 0006): the upstream install this was forked from, or null for a root install. The
   *  region header shows a subtle "from <base>" from `fork.base`; `upstreamId` keeps the id lineage. */
  upstreamId?: string | null
  /** The resolved gate state (always true here — only gate-open packs are in the projection; kept so
   *  the renderer's gate chip has an explicit value + can flip it). */
  gateOpen: boolean
  /** The effective-graph (prefixed) node ids this pack contributed. May be non-empty even when the
   *  pack is triggerOnly: a pure-trigger fragment keeps ALL its nodes (compose.ts:250-253) but wires
   *  none to the narrator. A pack whose maintenance chain is unreachable from its spliced entries has
   *  that chain dropped (asyncMemoryPack.ts `mctx`; compose.ts reachability). */
  nodeIds: string[]
  /** True iff the pack spliced NO checkpoint attachment (its composition `entries` AND `rejoinEdges`
   *  are both empty) — nothing plugs it into the narrator. Its nodes, if any, are present-but-detached.
   *  The renderer represents such a pack as a DETACHED region (ADR 0010's last consequence:
   *  trigger-only machinery must still be representable — "where is my pack"). */
  triggerOnly: boolean
}

export interface EffectiveGraphResult {
  doc: WorkflowDoc
  warnings: ComposeWarning[]
  packs: EffectivePackInfo[]
}

/** Project the effective graph for a chat (ADR 0010): the composed doc, the composition warnings, and
 *  one EffectivePackInfo per gate-open pack (name + spliced node ids + triggerOnly). The renderer
 *  groups/labels from this; flipping a gate + re-fetching recomposes live.
 *
 *  GROUNDED triggerOnly truth (verified against compose.ts:250-253 + asyncMemoryPack.ts): a pack is
 *  triggerOnly iff it spliced NO checkpoint attachment — its composition `entries` AND `rejoinEdges`
 *  are BOTH empty (no entry/rejoin edge plugged it into the narrator). NOTE this is NOT the same as
 *  "empty nodeIds": a fragment whose ONLY attachment is a trigger has NO entry attachments, so
 *  compose.ts keeps ALL its nodes (hasEntryAttachments=false → every node survives), but wires NONE of
 *  them to the narrator — the nodes are PRESENT-BUT-DETACHED. The flagship async-memory pack is NOT
 *  triggerOnly: it splices its `trim` (inline entry) + `export` (rejoin), so entries/rejoinEdges are
 *  non-empty; only its headless maintenance chain (declares NO context-ready entry) is DROPPED from a
 *  turn by reachability, but the pack still has spliced attachments. So: triggerOnly renders as a
 *  DETACHED region (its nodes, if any, float free — ADR 0010's last consequence: trigger-only
 *  machinery must still be representable). */
export const getEffectiveGraph = (profileId: string, chatId: string): EffectiveGraphResult => {
  seedBuiltinPacks(profileId)
  const { doc, warnings } = resolveEffectiveDoc(profileId, chatId)
  const composition = (doc.meta as { composition?: CompositionMeta } | undefined)?.composition
  const worldId = worldOfChat(profileId, chatId)

  // Manifest names for the enabled packs (the composition keys are pack ids). enabledFragmentsFor
  // gives the exact gate-open set for this chat; we join on it so a trigger-only pack (present in
  // composition but with no spliced attachments) is still listed with its correct triggerOnly flag.
  const recordOf = new Map(listPackRecords(profileId).map((p) => [p.id, p]))
  const enabledIds = worldId == null ? [] : enabledFragmentsFor(profileId, chatId).map((f) => f.packId)

  const packs: EffectivePackInfo[] = enabledIds.map((packId) => {
    const pc = composition?.packs[packId]
    const nodeIds = pc?.nodeIds ?? []
    // Spliced a checkpoint attachment iff any entry landed OR any rejoin edge was wired.
    const splicedAny = (pc?.entries.length ?? 0) > 0 || (pc?.rejoinEdges.length ?? 0) > 0
    const rec = recordOf.get(packId)
    return {
      packId,
      name: rec?.manifest.name ?? packId,
      gateOpen: true,
      nodeIds,
      triggerOnly: !splicedAny,
      ...(rec?.manifest.fork ? { fork: rec.manifest.fork } : {}),
      ...(rec?.upstreamId ? { upstreamId: rec.upstreamId } : {})
    }
  })

  return { doc, warnings, packs }
}

// ── Provider registration (module init) ───────────────────────────────────────────────────────
//
// Registering at import time (not lazily) mirrors how main services wire themselves during startup:
// importing this module from the IPC layer (registerAgentPackIpc) — which the app does once after
// app-ready — installs the provider so resolveEffectiveDoc composes enabled packs. Tests that want
// the zero-packs guarantee reset the provider to default in afterEach (setEnabledFragmentsProvider()).
setEnabledFragmentsProvider(enabledFragmentsFor)
