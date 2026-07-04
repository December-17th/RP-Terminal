// Agent-pack EXPORT / IMPORT — the machinery behind `.rptagent` user-to-user sharing (agent-packs
// plan WP4.2; phase 4). This is the main-side transfer layer over the SHARED envelope (WP4.1,
// shared/workflow/packEnvelope.ts): it builds an envelope from an installed pack (export), and
// parses + inspects + installs one from a file (import).
//
// Decisions grounded during the WP:
//  - ADR 0005 (install ≠ activate): import installs the pack with the gate CLOSED — activation is a
//    separate act. confirmImport never opens a gate.
//  - ADR 0007 (capabilities derived, never trusted): the envelope carries NO capability claims;
//    inspect RE-DERIVES the report locally via deriveCapabilityReport against the real registry.
//  - ADR 0008 (bundle for transport): the envelope bundles what a pack needs. See the TEMPLATE
//    BUNDLING RULE below.
//  - ADR 0008 version coexistence (WP4.6 — the WP1.4 debt PAID): library identity is (id, version),
//    so same-id-different-version import now INSTALLS ALONGSIDE (dedupe: 'new-version'), never blocks.
//    Exact (id, version) still dedupes ('already-installed'). The old `version-conflict` blocker is
//    GONE (recipes pin versions — you install 1.2 beside 1.4 and pin which one runs).
//
// ── TEMPLATE BUNDLING RULE (grounded, honest v0) ─────────────────────────────────────────────────
// A memory pack's table nodes (table.read/apply/export/gate) resolve their TableTemplate at RUNTIME
// from the CHAT's assignment — `getChatTableTemplateId(chatId)` (tableNodes.ts:31-34, 76-77, 153-154).
// NO fragment node config, exposedSetting default, or trigger default names a template id or name
// (verified: tableMemoryPack.ts + asyncMemoryPack.ts carry no `template*` field). So there is no
// CHAT-INDEPENDENT template reference for export to resolve. Per the WP4.2 honest rule ("bundle the
// templates the pack's exposedSettings/trigger defaults name IF resolvable, else bundle nothing and
// record it") we bundle NOTHING and record `noTemplatesBundled: true`. The envelope's
// `bundledTemplates` slot stays ready for the day a pack pins a template by name (WP4.1 API is fine
// as-is); today no pack does, so v0 ships portable-but-template-less memory packs. The importer's
// side of this: a memory pack works once its chat has a template assigned (the existing Memory rail
// binding flow), independent of the pack file.
//
// ── TEMPLATE COLLISION AT IMPORT (grounded) ──────────────────────────────────────────────────────
// `saveTableTemplate` mints a FRESH randomUUID id every call and never checks the name
// (tableTemplateService.ts:59-63) — templates are keyed by uuid, not name. So a bundled template
// whose `name` matches an existing template does NOT overwrite; it installs as a SECOND file (a
// duplicate name in the list). We report that honest outcome as `'will-duplicate'` per template in
// the inspection report. (Because v0 bundles nothing, this path is exercised only by hand-built
// envelopes / future template-pinning packs — but the logic is grounded + tested so it is correct the
// day a pack bundles.)

import { app } from 'electron'
import * as fs from 'fs'
import {
  parsePackEnvelope,
  serializePackEnvelope,
  PackEnvelope,
  PackEnvelopeParseError,
  MAX_PACK_ENVELOPE_BYTES
} from '../../shared/workflow/packEnvelope'
import { deriveCapabilityReport, CapabilityReport } from '../../shared/workflow/capabilities'
import { WorkflowDoc } from '../../shared/workflow/types'
import { getPackRecord, listPackVersions } from './agentPackStore'
import { install } from './agentPackService'
import { listTableTemplates, saveTableTemplate } from './tableTemplateService'
import { TableTemplate, TableTemplateSchema } from '../types/tableTemplate'
import { builtinRegistry } from './nodes/builtin'
import { log } from './logService'
import { randomUUID } from 'crypto'

