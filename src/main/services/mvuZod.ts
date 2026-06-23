import { runSandbox } from './sandboxService'
import { clone } from '../../shared/objectPath'

/**
 * MVU Zod schema support (Track R / R4) — clean-room.
 *
 * MVU cards ship a `data_schema` script: untrusted JS that builds a Zod schema and
 * calls `registerMvuSchema(schema)`. We can't run real Zod (or its remote CDN
 * imports) inside the sandbox cheaply, and we won't run untrusted code in Node — so
 * instead the sandbox injects a **recording** Zod-shaped builder (`MVU_ZOD_SHIM`)
 * that captures the schema's *structure* as a plain JSON tree (functions drop out on
 * serialization). A small Node-side interpreter then derives defaults + light
 * validation from that tree. Nothing from MVU / mvu_zod / js-slash-runner is copied.
 */

export interface SchemaNode {
  kind: string
  shape?: Record<string, SchemaNode>
  element?: SchemaNode
  value?: SchemaNode
  values?: unknown[]
  /** `.default()` / `.prefault()` / `.catch()` value. */
  def?: unknown
  isOptional?: boolean
  isNullable?: boolean
  loose?: boolean
  description?: string
}

/** A recording builder with the Zod surface MVU cards use; serializes to a tree. */
export const MVU_ZOD_SHIM = `
(function(){
  function node(kind, extra){
    var n = { kind: kind };
    if (extra) for (var k in extra) n[k] = extra[k];
    n.optional = function(){ n.isOptional = true; return n; };
    n.nullable = function(){ n.isNullable = true; return n; };
    n.nullish = function(){ n.isOptional = true; n.isNullable = true; return n; };
    n['default'] = function(v){ n.def = v; return n; };
    n.prefault = function(v){ n.def = v; return n; };
    n['catch'] = function(v){ n.def = v; return n; };
    n.describe = function(d){ n.description = d; return n; };
    n.transform = function(){ return n; };
    n.refine = function(){ return n; };
    n.superRefine = function(){ return n; };
    n.pipe = function(){ return n; };
    n.min = function(){ return n; };
    n.max = function(){ return n; };
    n.gte = function(){ return n; };
    n.lte = function(){ return n; };
    n.int = function(){ return n; };
    n.positive = function(){ return n; };
    n.nonnegative = function(){ return n; };
    n.length = function(){ return n; };
    n.regex = function(){ return n; };
    n.brand = function(){ return n; };
    n.readonly = function(){ return n; };
    n.array = function(){ return node('array', { element: n }); };
    return n;
  }
  var z = {
    object: function(s){ return node('object', { shape: s || {} }); },
    looseObject: function(s){ return node('object', { shape: s || {}, loose: true }); },
    strictObject: function(s){ return node('object', { shape: s || {} }); },
    string: function(){ return node('string'); },
    number: function(){ return node('number'); },
    boolean: function(){ return node('boolean'); },
    bigint: function(){ return node('number'); },
    date: function(){ return node('string'); },
    any: function(){ return node('any'); },
    unknown: function(){ return node('any'); },
    'null': function(){ return node('null'); },
    'undefined': function(){ return node('any'); },
    literal: function(v){ return node('literal', { value: v }); },
    'enum': function(v){ return node('enum', { values: v }); },
    nativeEnum: function(v){ return node('enum', { values: v }); },
    array: function(el){ return node('array', { element: el }); },
    record: function(a, b){ return node('record', { value: b || a }); },
    map: function(){ return node('record', {}); },
    tuple: function(items){ return node('tuple', { items: items }); },
    union: function(opts){ return node('union', { options: opts }); },
    discriminatedUnion: function(_k, opts){ return node('union', { options: opts }); },
    intersection: function(){ return node('object', { shape: {} }); },
    optional: function(t){ return (t && t.optional) ? t.optional() : node('any').optional(); },
    nullable: function(t){ return (t && t.nullable) ? t.nullable() : node('any').nullable(); },
    lazy: function(fn){ try { return fn(); } catch(e){ return node('any'); } },
    coerce: { number: function(){ return node('number'); }, string: function(){ return node('string'); }, boolean: function(){ return node('boolean'); } }
  };
  z.z = z;
  var registered = null;
  function registerMvuSchema(s){ var x = (typeof s === 'function') ? s() : s; registered = x; return x; }
  globalThis.z = z;
  globalThis.registerMvuSchema = registerMvuSchema;
  globalThis.__mvuImports = { registerMvuSchema: registerMvuSchema, z: z, 'default': z };
  globalThis.__getMvuSchema = function(){ return registered; };
  // Loose stubs the schema build may touch (lodash / jQuery-ready / toastr / YAML).
  globalThis._ = globalThis._ || new Proxy({}, { get: function(){ return function(){ return undefined; }; } });
  globalThis.$ = globalThis.$ || function(fn){ if (typeof fn === 'function'){ try { fn(); } catch(e){} } return { ready: function(f){ try { if (typeof f === 'function') f(); } catch(e){} } }; };
  globalThis.toastr = globalThis.toastr || { info:function(){}, success:function(){}, warning:function(){}, error:function(){} };
  globalThis.YAML = globalThis.YAML || { parse: function(){ return {}; }, stringify: function(){ return ''; } };
})();
`

