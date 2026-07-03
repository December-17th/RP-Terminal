// Structural (zod) validation for WorkflowDoc — the first half of the spec §12 validation
// gate (the second half is validate.ts's graph validation, which needs node descriptors and
// so runs main-side). Pure: imports only zod + the shared types, like shared/cardZod.ts.
import { z } from 'zod'
import { WorkflowDoc } from './types'
import { CHECKPOINT_IDS } from './attachments'

const EdgeEndSchema = z.object({ node: z.string().min(1), port: z.string().min(1) })

// Attachment declarations on a fragment doc (ADR 0009; ./checkpoints.ts AttachmentDecl). The
// checkpoint fields are constrained to the known v1 vocabulary here at the structural gate; the
// richer rules (a fragment needs ≥1 attachment, inline-entry type compatibility, WP1.6b's
// known-anchor-lane rule) live in validate.ts, which has the node descriptors. The trigger shape
// is a stub until WP2.1 (ADR 0003/0004) — only its `kind` discriminant exists so far.
//
// The optional boundary-port designations (entryPort/outPort/rejoinPort — attachments.ts
// FragmentPortRef) and the WP1.6b anchor-lane selector MUST be declared here: zod objects STRIP
// unknown keys on parse, so an undeclared field would silently vanish from any fragment doc
// round-tripped through parseWorkflowDoc, leaving every attachment unspliceable at compose time.
const CheckpointIdSchema = z.enum(CHECKPOINT_IDS)
const FragmentPortRefSchema = z.object({ node: z.string().min(1), port: z.string().min(1) })
const AttachmentDeclSchema = z.discriminatedUnion('kind', [
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
  z.object({ kind: z.literal('trigger') })
])

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
      isMainOutput: z.boolean().optional()
    })
  ),
  edges: z.array(z.object({ from: EdgeEndSchema, to: EdgeEndSchema })),
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
