// Pure display-derivation for the RECIPE export wizard + import inspection sheet (agent-packs plan
// WP5.3 — "share this world's setup"). Side-effect-free + React-free so it is unit-testable directly
// (test/recipeTransferDisplay.test.ts) under Node — the wizard + inspector components render these
// shapes, adding only the localized labels + the DOM.
//
// A recipe is a whole world SETUP: several agent packs (with pinned versions + gate state), an
// optional custom narrator, any bundled memory templates, and the activation that composes them. This
// module is the grown-up sibling of ./agentPackTransferDisplay.ts (one pack) — same visual language,
// but the surfaces here list a BUNDLE and the import confirm carries a world PICKER.
//
// What lives here:
//   · export-preview view-model assembly (the wizard Review step: pack list, narrator line, counts).
//   · a sensible default recipe name from the world name (the form step's prefill).
//   · import-inspection view-model assembly (identity, per-pack sub-cards with dedupe + condensed
//     capabilities + per-pack blocker flags, the narrator line, template plans, the recipe-level
//     blocked banner naming the offending packs, whether Install is allowed).
//   · parse-error → copy-key mapping (recipe-specific codes on top of the pack ones).
//   · world-picker state derivation (the list of worlds, current preselected, valid selection).
//   · partial-result copy mapping (the "these landed, this failed" panel).
//
// The localized COPY for each shape is in the components (routed through t()); this module produces
// only the structural decision + the data the label needs. Grounding: the IPC contract in
// src/preload/index.d.ts (previewRecipeExport / importRecipeDialog / confirmRecipeImport), the
// capability set in shared/workflow/capabilities.ts, WP5.2's service semantics in
// src/main/services/recipeTransferService.ts.

import type { CapabilityId } from '../../../../shared/workflow/capabilities'
import { CAPABILITY_IDS, isWriteCapability } from '../../../../shared/workflow/capabilities'

// ── Shared IPC-mirrored shapes ─────────────────────────────────────────────────────────────────────
// Mirrored from the preload contract (index.d.ts) so this pure module is typed against the IPC surface
// without importing main. Kept minimal — only the fields the display consumes.

export interface RecipeCapabilityReport {
  capabilities: CapabilityId[]
  unknownNodeTypes: string[]
  nodesByCapability: Partial<Record<CapabilityId, string[]>>
}

export type RecipeNarratorKind = 'builtin' | 'embedded'

// ── Export preview ───────────────────────────────────────────────────────────────────────────────

export interface RecipeExportPreview {
  recipeMeta: {
    id: string
    name: string
    description?: string
    creator?: string
    sizeBytes: number
  }
  packs: { id: string; version: number; name: string; enabled: boolean }[]
  narratorKind: RecipeNarratorKind
  bundledTemplateNames: string[]
  noTemplatesBundled: boolean
  warnings: string[]
}

/** One pack row in the export Review step: the display name, its pinned version, and whether the
 *  recipe carries it ENABLED (the gate state that will be reproduced on import). */
export interface RecipeExportPackRow {
  id: string
  name: string
  version: number
  enabled: boolean
}

/** The narrator line's kind — which sentence the view shows. `builtin` = "uses your default narrator";
 *  `custom` = "includes your custom narrator". (Kept distinct from the raw IPC 'embedded' so the copy
 *  mapping reads in the UI's own vocabulary.) */
export type RecipeNarratorLine = 'builtin' | 'custom'

export interface RecipeExportReviewModel {
  name: string
  description?: string
  creator?: string
  /** UTF-8 byte size estimate of the file, for a "weighs ~N" line. */
  sizeBytes: number
  packs: RecipeExportPackRow[]
  /** How many of the packs are carried enabled (the gate-state summary). */
  enabledCount: number
  /** Total packs in the bundle. */
  packCount: number
  narrator: RecipeNarratorLine
  templateNote: 'none' | 'bundled'
  bundledTemplateNames: string[]
  warnings: string[]
}