// ── knownTypes: the runtime's registered node set (ADR 0007 soundness input) ──────────────────────
//
// deriveCapabilityReport needs the set of node types the runtime KNOWS so an unmapped-but-known type
// is inert while an unmapped-UNKNOWN type surfaces (a pack from a newer RPT). Computed once from the
// builtin registry (the same source capabilitySoundness.test.ts enumerates). Lazy so importing this
// module doesn't force registry construction ordering.
let _knownTypes: ReadonlySet<string> | null = null
const knownTypes = (): ReadonlySet<string> => {
  if (_knownTypes == null) _knownTypes = new Set(builtinRegistry.descriptors().keys())
  return _knownTypes
}

/** The node types whose PRESENCE in a fragment we surface as an import WARNING (not a block): a
 *  `subgraph.call`/`subgraph.loop` references a LOCAL sub-graph whose behavior the surface analysis
 *  cannot fully derive (master-plan Amendment after WP4.1; ADR 0007 cross-doc reachability is a later
 *  WP). Creators see the same warning at export so "exports fine here, warned there" cannot happen. */
const SUBGRAPH_NODE_TYPES = new Set(['subgraph.call', 'subgraph.loop'])

/** Human-readable subgraph-presence warnings for a fragment (empty if none). One line per distinct
 *  subgraph-bearing node id so the UI can point at them. */
const subgraphWarnings = (doc: WorkflowDoc): string[] =>
  doc.nodes
    .filter((n) => SUBGRAPH_NODE_TYPES.has(n.type))
    .map(
      (n) =>
        `node "${n.id}" (${n.type}) references a local sub-graph — behavior not fully derivable`
    )

// ── EXPORT ────────────────────────────────────────────────────────────────────────────────────────

/** A structured export failure the UI branches on. `builtin-not-exportable`: builtins ship with the
 *  app; exporting one would shadow it elsewhere (a fork of a builtin IS exportable — the creator
 *  path). `not-installed`: no such pack in this profile. */
export interface ExportError {
  code: 'builtin-not-exportable' | 'not-installed'
  message: string
}

/** The dry-run export preview (WP4.3's wizard shows this WITHOUT writing). Mirrors what the file will
 *  contain: the envelope meta, an attachments summary, the LOCALLY-derived capability report (vs the
 *  real registry — same authority the importer uses, so the creator sees exactly what an importer
 *  will), the bundled template names, and the warnings (subgraph presence surfaced HERE too so
 *  creators see what importers will). */
export interface ExportPreview {
  envelopeMeta: {
    name: string
    version: number
    creator?: string
    /** UTF-8 byte length of the serialized `.rptagent` text (what the file will weigh). */
    sizeBytes: number
  }
  attachments: {
    /** Count by attachment kind (entry / rejoin / trigger) — the badge structure a creator recognizes. */
    entries: number
    rejoins: number
    triggers: number
  }
  capabilityReport: CapabilityReport
  bundledTemplateNames: string[]
  /** True iff no template was bundled (the v0 rule — see the module header). Lets the wizard show
   *  "this memory pack ships without a template; importers assign one to a chat". */
  noTemplatesBundled: boolean
  warnings: string[]
}

/** The result of building an envelope from an installed pack — either the serialized text + preview,
 *  or a structured error. Shared by preview (discard the text) and export (write the text). */
type BuildEnvelopeResult =
  | { ok: true; text: string; envelope: PackEnvelope; preview: ExportPreview }
  | { ok: false; error: ExportError }

/** The v0 template-bundling decision for a pack (see the module header's RULE). Today: always empty
 *  (`noTemplatesBundled: true`) because no pack names a chat-independent template. Factored out so the
 *  day a pack pins a template by name, this is the ONE place to resolve + bundle it. */
const resolveBundledTemplates = (): {
  templates: undefined
  names: string[]
  noTemplatesBundled: boolean
} => ({ templates: undefined, names: [], noTemplatesBundled: true })

