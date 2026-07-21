import { fromJSONSchema } from 'zod'
import type { JsonObject } from '../../../../shared/agentRuntime'

export const compileJsonSchema = (
  schema: JsonObject
): { ok: true; validate: ReturnType<typeof fromJSONSchema> } | { ok: false; message: string } => {
  try {
    return { ok: true, validate: fromJSONSchema(schema as never) }
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : 'Unsupported JSON Schema'
    }
  }
}
