// The `.rptrecipe` file format v1 — a shareable WORLD SETUP: a set of agent packs plus an activation
// preset (which packs are on, their world-scope override values, the narrator choice). ADR 0008
// ("recipes bundle for transport, reference internally"): there is no registry to resolve against, so
// the artifact must survive a Discord post — it EMBEDS full copies of every pack it uses (the SAME
// PackPayload the `.rptagent` envelope carries), while its activation preset references those packs
// INTERNALLY by (id, version). At import the embedded packs dedupe into the global library by
// (id, version) — already installed → skip, new → ordinary install, colliding version → install
// ALONGSIDE (WP4.6 version coexistence; ADR 0008: recipes reproduce exactly, "use your newer one
// instead" is a later explicit user choice, NOT this format's concern) — then the activation preset
// applies to the chosen world. This module is the SHARED authority for BOTH directions (export
// serializes with it, import verifies with it), so "exports fine, rejected on import" cannot happen.
//
// Untrusted, like packEnvelope: every embedded pack's fragment is REVALIDATED through the shared
// structural gate (revalidatePackFragment) and an embedded custom narrator is revalidated as a
// kind:'turn' doc with exactly one main-output node (the structural half of validateWorkflow's
// main-output rule — descriptor-dependent graph checks stay main-side, exactly as packEnvelope defers
// them). Nothing is trusted from the file.
//
// Pure: imports only zod + the shared schemas + packPayload internals; safe from main, renderer,
// preload, and tests.

import { z } from 'zod'
import { WorkflowDoc } from './types'
import { WorkflowDocSchema, parseWorkflowDoc } from './docSchema'
import {
  PackMetaSchema,
  BundledTemplateSchema,
  utf8Bytes,
  collectPackKeyWarnings,
  PACK_ORDER,
  revalidatePackFragment,
  type BundledTemplate,
  type PackPayload
} from './packPayload'

/** The one format version this module reads/writes. Any other numeric `formatVersion` reports as
 *  `unsupported-version` (carrying the value found) so import UI can say "made with a newer/older
 *  RPT?" rather than a wall of field errors. Bump deliberately when the shape changes incompatibly. */
export const RECIPE_ENVELOPE_FORMAT_VERSION = 1 as const

/** Size cap for a recipe file (structured `too-large` past it). Recipes are FAT BY DESIGN — they
 *  embed a full copy of every pack (each up to the 8 MiB per-pack cap) plus a shared bundledTemplates
 *  pool and a possibly-embedded narrator turn doc. A modest world setup of a handful of memory packs
 *  can dwarf a single `.rptagent`. We pick 64 MiB = 8× the per-pack cap: comfortably above a realistic
 *  ~8-pack recipe with shared templates, while still cheaply rejecting a hostile/garbage blob before
 *  zod walks the whole tree. Measured on the UTF-8 byte length of the input text. */
export const MAX_RECIPE_ENVELOPE_BYTES = 64 * 1024 * 1024

// ── narrator ──────────────────────────────────────────────────────────────────────────────────────
//
// A recipe pins ONE narrator (ADR 0008). Two forms, discriminated on `kind`:
//   - 'builtin'  — the app's built-in narrator. The format stores JUST the kind and carries NO doc
//                  and NO id. WHY no id: the builtin is referenced by a WELL-KNOWN id
//                  (`BUILTIN_WORKFLOW_ID = 'default'`, src/main/services/workflowStore.ts:15) that is
//                  the IMPORTING app's builtin, not the exporter's — the exporter's builtin default doc
//                  may differ version-to-version. Resolving that id is the importer's job; storing it here
//                  would be storing a fact about the exporter's machine that the importer must ignore.
//                  So the format records only "use your builtin narrator" (ADR 0008: "the builtin
//                  narrator is referenced by well-known id").
//   - 'embedded' — a CUSTOM narrator embeds a FULL turn WorkflowDoc, the same way a pack embeds its
//                  fragment (ADR 0008: "a custom narrator embeds the same way a pack does"). It is
//                  revalidated on parse as a kind:'turn' doc with exactly one main-output node.
const NarratorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtin') }),
  z.object({ kind: z.literal('embedded'), doc: WorkflowDocSchema })
])

