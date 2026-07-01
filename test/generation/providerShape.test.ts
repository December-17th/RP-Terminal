import { describe, it, expect } from 'vitest'
import { providerShape } from '../../src/main/services/generation/providerShape'
import { ChatMessage } from '../../src/main/services/promptBuilder'
import { Settings } from '../../src/main/types/models'

/** Minimal Settings fixture — providerShape only reads api.provider + generation.*. */
const makeSettings = (overrides: {
  provider: string
  system_as_user?: boolean
  merge_consecutive_roles?: boolean
}): Settings =>
  ({
    api: { provider: overrides.provider, endpoint: '', api_key: '', model: '' },
    generation: {
      system_as_user: overrides.system_as_user,
      merge_consecutive_roles: overrides.merge_consecutive_roles
    }
  }) as unknown as Settings

describe('providerShape', () => {
  it('applies system→user only when system_as_user is true AND provider is OpenAI-compatible', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' }
    ]

    const openaiShaped = providerShape(
      makeSettings({ provider: 'openai', system_as_user: true }),
      msgs
    )
    expect(openaiShaped.some((m) => m.role === 'system')).toBe(false)
    // system→user relabels 'sys' to a user turn, then merge_consecutive_roles (default on)
    // coalesces it with the adjacent 'hi' user turn into one message.
    expect(openaiShaped).toEqual([{ role: 'user', content: 'sys\nhi' }])

    const anthropicShaped = providerShape(
      makeSettings({ provider: 'anthropic', system_as_user: true }),
      msgs
    )
    expect(anthropicShaped.some((m) => m.role === 'system')).toBe(true)
  })

  it('does not apply system→user when system_as_user is false, even on an OpenAI-compatible provider', () => {
    const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }]
    const shaped = providerShape(makeSettings({ provider: 'openai', system_as_user: false }), msgs)
    expect(shaped).toEqual(msgs)
  })

  it('merges consecutive same-role messages by default', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' }
    ]
    const shaped = providerShape(makeSettings({ provider: 'anthropic' }), msgs)
    expect(shaped).toEqual([{ role: 'user', content: 'a\nb' }])
  })

  it('does not merge consecutive same-role messages when merge_consecutive_roles is false', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' }
    ]
    const shaped = providerShape(
      makeSettings({ provider: 'anthropic', merge_consecutive_roles: false }),
      msgs
    )
    expect(shaped).toEqual(msgs)
  })

  it('applies provider ordering: OpenAI-compatible provider keeps a trailing assistant prefill last', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'prefill' }
    ]
    const shaped = providerShape(makeSettings({ provider: 'openai' }), msgs)
    expect(shaped).toEqual(msgs) // orderForProvider: trailing assistant is kept last, unchanged
  })

  it('applies provider ordering: OpenAI-compatible provider moves a non-trailing last-user message to the end', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'system', content: 'trailing-non-user' }
    ]
    const shaped = providerShape(makeSettings({ provider: 'openai' }), msgs)
    // orderForProvider moves the last 'user' message (index 0) to the end when the array doesn't
    // already end on a user turn and doesn't end on an assistant prefill.
    expect(shaped).toEqual([
      { role: 'assistant', content: 'a1' },
      { role: 'system', content: 'trailing-non-user' },
      { role: 'user', content: 'u1' }
    ])
  })

  it('anthropic/google providers are left in original order (orderForProvider is a no-op)', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' }
    ]
    const shaped = providerShape(makeSettings({ provider: 'anthropic' }), msgs)
    expect(shaped).toEqual(msgs)
  })
})
