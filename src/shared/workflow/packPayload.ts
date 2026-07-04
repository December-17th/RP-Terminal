// Shared internals for the pack-carrying envelopes (`.rptagent` and `.rptrecipe`).
//
// Both `packEnvelope.ts` (one pack per file) and `recipeEnvelope.ts` (a set of embedded packs plus
// an activation preset — ADR 0008) carry the SAME pack payload shape and need the SAME untrusted
// revalidation. Rather than duplicate the schema + gate machinery across the two envelopes (and risk
// "accepted here, rejected there" drift — the exact failure the shared authority exists to prevent),
// the reusable pieces live here and both envelopes import them.
//
// Extracted verbatim from packEnvelope.ts (WP5.1 refactor): the ExposedSetting Zod mirror, the
// PackMeta/pack-payload schema (id/version identity + fragment), the BundledTemplate structural
// subset, the UTF-8 byte counter, and the pack-level unknown-key vocabulary. packEnvelope.ts now
// imports these instead of declaring them inline — its public API and serialized bytes are unchanged.
//
// Pure: imports only zod + the shared schemas; safe from main, renderer, preload, and tests.

import { z } from 'zod'
import { WorkflowDoc } from './types'
import { WorkflowDocSchema, parseWorkflowDoc } from './docSchema'
import type { ExposedSetting } from './packManifest'

// ── exposedSettings schema (mirrors packManifest.ExposedSetting) ─────────────────────────────────
//
// The manifest types are plain TS interfaces (packManifest.ts); an envelope needs a runtime Zod
// mirror so an untrusted file's manifest is validated, not just cast. These objects STRIP unknown
// keys (zod's default — the grilled decision: v0 does not preserve unknown keys); the parsers report
// stripped keys as WARNINGS separately (collectPackKeyWarnings), so the import UI still gets its
// "made with a newer version?" hint without the strictness that would REJECT the file. `label`
// accepts a plain string OR a locale map; `default` is unconstrained (per-setting type agreement is a
// materialize-time concern, not structural).
export const ExposedSettingSchema: z.ZodType<ExposedSetting> = z.object({
  id: z.string().min(1),
  label: z.union([z.string(), z.record(z.string(), z.string())]),
  type: z.enum(['number', 'string', 'boolean', 'enum']),
  default: z.unknown(),
  min: z.number().optional(),
  max: z.number().optional(),
  options: z.array(z.string()).optional(),
  target: z.object({ nodeId: z.string().min(1), path: z.string().min(1) })
})

// The pack-meta fields (packManifest.PackManifest minus the fragment, which lives inline as a full
// WorkflowDoc, plus the id/version identity from ADR 0008). Unknown pack keys strip + warn (see
// above). `fork` provenance is carried so an exported fork round-trips its lineage label.
export const PackMetaSchema = z.object({
  id: z.string().min(1),
  version: z.number(),
  name: z.string().min(1),
  description: z.string().optional(),
  creator: z.string().optional(),
  minRptVersion: z.string().optional(),
  exposedSettings: z.array(ExposedSettingSchema).optional(),
  fork: z.object({ base: z.string(), n: z.number() }).optional(),
  // The fragment is a full WorkflowDoc; `kind:'fragment'` is asserted post-parse (not baked into
  // the schema literal so the error message is a clear 'not-a-fragment', not a zod enum miss).
  fragment: WorkflowDocSchema
})

/** The pack payload as it appears inside either envelope — the `pack` object of `.rptagent` and each
 *  element of a recipe's `packs[]`. Identity is `id + version` (ADR 0008); `fragment` is a full
 *  `kind:'fragment'` WorkflowDoc revalidated on parse (never trusted from the file). */
export interface PackPayload {
  id: string
  version: number
  name: string
  description?: string
  creator?: string
  minRptVersion?: string
  exposedSettings?: ExposedSetting[]
  fork?: { base: string; n: number }
  /** A kind:'fragment' WorkflowDoc — one graph, many attachments (ADR 0009). */
  fragment: WorkflowDoc
}

