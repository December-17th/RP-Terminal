// Recipe EXPORT / IMPORT — the machinery behind `.rptrecipe` "share this world's setup" (agent-packs
// plan WP5.2; phase 5). This is the main-side transfer layer over the SHARED recipe envelope (WP5.1,
// shared/workflow/recipeEnvelope.ts): it assembles a recipe from the CURRENT world's state (export),
// and parses + inspects + applies one into a TARGET world (import).
//
// It mirrors agentPackTransferService.ts (the `.rptagent` transfer idiom) beat for beat: a dialog-free
// testable core, two-phase inspect/confirm with single-use TTL tokens, structured blockers, and the
// dialogs living in the IPC layer. A recipe is N pack installs plus one activation preset (ADR 0008),
// so this service DELEGATES the per-pack heavy lifting to agentPackService.install (the same install
// the `.rptagent` path uses) and the shared capability/registry derivation used at pack inspect.
//
// Decisions grounded during the WP (cited for the report):
//  - ADR 0008 (recipes bundle for transport, reference internally; reproduce EXACTLY): the recipe pins
//    each pack's VERSION and the narrator; import installs the PINNED version ALONGSIDE a differing
//    local one (WP4.6 coexistence) and activates what the recipe pinned. "Use your newer one instead"
//    is an explicit UI choice, never a service default — this service reproduces.
//  - ADR 0005 (install ≠ activate): import installs each pack (gate CLOSED, via install), THEN applies
//    the activation preset that opens/closes the gate per entry. Distinct steps.
//  - ADR 0007 (capabilities derived, never trusted): every embedded pack's capability report is
//    RE-DERIVED locally against the real registry at inspect; the file carries no capability claims.
//
// ── RECIPE-LEVEL BLOCKING RULE (grounded decision — ADR 0008's reproducibility grain) ──────────────
// A recipe is reproducible or it is nothing (ADR 0008: "recipes are reproducible or they are nothing").
// So a recipe is BLOCKED if ANY embedded pack is blocked OR the embedded narrator has unknown node
// types — a half-applied recipe would be a world setup the sharer never had. We still report PER-PACK
// (each pack's sub-report carries its own blockers) so the import UI can show WHICH pack broke it; the
// recipe-level `blocked` boolean is the OR over every pack + the narrator. A pack blocker blocks the
// whole recipe, exactly as ADR 0008's grain demands.
//
// ── PARTIAL-FAILURE HONESTY (grounded: NO cross-service transaction) ────────────────────────────────
// confirmRecipeImport runs a MULTI-STORE sequence: table templates (tableTemplateService, file-based),
// pack installs (agentPackStore, SQLite), a workflow doc save (workflowService, file-based), the
// selection sidecar (workflowService, file-based), and activation/override rows (agentPackStore,
// SQLite). These are DIFFERENT stores with DIFFERENT backends and NO shared transaction — verified: the
// SQLite store's helpers each open their own `getDb()` statement (agentPackStore.ts) with no exported
// begin/commit spanning the file-based services, and workflowService/tableTemplateService write JSON
// files atomically PER FILE (writeJsonSyncAtomic) with no cross-file rollback. So there is no way to
// wrap the whole confirm in one atomic unit in v0. If a step throws mid-sequence we therefore return a
// structured `partial` result LISTING what landed (installed packs, saved narrator, applied gates) so
// the UI can tell the user exactly the state the world is in — no silent half-apply, no fake rollback.

import { app } from 'electron'
import * as fs from 'fs'
import {
  parseRecipeEnvelope,
  serializeRecipeEnvelope,
  RecipeEnvelope,
  RecipeEnvelopeParseError,
  RecipeNarrator,
  ActivationEntry,
  MAX_RECIPE_ENVELOPE_BYTES
} from '../../shared/workflow/recipeEnvelope'
import { PackPayload, BundledTemplate } from '../../shared/workflow/packPayload'
import { deriveCapabilityReport, CapabilityReport } from '../../shared/workflow/capabilities'
import { WorkflowDoc } from '../../shared/workflow/types'
import { parseWorkflowDoc } from '../../shared/workflow/docSchema'
import {
  getPackRecord,
  getPackIdentity,
  listPackRecords,
  listPackVersions,
  listActivationRows,
  listOverrideRows,
  resolveGate,
  encodeScope
} from './agentPackStore'
import { install, setGate, setActiveVersion, setOverride } from './agentPackService'
import {
  BUILTIN_WORKFLOW_ID,
  getSelection,
  setWorldWorkflow,
  createWorkflowFromDoc,
  listWorkflows,
  getWorkflowById
} from './workflowService'
import { listTableTemplates, saveTableTemplate } from './tableTemplateService'
import { TableTemplate, TableTemplateSchema } from '../types/tableTemplate'
import { builtinRegistry } from './nodes/builtin'
import { log } from './logService'
import { randomUUID } from 'crypto'

// ── knownTypes: the runtime's registered node set (ADR 0007 soundness input) ──────────────────────
//
// Same lazy accessor agentPackTransferService uses — deriveCapabilityReport needs the set of node
// types the runtime KNOWS so an unmapped-but-known type is inert while an unmapped-UNKNOWN type
// surfaces (a pack from a newer RPT). Lazy so importing this module doesn't force registry ordering.
let _knownTypes: ReadonlySet<string> | null = null
const knownTypes = (): ReadonlySet<string> => {
  if (_knownTypes == null) _knownTypes = new Set(builtinRegistry.descriptors().keys())
  return _knownTypes
}