/** Rewrite a card `data_schema` ES module into a plain script the sandbox can run:
 * imports map to the injected `__mvuImports`, exports are stripped. */
export const rewriteSchemaModule = (code: string): string =>
  code
    .replace(/import\s*\*\s*as\s+(\w+)\s*from\s*['"][^'"]*['"]\s*;?/g, 'const $1 = __mvuImports;')
    .replace(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*['"]\s*;?/g, (_m, names) => {
      return `const {${names.replace(/\s+as\s+/g, ': ')}} = __mvuImports;`
    })
    .replace(/import\s+(\w+)\s*from\s*['"][^'"]*['"]\s*;?/g, 'const $1 = __mvuImports["default"];')
    .replace(/import\s*['"][^'"]*['"]\s*;?/g, '')
    .replace(/export\s+default\s+/g, '')
    .replace(/export\s*\{[^}]*\}\s*;?/g, '')
    .replace(/export\s+(const|let|var|function|class)\s/g, '$1 ')

/** Run a card `data_schema` in the sandbox and return the recorded schema tree. */
export const extractMvuSchema = async (code: string): Promise<SchemaNode | null> => {
  if (!code || !code.trim()) return null
  const job = {
    code: `${MVU_ZOD_SHIM}\n${rewriteSchemaModule(code)}\n;return (typeof __getMvuSchema === 'function') ? __getMvuSchema() : null;`,
    timeoutMs: 2000
  }
  const res = await runSandbox(job)
  return res.ok && res.result && typeof res.result === 'object' ? (res.result as SchemaNode) : null
}

/** Compute the default `stat_data` from a recorded schema tree (walks `.prefault`/
 * `.default` leaves; objects build a skeleton, arrays/records empty). */
export const schemaDefaults = (node: SchemaNode | undefined): unknown => {
  if (!node) return undefined
  if (node.def !== undefined) return clone(node.def)
  switch (node.kind) {
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(node.shape || {})) {
        const d = schemaDefaults(node.shape![k])
        if (d !== undefined) out[k] = d
      }
      return out
    }
    case 'array':
    case 'tuple':
      return []
    case 'record':
      return {}
    case 'enum':
      return node.values && node.values.length ? node.values[0] : undefined
    case 'literal':
      return node.value
    default:
      return undefined // primitives without a default are omitted from the seed
  }
}

/** Light validation/coercion of `stat_data` against the tree: recurse objects (drop
 * unknown keys unless `loose`), map arrays, coerce numeric strings. Lenient — unknown
 * shapes pass through unchanged. Full Zod fidelity is out of scope. */
export const validateStatData = (node: SchemaNode | undefined, data: unknown): unknown => {
  if (!node) return data
  switch (node.kind) {
    case 'object': {
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return data
      const src = data as Record<string, unknown>
      const out: Record<string, unknown> = {}
      const shape = node.shape || {}
      for (const k of Object.keys(shape)) {
        if (k in src) out[k] = validateStatData(shape[k], src[k])
      }
      if (node.loose) for (const k of Object.keys(src)) if (!(k in out)) out[k] = src[k]
      return out
    }
    case 'array':
      return Array.isArray(data) ? data.map((d) => validateStatData(node.element, d)) : data
    case 'number': {
      if (typeof data === 'number') return data
      const n = Number(data)
      return typeof data === 'string' && data.trim() !== '' && !Number.isNaN(n) ? n : data
    }
    default:
      return data
  }
}
