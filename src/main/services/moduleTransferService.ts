// Module EXPORT / IMPORT — the machinery behind `.rptmodule` user-to-user sharing (one-canvas rebuild
// WP6.5). Mirrors agentPackTransferService (the `.rptagent` transfer layer) in shape, smaller: it
// builds an envelope from a GROUP in an edited doc (export), and parses + inspects one from a file
// (import). The dialogs live in the IPC layer (agentPackIpc), keeping this service dialog-free +
// testable — the same seam the pack + recipe transfer services use.
//
// Key difference from the pack path: a module is NOT a doc, so import does NOT write anything durable
// to a doc store. `confirmModuleImport` installs bundled templates main-side (a durable act — templates
// are files) and hands the parsed module payload BACK to the renderer, which inserts it into the doc
// being edited (the editor store's `insertModule`). The doc lives unsaved in the editor store; main
// must never write it (that would race the user's unsaved edits).
//
// Grounded against: moduleEnvelope (the shared serialize/parse + guarantees), deriveCapabilityReport
// (ADR 0007 — capabilities derived from the module's nodes vs the real registry; an UNKNOWN node type
// is a BLOCKER, so a module from a newer RPT can't silently drop in), saveTableTemplate (fresh-uuid,
// never-overwrites → will-install vs will-duplicate), and agentPackTransferService's 5-min single-use
// token-map idiom (a SEPARATE map — do NOT unify with the pack/recipe maps).

import * as fs from 'fs'
import {
  parseModuleEnvelope,
  serializeModuleEnvelope,
  ModuleEnvelope,
  ModulePayload,
  ModuleEnvelopeParseError,
  MAX_MODULE_ENVELOPE_BYTES,
  type BundledTemplate
} from '../../shared/workflow/moduleEnvelope'
import { deriveCapabilityReport, CapabilityReport } from '../../shared/workflow/capabilities'
import { WorkflowDoc } from '../../shared/workflow/types'
import { listTableTemplates, saveTableTemplate } from './tableTemplateService'
import { TableTemplate, TableTemplateSchema } from '../types/tableTemplate'
import { builtinRegistry } from './nodes/builtin'
import { log } from './logService'
import { randomUUID } from 'crypto'

// ── knownTypes: the runtime's registered node set (ADR 0007 soundness input) ──────────────────────
let _knownTypes: ReadonlySet<string> | null = null
const knownTypes = (): ReadonlySet<string> => {
  if (_knownTypes == null) _knownTypes = new Set(builtinRegistry.descriptors().keys())
  return _knownTypes
}

/** A synthetic doc wrapping a module's nodes/edges so deriveCapabilityReport (which takes a WorkflowDoc)
 *  can analyze it against the real registry. No attachments → the structure-derived caps
 *  (injects-prompt / runs-headless) are absent, which is correct: a module carries no attachments. */
const syntheticDoc = (module: ModulePayload): WorkflowDoc => ({
  id: 'module',
  name: module.name,
  version: 1,
  schemaVersion: 1,
  nodes: module.nodes,
  edges: module.edges
})

// ── EXPORT ─────────────────────────────────────────────────────────────────────────────────────────

/** Build a module envelope PAYLOAD from a doc's group (pure — no fs, no dialog). Collects the group's
 *  member nodes, keeps only INTERNAL edges (both ends members — boundary edges are dropped, per the
 *  NON-GOAL "no boundary-edge carrying"), and the group's exposed settings. Returns null when the group
 *  id isn't in the doc. `opts.includeTemplate` bundles the whole active template (the v0 unit). */
export const buildModuleEnvelope = (
  doc: WorkflowDoc,
  groupId: string,
  opts: { includeTemplate?: TableTemplate } = {}
): { module: ModulePayload; bundledTemplates?: BundledTemplate[] } | null => {
  const group = (doc.groups ?? []).find((g) => g.id === groupId)
  if (!group) return null

  const memberIds = new Set(group.nodeIds)
  const nodes = doc.nodes.filter((n) => memberIds.has(n.id))
  // INTERNAL edges only: both ends must be members. A boundary edge (one end outside the group) is
  // dropped — an imported module lands unwired and the user connects it (the NON-GOAL).
  const edges = doc.edges.filter((e) => memberIds.has(e.from.node) && memberIds.has(e.to.node))

  const module: ModulePayload = {
    name: group.name,
    nodes,
    edges,
    ...(group.exposed && group.exposed.length > 0 ? { exposed: group.exposed } : {}),
    // Agent & memory UX (WP-A): carry the group's author setup guidance so an imported agent keeps it.
    ...(group.note ? { note: group.note } : {})
  }
  return {
    module,
    ...(opts.includeTemplate ? { bundledTemplates: [opts.includeTemplate as BundledTemplate] } : {})
  }
}

