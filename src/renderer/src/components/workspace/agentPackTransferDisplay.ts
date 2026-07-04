// Pure display-derivation for the agent-pack EXPORT wizard + IMPORT inspection sheet (agent-packs
// plan WP4.3). Everything here is side-effect-free and React-free so it is unit-testable directly
// (test/agentPackTransferDisplay.test.ts) under Node — the wizard + inspector components render these
// shapes, adding only the localized labels + the DOM.
//
// What lives here:
//   · error-code → copy key mapping (parse failures at import — the designed error sheet).
//   · blocker → copy-key mapping (each import blocker's honest explanation).
//   · export-preview view-model assembly (the Review step's teaching sections).
//   · inspection view-model assembly (identity, dedupe, capability rows, template outcomes,
//     warnings, blockers, whether Install is allowed).
//
// The localized COPY for each shape is in the components (routed through t()); this module produces
// only the structural decision + the data the label needs. Grounding: the IPC contracts in
// src/preload/index.d.ts (previewAgentPackExport / importAgentPackDialog / confirmAgentPackImport),
// the capability report in shared/workflow/capabilities.ts, WP4.2's service semantics in
// src/main/services/agentPackTransferService.ts.

import type { CapabilityId } from '../../../../shared/workflow/capabilities'
import { CAPABILITY_IDS, isWriteCapability } from '../../../../shared/workflow/capabilities'

// ── Shared IPC-mirrored shapes ─────────────────────────────────────────────────────────────────────
// Mirrored from the preload contract (index.d.ts) so this pure module is typed against the IPC surface
// without importing main. Kept minimal — only the fields the display consumes.

export interface CapabilityReportView {
  capabilities: CapabilityId[]
  unknownNodeTypes: string[]
  nodesByCapability: Partial<Record<CapabilityId, string[]>>
}

export interface ExportPreview {
  envelopeMeta: { name: string; version: number; creator?: string; sizeBytes: number }
  attachments: { entries: number; rejoins: number; triggers: number }
  capabilityReport: CapabilityReportView
  bundledTemplateNames: string[]
  noTemplatesBundled: boolean
  warnings: string[]
}

export type ImportBlocker =
  | { code: 'unknown-node-types'; nodeTypes: string[] }
  | { code: 'version-too-old'; minRptVersion: string; appVersion: string }
  // WP4.6: main NO LONGER emits version-conflict (a version difference installs alongside). The
  // variant is retained here so the existing inspector's recovery card (AgentPackImportInspector.tsx)
  // still type-checks — it is dead code now (blockers never contains it), left untouched this WP.
  | { code: 'version-conflict'; installedVersion: number }

export type ParseErrorCode =
  | 'too-large'
  | 'invalid-json'
  | 'unsupported-version'
  | 'invalid-envelope'
  | 'not-a-fragment'
  | 'invalid-fragment'

export interface ParseError {
  code: ParseErrorCode
  errors?: string[]
  foundVersion?: unknown
}

export interface InspectionReport {
  envelopeMeta?: {
    id: string
    name: string
    version: number
    creator?: string
    minRptVersion?: string
    fork?: { base: string; n: number }
  }
  capabilityReport?: CapabilityReportView
  bundledTemplatePlans: { name: string; outcome: 'will-install' | 'will-duplicate' }[]
  dedupe?: 'new' | 'new-version' | 'already-installed'
  blockers: ImportBlocker[]
  warnings: string[]
  parseError?: ParseError
  token?: string
}

// ── Capability rows (REUSED chip mapping — same visual language as WP3.1) ───────────────────────────
//
// A capability chip carries: the id (→ label key `agents.cap.<id>` + write-danger tint via
// isWriteCapability — the SAME authority the Installed cards use) and its per-capability node ids so
// the wizard/inspector can offer the "writes tables — 1 node" expandable. The node COUNT is the
// scannable teaching detail; the raw node ids are shown in the expand (useful to a creator reading
// their own pack, and honest for an importer). Deterministic order = CAPABILITY_IDS order.

/** One capability row: the chip id, whether it is a write (danger tint), and the node ids that confer
 *  it (empty for the structural caps injects-prompt / runs-headless, which have no conferring node —
 *  the view then renders "structure" rather than a node count). */
export interface CapabilityRow {
  id: CapabilityId
  write: boolean
  nodeIds: string[]
}

/** Assemble the capability rows for a report, in CAPABILITY_IDS order (stable chip row). The
 *  structural caps have no entry in nodesByCapability, so their nodeIds are []. */
export function capabilityRows(report: CapabilityReportView): CapabilityRow[] {
  return CAPABILITY_IDS.filter((id) => report.capabilities.includes(id)).map((id) => ({
    id,
    write: isWriteCapability(id),
    nodeIds: report.nodesByCapability[id] ?? []
  }))
}

