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
import { setEnabledFragmentsProvider, resolveEffectiveDoc } from './workflowService'
import { getChat } from './chatService'
import { log } from './logService'
import { BUILTIN_PACKS } from './nodes/builtin/tableMemoryPack'
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
  insertActivationRow,
  deleteActivationForWorld,
  insertOverrideRow,
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

/** Uninstall a pack. Builtin packs are UNINSTALLABLE (they ship with the app) — refuse and log. */
export const uninstall = (profileId: string, packId: string): boolean => {
  const pack = getPackRecord(profileId, packId)
  if (!pack) return false
  if (pack.builtin) {
    log('error', `agentPack uninstall: ${packId} is a built-in pack and cannot be uninstalled`)
    return false
  }
  return deletePack(profileId, packId)
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
// v0 NOTE: overrides are stored + resolved here but NOT yet applied to fragment docs. The
// override → fragment-doc materialization (feeding a resolved value into an exposed-setting node
// field) is a deliberately-later WP; do not build it here.

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
    fragments.push({
      packId: pack.id,
      doc: pack.fragment,
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
  const nameOf = new Map(listPackRecords(profileId).map((p) => [p.id, p.manifest.name]))
  const enabledIds = worldId == null ? [] : enabledFragmentsFor(profileId, chatId).map((f) => f.packId)

  const packs: EffectivePackInfo[] = enabledIds.map((packId) => {
    const pc = composition?.packs[packId]
    const nodeIds = pc?.nodeIds ?? []
    // Spliced a checkpoint attachment iff any entry landed OR any rejoin edge was wired.
    const splicedAny = (pc?.entries.length ?? 0) > 0 || (pc?.rejoinEdges.length ?? 0) > 0
    return {
      packId,
      name: nameOf.get(packId) ?? packId,
      gateOpen: true,
      nodeIds,
      triggerOnly: !splicedAny
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