/** Build the export envelope + preview for an installed pack (pure over the store read — the caller
 *  supplies profileId/packId). Refuses builtins (fork-of-builtin is fine — it is a non-builtin row).
 *  Does NOT write; export() and previewAgentPackExport() both call this and diverge only on the write. */
const buildExportEnvelope = (profileId: string, packId: string): BuildEnvelopeResult => {
  const pack = getPackRecord(profileId, packId)
  if (!pack)
    return { ok: false, error: { code: 'not-installed', message: `pack ${packId} is not installed` } }
  if (pack.builtin)
    return {
      ok: false,
      error: {
        code: 'builtin-not-exportable',
        message: `pack ${packId} is a built-in pack and cannot be exported (fork it first to share your edits)`
      }
    }

  const { templates, names, noTemplatesBundled } = resolveBundledTemplates()
  // WP4.6: minRptVersion now PERSISTS on the manifest (packManifest.ts), so export advertises it — a
  // stored pack round-trips its minimum through export→import→re-export. Absent = no minimum declared.
  const text = serializePackEnvelope({
    id: pack.id,
    version: pack.version,
    manifest: pack.manifest,
    fragment: pack.fragment,
    ...(pack.manifest.minRptVersion ? { minRptVersion: pack.manifest.minRptVersion } : {}),
    ...(templates ? { bundledTemplates: templates } : {})
  })

  // Re-parse our own output so the preview's envelope/report is derived from exactly what ships (and
  // so a build regression that produces an invalid envelope is caught here, not by the importer).
  const parsed = parsePackEnvelope(text)
  if (!parsed.ok) {
    // Should never happen — we just serialized a validated store record. Surface as not-installed-ish
    // rather than crash; log the detail for the dev.
    log('error', `agentPack export: self-parse failed for ${packId}`, parsed.error)
    return { ok: false, error: { code: 'not-installed', message: `pack ${packId} produced an invalid envelope` } }
  }

  const report = deriveCapabilityReport(pack.fragment, knownTypes())
  const attachments = pack.fragment.attachments ?? []
  const preview: ExportPreview = {
    envelopeMeta: {
      name: pack.manifest.name,
      version: pack.version,
      ...(pack.manifest.creator ? { creator: pack.manifest.creator } : {}),
      sizeBytes: new TextEncoder().encode(text).length
    },
    attachments: {
      entries: attachments.filter((a) => a.kind === 'entry').length,
      rejoins: attachments.filter((a) => a.kind === 'rejoin').length,
      triggers: attachments.filter((a) => a.kind === 'trigger').length
    },
    capabilityReport: report,
    bundledTemplateNames: names,
    noTemplatesBundled,
    warnings: subgraphWarnings(pack.fragment)
  }

  return { ok: true, text, envelope: parsed.value, preview }
}

/** The dry-run export preview for WP4.3's wizard: everything the wizard shows WITHOUT writing a file.
 *  Returns a structured error (builtin / not-installed) instead. Pure read of the store — no dialog. */
export const previewAgentPackExport = (
  profileId: string,
  packId: string
): { ok: true; preview: ExportPreview } | { ok: false; error: ExportError } => {
  const built = buildExportEnvelope(profileId, packId)
  return built.ok ? { ok: true, preview: built.preview } : { ok: false, error: built.error }
}

/** The default `.rptagent` filename for a pack: `<id>-v<version>.rptagent`, sanitized for the FS. The
 *  IPC layer passes this as the save dialog's defaultPath. */
export const exportFileName = (packId: string, version: number): string =>
  `${packId.replace(/[\\/:*?"<>|]/g, '_')}-v${version}.rptagent`

/** Write an installed pack's envelope to `filePath` (UTF-8). The IPC layer runs the save dialog and
 *  supplies the chosen path; a canceled dialog never reaches here. Returns the built envelope error
 *  (builtin / not-installed) if the pack can't be exported, else `{ ok: true }`. */
