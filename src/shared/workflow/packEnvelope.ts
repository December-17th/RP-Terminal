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
import type { PackManifest, ExposedSetting } from './packManifest'
import {
  PackMetaSchema,
  BundledTemplateSchema,
  utf8Bytes,
  collectPackKeyWarnings,
  PACK_ORDER,
  revalidatePackFragment,
  type BundledTemplate
} from './packPayload'

// BundledTemplate is re-exported for source compatibility (it was declared here in v0; it now lives
// in packPayload.ts, shared with the recipe envelope). Consumers importing it from packEnvelope keep working.
export type { BundledTemplate }

/** The one format version this module reads/writes. An envelope with any other `formatVersion` is
 *  reported as `unsupported-version` (carrying the value found) so import UI can say "made with a
 *  newer/older RPT?" rather than drowning the user in field errors. Bump deliberately when the
 *  envelope shape changes incompatibly. */
export const PACK_ENVELOPE_FORMAT_VERSION = 1 as const

/** Generous size cap for a pack file (structured error past it). Fragments + bundled templates are
 *  small JSON; 8 MiB is far above any realistic v0 pack yet cheaply rejects a hostile/garbage blob
 *  before zod walks it. Measured on the UTF-8 byte length of the input text. */
export const MAX_PACK_ENVELOPE_BYTES = 8 * 1024 * 1024

// The exposedSettings schema, pack-meta schema, bundledTemplates subset, and the UTF-8 byte counter
// now live in packPayload.ts (WP5.1 refactor) so the recipe envelope reuses the exact same pack
// payload validation. See that module's header for the grilled decisions (strip-unknown-keys,
// bundledTemplates structural-subset-plus-passthrough, main re-validation at install).

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
// PACK_ORDER lives in packPayload.ts (shared with the recipe envelope).

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

// utf8Bytes + KNOWN_PACK_KEYS + collectPackKeyWarnings live in packPayload.ts (shared with recipes).
const KNOWN_TOP_KEYS = new Set(['formatVersion', 'kind', 'pack', 'bundledTemplates'])

/** Report unknown top-level and pack-level keys on the RAW object as warnings (the fragment's own
 *  unknown keys are handled by docSchema's strip; deep template internals are intentionally opaque
 *  passthrough). Returns human-readable strings for the import UI's "newer version?" hint. The pack
 *  key vocabulary is the shared `collectPackKeyWarnings` (labelled "pack" → `unknown pack key "..."`). */
function collectUnknownKeyWarnings(raw: unknown): string[] {
  const warnings: string[] = []
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of Object.keys(raw as Record<string, unknown>))
      if (!KNOWN_TOP_KEYS.has(key)) warnings.push(`unknown top-level key "${key}"`)
    warnings.push(...collectPackKeyWarnings((raw as Record<string, unknown>).pack, 'pack'))
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

  // Re-run the fragment through the SAME structural gate the turn-doc path uses (shared
  // revalidatePackFragment), asserting kind:'fragment' — a pack whose graph is a plain 'turn' doc is
  // not a valid pack. WorkflowDocSchema already accepted it above; this is the shared authority.
  const frag = revalidatePackFragment(parsed.data.pack as PackEnvelope['pack'])
  if (!frag.ok) return { ok: false, error: { code: frag.code, errors: frag.errors } }

  return { ok: true, value: parsed.data as PackEnvelope, warnings }
}
