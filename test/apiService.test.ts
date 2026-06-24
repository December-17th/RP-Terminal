import { describe, it, expect } from 'vitest'
import { buildGeminiBody, thinkAssembler, orderForProvider } from '../src/main/services/apiService'
import { ChatMessage } from '../src/main/services/promptBuilder'

const params = (p: Record<string, number> = {}): any => ({
  temperature: 0.9,
  max_tokens: 4000,
  ...p
})

describe('buildGeminiBody', () => {
  it('hoists the leading system run into systemInstruction and maps assistant→model', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are Aria.' },
      { role: 'system', content: 'World Info: dragons.' },
      { role: 'assistant', content: 'Hello traveler' },
      { role: 'user', content: 'I wave' }
    ]
    const body: any = buildGeminiBody(msgs, params())
    expect(body.systemInstruction.parts[0].text).toContain('You are Aria.')
    expect(body.systemInstruction.parts[0].text).toContain('World Info: dragons.')
    expect(body.contents).toEqual([
      { role: 'model', parts: [{ text: 'Hello traveler' }] },
      { role: 'user', parts: [{ text: 'I wave' }] }
    ])
  })

  it('demotes a post-conversation (inline) system block to a user turn and merges it', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'system', content: 'depth-injected lore' }, // inline → user
      { role: 'user', content: 'u2' }
    ]
    const body: any = buildGeminiBody(msgs, params())
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'u1' }] },
      { role: 'model', parts: [{ text: 'a1' }] },
      { role: 'user', parts: [{ text: 'depth-injected lore\n\nu2' }] }
    ])
  })

  it('maps sampler params onto camelCase generationConfig and omits unset ones', () => {
    const body: any = buildGeminiBody(
      [{ role: 'user', content: 'hi' }],
      params({ top_p: 0.8, top_k: 40, max_tokens: 500 })
    )
    expect(body.generationConfig).toMatchObject({
      temperature: 0.9,
      maxOutputTokens: 500,
      topP: 0.8,
      topK: 40
    })
    expect('topA' in body.generationConfig).toBe(false)
    expect('top_p' in body.generationConfig).toBe(false)
  })

  it('omits systemInstruction when there is no leading system message', () => {
    const body: any = buildGeminiBody([{ role: 'user', content: 'hi' }], params())
    expect('systemInstruction' in body).toBe(false)
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
  })
})

describe('orderForProvider (end-on-user vs preserving a trailing assistant prefill)', () => {
  const m = (role: ChatMessage['role'], content = ''): ChatMessage => ({ role, content })

  it('keeps a trailing assistant prefill LAST so the model continues it (CoT [START THINKING])', () => {
    const msgs = [m('system', 's'), m('user', 'u'), m('assistant', 'PREFILL')]
    expect(orderForProvider(msgs, 'openai')).toEqual(msgs) // unchanged — prefill stays last
  })

  it('moves the last user message to the end when the trailing blocks are system (strict backends)', () => {
    const msgs = [m('system', 's'), m('user', 'u'), m('system', 'jailbreak')]
    expect(orderForProvider(msgs, 'openai')).toEqual([
      m('system', 's'),
      m('system', 'jailbreak'),
      m('user', 'u')
    ])
  })

  it('is a no-op when the user message is already last', () => {
    const msgs = [m('system', 's'), m('user', 'u')]
    expect(orderForProvider(msgs, 'openai')).toEqual(msgs)
  })

  it('leaves non-OpenAI providers (anthropic/gemini) untouched', () => {
    const msgs = [m('user', 'u'), m('system', 'x')]
    expect(orderForProvider(msgs, 'anthropic')).toEqual(msgs)
    expect(orderForProvider(msgs, 'gemini')).toEqual(msgs)
  })
})

describe('thinkAssembler (inline side-channel reasoning as <think>)', () => {
  const run = (
    steps: (a: ReturnType<typeof thinkAssembler>) => void
  ): { full: string; streamed: string } => {
    const deltas: string[] = []
    const a = thinkAssembler((d) => deltas.push(d))
    steps(a)
    return { full: a.done(), streamed: deltas.join('') }
  }

  it('wraps a reasoning run + content into one leading <think> block (streamed identically)', () => {
    const { full, streamed } = run((a) => {
      a.reasoning('think ')
      a.reasoning('hard')
      a.content('The answer.')
    })
    expect(full).toBe('<think>think hard</think>\n\nThe answer.')
    expect(streamed).toBe(full)
  })

  it('passes content through untouched when there is no reasoning', () => {
    expect(run((a) => a.content('Just narrative.')).full).toBe('Just narrative.')
  })

  it('closes a dangling reasoning-only stream', () => {
    expect(run((a) => a.reasoning('only thinking')).full).toBe('<think>only thinking</think>')
  })

  it('ignores empty chunks', () => {
    const { full } = run((a) => {
      a.reasoning('')
      a.content('')
      a.content('x')
    })
    expect(full).toBe('x')
  })
})