export const writeAgentPackExport = (
  profileId: string,
  packId: string,
  filePath: string
): { ok: true } | { ok: false; error: ExportError } => {
  const built = buildExportEnvelope(profileId, packId)
  if (!built.ok) return { ok: false, error: built.error }
  fs.writeFileSync(filePath, built.text, 'utf-8')
  return { ok: true }
}

// ── IMPORT (two-phase: inspect → confirm) ─────────────────────────────────────────────────────────
//
// WP4.3's inspection screen needs to SHOW the user what a file contains + what will happen BEFORE
// installing. So import is two-phase: `inspectAgentPackFile` reads/parses/derives everything and
// stashes the parsed envelope under a short-lived token; `confirmAgentPackImport(token)` performs the
// install. `importAgentPack` (IPC) = open dialog → inspect → hand the report to the renderer, which
// decides whether to confirm.

/** How a bundled template will land at import, per template (grounded in saveTableTemplate — see the
 *  module header). v0 bundles nothing, so this is populated only for hand-built / future envelopes.
 *   · `'will-install'`  — no existing template shares this name; it installs cleanly.
 *   · `'will-duplicate'`— an existing template already has this name; saveTableTemplate mints a fresh
 *     uuid and does NOT overwrite, so BOTH survive (a duplicate name in the list). Honest outcome. */
export interface BundledTemplatePlan {
  name: string
  outcome: 'will-install' | 'will-duplicate'
}

/** Why an import is BLOCKED at confirm time (checked at inspect, re-checked at confirm). The
 *  inspection report carries these so the UI can EXPLAIN the block on the inspection screen.
 *   · `unknown-node-types` — the fragment has node types this build doesn't know (a pack from a newer
 *     RPT); a fragment whose nodes can't run here would produce broken turns. Lists the types.
 *   · `version-too-old`    — the envelope's `minRptVersion` exceeds this app version. Carries both.
 *
 *  WP4.6: `version-conflict` is REMOVED — a same-id different-version import now installs ALONGSIDE
 *  (dedupe: 'new-version'), so a version difference is never a blocker. The WP4.3b inspector's
 *  uninstall-then-import recovery keys off `blockers` containing version-conflict, which no longer
 *  happens; that recovery path is simply unreachable (renderer untouched this WP). */
export type ImportBlocker =
  | { code: 'unknown-node-types'; nodeTypes: string[] }
  | { code: 'version-too-old'; minRptVersion: string; appVersion: string }

/** The full inspection report WP4.3's screen renders + a `token` for phase two. `dedupe` distinguishes
 *  a same-id+version no-op ('already-installed') from a fresh install ('new'); `blockers` (possibly
 *  several) list every reason confirm would refuse — EMPTY means confirm will proceed. `warnings`
 *  carry non-blocking notes (subgraph presence, unknown-key hints from the envelope parse). */
export interface InspectionReport {
  /** Present only when the file parsed. Absent on a parse failure (see `parseError`). */
  envelopeMeta?: {
    id: string
    name: string
    version: number
    creator?: string
    minRptVersion?: string
    fork?: { base: string; n: number }
  }
  capabilityReport?: CapabilityReport
  bundledTemplatePlans: BundledTemplatePlan[]
  /** 'new' = a fresh id (no version installed); 'new-version' = same id, a DIFFERENT version installed
   *  → installs ALONGSIDE (WP4.6, ADR 0008 — recipes pin versions); 'already-installed' = same
   *  id+version present (confirm is a no-op); undefined when the file didn't parse. */
  dedupe?: 'new' | 'new-version' | 'already-installed'
  blockers: ImportBlocker[]
  warnings: string[]
  /** Present ONLY on a parse failure (the file was unreadable / not a valid envelope). Mutually
   *  exclusive with the parsed fields above; `token` is absent (nothing to confirm). */
  parseError?: PackEnvelopeParseError
  /** The phase-two token, present iff the file parsed (even with blockers — the UI still shows the
   *  report; confirm will refuse). Absent on parse failure. */
  token?: string
}

