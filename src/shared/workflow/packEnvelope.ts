// The `.rptagent` file format v0 — the standalone, shareable envelope for ONE agent pack.
//
// A pack file is a SINGLE UTF-8 JSON document with a top-level `formatVersion` (rev-3 spec §Envelope;
// zip is a deferred additive envelope, unneeded until binary assets exist). It must survive being
// shared through a chat app and re-imported on another machine with no registry to resolve against —
// so it BUNDLES what it needs (ADR 0008: bundle for transport): the fragment inline, the manifest
// inline, and any table templates its memory nodes read (`bundledTemplates`). Prompts stay inline as
// structured strings inside node configs / exposedSettings targets — there is no separate
// prompt-resource system yet (rev-3 spec: "Prompts stay inline as structured strings").
//
// This module is the SHARED authority for both directions (rev-3 spec §Export wizard: "Export-time
// and import-time validation are one `shared/` implementation, so 'exports fine here, rejected there'
// cannot happen"): Studio's export preview serializes with it, main's import verifies with it. The
// fragment is NEVER trusted from the file — it is revalidated through the existing structural gate
// (docSchema.parseWorkflowDoc) plus a kind:'fragment' assertion, exactly as if freshly parsed.
//
// Identity is `id + version` (ADR 0008 dedupe; ADR 0007/master-plan version-coexistence): two packs
// with the same id but different versions are DISTINCT library entries, so the envelope carries both
// and never collapses them. See packManifest.ts for the version number-vs-string note.
//
// Pure: imports only zod + the shared schemas; safe from main, renderer, preload, and tests.

import { z } from 'zod'
import { WorkflowDoc } from './types'
import { WorkflowDocSchema, parseWorkflowDoc } from './docSchema'
import type { PackManifest, ExposedSetting } from './packManifest'

/** The one format version this module reads/writes. An envelope with any other `formatVersion` is
 *  reported as `unsupported-version` (carrying the value found) so import UI can say "made with a
 *  newer/older RPT?" rather than drowning the user in field errors. Bump deliberately when the
 *  envelope shape changes incompatibly. */
export const PACK_ENVELOPE_FORMAT_VERSION = 1 as const

/** Generous size cap for a pack file (structured error past it). Fragments + bundled templates are
 *  small JSON; 8 MiB is far above any realistic v0 pack yet cheaply rejects a hostile/garbage blob
 *  before zod walks it. Measured on the UTF-8 byte length of the input text. */
export const MAX_PACK_ENVELOPE_BYTES = 8 * 1024 * 1024

// ── exposedSettings schema (mirrors packManifest.ExposedSetting) ─────────────────────────────────
//
// The manifest types are plain TS interfaces (packManifest.ts); the envelope needs a runtime Zod
// mirror so an untrusted file's manifest is validated, not just cast. These objects STRIP unknown
// keys (zod's default — the grilled decision: v0 does not preserve unknown keys); the parser reports
// stripped top-level/pack keys as WARNINGS separately (collectUnknownKeyWarnings), so the import UI
// still gets its "made with a newer version?" hint without the strictness that would REJECT the file.
// `label` accepts a plain string OR a locale map; `default` is unconstrained (per-setting type
// agreement is a materialize-time concern, not structural).
const ExposedSettingSchema: z.ZodType<ExposedSetting> = z.object({
  id: z.string().min(1),
  label: z.union([z.string(), z.record(z.string(), z.string())]),
  type: z.enum(['number', 'string', 'boolean', 'enum']),
  default: z.unknown(),
  min: z.number().optional(),
  max: z.number().optional(),
  options: z.array(z.string()).optional(),
  target: z.object({ nodeId: z.string().min(1), path: z.string().min(1) })
})