/** The node types whose PRESENCE we surface as a WARNING (not a block), same as the pack path: a
 *  subgraph.call/subgraph.loop references a LOCAL sub-graph whose behavior the surface analysis can't
 *  fully derive. Creators see it at export so "exports fine, warned there" cannot happen. */
const SUBGRAPH_NODE_TYPES = new Set(['subgraph.call', 'subgraph.loop'])

const subgraphWarnings = (doc: WorkflowDoc): string[] =>
  doc.nodes
    .filter((n) => SUBGRAPH_NODE_TYPES.has(n.type))
    .map(
      (n) =>
        `node "${n.id}" (${n.type}) references a local sub-graph — behavior not fully derivable`
    )

// ════════════════════════════════════════════════════════════════════════════════════════════════
// EXPORT
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** A structured export failure the UI branches on.
 *  · `no-activated-packs` — the world has NO pack with an activation row (nothing to share as a recipe
 *    of packs). A world can still be exported for its narrator alone; the caller decides whether to
 *    treat this as an error (we return it so the UI can warn "this world activates no packs"). */
export interface RecipeExportError {
  code: 'no-activated-packs'
  message: string
}

/** The dry-run export preview (WP5.3's wizard shows this WITHOUT writing). Mirrors what the file will
 *  contain: the recipe meta, the pack list with pinned versions + gate state, the narrator kind, the
 *  bundled-template names, a size estimate, and the warnings (subgraph presence surfaced HERE too). */
export interface RecipeExportPreview {
  recipeMeta: {
    id: string
    name: string
    description?: string
    creator?: string
    /** UTF-8 byte length of the serialized `.rptrecipe` text (what the file will weigh). */
    sizeBytes: number
  }
  /** One row per pack that will be embedded + activated. `enabled` is the gate state carried into the
   *  recipe (a closed-with-row pack ships enabled:false — see the activation-row rule). */
  packs: { id: string; version: number; name: string; enabled: boolean }[]
  /** 'builtin' → the recipe pins the importer's default narrator; 'embedded' → a full custom turn doc
   *  rides along. */
  narratorKind: 'builtin' | 'embedded'
  bundledTemplateNames: string[]
  /** True iff no template was bundled (the honest v0 rule — nothing chat-independent to resolve). */
  noTemplatesBundled: boolean
  warnings: string[]
}

/** Caller-supplied recipe metadata (WP5.3's wizard collects it). `id` is minted here when absent. */
export interface BuildRecipeOpts {
  name: string
  description?: string
  creator?: string
  /** Stable recipe id; a fresh uuid is minted when omitted. */
  id?: string
}

/** The internal build result — the assembled envelope input + the preview, or a structured error.
 *  Shared by preview (discard the text) and export (write the text). */
type BuildRecipeResult =
  | { ok: true; text: string; envelope: RecipeEnvelope; preview: RecipeExportPreview }
  | { ok: false; error: RecipeExportError }

/** Build a PackPayload from a stored AgentPackRecord (the embedded-pack shape ADR 0008 bundles). The
 *  fragment is embedded verbatim (revalidated on the importer's parse, never trusted). minRptVersion,
 *  exposedSettings, and fork provenance ride along from the manifest so the pack round-trips exactly
 *  as its `.rptagent` export would (recipeEnvelope.orderedPack serializes it identically). */
const recordToPayload = (record: {
  id: string
  version: number
  manifest: {
    name: string
    description?: string
    creator?: string
    minRptVersion?: string
    exposedSettings?: PackPayload['exposedSettings']
    fork?: { base: string; n: number }
  }
  fragment: WorkflowDoc
}): PackPayload => ({
  id: record.id,
  version: record.version,
  name: record.manifest.name,
  ...(record.manifest.description ? { description: record.manifest.description } : {}),
  ...(record.manifest.creator ? { creator: record.manifest.creator } : {}),
  ...(record.manifest.minRptVersion ? { minRptVersion: record.manifest.minRptVersion } : {}),
  ...(record.manifest.exposedSettings ? { exposedSettings: record.manifest.exposedSettings } : {}),
  ...(record.manifest.fork ? { fork: record.manifest.fork } : {}),
  fragment: record.fragment
})

/** Resolve the world's selected narrator for the recipe (ADR 0008: ONE narrator per recipe). Reads the
 *  selection sidecar's per-world default (workflowService.getSelection().worlds[worldId]); when the
 *  world has NO explicit selection OR it resolves to the builtin id, the recipe pins `{ kind: 'builtin' }`
 *  (the well-known-id form — resolved importer-side against ITS builtin). A custom doc embeds as
 *  `{ kind: 'embedded', doc }`, re-parsed through parseWorkflowDoc to STRIP machine-specific / unknown
 *  fields (the stored file id is meaningless off this machine — import mints a fresh id — and any
 *  stray key is dropped so the payload is exactly a validated turn doc). An unresolvable / invalid
 *  selection falls back to builtin (log + reproduce the safe default rather than embed a broken doc). */