/** A recipe's narrator choice. `builtin` carries no doc/id (resolved importer-side against its own
 *  well-known `BUILTIN_WORKFLOW_ID`); `embedded` carries a full kind:'turn' WorkflowDoc. */
export type RecipeNarrator =
  | { kind: 'builtin' }
  | { kind: 'embedded'; doc: WorkflowDoc }

// ── activation preset ───────────────────────────────────────────────────────────────────────────
//
// One entry per activated pack. References a pack by (packId, version) — the internal reference ADR
// 0008 pins; the (packId, version) MUST name a pack present in `packs[]` (the internal-reference
// invariant, validated at parse as `activation-refers-unknown-pack`). `enabled` is the gate state to
// apply. `overrides` is the creator-exposed-settings override map for this pack, stored SCOPE-FREE as
// `settingId → value`: a recipe's overrides are conceptually WORLD-SCOPE values, but the format does
// NOT encode the scope (agentPackStore's `'world:<id>'` string) because the target world id is not
// known until import — the IMPORTER applies each map at WORLD scope (`encodeScope({ world })`,
// agentPackStore.ts) for the world the user is installing into. So the format carries the values; the
// importer carries the scope.
const ActivationEntrySchema = z.object({
  packId: z.string().min(1),
  version: z.number(),
  enabled: z.boolean(),
  // settingId → value; unconstrained values (per-setting type agreement is a materialize-time concern,
  // exactly as packPayload's ExposedSetting.default). Applied at WORLD scope by the importer.
  overrides: z.record(z.string(), z.unknown()).optional()
})

/** One activation-preset entry: which pack (by (packId, version) — must be present in `packs[]`), its
 *  gate state, and its scope-FREE override map (settingId → value, applied at world scope on import). */
export interface ActivationEntry {
  packId: string
  version: number
  enabled: boolean
  overrides?: Record<string, unknown>
}

// ── the recipe body + envelope ──────────────────────────────────────────────────────────────────

const RecipeBodySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  creator: z.string().optional(),
  narrator: NarratorSchema,
  packs: z.array(PackMetaSchema),
  activation: z.array(ActivationEntrySchema)
})

const RecipeEnvelopeSchema = z.object({
  formatVersion: z.literal(RECIPE_ENVELOPE_FORMAT_VERSION),
  kind: z.literal('rptrecipe'),
  recipe: RecipeBodySchema,
  bundledTemplates: z.array(BundledTemplateSchema).optional()
})

/** The `.rptrecipe` v1 document. `recipe.packs[]` are full embedded PackPayloads (same shape as
 *  `.rptagent`'s pack); `recipe.activation` references them by (packId, version); `recipe.narrator` is
 *  the builtin marker OR a full embedded turn doc; `bundledTemplates` is the SHARED template pool
 *  (memory packs across the recipe read from it), same shape `.rptagent` carries. ADR 0008. */
export interface RecipeEnvelope {
  formatVersion: typeof RECIPE_ENVELOPE_FORMAT_VERSION
  kind: 'rptrecipe'
  recipe: {
    id: string
    name: string
    description?: string
    creator?: string
    narrator: RecipeNarrator
    /** Full embedded pack payloads (ADR 0008 bundle-for-transport); dedupe by (id, version) at import. */
    packs: PackPayload[]
    /** The activation preset: enabled set + world-scope overrides, keyed to `packs[]` by (packId, version). */
    activation: ActivationEntry[]
  }
  /** Shared table-template pool for the embedded memory packs (ADR 0008 bundle-for-transport). */
  bundledTemplates?: BundledTemplate[]
}

/** The inputs `serializeRecipeEnvelope` needs. `packs` are full payloads (built from stored
 *  AgentPackRecords by the export service, WP5.2); `activation` references them by (packId, version). */
export interface SerializeRecipeEnvelopeInput {
  id: string
  name: string
  description?: string
  creator?: string
  narrator: RecipeNarrator
  packs: PackPayload[]
  activation: ActivationEntry[]
  bundledTemplates?: BundledTemplate[]
}

// Canonical key orders for byte-stable, diffable output (the grilled decision, mirrored from
// packEnvelope). Nested pack payloads reuse packPayload.PACK_ORDER so an embedded recipe pack and a
// standalone `.rptagent` pack serialize IDENTICALLY (a recipe-exported pack diffs against its
// standalone export).
const TOP_LEVEL_ORDER = ['formatVersion', 'kind', 'recipe', 'bundledTemplates'] as const
const RECIPE_ORDER = ['id', 'name', 'description', 'creator', 'narrator', 'packs', 'activation'] as const
const ACTIVATION_ORDER = ['packId', 'version', 'enabled', 'overrides'] as const