// The pack-meta fields (packManifest.PackManifest minus the fragment, which lives one level up as a
// full WorkflowDoc, plus the id/version identity from ADR 0008). Unknown pack keys strip + warn (see
// above). `fork` provenance is carried so an exported fork round-trips its lineage label.
const PackMetaSchema = z.object({
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

// ── bundledTemplates: a STRUCTURAL SUBSET of the native TableTemplate ───────────────────────────
//
// A memory pack's table nodes read a TableTemplate by shape. The authoritative schema
// (`TableTemplateSchema`, src/main/types/tableTemplate.ts) is a rich Zod object living in MAIN, and
// `shared/*` cannot import main. It is pure zod (no main deps) so it COULD move, but that is a
// main-side behavioral surface (heavily imported, disk-serialized via `saveTableTemplate`) out of
// this WP's scope. So the envelope validates a STRUCTURAL SUBSET here — the fields that identify a
// template + let import re-materialize it — and treats the rest as opaque pass-through data.
//
// Grounding: `saveTableTemplate` (tableTemplateService.ts:59-64) serializes exactly
// `TableTemplateSchema.parse(template)` to disk — the NATIVE shape (`{ name, sourceFormat,
// globalInjection?, tables: TableDef[] }`), NOT the chatSheets export shape. `bundledTemplates`
// mirrors THAT native shape. We pin the load-bearing top-level fields (name, tables[] with the
// per-table identity + DDL) and `.passthrough()` the deep template internals so a template authored
// against a newer TableDef still round-trips losslessly; main re-validates against the full
// TableTemplateSchema when it actually installs the template.
const BundledTableDefSchema = z
  .object({
    uid: z.string(),
    sqlName: z.string(),
    ddl: z.string()
  })
  .passthrough()

const BundledTemplateSchema = z
  .object({
    name: z.string(),
    sourceFormat: z.enum(['chatSheets-v2', 'native']).optional(),
    tables: z.array(BundledTableDefSchema)
  })
  .passthrough()

/** The structural subset of a native TableTemplate the envelope pins. The full shape (globalInjection,
 *  the rest of each TableDef) rides along via passthrough and is re-validated by main against the
 *  authoritative `TableTemplateSchema` at install time. */
export type BundledTemplate = z.infer<typeof BundledTemplateSchema>

// ── The envelope ────────────────────────────────────────────────────────────────────────────────

// Top-level strips unknown keys too (warnings come from collectUnknownKeyWarnings, not strictness).
const PackEnvelopeSchema = z.object({
  formatVersion: z.literal(PACK_ENVELOPE_FORMAT_VERSION),
  kind: z.literal('rptagent'),
  pack: PackMetaSchema,
  bundledTemplates: z.array(BundledTemplateSchema).optional()
})

/** The `.rptagent` v0 document. `pack.fragment` is a full `kind:'fragment'` WorkflowDoc; identity is
 *  `pack.id + pack.version` (ADR 0008). `bundledTemplates` carries native table templates so memory
 *  packs work out of the box on a machine that has never seen them (ADR 0008 bundle-for-transport). */
export interface PackEnvelope {
  formatVersion: typeof PACK_ENVELOPE_FORMAT_VERSION
  kind: 'rptagent'
  pack: {
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
  bundledTemplates?: BundledTemplate[]
}

/** The inputs `serializePackEnvelope` needs: the pack identity + manifest + fragment, and any
 *  bundled templates. Mirrors what `agentPackStore.AgentPackRecord` holds (id, version, manifest,
 *  fragment) so main can build an envelope straight from a stored record. */
export interface SerializePackEnvelopeInput {
  id: string
  version: number
  manifest: PackManifest
  fragment: WorkflowDoc
  bundledTemplates?: BundledTemplate[]
  /** Optional forward-looking meta the manifest doesn't carry (spec §Core Object). */
  minRptVersion?: string
}

// A canonical key order for the top-level + pack objects, so serialize output is byte-stable and
// diffable regardless of the input object's key insertion order (the grilled "diffable" decision).
const TOP_LEVEL_ORDER = ['formatVersion', 'kind', 'pack', 'bundledTemplates'] as const
const PACK_ORDER = [
  'id',
  'version',
  'name',
  'description',
  'creator',
  'minRptVersion',
  'exposedSettings',
  'fragment'
] as const

/** Build the ordered pack-meta object from an input, dropping undefined optionals so the serialized
 *  form is minimal + stable. `fork` is appended only when present (it rides after fragment as
 *  provenance, not part of the stable identity block). */
function orderedPack(input: SerializePackEnvelopeInput): Record<string, unknown> {
  const { manifest } = input
  const src: Record<string, unknown> = {
    id: input.id,
    version: input.version,
    name: manifest.name,
    description: manifest.description,
    creator: manifest.creator,
    minRptVersion: input.minRptVersion,
    exposedSettings: manifest.exposedSettings,
    fragment: input.fragment
  }
  const out: Record<string, unknown> = {}
  for (const key of PACK_ORDER) if (src[key] !== undefined) out[key] = src[key]
  if (manifest.fork !== undefined) out.fork = manifest.fork
  return out
}

/** Serialize a pack to the `.rptagent` v0 text: a single UTF-8 JSON document, 2-space pretty-printed
 *  with a STABLE top-level + pack key order (byte-identical for equal inputs — the grilled diffable
 *  decision). Optional manifest/meta fields absent from the input are omitted, not written as null.
 *  Does NOT itself validate the fragment (the caller — Studio's export path — runs the shared
 *  derivation + validation first); this is the pure text-shaping step. */
export function serializePackEnvelope(input: SerializePackEnvelopeInput): string {
  const doc: Record<string, unknown> = {
    formatVersion: PACK_ENVELOPE_FORMAT_VERSION,
    kind: 'rptagent',
    pack: orderedPack(input)
  }
  if (input.bundledTemplates !== undefined && input.bundledTemplates.length > 0)
    doc.bundledTemplates = input.bundledTemplates
  // Reorder top-level to the canonical sequence (JSON.stringify preserves insertion order; `doc`
  // is already built in TOP_LEVEL_ORDER, but reorder defensively so a future edit can't drift it).
  const ordered: Record<string, unknown> = {}
  for (const key of TOP_LEVEL_ORDER) if (doc[key] !== undefined) ordered[key] = doc[key]
  return JSON.stringify(ordered, null, 2)
}

/** A structured parse failure. `code` lets the import UI branch:
 *  - `too-large`      — the input exceeded MAX_PACK_ENVELOPE_BYTES (never parsed).
 *  - `invalid-json`   — the text was not valid JSON.
 *  - `unsupported-version` — a numeric formatVersion this build does not read (carries `foundVersion`).
 *  - `invalid-envelope`   — the JSON was well-formed but violated the schema (carries field `errors`).
 *  - `not-a-fragment`     — the fragment parsed but its `kind` is not 'fragment'.
 *  - `invalid-fragment`   — the fragment failed the structural gate (carries the underlying `errors`). */
export interface PackEnvelopeParseError {
  code:
    | 'too-large'
    | 'invalid-json'
    | 'unsupported-version'
    | 'invalid-envelope'
    | 'not-a-fragment'
    | 'invalid-fragment'
  /** Human-readable field/path errors (present for schema + fragment failures). */
  errors?: string[]
  /** The formatVersion actually found (present for `unsupported-version`). */
  foundVersion?: unknown
}

export type PackEnvelopeParseResult =
  | { ok: true; value: PackEnvelope; warnings: string[] }
  | { ok: false; error: PackEnvelopeParseError }

/** Byte length of a UTF-8 string without pulling in Buffer (shared runs outside Node too). */
function utf8Bytes(text: string): number {
  // TextEncoder is available in Node ≥11 and every browser; it counts real UTF-8 bytes.
  return new TextEncoder().encode(text).length
}

// Collect unknown-key warnings by diffing the RAW parsed object against the keys the strict schema
// keeps. We run the schema in a non-strict clone to get the accepted value, then diff — but simpler:
// walk the known top-level + pack + exposedSetting key sets and report any extra key on the raw
// object. This surfaces "made with a newer version?" hints without failing the parse.
const KNOWN_TOP_KEYS = new Set(['formatVersion', 'kind', 'pack', 'bundledTemplates'])
const KNOWN_PACK_KEYS = new Set([
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

/** Report unknown top-level and pack-level keys on the RAW object as warnings (the fragment's own
 *  unknown keys are handled by docSchema's strip; deep template internals are intentionally opaque
 *  passthrough). Returns human-readable strings for the import UI's "newer version?" hint. */
function collectUnknownKeyWarnings(raw: unknown): string[] {
  const warnings: string[] = []
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of Object.keys(raw as Record<string, unknown>))
      if (!KNOWN_TOP_KEYS.has(key)) warnings.push(`unknown top-level key "${key}"`)
    const pack = (raw as Record<string, unknown>).pack
    if (pack && typeof pack === 'object' && !Array.isArray(pack)) {
      for (const key of Object.keys(pack as Record<string, unknown>))
        if (!KNOWN_PACK_KEYS.has(key)) warnings.push(`unknown pack key "${key}"`)
    }
  }
  return warnings
}

/** Parse + verify a `.rptagent` v0 text. The fragment is REVALIDATED through the existing structural
 *  gate (docSchema.parseWorkflowDoc) — never trusted from the file — and asserted `kind:'fragment'`.
 *  Unknown top-level/pack keys are STRIPPED (v0 does not preserve them) but REPORTED as warnings so
 *  import UI can hint "made with a newer version of RPT?". Ordering of checks: size → JSON → version
 *  → envelope schema → fragment gate, so the cheapest/most-actionable error wins. */
export function parsePackEnvelope(text: string): PackEnvelopeParseResult {
  if (utf8Bytes(text) > MAX_PACK_ENVELOPE_BYTES)
    return { ok: false, error: { code: 'too-large' } }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: { code: 'invalid-json' } }
  }

  // Version gate FIRST (before the full schema) so an unknown version reports as such rather than as
  // a wall of field errors from a shape this build doesn't understand.
  const foundVersion = (raw as { formatVersion?: unknown } | null)?.formatVersion
  if (foundVersion !== PACK_ENVELOPE_FORMAT_VERSION)
    return { ok: false, error: { code: 'unsupported-version', foundVersion } }

  const warnings = collectUnknownKeyWarnings(raw)

  const parsed = PackEnvelopeSchema.safeParse(raw)
  if (!parsed.success) {
    const errors = parsed.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    return { ok: false, error: { code: 'invalid-envelope', errors } }
  }

  // Re-run the fragment through the SAME structural gate the turn-doc path uses. `WorkflowDocSchema`
  // already accepted it above, but parseWorkflowDoc is the shared authority and, crucially, we assert
  // kind:'fragment' here — a pack whose graph is a plain 'turn' doc is not a valid pack.
  const fragmentCheck = parseWorkflowDoc(parsed.data.pack.fragment)
  if (!fragmentCheck.ok)
    return { ok: false, error: { code: 'invalid-fragment', errors: [fragmentCheck.error] } }
  if (fragmentCheck.doc.kind !== 'fragment')
    return {
      ok: false,
      error: {
        code: 'not-a-fragment',
        errors: [`fragment.kind is "${fragmentCheck.doc.kind ?? 'turn'}", expected "fragment"`]
      }
    }

  return { ok: true, value: parsed.data as PackEnvelope, warnings }
}