const resolveRecipeNarrator = (profileId: string, worldId: string): RecipeNarrator => {
  const selection = getSelection(profileId)
  const selectedId = selection.worlds[worldId]
  if (!selectedId || selectedId === BUILTIN_WORKFLOW_ID) return { kind: 'builtin' }
  const raw = getWorkflowById(profileId, selectedId)
  if (!raw) {
    log('error', `recipe export: world narrator ${selectedId} not found, pinning builtin`)
    return { kind: 'builtin' }
  }
  // Strip machine-specific / runtime-only fields by re-parsing through the shared structural gate (it
  // drops unknown keys). The embedded doc is a validated turn doc; its id is discarded on import.
  const parsed = parseWorkflowDoc(raw)
  if (!parsed.ok) {
    log(
      'error',
      `recipe export: world narrator ${selectedId} failed structural parse, pinning builtin`,
      parsed.error
    )
    return { kind: 'builtin' }
  }
  // A subgraph/fragment doc must never be a narrator (resolveWorkflowDoc falls through past a subgraph;
  // a fragment isn't a run target). Treat as builtin — a recipe pins a real narrator or the default.
  const kind = parsed.doc.kind ?? 'turn'
  if (kind !== 'turn') {
    log('error', `recipe export: world narrator ${selectedId} is kind "${kind}", pinning builtin`)
    return { kind: 'builtin' }
  }
  return { kind: 'embedded', doc: parsed.doc }
}

/** The bundled-templates decision (honest v0, same rule as the pack path): today no pack pins a
 *  chat-independent template, so a recipe bundles NOTHING and records it. Factored out so the day a
 *  pack pins a template by name, this is the ONE place to resolve + pool it across the recipe. */
const resolveBundledTemplates = (): {
  templates: BundledTemplate[] | undefined
  names: string[]
  noTemplatesBundled: boolean
} => ({ templates: undefined, names: [], noTemplatesBundled: true })

/** Assemble the recipe from the CURRENT world's setup (the pure core over store reads — no dialog, no
 *  write). ACTIVATION-ROW INCLUSION RULE (grounded): a pack is included iff it has a WORLD-SCOPE
 *  activation row for `worldId` (a `chatId == null` row in listActivationRows). Gate OPEN → enabled:true;
 *  gate explicitly CLOSED (a row present with gate_open false) → enabled:false (still shipped, so the
 *  recipe reproduces the sharer's "installed but off" choice). A library pack the world NEVER activated
 *  (no row) is OMITTED — the recipe shares THIS WORLD's setup, not the whole library. Per pack we embed
 *  the PINNED version's payload (resolveGate's pinVersion, falling back to the highest installed when
 *  unpinned) and its world-scope override VALUES (scope-stripped). */
const buildRecipe = (
  profileId: string,
  worldId: string,
  opts: BuildRecipeOpts
): BuildRecipeResult => {
  // Gather every pack with a WORLD-SCOPE activation row for this world. A pack id appears once (its
  // world row); per-chat exception rows are ignored for the recipe (a recipe is a world-level preset).
  const packs: PackPayload[] = []
  const activation: ActivationEntry[] = []

  // Discover which pack ids have a WORLD-SCOPE activation row in this world. The store has no "list
  // packs activated in a world" call (and WP5.2 must not change the store schema), so we enumerate the
  // DISTINCT installed pack ids (listPackRecords) and keep those with a world-scope (chatId == null)
  // row for `worldId`. A dangling activation row for an UNINSTALLED id is intentionally invisible here:
  // export can only embed a payload it has, so an uninstalled id is nothing to share.
  const installedIds = [...new Set(listPackRecords(profileId).map((p) => p.id))]
  const packIdsWithWorldRow = installedIds.filter((packId) =>
    listActivationRows(packId).some((r) => r.worldId === worldId && r.chatId == null)
  )

  for (const packId of packIdsWithWorldRow) {
    const rows = listActivationRows(packId)
    const worldRow = rows.find((r) => r.worldId === worldId && r.chatId == null)
    if (!worldRow) continue // defensive — the filter above already guaranteed this row exists

    // The PINNED version this world's activation runs (WP4.6): resolveGate over the world-scope row.
    // Fall back to the highest installed version when unpinned (pickPinnedRecord's rule, applied here
    // via getPackRecord's "omit version = highest" convenience).
    const { pinVersion } = resolveGate(rows, worldId, null)
    const record =
      (pinVersion != null ? getPackRecord(profileId, packId, pinVersion) : null) ??
      getPackRecord(profileId, packId)
    if (!record) {
      // A dangling activation row for an uninstalled pack — skip it (we cannot embed a payload we
      // don't have). Log so the sharer knows their recipe omitted a stale row.
      log('error', `recipe export: pack ${packId} activated in world but not installed, omitting`)
      continue
    }
    if (record.builtin) {
      // A builtin pack ships with the app; embedding it would shadow the importer's builtin. Skip it
      // (the importer already has it) — same stance as the `.rptagent` builtin-not-exportable rule,
      // applied silently here because a recipe is a SET (one bad member shouldn't fail the export).
      log('info', `recipe export: pack ${packId} is builtin, not embedding (importer has it)`)
      continue
    }

    packs.push(recordToPayload(record))

    // World-scope override VALUES for this pack, scope-STRIPPED to settingId → value (the importer wraps
    // them at encodeScope({ world: target }) — the format carries values, the importer carries scope).
    const worldScope = encodeScope({ world: worldId })
    const overrides: Record<string, unknown> = {}
    for (const ov of listOverrideRows(packId)) {
      if (ov.scope === worldScope) overrides[ov.settingId] = ov.value
    }

    activation.push({
      packId,
      version: record.version,
      enabled: worldRow.gateOpen,
      ...(Object.keys(overrides).length > 0 ? { overrides } : {})
    })
  }

  if (packs.length === 0) {
    // No non-builtin pack is activated in this world. Per the task this is a caller-facing outcome; a
    // world with only a custom narrator and no packs is a thin recipe, but ADR 0008's artifact is a
    // SET of packs + a preset — an empty pack set is degenerate. Report it so the UI warns.
    return {
      ok: false,
      error: {
        code: 'no-activated-packs',
        message: `world ${worldId} has no activated (non-builtin) packs to share`
      }
    }
  }

  const narrator = resolveRecipeNarrator(profileId, worldId)
  const { templates, names, noTemplatesBundled } = resolveBundledTemplates()

  const id = opts.id ?? randomUUID()
  const text = serializeRecipeEnvelope({
    id,
    name: opts.name,
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.creator ? { creator: opts.creator } : {}),
    narrator,
    packs,
    activation,
    ...(templates ? { bundledTemplates: templates } : {})
  })

  // Re-parse our own output so the preview + returned envelope come from exactly what ships (and a
  // build regression producing an invalid envelope is caught here, not by the importer).
  const parsed = parseRecipeEnvelope(text)
  if (!parsed.ok) {
    log('error', `recipe export: self-parse failed for world ${worldId}`, parsed.error)
    return {
      ok: false,
      error: { code: 'no-activated-packs', message: `world ${worldId} produced an invalid recipe` }
    }
  }

  const preview: RecipeExportPreview = {
    recipeMeta: {
      id,
      name: opts.name,
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.creator ? { creator: opts.creator } : {}),
      sizeBytes: new TextEncoder().encode(text).length
    },
    packs: activation.map((a) => {
      const p = packs.find((pk) => pk.id === a.packId && pk.version === a.version)!
      return { id: a.packId, version: a.version, name: p.name, enabled: a.enabled }
    }),
    narratorKind: narrator.kind,
    bundledTemplateNames: names,
    noTemplatesBundled,
    warnings: [
      ...packs.flatMap((p) => subgraphWarnings(p.fragment)),
      ...(narrator.kind === 'embedded' ? subgraphWarnings(narrator.doc) : [])
    ]
  }

  return { ok: true, text, envelope: parsed.value, preview }
}