/** Order one pack payload for serialization, dropping undefined optionals. Mirrors
 *  packEnvelope.orderedPack byte-for-byte (`fork` appended after fragment) so an embedded pack and a
 *  standalone `.rptagent` pack are identical text. */
function orderedPack(pack: PackPayload): Record<string, unknown> {
  const src: Record<string, unknown> = {
    id: pack.id,
    version: pack.version,
    name: pack.name,
    description: pack.description,
    creator: pack.creator,
    minRptVersion: pack.minRptVersion,
    exposedSettings: pack.exposedSettings,
    fragment: pack.fragment
  }
  const out: Record<string, unknown> = {}
  for (const key of PACK_ORDER) if (src[key] !== undefined) out[key] = src[key]
  if (pack.fork !== undefined) out.fork = pack.fork
  return out
}

/** Order one activation entry, dropping an absent `overrides`. */
function orderedActivation(entry: ActivationEntry): Record<string, unknown> {
  const src: Record<string, unknown> = {
    packId: entry.packId,
    version: entry.version,
    enabled: entry.enabled,
    overrides: entry.overrides
  }
  const out: Record<string, unknown> = {}
  for (const key of ACTIVATION_ORDER) if (src[key] !== undefined) out[key] = src[key]
  return out
}

/** Order the narrator, dropping nothing meaningful: `builtin` is `{ kind }` (NO id — see NarratorSchema);
 *  `embedded` is `{ kind, doc }`. */
function orderedNarrator(narrator: RecipeNarrator): Record<string, unknown> {
  if (narrator.kind === 'builtin') return { kind: 'builtin' }
  return { kind: 'embedded', doc: narrator.doc }
}

/** Serialize a recipe to `.rptrecipe` v1 text: a single UTF-8 JSON document, 2-space pretty-printed
 *  with STABLE top-level / recipe / pack / activation key order (byte-identical for equal inputs).
 *  Optional fields absent from the input are omitted, not written as null. Does NOT itself validate
 *  the embedded fragments/narrator (the export service runs the shared validation first); this is the
 *  pure text-shaping step. */
export function serializeRecipeEnvelope(input: SerializeRecipeEnvelopeInput): string {
  const recipeSrc: Record<string, unknown> = {
    id: input.id,
    name: input.name,
    description: input.description,
    creator: input.creator,
    narrator: orderedNarrator(input.narrator),
    packs: input.packs.map(orderedPack),
    activation: input.activation.map(orderedActivation)
  }
  const recipe: Record<string, unknown> = {}
  for (const key of RECIPE_ORDER) if (recipeSrc[key] !== undefined) recipe[key] = recipeSrc[key]

  const doc: Record<string, unknown> = {
    formatVersion: RECIPE_ENVELOPE_FORMAT_VERSION,
    kind: 'rptrecipe',
    recipe
  }
  if (input.bundledTemplates !== undefined && input.bundledTemplates.length > 0)
    doc.bundledTemplates = input.bundledTemplates

  const ordered: Record<string, unknown> = {}
  for (const key of TOP_LEVEL_ORDER) if (doc[key] !== undefined) ordered[key] = doc[key]
  return JSON.stringify(ordered, null, 2)
}

/** A structured parse failure. `code` lets the import UI branch. Reuses packEnvelope's codes where
 *  the meaning is identical, adding three recipe-specific codes for the cross-invariants ADR 0008
 *  pins:
 *   - `too-large`            — input exceeded MAX_RECIPE_ENVELOPE_BYTES (never parsed).
 *   - `invalid-json`         — the text was not valid JSON.
 *   - `unsupported-version`  — a numeric formatVersion this build does not read (carries `foundVersion`).
 *   - `invalid-envelope`     — well-formed JSON that violated the schema (carries field `errors`).
 *   - `not-a-fragment`       — an embedded pack's graph parsed but its kind is not 'fragment' (carries the pack index).
 *   - `invalid-fragment`     — an embedded pack's fragment failed the structural gate (carries `errors`).
 *   - `invalid-narrator`     — an embedded narrator failed the turn-doc gate (bad structure, wrong kind,
 *                              or not exactly one main-output node) (carries `errors`).
 *   - `duplicate-pack`       — two `packs[]` share the same (id, version) — ADR 0008 never collapses them,
 *                              but the SAME (id, version) twice is a malformed artifact (carries `errors`).
 *   - `activation-refers-unknown-pack` — an activation entry names a (packId, version) not present in
 *                              `packs[]` (ADR 0008's internal-reference invariant — carries `errors`).
 *   - `activation-duplicate-pack`      — two activation entries name the same packId (a recipe activates
 *                              ONE version of a pack; carries `errors`). */
