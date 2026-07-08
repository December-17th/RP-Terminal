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

import {
  textTemplate,
  interpolate,
  promptMessages,
  mergeMessages
} from '../../src/main/services/nodes/builtin/messageNodes'
import { evalTemplate } from '../../src/main/services/templateService'
import { RunContext, NodeImpl } from '../../src/main/services/nodes/types'
import { GenContext } from '../../src/main/services/generation/types'
import { ChatMessage } from '../../src/main/services/promptBuilder'

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

/** Fake GenContext for the message-list nodes: also carries the api/generation settings fields
 *  providerShape reads (api.provider, generation.system_as_user, generation.merge_consecutive_roles). */
const makeGenWithSettings = (settingsOverrides: Record<string, unknown> = {}): GenContext =>
  makeGen({
    settings: {
      templates: { enabled: true },
      api: { provider: 'anthropic', endpoint: '', api_key: '', model: '' },
      generation: {},
      ...settingsOverrides
    } as unknown as GenContext['settings']
  })

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

  it('substitutes {{input}} from the `input` slot (agent.llm payload port): string passes, object JSON-encodes', () => {
    expect(interpolate('block=[{{input}}]', { input: 'TABLE BLOCK' })).toBe('block=[TABLE BLOCK]')
    expect(interpolate('block=[{{input}}]', { input: { a: 1 } })).toBe('block=[{"a":1}]')
  })

  it('leaves {{input}} literal when no `input` slot is wired (text.template / prompt.messages case)', () => {
    // Only agent.llm supplies an `input` slot; the generic authoring nodes must not eat {{input}}.
    expect(interpolate('a={{in1}} b={{input}}', { in1: 'x' })).toBe('a=x b={{input}}')
  })

  it('substitutes {{input}} AFTER macros+EJS, so a table block carrying {{…}}/<%…%> stays literal', () => {
    const gen = makeGen()
    const out = interpolate('block=[{{input}}] direct={{user}}', { input: '{{user}} <%= ejs %>' }, gen)
    // The template's own {{user}} expands, but the input payload's macro/EJS text must NOT run —
    // {{input}} is data, substituted last (the {{inN}} invariant).
    expect(out).toBe('block=[{{user}} <%= ejs %>] direct=Alice')
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

describe('prompt.messages', () => {
  it('descriptor: gen:Context + in1-in4:Any + when:Signal inputs, messages:Messages output', () => {
    expect(promptMessages.type).toBe('prompt.messages')
    expect(promptMessages.inputs).toEqual([
      { name: 'gen', type: 'Context' },
      { name: 'in1', type: 'Any' },
      { name: 'in2', type: 'Any' },
      { name: 'in3', type: 'Any' },
      { name: 'in4', type: 'Any' },
      { name: 'when', type: 'Signal' }
    ])
    expect(promptMessages.outputs).toEqual([{ name: 'messages', type: 'Messages' }])
  })

  it('builds role rows from config and interpolates each row (slots + macros)', async () => {
    const ctx = makeCtx()
    // Distinct roles (system/user) so provider-shaping (merge/order) is a no-op here — this
    // case is about row-building + interpolation, not shaping (covered separately below).
    const gen = makeGenWithSettings()
    const node = meta(promptMessages, 'n1', {
      messages: [
        { role: 'system', content: 'You are {{char}}.' },
        { role: 'user', content: '{{in1}}' }
      ]
    })
    const res = await promptMessages.run(ctx, { gen, in1: 'hi there' }, node)
    expect(res).toEqual({
      outputs: {
        messages: [
          { role: 'system', content: 'You are Bob.' },
          { role: 'user', content: 'hi there' }
        ]
      }
    })
  })

  it('returns raw interpolated rows (no provider shaping) when gen is unwired', async () => {
    const ctx = makeCtx()
    const node = meta(promptMessages, 'n1', {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'system', content: 'sys2' }
      ]
    })
    const res = await promptMessages.run(ctx, {}, node)
    // No gen -> no providerShape call -> consecutive system rows stay unmerged.
    expect(res).toEqual({
      outputs: {
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'system', content: 'sys2' }
        ]
      }
    })
  })

  it('provider-shapes the row list when gen is wired (system→user + merge, OpenAI-compatible)', async () => {
    const ctx = makeCtx()
    const gen = makeGenWithSettings({
      api: { provider: 'openai', endpoint: '', api_key: '', model: '' },
      generation: { system_as_user: true }
    })
    const node = meta(promptMessages, 'n1', {
      messages: [
        { role: 'system', content: 'sys1' },
        { role: 'system', content: 'sys2' }
      ]
    })
    const res = await promptMessages.run(ctx, { gen }, node)
    // system_as_user relabels both rows to 'user', then merge_consecutive_roles (default on)
    // coalesces them into one message.
    expect(res).toEqual({ outputs: { messages: [{ role: 'user', content: 'sys1\nsys2' }] } })
  })

  it('provider-shapes with default settings (anthropic, no system_as_user): merges consecutive roles only', async () => {
    const ctx = makeCtx()
    const gen = makeGenWithSettings()
    const node = meta(promptMessages, 'n1', {
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' }
      ]
    })
    const res = await promptMessages.run(ctx, { gen }, node)
    expect(res).toEqual({ outputs: { messages: [{ role: 'user', content: 'a\nb' }] } })
  })
})

describe('merge.messages', () => {
  const msg = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content })

  it('descriptor: gen:Context + a-d:Messages + when:Signal inputs, messages:Messages output', () => {
    expect(mergeMessages.type).toBe('merge.messages')
    expect(mergeMessages.inputs).toEqual([
      { name: 'gen', type: 'Context' },
      { name: 'a', type: 'Messages' },
      { name: 'b', type: 'Messages' },
      { name: 'c', type: 'Messages' },
      { name: 'd', type: 'Messages' },
      { name: 'when', type: 'Signal' }
    ])
    expect(mergeMessages.outputs).toEqual([{ name: 'messages', type: 'Messages' }])
  })

  it('concatenates wired ports a->d in port order, skipping unwired ports, with no gen wired', () => {
    const ctx = makeCtx()
    const node = { id: 'n1', config: {} }
    const a = [msg('system', 's1')]
    const c = [msg('user', 'u1'), msg('assistant', 'a1')]
    const res = mergeMessages.run(ctx, { a, c }, node)
    expect(res).toEqual({
      outputs: { messages: [msg('system', 's1'), msg('user', 'u1'), msg('assistant', 'a1')] }
    })
  })

  it('returns [] when no ports are wired and gen is unwired', () => {
    const ctx = makeCtx()
    const node = { id: 'n1', config: {} }
    const res = mergeMessages.run(ctx, {}, node)
    expect(res).toEqual({ outputs: { messages: [] } })
  })

  it('provider-shapes the merged list when gen is wired', () => {
    const ctx = makeCtx()
    const gen = makeGenWithSettings()
    const node = { id: 'n1', config: {} }
    const a = [msg('user', 'a')]
    const b = [msg('user', 'b')]
    const res = mergeMessages.run(ctx, { gen, a, b }, node)
    // merge_consecutive_roles default-on coalesces the two user rows across the a/b seam.
    expect(res).toEqual({ outputs: { messages: [msg('user', 'a\nb')] } })
  })
})
