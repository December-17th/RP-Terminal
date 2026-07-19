import { fromJSONSchema } from 'zod'
import type { ContractPath } from './errors'
import type { JsonSchema } from './types'

export interface JsonSchemaSemanticIssue {
  path: ContractPath
  message: string
  code?: 'invalid' | 'unsupported'
}

const JSON_SCHEMA_TYPES = new Set([
  'null',
  'boolean',
  'object',
  'array',
  'number',
  'integer',
  'string'
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const issue = (path: ContractPath, message: string): JsonSchemaSemanticIssue => ({
  path,
  message
})

const unsupportedIssue = (path: ContractPath, message: string): JsonSchemaSemanticIssue => ({
  path,
  message,
  code: 'unsupported'
})

const SUPPORTED_RUNTIME_KEYWORDS = new Set([
  '$schema',
  '$id',
  'id',
  '$ref',
  '$defs',
  'definitions',
  '$comment',
  '$anchor',
  '$vocabulary',
  'type',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'properties',
  'required',
  'additionalProperties',
  'patternProperties',
  'propertyNames',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'description',
  'default',
  'nullable',
  'readOnly'
])

const RUNTIME_STRING_FORMATS = new Set([
  'email',
  'uri',
  'uri-reference',
  'uuid',
  'guid',
  'date-time',
  'date',
  'time',
  'duration',
  'ipv4',
  'ipv6',
  'mac',
  'cidr',
  'cidr-v6',
  'base64',
  'base64url',
  'e164',
  'jwt',
  'emoji',
  'nanoid',
  'cuid',
  'cuid2',
  'ulid',
  'xid',
  'ksuid'
])

const validateSchema = (schema: unknown, path: ContractPath): JsonSchemaSemanticIssue[] => {
  if (typeof schema === 'boolean') return []
  if (!isRecord(schema)) return [issue(path, 'JSON Schema must be an object or boolean')]

  const errors: JsonSchemaSemanticIssue[] = []
  const add = (field: string, message: string): void => {
    errors.push(issue([...path, field], message))
  }
  const addUnsupported = (field: string, message: string): void => {
    errors.push(unsupportedIssue([...path, field], message))
  }
  const validateNested = (field: string): void => {
    if (schema[field] !== undefined) {
      errors.push(...validateSchema(schema[field], [...path, field]))
    }
  }
  const validateSchemaRecord = (field: string): void => {
    const value = schema[field]
    if (value === undefined) return
    if (!isRecord(value)) {
      add(field, `${field} must be an object whose values are JSON Schemas`)
      return
    }
    for (const [key, nested] of Object.entries(value)) {
      errors.push(...validateSchema(nested, [...path, field, key]))
    }
  }
  const validateSchemaArray = (field: string): void => {
    const value = schema[field]
    if (value === undefined) return
    if (!Array.isArray(value) || value.length === 0) {
      add(field, `${field} must be a non-empty array of JSON Schemas`)
      return
    }
    value.forEach((nested, index) => {
      errors.push(...validateSchema(nested, [...path, field, index]))
    })
  }

  for (const field of Object.keys(schema)) {
    if (!SUPPORTED_RUNTIME_KEYWORDS.has(field)) {
      addUnsupported(field, `${field} is not supported by the Agent runtime JSON Schema validator`)
    }
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (
      types.length === 0 ||
      types.some((type) => typeof type !== 'string' || !JSON_SCHEMA_TYPES.has(type)) ||
      new Set(types).size !== types.length
    ) {
      add(
        'type',
        'type must be a JSON Schema type or a non-empty array of unique JSON Schema types'
      )
    }
  }

  for (const field of ['$schema', '$id', '$ref', '$anchor', '$dynamicRef', '$dynamicAnchor']) {
    if (schema[field] !== undefined && typeof schema[field] !== 'string') {
      add(field, `${field} must be a string`)
    }
  }

  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    add('enum', 'enum must be a non-empty array')
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      schema.required.some((name) => typeof name !== 'string') ||
      new Set(schema.required).size !== schema.required.length)
  ) {
    add('required', 'required must be an array of unique property names')
  }

  for (const field of [
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'minContains',
    'maxContains',
    'minProperties',
    'maxProperties'
  ]) {
    const value = schema[field]
    if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) {
      add(field, `${field} must be a non-negative integer`)
    }
  }
  for (const field of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
    const value = schema[field]
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      add(field, `${field} must be a finite number`)
    }
  }
  if (
    schema.multipleOf !== undefined &&
    (typeof schema.multipleOf !== 'number' ||
      !Number.isFinite(schema.multipleOf) ||
      schema.multipleOf <= 0)
  ) {
    add('multipleOf', 'multipleOf must be a positive finite number')
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') {
      add('pattern', 'pattern must be a string')
    } else {
      try {
        new RegExp(schema.pattern)
      } catch {
        add('pattern', 'pattern must be a valid regular expression')
      }
    }
  }
  if (
    schema.format !== undefined &&
    (typeof schema.format !== 'string' || !RUNTIME_STRING_FORMATS.has(schema.format))
  ) {
    addUnsupported(
      'format',
      'format must name a format supported by the Agent runtime JSON Schema validator'
    )
  }
  if (schema.not !== undefined) {
    if (!isRecord(schema.not) || Object.keys(schema.not).length !== 0) {
      addUnsupported(
        'not',
        'not is supported only as an empty schema by the Agent runtime JSON Schema validator'
      )
    }
  }
  for (const field of ['nullable', 'readOnly']) {
    if (schema[field] !== undefined && typeof schema[field] !== 'boolean') {
      add(field, `${field} must be a boolean`)
    }
  }
  if (schema.patternProperties !== undefined && isRecord(schema.patternProperties)) {
    for (const pattern of Object.keys(schema.patternProperties)) {
      try {
        new RegExp(pattern)
      } catch {
        errors.push(issue([...path, 'patternProperties', pattern], 'property pattern is invalid'))
      }
    }
  }

  for (const field of ['$defs', 'definitions', 'properties', 'patternProperties']) {
    validateSchemaRecord(field)
  }
  for (const field of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) validateSchemaArray(field)
  for (const field of [
    'additionalProperties',
    'unevaluatedProperties',
    'propertyNames',
    'items',
    'contains',
    'not'
  ]) {
    validateNested(field)
  }

  return errors
}

export const validateJsonSchemaSemantics = (schema: JsonSchema): JsonSchemaSemanticIssue[] =>
  (() => {
    const errors = validateSchema(schema, [])
    if (errors.length) return errors
    try {
      fromJSONSchema(schema as never)
      return []
    } catch (cause) {
      return [
        unsupportedIssue(
          [],
          cause instanceof Error
            ? cause.message
            : 'JSON Schema is not supported by the Agent runtime validator'
        )
      ]
    }
  })()

export const isObjectInputSchema = (schema: JsonSchema): boolean => schema.type === 'object'