export interface RecipeEnvelopeParseError {
  code:
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
  /** Human-readable field/path errors (present for schema, fragment, narrator, and invariant failures). */
  errors?: string[]
  /** The formatVersion actually found (present for `unsupported-version`). */
  foundVersion?: unknown
}

export type RecipeEnvelopeParseResult =
  | { ok: true; value: RecipeEnvelope; warnings: string[] }
  | { ok: false; error: RecipeEnvelopeParseError }

const KNOWN_TOP_KEYS = new Set(['formatVersion', 'kind', 'recipe', 'bundledTemplates'])
const KNOWN_RECIPE_KEYS = new Set([
  'id',
  'name',
  'description',
  'creator',
  'narrator',
  'packs',
  'activation'
])
const KNOWN_ACTIVATION_KEYS = new Set(['packId', 'version', 'enabled', 'overrides'])

/** Report unknown keys at the top level, the recipe level, each embedded pack, and each activation
 *  entry as WARNINGS (stripped, not rejected) so import UI can hint "made with a newer version?".
 *  Embedded fragment/narrator docs have their own unknown keys handled by docSchema's strip; deep
 *  template internals are intentionally opaque passthrough. */
function collectUnknownKeyWarnings(raw: unknown): string[] {
  const warnings: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return warnings
  const top = raw as Record<string, unknown>
  for (const key of Object.keys(top)) if (!KNOWN_TOP_KEYS.has(key)) warnings.push(`unknown top-level key "${key}"`)

  const recipe = top.recipe
  if (recipe && typeof recipe === 'object' && !Array.isArray(recipe)) {
    const r = recipe as Record<string, unknown>
    for (const key of Object.keys(r)) if (!KNOWN_RECIPE_KEYS.has(key)) warnings.push(`unknown recipe key "${key}"`)

    if (Array.isArray(r.packs))
      r.packs.forEach((p, i) => warnings.push(...collectPackKeyWarnings(p, `packs[${i}]`)))

    if (Array.isArray(r.activation))
      r.activation.forEach((entry, i) => {
        if (entry && typeof entry === 'object' && !Array.isArray(entry))
          for (const key of Object.keys(entry as Record<string, unknown>))
            if (!KNOWN_ACTIVATION_KEYS.has(key)) warnings.push(`unknown activation[${i}] key "${key}"`)
      })
  }
  return warnings
}

/** Parse + verify a `.rptrecipe` v1 text. Every embedded pack fragment is REVALIDATED through the
 *  shared structural gate (never trusted from the file); an embedded narrator is revalidated as a
 *  kind:'turn' doc with exactly one main-output node. The internal-reference + uniqueness invariants
 *  ADR 0008 pins are checked at parse. Unknown keys at every level are STRIPPED but REPORTED as
 *  warnings. Check order: size → JSON → version → envelope schema → embedded fragments → narrator →
 *  duplicate-pack → activation invariants, so the cheapest/most-actionable error wins. */