// ── bundledTemplates: a STRUCTURAL SUBSET of the native TableTemplate ───────────────────────────
//
// A memory pack's table nodes read a TableTemplate by shape. The authoritative schema
// (`TableTemplateSchema`, src/main/types/tableTemplate.ts) is a rich Zod object living in MAIN, and
// `shared/*` cannot import main. So the envelope validates a STRUCTURAL SUBSET here — the fields that
// identify a template + let import re-materialize it — and treats the rest as opaque pass-through
// data (`.passthrough()`); main re-validates against the full TableTemplateSchema at install time.
const BundledTableDefSchema = z
  .object({
    uid: z.string(),
    sqlName: z.string(),
    ddl: z.string()
  })
  .passthrough()

export const BundledTemplateSchema = z
  .object({
    name: z.string(),
    sourceFormat: z.enum(['chatSheets-v2', 'native']).optional(),
    tables: z.array(BundledTableDefSchema)
  })
  .passthrough()

/** The structural subset of a native TableTemplate an envelope pins. The full shape (globalInjection,
 *  the rest of each TableDef) rides along via passthrough and is re-validated by main against the
 *  authoritative `TableTemplateSchema` at install time. Shared by `.rptagent` and `.rptrecipe`. */
export type BundledTemplate = z.infer<typeof BundledTemplateSchema>

/** Byte length of a UTF-8 string without pulling in Buffer (shared runs outside Node too). */
export function utf8Bytes(text: string): number {
  // TextEncoder is available in Node ≥11 and every browser; it counts real UTF-8 bytes.
  return new TextEncoder().encode(text).length
}

/** The pack-payload keys the strict schema keeps. An extra key on a raw pack object is reported as a
 *  warning (forward-compat hint), not a rejection. Shared so both envelopes warn identically. */
export const KNOWN_PACK_KEYS = new Set([
  'id',
  'version',
  'name',
  'description',
  'creator',
  'minRptVersion',
  'exposedSettings',
  'fork',
  'fragment'
])

/** Report unknown keys on ONE raw pack object as warnings, prefixed with a caller-supplied label so
 *  a recipe (many packs) can say WHICH pack (`packs[0]`). Returns human-readable strings. */
export function collectPackKeyWarnings(rawPack: unknown, label: string): string[] {
  const warnings: string[] = []
  if (rawPack && typeof rawPack === 'object' && !Array.isArray(rawPack)) {
    for (const key of Object.keys(rawPack as Record<string, unknown>))
      if (!KNOWN_PACK_KEYS.has(key)) warnings.push(`unknown ${label} key "${key}"`)
  }
  return warnings
}

/** The canonical key order for a serialized pack payload (byte-stable, diffable output). `fork` is
 *  appended after fragment as provenance — see the ordering note in packEnvelope.orderedPack. */
export const PACK_ORDER = [
  'id',
  'version',
  'name',
  'description',
  'creator',
  'minRptVersion',
  'exposedSettings',
  'fragment'
] as const

/** Revalidate one PARSED pack payload's fragment through the shared structural gate (never trust the
 *  file) and assert `kind:'fragment'`. Returns a code the envelope maps to its own error union.
 *  Mirrors packEnvelope's fragment gate so `.rptagent` and each embedded recipe pack check identically. */
export function revalidatePackFragment(
  pack: PackPayload
): { ok: true } | { ok: false; code: 'not-a-fragment' | 'invalid-fragment'; errors: string[] } {
  const fragmentCheck = parseWorkflowDoc(pack.fragment)
  if (!fragmentCheck.ok) return { ok: false, code: 'invalid-fragment', errors: [fragmentCheck.error] }
  if (fragmentCheck.doc.kind !== 'fragment')
    return {
      ok: false,
      code: 'not-a-fragment',
      errors: [`fragment.kind is "${fragmentCheck.doc.kind ?? 'turn'}", expected "fragment"`]
    }
  return { ok: true }
}
