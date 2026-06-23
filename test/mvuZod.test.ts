import { describe, it, expect } from 'vitest'
import {
  extractMvuSchema,
  schemaDefaults,
  validateStatData,
  rewriteSchemaModule,
  SchemaNode
} from '../src/main/services/mvuZod'

// A representative MVU card data_schema: ES-module imports, global `z`, jQuery-ready
// registration — exercises import rewriting, the recording shim, and capture.
const sample = `
import { registerMvuSchema as r } from 'https://cdn/mvu_zod.js';
const d = z.object({
  hero: z.object({ hp: z.number().prefault(100), name: z.string().prefault('Hero') }),
  fate: z.number().prefault(0),
  quests: z.array(z.string()).prefault([]),
  rels: z.record(z.string(), z.number()).prefault({})
});
$(() => { r(d); });
`

describe('rewriteSchemaModule', () => {
  it('maps named (aliased) imports to __mvuImports and strips imports/exports', () => {
    const out = rewriteSchemaModule(
      "import { registerMvuSchema as r, z as t } from 'x';\nexport default d;"
    )
    expect(out).toContain('registerMvuSchema: r')
    expect(out).toContain('z: t')
    expect(out).toContain('__mvuImports')
    expect(out).not.toContain('import')
    expect(out).not.toContain('export')
  })
})

describe('extractMvuSchema (sandboxed)', () => {
  it('records the schema tree from a card data_schema', async () => {
    const node = await extractMvuSchema(sample)
    expect(node).toBeTruthy()
    expect(node!.kind).toBe('object')
    expect(node!.shape!.fate).toMatchObject({ kind: 'number', def: 0 })
    expect(node!.shape!.hero.shape!.hp).toMatchObject({ kind: 'number', def: 100 })
    expect(node!.shape!.quests).toMatchObject({ kind: 'array' })
  })

  it('derives the default stat_data from the extracted tree', async () => {
    const node = await extractMvuSchema(sample)
    expect(schemaDefaults(node!)).toEqual({
      hero: { hp: 100, name: 'Hero' },
      fate: 0,
      quests: [],
      rels: {}
    })
  })

  it('returns null for empty input', async () => {
    expect(await extractMvuSchema('')).toBeNull()
  })
})

describe('schemaDefaults / validateStatData (pure)', () => {
  it('builds object skeletons; omits primitives without a default', () => {
    const tree: SchemaNode = {
      kind: 'object',
      shape: { a: { kind: 'number', def: 5 }, b: { kind: 'string' } }
    }
    expect(schemaDefaults(tree)).toEqual({ a: 5 })
  })

  it('drops unknown keys (strict) but keeps them (loose), and coerces numeric strings', () => {
    const strict: SchemaNode = { kind: 'object', shape: { hp: { kind: 'number' } } }
    expect(validateStatData(strict, { hp: '80', extra: 1 })).toEqual({ hp: 80 })

    const loose: SchemaNode = { kind: 'object', loose: true, shape: { hp: { kind: 'number' } } }
    expect(validateStatData(loose, { hp: 5, extra: 1 })).toEqual({ hp: 5, extra: 1 })
  })
})