/** Assemble the recipe for the CURRENT world (the public export core; WP5.3's wizard drives it). Reads
 *  the world's activated packs + narrator + overrides and returns the serialized `.rptrecipe` text +
 *  the envelope + the preview, or a structured error. Pure over the store reads — no dialog, no write.
 *  The IPC layer runs the save dialog + writes the returned text. */
export const buildRecipeFromWorld = (
  profileId: string,
  worldId: string,
  opts: BuildRecipeOpts
): BuildRecipeResult => buildRecipe(profileId, worldId, opts)

/** The dry-run export preview for WP5.3's wizard: everything the wizard shows WITHOUT writing a file.
 *  Returns a structured error (no-activated-packs / invalid) instead. Pure read of the store — no dialog. */
export const previewRecipeExport = (
  profileId: string,
  worldId: string,
  opts: BuildRecipeOpts
): { ok: true; preview: RecipeExportPreview } | { ok: false; error: RecipeExportError } => {
  const built = buildRecipe(profileId, worldId, opts)
  return built.ok ? { ok: true, preview: built.preview } : { ok: false, error: built.error }
}

/** The default `.rptrecipe` filename for a recipe: `<name>.rptrecipe`, sanitized for the FS. The IPC
 *  layer passes this as the save dialog's defaultPath. */
export const recipeFileName = (name: string): string =>
  `${(name || 'recipe').replace(/[\\/:*?"<>|]/g, '_')}.rptrecipe`

/** Write a world's recipe envelope to `filePath` (UTF-8). The IPC layer runs the save dialog and
 *  supplies the chosen path; a canceled dialog never reaches here. Returns the build error
 *  (no-activated-packs / invalid) if the recipe can't be assembled, else `{ ok: true }`. */