export function parseRecipeEnvelope(text: string): RecipeEnvelopeParseResult {
  if (utf8Bytes(text) > MAX_RECIPE_ENVELOPE_BYTES) return { ok: false, error: { code: 'too-large' } }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: { code: 'invalid-json' } }
  }

  // Version gate FIRST (before the full schema) so an unknown version reports as such, not as a wall
  // of field errors from a shape this build doesn't understand.
  const foundVersion = (raw as { formatVersion?: unknown } | null)?.formatVersion
  if (foundVersion !== RECIPE_ENVELOPE_FORMAT_VERSION)
    return { ok: false, error: { code: 'unsupported-version', foundVersion } }

  const warnings = collectUnknownKeyWarnings(raw)

  const parsed = RecipeEnvelopeSchema.safeParse(raw)
  if (!parsed.success) {
    const errors = parsed.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    return { ok: false, error: { code: 'invalid-envelope', errors } }
  }

  const recipe = parsed.data.recipe

  // Every embedded pack's fragment through the SAME gate `.rptagent` uses — never trusted from the
  // file — asserting kind:'fragment'. The pack index is carried so import UI can name the bad pack.
  for (let i = 0; i < recipe.packs.length; i++) {
    const frag = revalidatePackFragment(recipe.packs[i] as PackPayload)
    if (!frag.ok)
      return {
        ok: false,
        error: { code: frag.code, errors: frag.errors.map((e) => `packs[${i}]: ${e}`) }
      }
  }

  // An embedded custom narrator is a full turn doc (ADR 0008). Revalidate it through the shared
  // structural gate and enforce the exactly-one-main-output rule (the descriptor-free half of
  // validateWorkflow's main-output check, validate.ts:102-108) plus kind:'turn'. Descriptor-dependent
  // graph checks (port types, node types) stay main-side, exactly as packEnvelope defers them.
  if (recipe.narrator.kind === 'embedded') {
    const narratorCheck = validateEmbeddedNarrator(recipe.narrator.doc)
    if (!narratorCheck.ok)
      return { ok: false, error: { code: 'invalid-narrator', errors: narratorCheck.errors } }
  }

  // Duplicate (id, version) within packs[] → malformed. ADR 0008 keeps DISTINCT (id, version) entries
  // (coexistence), but the SAME (id, version) twice cannot be deduped meaningfully.
  const seenPack = new Set<string>()
  for (const p of recipe.packs) {
    const key = `${p.id}@${p.version}`
    if (seenPack.has(key))
      return {
        ok: false,
        error: { code: 'duplicate-pack', errors: [`packs contains duplicate (id, version): ${key}`] }
      }
    seenPack.add(key)
  }

  // Activation invariants (ADR 0008):
  //  (a) internal-reference: each entry's (packId, version) MUST be present in packs[].
  //  (b) one-version-per-pack: a recipe activates ONE version of a pack, so no two activation entries
  //      may name the same packId (carrying two VERSIONS of one id in packs[] is legal — ADR 0008
  //      pins coexistence — but activation picks exactly one).
  const seenActivationPack = new Set<string>()
  for (const entry of recipe.activation) {
    if (seenActivationPack.has(entry.packId))
      return {
        ok: false,
        error: {
          code: 'activation-duplicate-pack',
          errors: [`activation names pack "${entry.packId}" more than once (a recipe activates one version per pack)`]
        }
      }
    seenActivationPack.add(entry.packId)

    if (!seenPack.has(`${entry.packId}@${entry.version}`))
      return {
        ok: false,
        error: {
          code: 'activation-refers-unknown-pack',
          errors: [`activation references pack "${entry.packId}@${entry.version}" not present in packs[]`]
        }
      }
  }

  return { ok: true, value: parsed.data as RecipeEnvelope, warnings }
}

/** Revalidate an embedded narrator turn doc: it passes the shared structural gate, its kind is 'turn'
 *  (absent kind defaults to 'turn' — docSchema/validate.ts), and it has EXACTLY ONE main-output node.
 *  This is the descriptor-FREE portion of validateWorkflow's main-output rule (validate.ts:102-108);
 *  the descriptor-dependent graph checks (node types, port compatibility, cycles) run main-side at
 *  install, exactly as packEnvelope defers a fragment's graph validation. */
function validateEmbeddedNarrator(
  doc: WorkflowDoc
): { ok: true } | { ok: false; errors: string[] } {
  const parsed = parseWorkflowDoc(doc)
  if (!parsed.ok) return { ok: false, errors: [parsed.error] }
  const kind = parsed.doc.kind ?? 'turn'
  if (kind !== 'turn')
    return { ok: false, errors: [`narrator.doc.kind is "${kind}", expected "turn"`] }
  const mains = parsed.doc.nodes.filter((n) => n.isMainOutput)
  if (mains.length !== 1)
    return { ok: false, errors: [`expected exactly 1 main-output node, found ${mains.length}`] }
  return { ok: true }
}