/** Flatten a RecipeExportPreview into the render-ready Review model. Pure. */
export function recipeExportReviewModel(preview: RecipeExportPreview): RecipeExportReviewModel {
  const packs: RecipeExportPackRow[] = preview.packs.map((p) => ({
    id: p.id,
    name: p.name,
    version: p.version,
    enabled: p.enabled
  }))
  return {
    name: preview.recipeMeta.name,
    ...(preview.recipeMeta.description ? { description: preview.recipeMeta.description } : {}),
    ...(preview.recipeMeta.creator ? { creator: preview.recipeMeta.creator } : {}),
    sizeBytes: preview.recipeMeta.sizeBytes,
    packs,
    enabledCount: packs.filter((p) => p.enabled).length,
    packCount: packs.length,
    narrator: preview.narratorKind === 'embedded' ? 'custom' : 'builtin',
    templateNote: preview.noTemplatesBundled ? 'none' : 'bundled',
    bundledTemplateNames: preview.bundledTemplateNames,
    warnings: preview.warnings
  }
}

/** The i18n key for the narrator line in the export Review + import inspection. */
export function narratorLineKey(line: RecipeNarratorLine): string {
  return `recipe.narrator.${line}`
}

// ── Export form (the small name/description/creator step) ────────────────────────────────────────

export interface RecipeExportFormValues {
  name: string
  description: string
  creator: string
}

/** The prefilled form values for the export step, derived from the world name. Name is required, so
 *  it seeds sensibly from the world (falling back to a generic label when the world is unnamed); the
 *  optional fields start empty. Pure — the component owns the fallback label via t(). */
export function initialRecipeForm(worldName: string, fallbackName: string): RecipeExportFormValues {
  const trimmed = worldName.trim()
  return {
    name: trimmed ? `${trimmed}` : fallbackName,
    description: '',
    creator: ''
  }
}

/** Whether the export form may be submitted (name required, non-blank). Pure. */
export function canSubmitRecipeForm(values: RecipeExportFormValues): boolean {
  return values.name.trim().length > 0
}

/** Normalize the form into the export opts the IPC expects (trims; drops empty optionals). Pure. */
export function recipeExportOpts(values: RecipeExportFormValues): {
  name: string
  description?: string
  creator?: string
} {
  const name = values.name.trim()
  const description = values.description.trim()
  const creator = values.creator.trim()
  return {
    name,
    ...(description ? { description } : {}),
    ...(creator ? { creator } : {})
  }
}

// ── The structured export error ─────────────────────────────────────────────────────────────────

export type RecipeExportErrorCode = 'no-activated-packs'

/** The i18n key for a recipe export error's headline copy. */
export function recipeExportErrorKey(code: RecipeExportErrorCode): string {
  return `recipe.export.error.${code}`
}

// ── Import: the raw inspection report (mirrored from importRecipeDialog) ──────────────────────────

export type RecipeDedupe = 'new' | 'new-version' | 'already-installed'

export interface RecipeImportPack {
  id: string
  version: number
  name: string
  dedupe: RecipeDedupe
  capabilityReport: RecipeCapabilityReport
  unknownNodeTypes: string[]
  warnings: string[]
}

export interface RecipeImportNarrator {
  kind: RecipeNarratorKind
  nodeCount?: number
  unknownNodeTypes: string[]
  warnings: string[]
}

export type RecipeParseErrorCode =
  | 'too-large'
  | 'invalid-json'
  | 'unsupported-version'
  | 'invalid-envelope'
  | 'not-a-fragment'
  | 'invalid-fragment'
  | 'invalid-narrator'
  | 'duplicate-pack'
  | 'activation-refers-unknown-pack'
  | 'activation-duplicate-pack'

export interface RecipeParseError {
  code: RecipeParseErrorCode
  errors?: string[]
  foundVersion?: unknown
}