/** The pending-import state stashed between inspect and confirm. Keyed by an opaque token; carries the
 *  parsed envelope + the profile it was inspected for + a TTL expiry so a never-confirmed inspection
 *  doesn't leak. Kept in-memory only (a token is not persisted across restarts — a restart mid-import
 *  simply requires re-inspecting the file). */
interface PendingImport {
  profileId: string
  envelope: PackEnvelope
  expiresAt: number
}

/** In-memory token → pending-import map (TTL-swept). Simple by design (WP4.2 brief): a short TTL,
 *  cleared on confirm/cancel, swept lazily on each inspect. Not persisted. */
const pending = new Map<string, PendingImport>()

/** How long a pending inspection lives before it is swept (5 minutes — long enough for a human to
 *  read the inspection screen and click confirm, short enough that an abandoned one doesn't linger). */
export const IMPORT_TOKEN_TTL_MS = 5 * 60 * 1000

/** Drop every expired pending import (lazy sweep — called on each inspect so the map self-cleans
 *  without a timer). Exported for the TTL test. */
export const sweepExpiredImports = (now = Date.now()): void => {
  for (const [token, p] of pending) if (p.expiresAt <= now) pending.delete(token)
}

/** Parse a `major.minor.patch` (or leading subset) into comparable numbers; missing parts → 0. Extra
 *  suffix (e.g. `-beta`) is ignored (compared on the numeric core only) — enough for the v0
 *  `minRptVersion` gate (a coarse "is your app new enough" check, not full semver range logic). */
const parseSemverCore = (v: string): [number, number, number] => {
  const parts = v.split('.').map((p) => parseInt(p, 10))
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
}

/** True iff `required` is strictly NEWER than `app` (so import must refuse `version-too-old`). Compares
 *  the numeric major.minor.patch cores. */
export const isVersionTooOld = (required: string, appVersion: string): boolean => {
  const r = parseSemverCore(required)
  const a = parseSemverCore(appVersion)
  for (let i = 0; i < 3; i++) {
    if (r[i] > a[i]) return true
    if (r[i] < a[i]) return false
  }
  return false
}

/** Assemble the inspection report from a PARSED envelope (the pure core — no fs, no dialog). Derives
 *  the capability report locally (ADR 0007 — never trusts the file), checks dedupe + version-conflict
 *  against the store, plans bundled templates against existing names, and gathers blockers + warnings.
 *  `appVersion` is injected (the IPC layer passes app.getVersion()) so this stays testable. Does NOT
 *  stash a token — the caller (inspectAgentPackFile) mints + stashes it. Exported for the tests. */
export const buildInspectionCore = (
  profileId: string,
  envelope: PackEnvelope,
  parseWarnings: string[],
  appVersion: string
): Omit<InspectionReport, 'token' | 'parseError'> => {
  const { pack } = envelope
  const report = deriveCapabilityReport(pack.fragment, knownTypes())

  // Dedupe against the store (WP4.6 version coexistence, ADR 0008). Exact (id, version) → dedupe
  // no-op; same id, another version installed → INSTALL ALONGSIDE ('new-version', never a blocker);
  // no version of the id installed → 'new'. Probe the exact (id, version) AND the id's version set.
  const exact = getPackRecord(profileId, pack.id, pack.version)
  const installedVersions = listPackVersions(profileId, pack.id)
  let dedupe: 'new' | 'new-version' | 'already-installed' = 'new'
  if (exact) dedupe = 'already-installed'
  else if (installedVersions.length > 0) dedupe = 'new-version'
  const blockers: ImportBlocker[] = []

  // Unknown node types → the fragment can't run here (ADR 0007 soundness). BLOCK.
  if (report.unknownNodeTypes.length > 0)
    blockers.push({ code: 'unknown-node-types', nodeTypes: report.unknownNodeTypes })

  // minRptVersion gate.
  if (pack.minRptVersion && isVersionTooOld(pack.minRptVersion, appVersion))
    blockers.push({ code: 'version-too-old', minRptVersion: pack.minRptVersion, appVersion })

  // Bundled-template plans (grounded in saveTableTemplate — name collision → duplicate, never overwrite).
  const existingNames = new Set(listTableTemplates(profileId).map((t) => t.name))
  const bundledTemplatePlans: BundledTemplatePlan[] = (envelope.bundledTemplates ?? []).map((t) => ({
    name: t.name,
    outcome: existingNames.has(t.name) ? 'will-duplicate' : 'will-install'
  }))

  const warnings = [...parseWarnings, ...subgraphWarnings(pack.fragment)]

  return {
    envelopeMeta: {
      id: pack.id,
      name: pack.name,
      version: pack.version,
      ...(pack.creator ? { creator: pack.creator } : {}),
      ...(pack.minRptVersion ? { minRptVersion: pack.minRptVersion } : {}),
      ...(pack.fork ? { fork: pack.fork } : {})
    },
    capabilityReport: report,
    bundledTemplatePlans,
    dedupe,
    blockers,
    warnings
  }
}