export const writeRecipeExport = (
  profileId: string,
  worldId: string,
  opts: BuildRecipeOpts,
  filePath: string
): { ok: true } | { ok: false; error: RecipeExportError } => {
  const built = buildRecipe(profileId, worldId, opts)
  if (!built.ok) return { ok: false, error: built.error }
  fs.writeFileSync(filePath, built.text, 'utf-8')
  return { ok: true }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// IMPORT (two-phase: inspect -> confirm)
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// Mirrors agentPackTransferService's pack-import flow (inspect stashes a token; confirm consumes it),
// scaled up to a SET of packs + a narrator + an activation preset. inspectRecipeFile builds a per-pack
// sub-report (reusing the pack inspect pieces: LOCAL capability derivation, unknown-node-types,
// subgraph warnings, dedupe by (id, version)), a narrator report, template plans, and the recipe-level
// blocked flag (the ADR 0008 OR — see the module header). confirmRecipeImport(token, targetWorldId)
// applies everything into the world the user chooses AT CONFIRM (the file doesn't know the world).

/** Per-pack dedupe status against the target profile's library (WP4.6 coexistence, same vocabulary the
 *  pack path uses): 'new' = no version of the id installed; 'new-version' = the id is installed at
 *  ANOTHER version (this pinned version installs ALONGSIDE); 'already-installed' = this exact (id,
 *  version) is present (install is a no-op). */
export type RecipeDedupe = 'new' | 'new-version' | 'already-installed'

/** One embedded pack's inspection sub-report. Carries the LOCALLY-derived capability report (ADR 0007
 *  — never trusts the file), the dedupe status, the pack's own blockers (unknown node types), and any
 *  subgraph-presence warnings. The recipe-level `blocked` is the OR over every pack's blockers + the
 *  narrator (ADR 0008 reproducibility grain — a recipe is reproducible or it is nothing). */
export interface RecipePackReport {
  id: string
  version: number
  name: string
  dedupe: RecipeDedupe
  capabilityReport: CapabilityReport
  /** Node types in this pack's fragment the local build doesn't know (a pack from a newer RPT). A
   *  non-empty list BLOCKS the whole recipe. */
  unknownNodeTypes: string[]
  warnings: string[]
}

/** The embedded-narrator inspection report. 'builtin' → "uses your default narrator" (nothing to
 *  install, never a blocker). 'embedded' → a structural summary (node count) + the local node-type
 *  check: unknown types in the narrator BLOCK the recipe, exactly like a pack fragment. */
export interface RecipeNarratorReport {
  kind: 'builtin' | 'embedded'
  /** Present only for an embedded narrator: the node count (the shared parser already asserted exactly
   *  one main-output at envelope parse, so this is display data). */
  nodeCount?: number
  /** Node types in the embedded narrator the local build doesn't know — a BLOCKER (like a pack). */
  unknownNodeTypes: string[]
  warnings: string[]
}

/** How a bundled template will land at import, per template (grounded in saveTableTemplate — a fresh
 *  uuid each, no overwrite, so a name collision installs a duplicate). Identical to the pack path's
 *  BundledTemplatePlan; v0 recipes bundle nothing, so this is populated only by hand-built / future
 *  template-pinning recipes. */
export interface RecipeTemplatePlan {
  name: string
  outcome: 'will-install' | 'will-duplicate'
}

/** The full recipe inspection report WP5.3's wizard renders + a `token` for phase two. `blocked` is the
 *  recipe-level verdict (ADR 0008 OR: any pack blocked OR the narrator has unknown types → the whole
 *  recipe is blocked; confirm refuses); the per-pack + narrator sub-reports say WHICH member broke it.
 *  `parseError` is present ONLY on a parse failure (mutually exclusive with the parsed fields; no token). */
export interface RecipeInspectionReport {
  /** Present only when the file parsed. */
  recipeMeta?: {
    id: string
    name: string
    description?: string
    creator?: string
  }
  packs: RecipePackReport[]
  narrator?: RecipeNarratorReport
  templatePlans: RecipeTemplatePlan[]
  /** The recipe-level verdict — true iff ANY pack has unknown node types OR the narrator does (ADR
   *  0008: reproduce the whole recipe or nothing). Confirm refuses a blocked recipe. */
  blocked: boolean
  warnings: string[]
  /** Present ONLY on a parse failure (the file was unreadable / not a valid recipe envelope). */
  parseError?: RecipeEnvelopeParseError
  /** The phase-two token, present iff the file parsed (even when blocked — the UI still shows the
   *  report; confirm will refuse). Absent on parse failure. */
  token?: string
}

/** The pending-import state stashed between inspect and confirm. Keyed by an opaque token; carries the
 *  parsed envelope + the profile it was inspected for + a TTL expiry. In-memory only (not persisted —
 *  a restart mid-import simply requires re-inspecting the file). The TARGET WORLD is NOT stored here:
 *  it is chosen at confirm (the recipe file doesn't know it), so confirmRecipeImport takes it as an arg. */
interface PendingRecipeImport {
  profileId: string
  envelope: RecipeEnvelope
  expiresAt: number
}

/** In-memory token -> pending-import map (TTL-swept). Separate from the pack transfer service's map by
 *  design: the two flows carry different envelope types + confirm signatures (a recipe confirm needs a
 *  targetWorldId), so a shared map would need a union value + branchy consumers — not clean. Same TTL +
 *  single-use + lazy-sweep discipline, so the behavior is identical; only the stored shape differs. */
const pendingRecipes = new Map<string, PendingRecipeImport>()

/** How long a pending recipe inspection lives before it is swept (5 minutes — matches the pack path's
 *  IMPORT_TOKEN_TTL_MS: long enough to read the wizard + pick a world + confirm, short enough that an
 *  abandoned inspection doesn't linger). */
export const RECIPE_IMPORT_TOKEN_TTL_MS = 5 * 60 * 1000

/** Drop every expired pending recipe import (lazy sweep — called on each inspect so the map self-cleans
 *  without a timer). Exported for the TTL test. */
export const sweepExpiredRecipeImports = (now = Date.now()): void => {
  for (const [token, p] of pendingRecipes) if (p.expiresAt <= now) pendingRecipes.delete(token)
}

/** Build one embedded pack's inspection sub-report (pure core — no fs, no dialog). Derives the
 *  capability report locally (ADR 0007), computes dedupe against the target profile's library, and
 *  collects unknown-node-types (the blocker) + subgraph warnings. */
const buildPackReport = (profileId: string, pack: PackPayload): RecipePackReport => {
  const report = deriveCapabilityReport(pack.fragment, knownTypes())
  const exact = getPackIdentity(profileId, pack.id, pack.version)
  const installedVersions = listPackVersions(profileId, pack.id)
  let dedupe: RecipeDedupe = 'new'
  if (exact) dedupe = 'already-installed'
  else if (installedVersions.length > 0) dedupe = 'new-version'
  return {
    id: pack.id,
    version: pack.version,
    name: pack.name,
    dedupe,
    capabilityReport: report,
    unknownNodeTypes: report.unknownNodeTypes,
    warnings: subgraphWarnings(pack.fragment)
  }
}

/** Build the narrator inspection report. Builtin → "uses your default narrator" (never a blocker).
 *  Embedded → derive its capability report LOCALLY (the same registry the packs use) so an unknown node
 *  type in the narrator surfaces as a BLOCKER (ADR 0008: the narrator is part of what must reproduce). */
const buildNarratorReport = (narrator: RecipeNarrator): RecipeNarratorReport => {
  if (narrator.kind === 'builtin') return { kind: 'builtin', unknownNodeTypes: [], warnings: [] }
  const report = deriveCapabilityReport(narrator.doc, knownTypes())
  return {
    kind: 'embedded',
    nodeCount: narrator.doc.nodes.length,
    unknownNodeTypes: report.unknownNodeTypes,
    warnings: subgraphWarnings(narrator.doc)
  }
}

/** Assemble the full inspection report from a PARSED envelope (the pure core — no fs, no dialog). Runs
 *  the per-pack + narrator sub-reports + template plans, then computes the recipe-level `blocked` as the
 *  OR over every pack's unknown-node-types AND the narrator's (ADR 0008 reproducibility grain). Does NOT
 *  stash a token — the caller (inspectRecipeFile) mints + stashes it. Exported for the tests. */
export const buildRecipeInspectionCore = (
  profileId: string,
  envelope: RecipeEnvelope,
  parseWarnings: string[]
): Omit<RecipeInspectionReport, 'token' | 'parseError'> => {
  const recipe = envelope.recipe
  const packs = recipe.packs.map((p) => buildPackReport(profileId, p))
  const narrator = buildNarratorReport(recipe.narrator)

  // Template plans (grounded in saveTableTemplate — a name collision installs a duplicate, never
  // overwrites). v0 recipes bundle nothing, so this is empty unless a hand-built recipe carries them.
  const existingNames = new Set(listTableTemplates(profileId).map((t) => t.name))
  const templatePlans: RecipeTemplatePlan[] = (envelope.bundledTemplates ?? []).map((t) => ({
    name: t.name,
    outcome: existingNames.has(t.name) ? 'will-duplicate' : 'will-install'
  }))

  // ADR 0008 reproducibility grain: the recipe is blocked iff ANY pack has unknown node types OR the
  // narrator does. One broken member blocks the whole recipe; the sub-reports say which.
  const blocked =
    packs.some((p) => p.unknownNodeTypes.length > 0) || narrator.unknownNodeTypes.length > 0

  return {
    recipeMeta: {
      id: recipe.id,
      name: recipe.name,
      ...(recipe.description ? { description: recipe.description } : {}),
      ...(recipe.creator ? { creator: recipe.creator } : {})
    },
    packs,
    narrator,
    templatePlans,
    blocked,
    warnings: [...parseWarnings, ...packs.flatMap((p) => p.warnings), ...narrator.warnings]
  }
}

/** Phase one: read + parse + inspect a `.rptrecipe` file WITHOUT installing (WP5.3's wizard). On
 *  success, stashes the parsed envelope under a fresh token (returned in the report) so
 *  confirmRecipeImport(token, targetWorldId) can apply it; on a parse failure, returns a report
 *  carrying only `parseError` (no token). Never throws across the IPC boundary — a read/parse failure
 *  is a structured report, not an exception. The TARGET WORLD is NOT chosen here (it's a confirm-time
 *  arg — the recipe file doesn't know it). */
export const inspectRecipeFile = (profileId: string, filePath: string): RecipeInspectionReport => {
  sweepExpiredRecipeImports()

  let text: string
  try {
    // Stat-guard before slurping the whole file (the shared parser also caps, but a stat avoids
    // reading a hostile multi-GB blob). Recipes are fat, so the cap is the recipe cap (64 MiB).
    const size = fs.statSync(filePath).size
    if (size > MAX_RECIPE_ENVELOPE_BYTES)
      return {
        packs: [],
        templatePlans: [],
        blocked: false,
        warnings: [],
        parseError: { code: 'too-large' }
      }
    text = fs.readFileSync(filePath, 'utf-8')
  } catch (error) {
    log('error', 'recipe import: failed to read file', error)
    return {
      packs: [],
      templatePlans: [],
      blocked: false,
      warnings: [],
      parseError: { code: 'invalid-json' }
    }
  }

  const parsed = parseRecipeEnvelope(text)
  if (!parsed.ok)
    return { packs: [], templatePlans: [], blocked: false, warnings: [], parseError: parsed.error }

  const core = buildRecipeInspectionCore(profileId, parsed.value, parsed.warnings)
  const token = randomUUID()
  pendingRecipes.set(token, {
    profileId,
    envelope: parsed.value,
    expiresAt: Date.now() + RECIPE_IMPORT_TOKEN_TTL_MS
  })
  return { ...core, token }
}

// ── confirm: apply the recipe into the target world ───────────────────────────────────────────────

/** What confirmRecipeImport did, per step, so a PARTIAL failure can report exactly what landed (no
 *  rollback machinery in v0 — see the module header's grounded no-transaction claim). Each field lists
 *  the members that completed BEFORE any throw. */
export interface RecipeApplied {
  /** Templates saved (name + the uuid saveTableTemplate minted). */
  templates: { name: string; id: string }[]
  /** Packs installed (id + version). `installed` true = a new library row; false = the dedupe no-op —
   *  both count as "the pinned version is present" (the recipe's goal). */
  packs: { id: string; version: number; installed: boolean }[]
  /** The narrator applied to the target world's selection sidecar: 'builtin' (sidecar pinned to the
   *  well-known builtin id) or 'embedded' (a fresh workflow doc saved + selected), with the saved id. */
  narrator?: { kind: 'builtin' | 'embedded'; workflowId: string }
  /** Activation entries applied (gate set + version pinned + overrides wrapped at world scope). */
  activation: { packId: string; version: number; enabled: boolean }[]
}

/** The result of a confirmed recipe import.
 *   · ok:true          — the whole sequence landed; `applied` details every step.
 *   · 'expired'        — the token is unknown / TTL-swept / already consumed; re-inspect the file.
 *   · 'blocked'        — the recipe was blocked (a pack or the narrator has unknown node types);
 *     re-checked at confirm (defense-in-depth). Carries the per-pack + narrator reports so the UI
 *     re-explains WHICH member blocked it.
 *   · 'partial'        — a step THREW mid-sequence (no cross-service transaction exists in v0 — see the
 *     module header). `applied` lists exactly what landed before the throw; `failedStep` + `error` name
 *     where it stopped so the UI can tell the user the world's real state. */
export type ConfirmRecipeResult =
  | { ok: true; applied: RecipeApplied }
  | { ok: false; code: 'expired' }
  | { ok: false; code: 'blocked'; packs: RecipePackReport[]; narrator?: RecipeNarratorReport }
  | { ok: false; code: 'partial'; applied: RecipeApplied; failedStep: string; error: string }

/** Pick a collision-safe NAME for an imported narrator doc. Ids never collide (createWorkflowFromDoc
 *  mints a fresh uuid — workflowService.ts), but NAMES can duplicate freely in listWorkflows, so we
 *  apply the SAME numbered-suffix convention cloneWorkflow uses ("X" -> "X (copy)" -> "X (copy 2)") when
 *  the recipe's narrator name already exists among the profile's workflows. Keeps the imported narrator
 *  distinguishable in the selection dropdown instead of silently shadowing an identically-named one. */
const collisionSafeNarratorName = (profileId: string, desired: string): string => {
  const taken = new Set(listWorkflows(profileId).map((w) => w.name))
  if (!taken.has(desired)) return desired
  let name = `${desired} (copy)`
  for (let n = 2; taken.has(name); n++) name = `${desired} (copy ${n})`
  return name
}

/** Phase two: apply a stashed recipe into the TARGET world (chosen HERE — the file doesn't know it).
 *  Re-checks the recipe-level block (defense-in-depth) and refuses if it holds. Sequence (ADR 0008 = N
 *  pack installs + one activation preset; ADR 0005 install != activate, so install first, activate after):
 *    1. install templates (fresh uuid each; a name collision installs a duplicate — grounded, no overwrite)
 *    2. install each pack (dedupe by (id, version); a differing version installs ALONGSIDE — WP4.6)
 *    3. narrator: embedded -> save a fresh workflow doc (collision-safe name) + set as the target world's
 *       default via the selection sidecar; builtin -> set the sidecar to the builtin id EXPLICITLY (the
 *       recipe SAYS builtin, so we pin it — reproduce, don't leave it on a stale prior selection)
 *    4. activation: per entry, setGate(packId, targetWorldId, null, enabled, version) + (if enabled)
 *       setActiveVersion + wrap each override at encodeScope({ world: targetWorldId }) via setOverride
 *  Consumes the token (single-use) on success AND on a blocked refusal. A THROW mid-sequence returns a
 *  structured 'partial' listing what landed (no rollback in v0 — the stores share no transaction). */
export const confirmRecipeImport = (token: string, targetWorldId: string): ConfirmRecipeResult => {
  sweepExpiredRecipeImports()
  const p = pendingRecipes.get(token)
  if (!p) return { ok: false, code: 'expired' }
  // Single-use: consume now so a double-confirm can't double-apply.
  pendingRecipes.delete(token)

  const { profileId, envelope } = p
  const recipe = envelope.recipe

  // Re-check the recipe-level block against CURRENT registry state (defense-in-depth; the sub-reports
  // are cheap to rebuild and the UI needs them to re-explain a refusal).
  const core = buildRecipeInspectionCore(profileId, envelope, [])
  if (core.blocked)
    return { ok: false, code: 'blocked', packs: core.packs, narrator: core.narrator }

  const applied: RecipeApplied = { templates: [], packs: [], activation: [] }

  try {
    // 1. Templates first (re-validated against the FULL TableTemplateSchema; the envelope pinned only a
    //    structural subset). A bad bundled template is skipped + logged — never aborts the recipe.
    for (const bundled of envelope.bundledTemplates ?? []) {
      const parsedT = TableTemplateSchema.safeParse(bundled)
      if (!parsedT.success) {
        log(
          'error',
          `recipe import: bundled template "${bundled.name}" failed validation; skipping`,
          parsedT.error.issues.slice(0, 3)
        )
        continue
      }
      const template: TableTemplate = parsedT.data
      const id = saveTableTemplate(profileId, template)
      applied.templates.push({ name: template.name, id })
    }

    // 2. Install each embedded pack (dedupe by (id, version); alongside per WP4.6). Same install the
    //    `.rptagent` path uses, so gates stay CLOSED here (ADR 0005) — step 4 applies the preset.
    for (const payload of recipe.packs) {
      const result = install(profileId, {
        id: payload.id,
        version: payload.version,
        upstreamId: null,
        upstreamVersion: null,
        builtin: false,
        manifest: {
          name: payload.name,
          ...(payload.description ? { description: payload.description } : {}),
          ...(payload.creator ? { creator: payload.creator } : {}),
          ...(payload.minRptVersion ? { minRptVersion: payload.minRptVersion } : {}),
          ...(payload.exposedSettings ? { exposedSettings: payload.exposedSettings } : {}),
          ...(payload.fork ? { fork: payload.fork } : {})
        },
        fragment: payload.fragment
      })
      applied.packs.push({ id: payload.id, version: payload.version, installed: result.installed })
    }

    // 3. Narrator into the TARGET world's selection sidecar (reproduce what the recipe pinned).
    if (recipe.narrator.kind === 'embedded') {
      // Save a fresh workflow doc (createWorkflowFromDoc mints a fresh uuid id — no id collision) with a
      // collision-safe NAME, then point the target world's default at it.
      const desiredName = recipe.narrator.doc.name
      const named = {
        ...recipe.narrator.doc,
        name: collisionSafeNarratorName(profileId, desiredName)
      }
      const saved = createWorkflowFromDoc(profileId, named)
      if (!saved.ok) {
        // The narrator was revalidated at envelope parse (exactly-one-main-output turn doc), so a save
        // failure here is unexpected — surface it as a partial (templates + packs already landed).
        return { ok: false, code: 'partial', applied, failedStep: 'narrator', error: saved.error }
      }
      setWorldWorkflow(profileId, targetWorldId, saved.id)
      applied.narrator = { kind: 'embedded', workflowId: saved.id }
    } else {
      // Builtin: pin the sidecar to the well-known builtin id EXPLICITLY (the recipe says builtin, so
      // reproduce it — don't leave the world on a stale prior selection).
      setWorldWorkflow(profileId, targetWorldId, BUILTIN_WORKFLOW_ID)
      applied.narrator = { kind: 'builtin', workflowId: BUILTIN_WORKFLOW_ID }
    }

    // 4. Activation preset: per entry, set the gate (pinning the version), then re-pin as a unit + wrap
    //    each override at WORLD scope for the target world (the format carries values; we carry scope).
    for (const entry of recipe.activation) {
      setGate(entry.packId, targetWorldId, null, entry.enabled, entry.version)
      // setActiveVersion re-pins every activation row for (pack, world) as a unit; it needs an existing
      // activation row, which setGate just wrote. Meaningful for an enabled entry (a closed gate still
      // records the pin via setGate's version arg, so this is belt-and-suspenders for enabled).
      if (entry.enabled) setActiveVersion(profileId, entry.packId, entry.version, targetWorldId)
      // World-scope overrides: the format's scope-free settingId->value map, wrapped at the TARGET
      // world's scope (encodeScope({ world })) — the importer carries the scope (recipeEnvelope header).
      for (const [settingId, value] of Object.entries(entry.overrides ?? {})) {
        setOverride(entry.packId, { world: targetWorldId }, settingId, value)
      }
      applied.activation.push({
        packId: entry.packId,
        version: entry.version,
        enabled: entry.enabled
      })
    }
  } catch (error) {
    // No cross-service transaction exists in v0 (module header). Report exactly what landed so the UI
    // can tell the user the world's real state — never a silent half-apply, never a fake rollback.
    return {
      ok: false,
      code: 'partial',
      applied,
      failedStep: 'activation',
      error: error instanceof Error ? error.message : String(error)
    }
  }

  return { ok: true, applied }
}

/** Cancel a pending recipe inspection (drop its stashed state). Idempotent — a no-op for an unknown
 *  token. The IPC layer calls this when the user dismisses the wizard without confirming. */
export const cancelRecipeImport = (token: string): void => {
  pendingRecipes.delete(token)
}

/** The current app version (Electron's app.getVersion()). Re-exported for IPC symmetry with the pack
 *  transfer service; the recipe flow has no minRptVersion gate of its own (each embedded pack's minimum
 *  is a pack-level concern the pack install already stores — a recipe-wide gate is a phase-6 concern). */
export const appVersion = (): string => app.getVersion()