/** The default `.rptmodule` filename for a module: `<name>.rptmodule`, sanitized for the FS. */
export const moduleFileName = (name: string): string =>
  `${(name || 'module').replace(/[\\/:*?"<>|]/g, '_')}.rptmodule`

/** Write a module envelope to `filePath` (UTF-8). The IPC layer runs the save dialog and supplies the
 *  chosen path. Serializes the payload (the caller already built it from the group). */
export const writeModuleExport = (
  module: ModulePayload,
  filePath: string,
  bundledTemplates?: BundledTemplate[]
): void => {
  fs.writeFileSync(filePath, serializeModuleEnvelope(module, bundledTemplates), 'utf-8')
}

// ── IMPORT (two-phase: inspect → confirm) ────────────────────────────────────────────────────────

/** How a bundled template will land at import, per template (grounded in saveTableTemplate — a fresh
 *  uuid each, name collision installs a DUPLICATE, never overwrites). */
export interface ModuleTemplatePlan {
  name: string
  outcome: 'will-install' | 'will-duplicate'
}

/** The inspection report the import sheet renders + a `token` for phase two. `blockers` list every
 *  reason confirm would refuse — EMPTY means confirm proceeds. Present only when the file parsed;
 *  `parseError` is present ONLY on a parse failure (mutually exclusive, no token). */
export interface ModuleInspectionReport {
  meta?: { name: string; nodeCount: number; description?: string; creator?: string }
  capabilityReport?: CapabilityReport
  templatePlans: ModuleTemplatePlan[]
  /** Non-empty → confirm refuses. v1's only blocker: unknown node types (a module from a newer RPT
   *  whose nodes can't run here). */
  blockers: { code: 'unknown-node-types'; nodeTypes: string[] }[]
  warnings: string[]
  parseError?: ModuleEnvelopeParseError
  token?: string
}

/** The pending-import state stashed between inspect and confirm (SEPARATE from the pack/recipe maps —
 *  do NOT unify). Keyed by an opaque token; carries the parsed envelope + the profile + a TTL expiry. */
interface PendingModuleImport {
  profileId: string
  envelope: ModuleEnvelope
  expiresAt: number
}

const pending = new Map<string, PendingModuleImport>()

/** How long a pending inspection lives before it is swept (5 minutes — the pack-transfer TTL). */
export const MODULE_IMPORT_TOKEN_TTL_MS = 5 * 60 * 1000

/** Drop every expired pending import (lazy sweep — called on each inspect so the map self-cleans
 *  without a timer). Exported for the TTL test. */
export const sweepExpiredModuleImports = (now = Date.now()): void => {
  for (const [token, p] of pending) if (p.expiresAt <= now) pending.delete(token)
}

/** Assemble the inspection report from a PARSED envelope (the pure core — no fs, no dialog). Derives
 *  the capability report locally against the real registry (ADR 0007 — never trusts the file; an
 *  UNKNOWN node type is a BLOCKER), plans bundled templates against existing names, and gathers
 *  blockers + warnings. Does NOT stash a token — the caller mints + stashes it. Exported for tests. */
export const buildModuleInspectionCore = (
  profileId: string,
  envelope: ModuleEnvelope,
  parseWarnings: string[]
): Omit<ModuleInspectionReport, 'token' | 'parseError'> => {
  const { module } = envelope
  const report = deriveCapabilityReport(syntheticDoc(module), knownTypes())

  const blockers: { code: 'unknown-node-types'; nodeTypes: string[] }[] = []
  if (report.unknownNodeTypes.length > 0)
    blockers.push({ code: 'unknown-node-types', nodeTypes: report.unknownNodeTypes })

  const existingNames = new Set(listTableTemplates(profileId).map((t) => t.name))
  const templatePlans: ModuleTemplatePlan[] = (envelope.bundledTemplates ?? []).map((t) => ({
    name: t.name,
    outcome: existingNames.has(t.name) ? 'will-duplicate' : 'will-install'
  }))

  return {
    meta: {
      name: module.name,
      nodeCount: module.nodes.length,
      ...(module.description ? { description: module.description } : {}),
      ...(module.creator ? { creator: module.creator } : {})
    },
    capabilityReport: report,
    templatePlans,
    blockers,
    warnings: parseWarnings
  }
}

