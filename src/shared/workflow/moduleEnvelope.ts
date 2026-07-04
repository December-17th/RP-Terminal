// The `.rptmodule` file format v1 — the standalone, shareable envelope for ONE on-canvas MODULE
// (one-canvas rebuild WP6.5). A module is a GROUP of in-place nodes (types.ts GroupDecl): its member
// nodes, the edges INTERNAL to it, and the settings it exposes. Unlike a pack (`.rptagent`) a module
// is NOT a doc — it carries no doc-level identity, no `kind`, no attachments; it is a reusable slab of
// graph the author drops into whatever doc they're editing and wires up themselves.
//
// This module is the SHARED authority for both directions (the packEnvelope precedent: "export-time
// and import-time validation are one `shared/` implementation, so 'exports fine here, rejected there'
// cannot happen"). The renderer's export path serializes with it; main's import verifies with it. The
// nodes are NEVER trusted from the file — they are revalidated through the existing NodeInstance zod
// (the same `nodes` element schema docSchema.WorkflowDocSchema uses), plus the module-shape invariants
// (≥2 members, internal edges only, exposed refs point at members).
//
// Reuse: `bundledTemplates` is the SAME structural subset as the pack envelopes (packPayload.ts) — a
// module whose table nodes read a template can ship the whole active template so it works on a machine
// that has never seen it (ADR 0008 bundle-for-transport). Main re-validates it against the full
// TableTemplateSchema at install, exactly as the pack path does.
//
// Pure: imports only zod + the shared schemas; safe from main, renderer, preload, and tests.

import { z } from 'zod'
import type { Edge, ExposedGroupSetting, NodeInstance } from './types'
import {
  BundledTemplateSchema,
  utf8Bytes,
  type BundledTemplate
} from './packPayload'

export type { BundledTemplate }

/** The one format version this module reads/writes. An envelope with any other `formatVersion` is
 *  reported as `unsupported-version` (carrying the value found) so import UI can say "made with a
 *  newer/older RPT?". Bump deliberately when the envelope shape changes incompatibly. */
export const MODULE_ENVELOPE_FORMAT_VERSION = 1 as const

/** Generous size cap for a module file (structured error past it). A module is small JSON (a slab of
 *  nodes + edges + maybe one template); 8 MiB is far above any realistic module yet cheaply rejects a
 *  hostile/garbage blob before zod walks it. Measured on the UTF-8 byte length of the input text. */
export const MAX_MODULE_ENVELOPE_BYTES = 8 * 1024 * 1024

// ── zod: the module payload ──────────────────────────────────────────────────────────────────────
//
// The `nodes` element schema is a STRUCTURAL COPY of docSchema.WorkflowDocSchema's node object (kept
// in lockstep — a module's nodes are ordinary doc nodes, disabled flag included). It is NOT imported
// from docSchema (that module keeps its node schema inline inside WorkflowDocSchema); redeclaring the
// element here is the smallest seam. Any new whitelisted node field must be added in BOTH places — the
// module round-trip test pins the fields a module must carry.
const NodeInstanceSchema: z.ZodType<NodeInstance> = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  panel: z
    .object({ show: z.boolean(), label: z.string().optional(), collapsed: z.boolean().optional() })
    .optional(),
  isMainOutput: z.boolean().optional(),
  disabled: z.boolean().optional()
})

const EdgeEndSchema = z.object({ node: z.string().min(1), port: z.string().min(1) })
const EdgeSchema: z.ZodType<Edge> = z.object({ from: EdgeEndSchema, to: EdgeEndSchema })

const ExposedGroupSettingSchema: z.ZodType<ExposedGroupSetting> = z.object({
  node: z.string().min(1),
  path: z.string().min(1),
  label: z.string().min(1)
})

const ModuleSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  creator: z.string().optional(),
  nodes: z.array(NodeInstanceSchema),
  edges: z.array(EdgeSchema),
  exposed: z.array(ExposedGroupSettingSchema).optional()
})