// ── Export preview view-model (the Review step) ──────────────────────────────────────────────────────
//
// The Review step teaches "what a pack IS": identity + attachments + derived capabilities + the
// template note + warnings framed as "importers will see these". This shape flattens the preview into
// the render-ready pieces; the component owns the localized copy.

/** Which template note the Review step shows. `none` = the honest "binds at runtime" copy (v0 — the
 *  common case); `bundled` = a real list of bundled template names. */
export type TemplateNoteKind = 'none' | 'bundled'

export interface ExportReviewModel {
  name: string
  version: number
  creator?: string
  /** UTF-8 byte size of the file, for a "weighs ~N" line. */
  sizeBytes: number
  attachments: { entries: number; rejoins: number; triggers: number }
  /** True iff the pack declares no attachment at all (a degenerate pack — the view can note it). */
  noAttachments: boolean
  capabilities: CapabilityRow[]
  templateNote: TemplateNoteKind
  bundledTemplateNames: string[]
  warnings: string[]
}

/** Flatten an ExportPreview into the render-ready Review model. Pure. */
export function exportReviewModel(preview: ExportPreview): ExportReviewModel {
  const { entries, rejoins, triggers } = preview.attachments
  return {
    name: preview.envelopeMeta.name,
    version: preview.envelopeMeta.version,
    ...(preview.envelopeMeta.creator ? { creator: preview.envelopeMeta.creator } : {}),
    sizeBytes: preview.envelopeMeta.sizeBytes,
    attachments: preview.attachments,
    noAttachments: entries + rejoins + triggers === 0,
    capabilities: capabilityRows(preview.capabilityReport),
    templateNote: preview.noTemplatesBundled ? 'none' : 'bundled',
    bundledTemplateNames: preview.bundledTemplateNames,
    warnings: preview.warnings
  }
}

/** A human-ish file-size string ("1.2 KB" / "840 B"). Kept pure (no locale number formatting — the
 *  app has no number-formatter dependency and the value is informational). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
}

// ── The structured export error (from previewAgentPackExport / exportAgentPackDialog) ────────────────

export type ExportErrorCode = 'builtin-not-exportable' | 'not-installed'

/** The i18n key for an export error's headline copy. */
export function exportErrorKey(code: ExportErrorCode): string {
  return `agents.export.error.${code}`
}

// ── Import: parse-error → copy key (the designed error sheet) ────────────────────────────────────────
//
// A parse failure means the file never became an envelope — there is NO token, nothing to confirm.
// Each structured code maps to honest, localized copy. The component renders a title + body per code;
// `unsupported-version` and the schema/fragment codes carry extra detail (foundVersion / field errors)
// the component appends. This mapping is the ONE place the code→copy relationship lives (tested).

/** The i18n key for a parse-error's TITLE. */
export function parseErrorTitleKey(code: ParseErrorCode): string {
  return `agents.import.parseError.${code}.title`
}

/** The i18n key for a parse-error's BODY (plain-language "what went wrong + what to do"). */
export function parseErrorBodyKey(code: ParseErrorCode): string {
  return `agents.import.parseError.${code}.body`
}

/** Whether this parse-error code carries a detail list the sheet should render (schema/fragment field
 *  errors, present on invalid-envelope / not-a-fragment / invalid-fragment). too-large / invalid-json /
 *  unsupported-version carry no field list. */
export function parseErrorHasDetails(err: ParseError): boolean {
  return (err.errors?.length ?? 0) > 0
}

// ── Import: blocker → copy key + explanation vars (the reason cards) ──────────────────────────────────
//
// Each blocker is rendered as a clear reason card that EXPLAINS why Install is refused. The mapping
// gives a title key + a body key + the interpolation vars the body needs. unknown-node-types lists the
// types inside the card (NOT as capability chips — they aren't capabilities, they're unrecognized
// nodes). WP4.6: the version-conflict blocker is GONE (a version difference installs alongside), so no
// blocker is recoverable-via-uninstall anymore; `recoverable` stays on the shape (always false today)
// so the component's reason-card code doesn't churn.

export interface BlockerCopy {
  /** i18n key for the reason-card title. */
  titleKey: string
  /** i18n key for the reason-card body. */
  bodyKey: string
  /** Interpolation vars for the body key (empty when none). */
  vars: Record<string, string | number>
  /** The node types to LIST inside the card (unknown-node-types only; [] otherwise). */
  nodeTypes: string[]
  /** Whether the blocker offers an uninstall-then-import recovery. Always false since WP4.6 removed the
   *  one recoverable blocker (version-conflict); kept so the component's card code is unchanged. */
  recoverable: boolean
}