export interface RecipeInspectionReport {
  recipeMeta?: { id: string; name: string; description?: string; creator?: string }
  packs: RecipeImportPack[]
  narrator?: RecipeImportNarrator
  templatePlans: { name: string; outcome: 'will-install' | 'will-duplicate' }[]
  blocked: boolean
  warnings: string[]
  parseError?: RecipeParseError
  token?: string
}

// ── Import: capability rows (condensed for the compact pack sub-cards) ────────────────────────────
//
// A recipe lists SEVERAL packs, so each pack's capabilities are shown as CONDENSED chips (no
// per-capability node expand — that level of detail belongs to the single-pack inspector). We keep the
// write-danger split (the one thing a user weighs) and the CAPABILITY_IDS order (stable chip rows).

export interface CondensedCapability {
  id: CapabilityId
  write: boolean
}

/** The condensed capability chips for a pack, in CAPABILITY_IDS order. Pure. */
export function condensedCapabilities(report: RecipeCapabilityReport): CondensedCapability[] {
  return CAPABILITY_IDS.filter((id) => report.capabilities.includes(id)).map((id) => ({
    id,
    write: isWriteCapability(id)
  }))
}

// ── Import: the full inspection view-model ────────────────────────────────────────────────────────
//
// The recipe inspection sheet distilled to render-ready pieces. `kind` splits the two top-level
// shapes: a parse failure (designed error sheet — no token, nothing installs) vs a parsed report (the
// trust screen). For a parsed report: identity, per-pack sub-cards, the narrator line, template
// outcomes, warnings, the recipe-level blocked flag + the names of the OFFENDING packs (any member
// with unknown node types), and `canInstall`.

export interface RecipePackCard {
  id: string
  name: string
  version: number
  dedupe: RecipeDedupe
  capabilities: CondensedCapability[]
  /** The unknown node types this pack carries — non-empty ⇒ this pack is a blocker (a badge on the
   *  sub-card lists them). */
  unknownNodeTypes: string[]
  /** Convenience flag: this pack blocks the whole recipe. */
  blocks: boolean
  warnings: string[]
}

export interface RecipeInspectionModel {
  kind: 'parse-error' | 'report'
  /** parse-error only. */
  parseError?: RecipeParseError
  /** report only — everything below is present when kind === 'report'. */
  identity?: { id: string; name: string; description?: string; creator?: string }
  packs: RecipePackCard[]
  narrator?: { line: RecipeNarratorLine; nodeCount?: number; blocks: boolean }
  templatePlans: { name: string; outcome: 'will-install' | 'will-duplicate' }[]
  warnings: string[]
  /** True iff any recipe member is broken (unknown node types anywhere) — the recipe-level banner. */
  blocked: boolean
  /** The display names of the packs that block the recipe — the banner names the offenders. */
  offenderNames: string[]
  /** True iff Install may proceed (parsed with a token AND not blocked). */
  canInstall: boolean
  /** The phase-two token, present iff the file parsed. Absent on a parse failure. */
  token?: string
}

/** Assemble the recipe inspection view-model from the raw report. Pure — the ONE place the report's
 *  shape is interpreted for rendering. A parse failure short-circuits to the error sheet (no token, no
 *  install). Otherwise Install is allowed iff there is a token and the recipe is not blocked. One
 *  broken member blocks the WHOLE recipe (WP5.2 friction: per-pack reports, recipe-level block). */
