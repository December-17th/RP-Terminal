// Pure JSON-Schema walker for the node-workflow config panel (Phase 4 task 5). Consumes the
// EXACT shapes `z.toJSONSchema` emits for our builtin configSchemas (see
// src/main/services/nodes/catalog.ts + .superpowers/sdd/task-1-report.md for the real output):
// `additionalProperties: false` on every object, `z.unknown()` -> `{}` (no type/enum/properties
// at all), enums -> `{ type: 'string', enum: [...] }`, nested object arrays -> `{ type: 'array',
// items: <object schema> }`. NO React imports here — this stays vitest-pure so it can be pinned
// directly against the real catalog output in test/workflow/schemaForm.test.ts.

export type FieldSpec =
  | { kind: 'string'; key: string; required: boolean }
  | { kind: 'number'; key: string; required: boolean }
  | { kind: 'boolean'; key: string; required: boolean }
  | { kind: 'enum'; key: string; required: boolean; options: string[] }
  | { kind: 'objectArray'; key: string; required: boolean; itemFields: FieldSpec[] }
  | { kind: 'json'; key: string; required: boolean } // fallback for anything else

type JsonSchema = Record<string, unknown>

/** Classify a single property's JSON Schema into the FieldSpec it should render as. */
function fieldForProperty(key: string, prop: JsonSchema, required: boolean): FieldSpec {
  const type = prop.type
  if (type === 'string' && Array.isArray(prop.enum)) {
    return { kind: 'enum', key, required, options: prop.enum as string[] }
  }
  if (!('type' in prop) && Array.isArray(prop.enum)) {
    // Defensive: some zod/JSON-Schema emitters drop `type` and emit a bare `enum` array.
    return { kind: 'enum', key, required, options: prop.enum as string[] }
  }
  if (type === 'string') return { kind: 'string', key, required }
  if (type === 'number' || type === 'integer') return { kind: 'number', key, required }
  if (type === 'boolean') return { kind: 'boolean', key, required }
  if (type === 'array') {
    const items = prop.items as JsonSchema | undefined
    if (items && items.type === 'object' && typeof items.properties === 'object') {
      return {
        kind: 'objectArray',
        key,
        required,
        itemFields: fieldsFromSchema(items)
      }
    }
    return { kind: 'json', key, required }
  }
  // Anything else: missing type, unions, or `{}` from z.unknown() -> raw JSON fallback.
  return { kind: 'json', key, required }
}

/** Walk a top-level (or nested item) object JSON Schema into one FieldSpec per `properties`
 *  entry. Non-object schemas (or undefined) have no fields to render -> []. */
export function fieldsFromSchema(schema: JsonSchema | undefined): FieldSpec[] {
  if (!schema) return []
  if (schema.type !== 'object') return []
  const properties = schema.properties
  if (!properties || typeof properties !== 'object') return []
  const requiredKeys = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
  return Object.entries(properties as Record<string, JsonSchema>).map(([key, prop]) =>
    fieldForProperty(key, prop, requiredKeys.has(key))
  )
}