/** Map an import blocker to its render-ready copy keys + vars. Pure. */
export function blockerCopy(blocker: ImportBlocker): BlockerCopy {
  switch (blocker.code) {
    case 'unknown-node-types':
      return {
        titleKey: 'agents.import.blocker.unknownNodeTypes.title',
        bodyKey: 'agents.import.blocker.unknownNodeTypes.body',
        vars: { count: blocker.nodeTypes.length },
        nodeTypes: blocker.nodeTypes,
        recoverable: false
      }
    case 'version-too-old':
      return {
        titleKey: 'agents.import.blocker.versionTooOld.title',
        bodyKey: 'agents.import.blocker.versionTooOld.body',
        vars: { required: blocker.minRptVersion, app: blocker.appVersion },
        nodeTypes: [],
        recoverable: false
      }
    // WP4.6: dead branch — main no longer emits version-conflict. Retained so the mapping stays total
    // over the (backward-compatible) union and the inspector's recovery card keeps compiling.
    case 'version-conflict':
      return {
        titleKey: 'agents.import.blocker.versionConflict.title',
        bodyKey: 'agents.import.blocker.versionConflict.body',
        vars: { installed: blocker.installedVersion },
        nodeTypes: [],
        recoverable: true
      }
  }
}

// ── Import: the full inspection view-model ───────────────────────────────────────────────────────────
//
// The inspection sheet distilled to render-ready pieces. `kind` splits the two top-level shapes: a
// parse failure (designed error sheet — no token, nothing installs) vs a parsed report (the trust
// screen). For a parsed report: identity, dedupe chip, capability rows, template outcomes, warnings,
// blocker reason-cards, and `canInstall` (Install enabled iff no blockers). The version-conflict
// blocker's installed version is surfaced (`conflictInstalledVersion`) so the component can wire the
// uninstall-then-import recovery when the uninstall capability is available.

export type DedupeState = 'new' | 'new-version' | 'already-installed'

export interface TemplatePlanView {
  name: string
  outcome: 'will-install' | 'will-duplicate'
}

export interface InspectionModel {
  kind: 'parse-error' | 'report'
  /** parse-error only. */
  parseError?: ParseError
  /** report only — everything below is present when kind === 'report'. */
  identity?: {
    id: string
    name: string
    version: number
    creator?: string
    minRptVersion?: string
    fork?: { base: string; n: number }
  }
  dedupe?: DedupeState
  capabilities: CapabilityRow[]
  templatePlans: TemplatePlanView[]
  warnings: string[]
  blockers: ImportBlocker[]
  /** True iff Install may proceed (no blockers AND the file parsed with a token). */
  canInstall: boolean
  /** WP4.6: always undefined now (main no longer emits version-conflict). Kept so the inspector's
   *  recovery card compiles unchanged. */
  conflictInstalledVersion?: number
  /** The phase-two token, present iff the file parsed. Absent on a parse failure. */
  token?: string
}

/** Assemble the inspection view-model from the raw report. Pure — the ONE place the report's shape is
 *  interpreted for rendering. A parse failure short-circuits to the error sheet (no token, no install).
 *  Otherwise Install is allowed iff there are no blockers and a token is present. */
export function inspectionModel(report: InspectionReport): InspectionModel {
  if (report.parseError) {
    return {
      kind: 'parse-error',
      parseError: report.parseError,
      capabilities: [],
      templatePlans: [],
      warnings: [],
      blockers: [],
      canInstall: false
    }
  }

  // WP4.6: main no longer emits version-conflict, so this find is always undefined now; kept so the
  // inspector's (dead) recovery card still receives its prop shape and compiles unchanged.
  const conflict = report.blockers.find(
    (b): b is Extract<ImportBlocker, { code: 'version-conflict' }> => b.code === 'version-conflict'
  )

  return {
    kind: 'report',
    ...(report.envelopeMeta ? { identity: report.envelopeMeta } : {}),
    ...(report.dedupe ? { dedupe: report.dedupe } : {}),
    capabilities: report.capabilityReport ? capabilityRows(report.capabilityReport) : [],
    templatePlans: report.bundledTemplatePlans,
    warnings: report.warnings,
    blockers: report.blockers,
    // Install proceeds only with a token (parsed) and no blockers. WP4.6: a 'new-version' dedupe
    // installs alongside (no blocker), so it is installable — the same as 'new'.
    canInstall: !!report.token && report.blockers.length === 0,
    ...(conflict ? { conflictInstalledVersion: conflict.installedVersion } : {}),
    ...(report.token ? { token: report.token } : {})
  }
}

/** The i18n key for a bundled-template outcome ("will install" / "will add a copy"). */
export function templateOutcomeKey(outcome: 'will-install' | 'will-duplicate'): string {
  return `agents.import.templateOutcome.${outcome}`
}

/** The i18n key for a dedupe chip ("new" / "already installed"). */
export function dedupeChipKey(dedupe: DedupeState): string {
  return `agents.import.dedupe.${dedupe}`
}