export function recipeInspectionModel(report: RecipeInspectionReport): RecipeInspectionModel {
  if (report.parseError) {
    return {
      kind: 'parse-error',
      parseError: report.parseError,
      packs: [],
      templatePlans: [],
      warnings: [],
      blocked: false,
      offenderNames: [],
      canInstall: false
    }
  }

  const packs: RecipePackCard[] = report.packs.map((p) => {
    const unknown = p.unknownNodeTypes ?? []
    return {
      id: p.id,
      name: p.name,
      version: p.version,
      dedupe: p.dedupe,
      capabilities: condensedCapabilities(p.capabilityReport),
      unknownNodeTypes: unknown,
      blocks: unknown.length > 0,
      warnings: p.warnings ?? []
    }
  })

  const narratorBlocks = (report.narrator?.unknownNodeTypes.length ?? 0) > 0
  const offenderNames = packs.filter((p) => p.blocks).map((p) => p.name)

  return {
    kind: 'report',
    ...(report.recipeMeta ? { identity: report.recipeMeta } : {}),
    packs,
    ...(report.narrator
      ? {
          narrator: {
            line: report.narrator.kind === 'embedded' ? 'custom' : 'builtin',
            ...(report.narrator.nodeCount !== undefined
              ? { nodeCount: report.narrator.nodeCount }
              : {}),
            blocks: narratorBlocks
          }
        }
      : {}),
    templatePlans: report.templatePlans,
    warnings: report.warnings,
    blocked: report.blocked,
    offenderNames,
    canInstall: !!report.token && !report.blocked,
    ...(report.token ? { token: report.token } : {})
  }
}

/** The i18n key for a recipe dedupe chip (reuses the pack dedupe wording — same three states). */
export function recipeDedupeChipKey(dedupe: RecipeDedupe): string {
  return `recipe.import.dedupe.${dedupe}`
}

/** The i18n key for a bundled-template outcome (reuses the pack wording). */
export function recipeTemplateOutcomeKey(outcome: 'will-install' | 'will-duplicate'): string {
  return `recipe.import.templateOutcome.${outcome}`
}

// ── Import: parse-error → copy key ────────────────────────────────────────────────────────────────
//
// A parse failure means the file never became a valid recipe — there is NO token, nothing to confirm.
// The recipe format adds four codes on top of the pack ones (invalid-narrator / duplicate-pack /
// activation-refers-unknown-pack / activation-duplicate-pack). This mapping is the ONE place the
// code→copy relationship lives (tested).

export function recipeParseErrorTitleKey(code: RecipeParseErrorCode): string {
  return `recipe.import.parseError.${code}.title`
}

export function recipeParseErrorBodyKey(code: RecipeParseErrorCode): string {
  return `recipe.import.parseError.${code}.body`
}

/** Whether this parse-error code carries a detail list the sheet should render (schema/fragment field
 *  errors). Present on the schema/structure codes; absent on too-large / invalid-json / unsupported. */
export function recipeParseErrorHasDetails(err: RecipeParseError): boolean {
  return (err.errors?.length ?? 0) > 0
}

// ── Import: world picker state ────────────────────────────────────────────────────────────────────
//
// WP5.2 friction (binding): the world picker happens at CONFIRM time — the token does NOT store a
// world. The picker lists worlds (from the renderer's world/character data), marks the current one,
// and preselects it if any. Confirm is disabled until a world is chosen.

export interface WorldOption {
  id: string
  name: string
  /** True for the currently-open world (the one the recipe was, if any, exported from context). */
  current: boolean
}

export interface WorldPickerState {
  options: WorldOption[]
  /** The selected world id, or null when nothing is selected yet. */
  selectedId: string | null
  /** Whether a target is chosen (Install may proceed on the picker's part). */
  hasSelection: boolean
}

/** Build the initial world-picker state: the option list (current world marked) + the current world
 *  preselected when present. `worlds` is the renderer's {id,name} list; `currentWorldId` is the open
 *  world (the active chat's character_id) or null. Pure. */
export function initialWorldPicker(
  worlds: { id: string; name: string }[],
  currentWorldId: string | null
): WorldPickerState {
  const options: WorldOption[] = worlds.map((w) => ({
    id: w.id,
    name: w.name,
    current: w.id === currentWorldId
  }))
  // Preselect the current world when it is a real option; else nothing (the user must choose).
  const selectedId =
    currentWorldId && options.some((o) => o.id === currentWorldId) ? currentWorldId : null
  return { options, selectedId, hasSelection: selectedId !== null }
}