/** Phase one: read + parse + inspect a `.rptagent` file WITHOUT installing (WP4.3's inspection
 *  screen). On success, stashes the parsed envelope under a fresh token (returned in the report) so
 *  `confirmAgentPackImport(token)` can install it; on a parse failure, returns a report carrying only
 *  `parseError` (no token). `appVersion` is injected by the IPC layer (app.getVersion()). Never throws
 *  across the IPC boundary — a read/parse failure is a structured report, not an exception. */
export const inspectAgentPackFile = (
  profileId: string,
  filePath: string,
  appVersion: string
): InspectionReport => {
  sweepExpiredImports()

  let text: string
  try {
    // Guard the byte size before reading the whole thing into a string (the shared parser also caps,
    // but a stat-guard avoids slurping a hostile multi-GB file). fs.statSync is cheap.
    const size = fs.statSync(filePath).size
    if (size > MAX_PACK_ENVELOPE_BYTES)
      return { bundledTemplatePlans: [], blockers: [], warnings: [], parseError: { code: 'too-large' } }
    text = fs.readFileSync(filePath, 'utf-8')
  } catch (error) {
    log('error', 'agentPack import: failed to read file', error)
    return {
      bundledTemplatePlans: [],
      blockers: [],
      warnings: [],
      parseError: { code: 'invalid-json' }
    }
  }

  const parsed = parsePackEnvelope(text)
  if (!parsed.ok)
    return { bundledTemplatePlans: [], blockers: [], warnings: [], parseError: parsed.error }

  const core = buildInspectionCore(profileId, parsed.value, parsed.warnings, appVersion)
  const token = randomUUID()
  pending.set(token, {
    profileId,
    envelope: parsed.value,
    expiresAt: Date.now() + IMPORT_TOKEN_TTL_MS
  })
  return { ...core, token }
}

/** The result of a confirmed import. On success: the installed summary + template outcomes. On
 *  failure: a structured code the UI localizes.
 *   · `expired`      — the token is unknown / TTL-swept / already consumed; re-inspect the file.
 *   · `blocked`      — a blocker (unknown-node-types / version-too-old) was present; carries the
 *     blockers so the UI re-explains (defense-in-depth: confirm re-checks, never trusting that
 *     inspect's report was acted on). WP4.6: version-conflict is no longer a blocker (installs
 *     alongside), so a version difference never reaches this branch. */
export type ConfirmImportResult =
  | {
      ok: true
      /** 'installed' = a new library row; 'already-installed' = the id+version dedupe no-op. */
      installed: 'installed' | 'already-installed'
      pack: { id: string; version: number; name: string }
      /** Per bundled template: the name + the id it was saved under (present only for templates that
       *  actually installed — v0 bundles none). */
      installedTemplates: { name: string; id: string }[]
    }
  | { ok: false; code: 'expired' }
  | { ok: false; code: 'blocked'; blockers: ImportBlocker[] }

