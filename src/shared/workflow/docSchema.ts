// Structural (zod) validation for WorkflowDoc — the first half of the spec §12 validation
// gate (the second half is validate.ts's graph validation, which needs node descriptors and
// so runs main-side). Pure: imports only zod + the shared types, like shared/cardZod.ts.
import { z } from 'zod'
import { WorkflowDoc } from './types'

const EdgeEndSchema = z.object({ node: z.string().min(1), port: z.string().min(1) })

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
  meta: z.record(z.string(), z.unknown()).optional()
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
