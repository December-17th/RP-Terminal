// Structural (zod) validation for WorkflowDoc — the first half of the spec §12 validation
// gate (the second half is validate.ts's graph validation, which needs node descriptors and
// so runs main-side). Pure: imports only zod + the shared types, like shared/cardZod.ts.
import { z } from 'zod'
import { WorkflowDoc } from './types'
import { CHECKPOINT_IDS, TRIGGER_OPS, TABLE_STATS } from './attachments'

const EdgeEndSchema = z.object({ node: z.string().min(1), port: z.string().min(1) })

// Attachment declarations on a fragment doc (ADR 0009; ./checkpoints.ts AttachmentDecl). The
// checkpoint fields are constrained to the known v1 vocabulary here at the structural gate; the
// richer rules (a fragment needs ≥1 attachment, inline-entry type compatibility, WP1.6b's
// known-anchor-lane rule) live in validate.ts, which has the node descriptors. The trigger shape
// is a stub until WP2.1 (ADR 0003/0004) — only its `kind` discriminant exists so far.
//
// The optional boundary-port designations (entryPort/outPort/rejoinPort — attachments.ts
// FragmentPortRef), the WP1.6b anchor-lane selector, AND the WP2.1 trigger condition fields (source/
// op/value/everyNFloors) MUST be declared here: zod objects STRIP unknown keys on parse, so an
// undeclared field would silently vanish from any fragment doc round-tripped through parseWorkflowDoc
// — leaving an attachment unspliceable, or (for a trigger) turning a real state condition into an
// empty stub. Everything the model carries is declared below.
const CheckpointIdSchema = z.enum(CHECKPOINT_IDS)
const FragmentPortRefSchema = z.object({ node: z.string().min(1), port: z.string().min(1) })

// A trigger's condition value: number | string | boolean (attachments.ts StateTrigger.value; op/type
// agreement — numeric ops need a number — is validate.ts's TRIGGER_VALUE rule, not structural).
const TriggerValueSchema = z.union([z.number(), z.string(), z.boolean()])

// A tagged committed-state pointer (attachments.ts TriggerSource). `vars` carries a dot/bracket path
// (well-formedness is validate.ts's TRIGGER_PATH rule); `table` carries a sqlName + a CLOSED stat.
const TriggerSourceSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('vars'), path: z.string().min(1) }),
  z.object({ scope: z.literal('table'), table: z.string().min(1), stat: z.enum(TABLE_STATS) })
])

// The three v1 trigger kinds (attachments.ts TriggerAttachment), discriminated on `trigger`. All
// share kind:'trigger', so they form a nested union folded into the outer attachment union below.
const TriggerAttachmentSchema = z.discriminatedUnion('trigger', [
  z.object({
    kind: z.literal('trigger'),
    trigger: z.literal('state'),
    source: TriggerSourceSchema,
    op: z.enum(TRIGGER_OPS),
    value: TriggerValueSchema
  }),
  z.object({
    kind: z.literal('trigger'),
    trigger: z.literal('cadence'),
    // Structural floor: integer ≥ 1 (validate.ts re-checks as CADENCE_N for the descriptor path).
    everyNFloors: z.number().int().min(1)
  }),
  z.object({ kind: z.literal('trigger'), trigger: z.literal('manual') })
])

// The outer attachment union. Entry/rejoin are discriminated cleanly on `kind`; the three trigger
// shapes all share kind:'trigger', so the union is a plain z.union (not discriminatedUnion('kind'),
// which forbids duplicate discriminant values) with the trigger sub-union as one arm.
const AttachmentDeclSchema = z.union([
  z.object({
    kind: z.literal('entry'),
    checkpoint: CheckpointIdSchema,
    mode: z.enum(['branch', 'inline']),
    entryPort: FragmentPortRefSchema.optional(),
    outPort: FragmentPortRefSchema.optional()
  }),
  z.object({
    kind: z.literal('rejoin'),
    checkpoint: CheckpointIdSchema,
    rejoinPort: FragmentPortRefSchema.optional(),
    // WP1.6b anchor-lane selector; lane-name validity is validate.ts's UNKNOWN_ANCHOR rule.
    anchor: z.string().min(1).optional()
  }),
  TriggerAttachmentSchema
])

// One-canvas rebuild (WP6.3): on-canvas module groupings (types.ts GroupDecl/ExposedGroupSetting).
// Pure doc metadata over in-place nodes. nodeIds needs ≥2 members; exposed entries carry a member
// node id + a config path + a label, all nonempty. Path VALIDITY (does the field exist) is NOT
// structural — a stale path renders empty in the panel (validate.ts leaves it alone).
const ExposedGroupSettingSchema = z.object({
  node: z.string().min(1),
  path: z.string().min(1),
  label: z.string().min(1)
})
const GroupDeclSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  nodeIds: z.array(z.string().min(1)).min(2),
  collapsed: z.boolean().optional(),
  exposed: z.array(ExposedGroupSettingSchema).optional(),
  // Agent & memory UX (WP-A; spec §1). MUST be declared here — zod objects STRIP unknown keys on
  // parse, so an undeclared `note`/`origin` would silently vanish from a group round-tripped through
  // parseWorkflowDoc. `note` = author setup guidance (verbatim); `origin` = import provenance.
  note: z.string().optional(),
  origin: z.literal('import').optional()
})

export const WorkflowDocSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.number(),
  // Bump + migrate (spec §15) when the doc shape changes; only v1 exists today.
  schemaVersion: z.literal(1),
  description: z.string().optional(),
  nodes: z.array(
    z.object({
      id: z.string().min(1),
      type: z.string().min(1),
      config: z.record(z.string(), z.unknown()).optional(),
      position: z.object({ x: z.number(), y: z.number() }).optional(),
      panel: z
        .object({
          show: z.boolean(),
          label: z.string().optional(),
          collapsed: z.boolean().optional()
        })
        .optional(),
      isMainOutput: z.boolean().optional(),
      // One-canvas rebuild (WP6.1; ADR 0011): the node-disable flag. MUST be declared here — zod
      // strips unknown keys on parse, so an undeclared `disabled` would silently vanish from a
      // round-tripped doc. Absent = enabled.
      disabled: z.boolean().optional()
    })
  ),
  edges: z.array(z.object({ from: EdgeEndSchema, to: EdgeEndSchema })),
  // One-canvas rebuild (WP6.3): on-canvas module groupings. Optional so pre-WP6.3 docs are
  // unaffected; membership/overlap/exposed-member rules are validate.ts's (they need the node set).
  groups: z.array(GroupDeclSchema).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  // Absent = 'turn' (sub-graph nodes v1 plan §2). 'fragment' = an agent pack's executable part
  // (agent-packs plan WP1.1; ADR 0002/0009).
  kind: z.enum(['turn', 'subgraph', 'fragment']).optional(),
  // Only carried by fragment docs (ADR 0009). Structurally optional so 'turn'/'subgraph' docs are
  // unaffected; the "fragment requires ≥1 attachment" rule is enforced in validate.ts.
  attachments: z.array(AttachmentDeclSchema).optional()
})

/** Structural parse with a single human-readable error string (shown on import/save reject). */
export const parseWorkflowDoc = (
  raw: unknown
): { ok: true; doc: WorkflowDoc } | { ok: false; error: string } => {
  const r = WorkflowDocSchema.safeParse(raw)
  if (r.success) return { ok: true, doc: r.data as WorkflowDoc }
  const error = r.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ')
  return { ok: false, error }
}
