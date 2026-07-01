import { describe, it, expect, vi } from 'vitest'

// evalTemplate needs the QuickJS WASM engine at runtime — mock it with a marker so tests can
// assert ordering (macros+EJS run before slot substitution) without booting quickjs. Keep the
// real buildTemplateContext (pure constructor) via importActual.
vi.mock('../../src/main/services/templateService', async (importActual) => {
  const actual = await importActual<typeof import('../../src/main/services/templateService')>()
  return {
    ...actual,
    evalTemplate: vi.fn((t: string) => t.replace(/<%=\s*ejs\s*%>/, 'EJS_RAN'))
  }
})

import { textTemplate, interpolate } from '../../src/main/services/nodes/builtin/messageNodes'
import { evalTemplate } from '../../src/main/services/templateService'
import { RunContext, NodeImpl } from '../../src/main/services/nodes/types'
import { GenContext } from '../../src/main/services/generation/types'

const makeCtx = (): RunContext => ({
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
})

/** Mirrors the engine's node.config parsing (workflowEngine.ts): parse raw config through
 *  the impl's configSchema before handing it to run(), as NodeMeta. */
const meta = (impl: NodeImpl, id: string, rawConfig: Record<string, unknown>) => ({
  id,
  config: impl.configSchema!.parse(rawConfig) as Record<string, unknown>
})

/** Minimal fake GenContext with only the fields `interpolate` touches. */
const makeGen = (overrides: Partial<GenContext> = {}): GenContext =>
  ({
    userName: 'Alice',
    card: { data: { name: 'Bob' } },
    workingVars: { x: 42 },
    globals: {},
    settings: { templates: { enabled: true } },
    ...overrides
  }) as unknown as GenContext

describe('interpolate', () => {
  it('substitutes slot values: string passes through, object JSON-encodes, missing -> empty', () => {
    const out = interpolate('a={{in1}} b={{in2}} c={{in3}}', {
      in1: 'hello',
      in2: { a: 1 }
      // in3 intentionally missing/unwired
    })
    expect(out).toBe('a=hello b={"a":1} c=')
  })

  it('substitutes slots AFTER macros+EJS, so a slot value containing {{user}} stays literal', () => {
    const gen = makeGen()
    const out = interpolate('slot=[{{in1}}] direct={{user}}', { in1: '{{user}}' }, gen)
    // The template's OWN {{user}} expands (macros ran on the template text), but the slot's
    // VALUE of literal "{{user}}" must NOT be re-expanded — slot substitution happens last.
    expect(out).toBe('slot=[{{user}}] direct=Alice')
  })

  it('expands macros from gen (user/char/vars/globals) in the template text', () => {
    const gen = makeGen({ userName: 'Alice', workingVars: { x: 42 }, globals: { g: 'G' } })
    const out = interpolate(
      'user={{user}} char={{char}} x={{getvar::x}} g={{getglobalvar::g}}',
      {},
      gen
    )
    expect(out).toBe('user=Alice char=Bob x=42 g=G')
  })

  it('substitutes slots AFTER EJS, so a slot value containing EJS tags stays literal', () => {
    const gen = makeGen()
    const out = interpolate('slot=[{{in1}}] direct=<%= ejs %>', { in1: '<%= ejs %>' }, gen)
    // The template's OWN EJS tag ran (marker), but the slot's VALUE must come through as
    // literal template code — EJS ran before slot substitution, never on upstream data.
    expect(out).toBe('slot=[<%= ejs %>] direct=EJS_RAN')
  })

  it('runs EJS only when gen is wired (marker present with gen, absent without)', () => {
    const gen = makeGen()
    const withGen = interpolate('<%= ejs %>', {}, gen)
    expect(withGen).toBe('EJS_RAN')
    expect(evalTemplate).toHaveBeenCalled()

    vi.mocked(evalTemplate).mockClear()
    const withoutGen = interpolate('<%= ejs %>', {})
    expect(withoutGen).toBe('<%= ejs %>')
    expect(evalTemplate).not.toHaveBeenCalled()
  })

  it('no gen: only slot substitution happens, macro/EJS placeholders in the template text are untouched', () => {
    const out = interpolate('{{user}} <%= ejs %> {{in1}}', { in1: 'hi' })
    expect(out).toBe('{{user}} <%= ejs %> hi')
  })
})

describe('text.template', () => {
  it('descriptor: gen:Context + in1-in4:Any + when:Signal inputs, text:Text output', () => {
    expect(textTemplate.type).toBe('text.template')
    expect(textTemplate.inputs).toEqual([
      { name: 'gen', type: 'Context' },
      { name: 'in1', type: 'Any' },
      { name: 'in2', type: 'Any' },
      { name: 'in3', type: 'Any' },
      { name: 'in4', type: 'Any' },
      { name: 'when', type: 'Signal' }
    ])
    expect(textTemplate.outputs).toEqual([{ name: 'text', type: 'Text' }])
  })

  it('renders the configured template with wired gen + slots', async () => {
    const ctx = makeCtx()
    const gen = makeGen()
    const node = meta(textTemplate, 'n1', { template: 'Hello {{user}}, {{in1}}' })
    const res = await textTemplate.run(ctx, { gen, in1: 'welcome' }, node)
    expect(res).toEqual({ outputs: { text: 'Hello Alice, welcome' } })
  })

  it('renders with no gen wired: slots only', async () => {
    const ctx = makeCtx()
    const node = meta(textTemplate, 'n1', { template: '{{in1}} / {{in2}}' })
    const res = await textTemplate.run(ctx, { in1: 'a', in2: { b: 2 } }, node)
    expect(res).toEqual({ outputs: { text: 'a / {"b":2}' } })
  })
})