const ModuleEnvelopeSchema = z.object({
  formatVersion: z.literal(MODULE_ENVELOPE_FORMAT_VERSION),
  kind: z.literal('rptmodule'),
  module: ModuleSchema,
  bundledTemplates: z.array(BundledTemplateSchema).optional()
})

/** The `module` payload of a `.rptmodule` file: the group's members, its internal edges, and the
 *  settings it exposes. Node ids are AS-AUTHORED — the importer remints them (collision-safe) so a
 *  module can be dropped into a doc that already uses those ids. */
export interface ModulePayload {
  name: string
  description?: string
  creator?: string
  /** The group's member nodes (ids as-authored; disabled included). */
  nodes: NodeInstance[]
  /** INTERNAL edges only — both ends are member nodes (boundary edges are dropped at build). */
  edges: Edge[]
  /** Settings promoted onto the module's panel; each `node` must be a member. */
  exposed?: ExposedGroupSetting[]
}

/** The `.rptmodule` v1 document. */
export interface ModuleEnvelope {
  formatVersion: typeof MODULE_ENVELOPE_FORMAT_VERSION
  kind: 'rptmodule'
  module: ModulePayload
  bundledTemplates?: BundledTemplate[]
}

// ── serialize ────────────────────────────────────────────────────────────────────────────────────

// Canonical key orders so serialize output is byte-stable + diffable regardless of input key order
// (the packEnvelope "diffable" decision).
const TOP_LEVEL_ORDER = ['formatVersion', 'kind', 'module', 'bundledTemplates'] as const
const MODULE_ORDER = ['name', 'description', 'creator', 'nodes', 'edges', 'exposed'] as const

/** Build the ordered module object from a payload, dropping undefined/empty optionals so the
 *  serialized form is minimal + stable. */
function orderedModule(module: ModulePayload): Record<string, unknown> {
  const src: Record<string, unknown> = {
    name: module.name,
    description: module.description,
    creator: module.creator,
    nodes: module.nodes,
    edges: module.edges,
    exposed: module.exposed && module.exposed.length > 0 ? module.exposed : undefined
  }
  const out: Record<string, unknown> = {}
  for (const key of MODULE_ORDER) if (src[key] !== undefined) out[key] = src[key]
  return out
}

/** Serialize a module to the `.rptmodule` v1 text: a single UTF-8 JSON document, 2-space
 *  pretty-printed with a STABLE top-level + module key order (byte-identical for equal inputs). Optional
 *  fields absent from the input are omitted, not written as null. Does NOT itself validate the module
 *  invariants (the caller runs the build derivation first); this is the pure text-shaping step. */
export function serializeModuleEnvelope(module: ModulePayload, bundledTemplates?: BundledTemplate[]): string {
  const doc: Record<string, unknown> = {
    formatVersion: MODULE_ENVELOPE_FORMAT_VERSION,
    kind: 'rptmodule',
    module: orderedModule(module)
  }
  if (bundledTemplates !== undefined && bundledTemplates.length > 0) doc.bundledTemplates = bundledTemplates
  const ordered: Record<string, unknown> = {}
  for (const key of TOP_LEVEL_ORDER) if (doc[key] !== undefined) ordered[key] = doc[key]
  return JSON.stringify(ordered, null, 2)
}

// ── parse ────────────────────────────────────────────────────────────────────────────────────────

/** A structured parse failure. `code` lets the import UI branch:
 *  - `too-large`           — the input exceeded MAX_MODULE_ENVELOPE_BYTES (never parsed).
 *  - `invalid-json`        — the text was not valid JSON.
 *  - `unsupported-version` — a numeric formatVersion this build does not read (carries `foundVersion`).
 *  - `invalid-envelope`    — the JSON was well-formed but violated the schema (carries field `errors`).
 *  - `empty-module`        — fewer than 2 member nodes (a module needs ≥2 — the GroupDecl rule).
 *  - `external-edge`       — an edge end is not a member node (a module carries INTERNAL edges only).
 *  - `exposed-not-member`  — an exposed setting names a node that is not a member. */
