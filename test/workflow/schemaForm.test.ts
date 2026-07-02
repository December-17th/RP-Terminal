import { describe, it, expect } from 'vitest'
import { fieldsFromSchema } from '../../src/renderer/src/components/workflow/schemaForm'
import { listNodeTypes } from '../../src/main/services/nodes/catalog'

const schemaFor = (type: string): Record<string, unknown> | undefined => {
  const info = listNodeTypes().find((t) => t.type === type)
  return info?.configSchema
}

describe('fieldsFromSchema', () => {
  it('undefined -> []', () => {
    expect(fieldsFromSchema(undefined)).toEqual([])
  })

  it('{} (non-object, no properties) -> []', () => {
    expect(fieldsFromSchema({})).toEqual([])
  })

  it('array top-level schema -> []', () => {
    expect(fieldsFromSchema({ type: 'array', items: { type: 'string' } })).toEqual([])
  })

  it('text.template -> single required string field', () => {
    const schema = schemaFor('text.template')
    expect(schema).toBeDefined()
    expect(fieldsFromSchema(schema)).toEqual([{ kind: 'string', key: 'template', required: true }])
  })

  it('control.if -> op enum (9 predicate ops) + value json + path optional string', () => {
    const schema = schemaFor('control.if')
    expect(schema).toBeDefined()
    const fields = fieldsFromSchema(schema)

    const path = fields.find((f) => f.key === 'path')
    expect(path).toEqual({ kind: 'string', key: 'path', required: false })

    const op = fields.find((f) => f.key === 'op')
    expect(op).toEqual({
      kind: 'enum',
      key: 'op',
      required: true,
      options: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'truthy', 'falsy', 'contains']
    })

    const value = fields.find((f) => f.key === 'value')
    expect(value).toEqual({ kind: 'json', key: 'value', required: false })

    expect(fields).toHaveLength(3)
  })

  it('prompt.messages -> objectArray of {role enum, content string}', () => {
    const schema = schemaFor('prompt.messages')
    expect(schema).toBeDefined()
    const fields = fieldsFromSchema(schema)
    expect(fields).toEqual([
      {
        kind: 'objectArray',
        key: 'messages',
        required: true,
        itemFields: [
          {
            kind: 'enum',
            key: 'role',
            required: true,
            options: ['system', 'user', 'assistant']
          },
          { kind: 'string', key: 'content', required: true }
        ]
      }
    ])
  })

  it('mvu.set -> path string required + value json optional', () => {
    const schema = schemaFor('mvu.set')
    expect(schema).toBeDefined()
    const fields = fieldsFromSchema(schema)
    expect(fields).toEqual([
      { kind: 'string', key: 'path', required: true },
      { kind: 'json', key: 'value', required: false }
    ])
  })
})