/** Apply a selection to the picker state (validates the id is a known option). Pure. */
export function selectWorld(state: WorldPickerState, id: string): WorldPickerState {
  if (!state.options.some((o) => o.id === id)) return state
  return { ...state, selectedId: id, hasSelection: true }
}

// ── Import: the applied / partial result copy ─────────────────────────────────────────────────────
//
// confirmRecipeImport resolves to one of: ok (everything landed), blocked (a re-checked block), or
// PARTIAL — some steps landed and one failed midway. The partial shape needs HONEST "these landed,
// this failed" copy the pack flow never needed. This maps the raw applied/failedStep into a
// render-ready summary: the plain-language "what landed" lines + which step failed. And it states that
// re-importing is safe (the service dedupes → idempotent).

export interface RecipeApplied {
  templates: { name: string; id: string }[]
  packs: { id: string; version: number; installed: boolean }[]
  narrator?: { kind: RecipeNarratorKind; workflowId: string }
  activation: { packId: string; version: number; enabled: boolean }[]
}

/** One "what landed" line in the partial-result panel. `key` is a copy key; `vars` its interpolation.
 *  Only the steps that actually did something are emitted (empty steps are dropped — the panel lists
 *  concrete outcomes, not a checklist of nothing). */
export interface AppliedLine {
  key: string
  vars: Record<string, string | number>
}

/** The steps of a recipe install, in apply order — the SAME order the service applies them, so
 *  `failedStep` (a raw string from the service) can be classified against this list. */
export const RECIPE_STEPS = ['templates', 'packs', 'narrator', 'activation'] as const
export type RecipeStep = (typeof RECIPE_STEPS)[number]

/** Render-ready lines describing what an `applied` shape landed. Pure. Emits one line per non-empty
 *  step, in apply order. Used by BOTH the success path (everything) and the partial panel (the part
 *  that landed before the failure). */
export function appliedLines(applied: RecipeApplied): AppliedLine[] {
  const lines: AppliedLine[] = []
  if (applied.templates.length > 0) {
    lines.push({ key: 'recipe.applied.templates', vars: { n: applied.templates.length } })
  }
  const installed = applied.packs.filter((p) => p.installed).length
  if (applied.packs.length > 0) {
    // "N packs installed (M new)" — the pinned versions land; some may already have been present.
    lines.push({
      key: 'recipe.applied.packs',
      vars: { n: applied.packs.length, installed }
    })
  }
  if (applied.narrator) {
    lines.push({ key: 'recipe.applied.narrator', vars: {} })
  }
  if (applied.activation.length > 0) {
    const enabled = applied.activation.filter((a) => a.enabled).length
    lines.push({ key: 'recipe.applied.activation', vars: { n: applied.activation.length, enabled } })
  }
  return lines
}

export interface PartialResultModel {
  /** The lines describing what landed before the failure (plain language). */
  applied: AppliedLine[]
  /** The i18n key naming the step that failed ("Setting the narrator failed", etc.). */
  failedStepKey: string
  /** The raw error message from the service (shown verbatim, muted). */
  error: string
}

/** Classify a raw `failedStep` string into a known step (for a specific copy line) or 'unknown'.
 *  The service emits the step name; we match it against RECIPE_STEPS (case-insensitive, substring —
 *  the service may qualify it, e.g. "narrator.install"). Pure. */
export function classifyFailedStep(failedStep: string): RecipeStep | 'unknown' {
  const s = failedStep.toLowerCase()
  for (const step of RECIPE_STEPS) {
    if (s.includes(step)) return step
  }
  return 'unknown'
}

/** The i18n key for a failed step's "this failed" line. */
export function failedStepKey(failedStep: string): string {
  const step = classifyFailedStep(failedStep)
  return `recipe.partial.failed.${step}`
}

/** Assemble the partial-result panel model from a confirm 'partial' result. Pure. */
export function partialResultModel(
  applied: RecipeApplied,
  failedStep: string,
  error: string
): PartialResultModel {
  return {
    applied: appliedLines(applied),
    failedStepKey: failedStepKey(failedStep),
    error
  }
}