/** Phase two: install the pack (and bundled templates) for a stashed inspection token. Re-checks
 *  blockers (defense-in-depth) and refuses if any hold. Installs templates FIRST (per the grounded
 *  collision rule — a fresh uuid each, duplicates by name allowed), then the pack via the ordinary
 *  agentPackService.install (id+version dedupe, gate CLOSED — ADR 0005 activation is separate). The
 *  `appVersion` is injected so the confirm-time re-check matches inspect. Consumes the token (single-
 *  use) on both success and blocked-refusal. Returns `expired` for an unknown/consumed/swept token. */
export const confirmAgentPackImport = (
  token: string,
  appVersion: string
): ConfirmImportResult => {
  sweepExpiredImports()
  const p = pending.get(token)
  if (!p) return { ok: false, code: 'expired' }
  // Single-use: consume now so a double-confirm can't double-install.
  pending.delete(token)

  const { profileId, envelope } = p
  const { pack } = envelope

  // Re-check blockers against CURRENT store + app state (defense-in-depth; the store may have changed
  // between inspect and confirm — e.g. the user installed another version).
  const core = buildInspectionCore(profileId, envelope, [], appVersion)
  if (core.blockers.length > 0) return { ok: false, code: 'blocked', blockers: core.blockers }

  // Install bundled templates first (re-validated against the FULL TableTemplateSchema — the envelope
  // pinned only a structural subset; saveTableTemplate re-parses, tableTemplateService.ts:62). A fresh
  // uuid each; a name collision installs a duplicate (grounded — no overwrite).
  const installedTemplates: { name: string; id: string }[] = []
  for (const bundled of envelope.bundledTemplates ?? []) {
    // The bundled template is a structural subset (+ passthrough) of a native TableTemplate; parse it
    // through the authoritative schema to fill defaults + reject a malformed one. A bad bundled
    // template is skipped + logged (never blocks the pack install — the pack is the primary artifact).
    const parsed = TableTemplateSchema.safeParse(bundled)
    if (!parsed.success) {
      log('error', `agentPack import: bundled template "${bundled.name}" failed validation; skipping`, parsed.error.issues.slice(0, 3))
      continue
    }
    const template: TableTemplate = parsed.data
    const id = saveTableTemplate(profileId, template)
    installedTemplates.push({ name: template.name, id })
  }

  // Install the pack (gate CLOSED — ADR 0005). agentPackService.install dedupes exact id+version and
  // INSTALLS ALONGSIDE a different version (WP4.6, ADR 0008 — no more version-conflict refusal).
  // WP4.6: minRptVersion now PERSISTS on the manifest, so a too-old-gated pack's minimum round-trips
  // (import stores it → a re-export re-advertises it). The version-too-old blocker above still refuses
  // an app that is actually too old, so a stored minRptVersion never gates a machine that can't run it.
  const record: Parameters<typeof install>[1] = {
    id: pack.id,
    version: pack.version,
    upstreamId: null,
    upstreamVersion: null,
    builtin: false,
    manifest: {
      name: pack.name,
      ...(pack.description ? { description: pack.description } : {}),
      ...(pack.creator ? { creator: pack.creator } : {}),
      ...(pack.minRptVersion ? { minRptVersion: pack.minRptVersion } : {}),
      ...(pack.exposedSettings ? { exposedSettings: pack.exposedSettings } : {}),
      ...(pack.fork ? { fork: pack.fork } : {})
    },
    fragment: pack.fragment
  }
  const result = install(profileId, record)

  return {
    ok: true,
    installed: result.installed ? 'installed' : 'already-installed',
    pack: { id: pack.id, version: pack.version, name: pack.name },
    installedTemplates
  }
}

/** Cancel a pending inspection (drop its stashed state). Idempotent — a no-op for an unknown token.
 *  The IPC layer calls this when the user dismisses the inspection screen without confirming. */
export const cancelAgentPackImport = (token: string): void => {
  pending.delete(token)
}

/** The current app version (Electron's `app.getVersion()` = package.json `version`). Read here so the
 *  IPC layer has one accessor; the pure core takes it as a parameter (testable without electron). */
export const appVersion = (): string => app.getVersion()