export interface ModuleEnvelopeParseError {
  code:
    | 'too-large'
    | 'invalid-json'
    | 'unsupported-version'
    | 'invalid-envelope'
    | 'empty-module'
    | 'external-edge'
    | 'exposed-not-member'
  errors?: string[]
  foundVersion?: unknown
}

export type ModuleEnvelopeParseResult =
  | { ok: true; value: ModuleEnvelope; warnings: string[] }
  | { ok: false; error: ModuleEnvelopeParseError }

const KNOWN_TOP_KEYS = new Set(['formatVersion', 'kind', 'module', 'bundledTemplates'])
const KNOWN_MODULE_KEYS = new Set(['name', 'description', 'creator', 'nodes', 'edges', 'exposed'])

/** Report unknown top-level + module-level keys on the RAW object as warnings (forward-compat hint —
 *  "made with a newer version of RPT?"). v1 strips unknown keys; this surfaces them without rejecting.
 *  Mirrors packEnvelope's collectUnknownKeyWarnings collector pattern. */
function collectUnknownKeyWarnings(raw: unknown): string[] {
  const warnings: string[] = []
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of Object.keys(raw as Record<string, unknown>))
      if (!KNOWN_TOP_KEYS.has(key)) warnings.push(`unknown top-level key "${key}"`)
    const module = (raw as Record<string, unknown>).module
    if (module && typeof module === 'object' && !Array.isArray(module))
      for (const key of Object.keys(module as Record<string, unknown>))
        if (!KNOWN_MODULE_KEYS.has(key)) warnings.push(`unknown module key "${key}"`)
  }
  return warnings
}

/** Check the module-shape invariants a schema can't express (they span multiple fields): ≥2 members,
 *  internal edges only, exposed refs point at members. Returns the first violation as a structured code
 *  (so the import UI can explain it precisely), or null when the module is well-formed. */
function checkModuleInvariants(module: ModulePayload): ModuleEnvelopeParseError | null {
  if (module.nodes.length < 2) return { code: 'empty-module' }
  const memberIds = new Set(module.nodes.map((n) => n.id))
  for (const e of module.edges) {
    if (!memberIds.has(e.from.node) || !memberIds.has(e.to.node))
      return {
        code: 'external-edge',
        errors: [`edge ${e.from.node}:${e.from.port}->${e.to.node}:${e.to.port} has an end outside the module`]
      }
  }
  for (const x of module.exposed ?? []) {
    if (!memberIds.has(x.node))
      return { code: 'exposed-not-member', errors: [`exposed setting names non-member node "${x.node}"`] }
  }
  return null
}

/** Parse + verify a `.rptmodule` v1 text. Nodes are REVALIDATED through the NodeInstance zod (never
 *  trusted from the file); the module-shape invariants (≥2 members, internal edges only, exposed refs
 *  are members) are checked separately. Unknown keys are STRIPPED but REPORTED as warnings. Ordering of
 *  checks: size → JSON → version → envelope schema → module invariants, so the cheapest/most-actionable
 *  error wins. Mirrors parsePackEnvelope's structure. */
export function parseModuleEnvelope(text: string): ModuleEnvelopeParseResult {
  if (utf8Bytes(text) > MAX_MODULE_ENVELOPE_BYTES)
    return { ok: false, error: { code: 'too-large' } }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: { code: 'invalid-json' } }
  }

  const foundVersion = (raw as { formatVersion?: unknown } | null)?.formatVersion
  if (foundVersion !== MODULE_ENVELOPE_FORMAT_VERSION)
    return { ok: false, error: { code: 'unsupported-version', foundVersion } }

  const warnings = collectUnknownKeyWarnings(raw)

  const parsed = ModuleEnvelopeSchema.safeParse(raw)
  if (!parsed.success) {
    const errors = parsed.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    return { ok: false, error: { code: 'invalid-envelope', errors } }
  }

  const value = parsed.data as ModuleEnvelope
  const invariant = checkModuleInvariants(value.module)
  if (invariant) return { ok: false, error: invariant }

  return { ok: true, value, warnings }
}
