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

import { ComposeFragment } from '../../shared/workflow/compose'
import { setEnabledFragmentsProvider } from './workflowService'
import { getChat } from './chatService'
import { log } from './logService'
import { BUILTIN_PACKS } from './nodes/builtin/tableMemoryPack'
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
  layerOverrides
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

// ── Provider registration (module init) ───────────────────────────────────────────────────────
//
// Registering at import time (not lazily) mirrors how main services wire themselves during startup:
// importing this module from the IPC layer (registerAgentPackIpc) — which the app does once after
// app-ready — installs the provider so resolveEffectiveDoc composes enabled packs. Tests that want
// the zero-packs guarantee reset the provider to default in afterEach (setEnabledFragmentsProvider()).
setEnabledFragmentsProvider(enabledFragmentsFor)
