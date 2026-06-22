import { describe, it, expect } from 'vitest'
import { buildGeminiBody } from '../src/main/services/apiService'
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