/** Phase one: read + parse + inspect a `.rptmodule` file WITHOUT installing. On success, stashes the
 *  parsed envelope under a fresh token (returned in the report) so `confirmModuleImport(token)` can
 *  install templates + return the module; on a parse failure, returns a report carrying only
 *  `parseError` (no token). Never throws across the IPC boundary. */
export const inspectModuleFile = (profileId: string, filePath: string): ModuleInspectionReport => {
  sweepExpiredModuleImports()

  let text: string
  try {
    const size = fs.statSync(filePath).size
    if (size > MAX_MODULE_ENVELOPE_BYTES)
      return { templatePlans: [], blockers: [], warnings: [], parseError: { code: 'too-large' } }
    text = fs.readFileSync(filePath, 'utf-8')
  } catch (error) {
    log('error', 'module import: failed to read file', error)
    return { templatePlans: [], blockers: [], warnings: [], parseError: { code: 'invalid-json' } }
  }

  const parsed = parseModuleEnvelope(text)
  if (!parsed.ok) return { templatePlans: [], blockers: [], warnings: [], parseError: parsed.error }

  const core = buildModuleInspectionCore(profileId, parsed.value, parsed.warnings)
  const token = randomUUID()
  pending.set(token, {
    profileId,
    envelope: parsed.value,
    expiresAt: Date.now() + MODULE_IMPORT_TOKEN_TTL_MS
  })
  return { ...core, token }
}

/** The result of a confirmed import. On success: the module payload (returned to the RENDERER, which
 *  inserts it into the edited doc) + the templates that installed. On failure: a structured code.
 *   · `expired` — unknown / TTL-swept / already-consumed token; re-inspect the file.
 *   · `blocked` — a blocker held (unknown node types); carries them so the UI re-explains. */
export type ConfirmModuleImportResult =
  | {
      ok: true
      module: ModulePayload
      installedTemplates: { name: string; id: string }[]
    }
  | { ok: false; code: 'expired' }
  | { ok: false; code: 'blocked'; blockers: { code: 'unknown-node-types'; nodeTypes: string[] }[] }

/** Phase two: install bundled templates main-side and hand the module payload back to the renderer.
 *  Re-checks blockers (defense-in-depth — the store may have changed between inspect and confirm).
 *  Templates install with a fresh uuid each (a name collision installs a duplicate — grounded, no
 *  overwrite). Consumes the token (single-use) on both success and blocked-refusal. Does NOT write any
 *  doc (the graph insertion is a renderer/store concern — the doc lives unsaved in the editor). */
export const confirmModuleImport = (token: string): ConfirmModuleImportResult => {
  sweepExpiredModuleImports()
  const p = pending.get(token)
  if (!p) return { ok: false, code: 'expired' }
  pending.delete(token)

  const { profileId, envelope } = p
  const core = buildModuleInspectionCore(profileId, envelope, [])
  if (core.blockers.length > 0) return { ok: false, code: 'blocked', blockers: core.blockers }

  const installedTemplates: { name: string; id: string }[] = []
  for (const bundled of envelope.bundledTemplates ?? []) {
    // Re-validate the bundled structural subset against the authoritative schema (fills defaults,
    // rejects a malformed one). A bad template is skipped + logged (never blocks the module import —
    // the module is the primary artifact).
    const parsed = TableTemplateSchema.safeParse(bundled)
    if (!parsed.success) {
      log('error', `module import: bundled template "${bundled.name}" failed validation; skipping`, parsed.error.issues.slice(0, 3))
      continue
    }
    const template: TableTemplate = parsed.data
    const id = saveTableTemplate(profileId, template)
    installedTemplates.push({ name: template.name, id })
  }

  return { ok: true, module: envelope.module, installedTemplates }
}

/** Cancel a pending inspection (drop its stashed state). Idempotent — a no-op for an unknown token.
 *  The IPC layer calls this when the user dismisses the import sheet without confirming. */
export const cancelModuleImport = (token: string): void => {
  pending.delete(token)
}
