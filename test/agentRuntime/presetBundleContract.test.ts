import { describe, expect, it } from 'vitest'
import { parseAgentDefinition } from '../../src/shared/agentRuntime'
import { MONTHLY_PROPERTY_AGENT } from './fixtures/contracts'

/**
 * ADR 0021 slice 1: an Agent Definition may bundle a prompt preset. Contracts only — nothing
 * consumes the bundle yet, so these tests pin the shape and its error reporting.
 */
const ENVELOPE = {
  source: { bytes: '{"prompts":[]}', sha256: 'abc123' },
  parsed: { prompts: [{ identifier: 'main', content: 'You are a world simulator.' }] }
}

const withPreset = (preset: unknown): unknown => ({ ...MONTHLY_PROPERTY_AGENT, preset })

describe('AgentPresetBundle contract', () => {
  it('parses a definition with no preset unchanged', () => {
    const result = parseAgentDefinition(MONTHLY_PROPERTY_AGENT)

    expect(result.ok ? [] : result.errors).toEqual([])
    if (!result.ok) return
    expect('preset' in result.value).toBe(false)
  })

  it('accepts a bundle alongside the required prompt', () => {
    const result = parseAgentDefinition(withPreset({ preset: ENVELOPE }))

    expect(result.ok ? [] : result.errors).toEqual([])
    if (!result.ok) return
    expect(result.value.preset?.preset).toEqual(ENVELOPE)
    expect(result.value.prompt).toHaveLength(2)
  })

  it('parses generation-parameter overrides inside the bundle', () => {
    const result = parseAgentDefinition(
      withPreset({
        preset: ENVELOPE,
        generationParameters: { temperature: 0.4, max_tokens: 2048, stop: ['<|end|>'] }
      })
    )

    expect(result.ok ? [] : result.errors).toEqual([])
    if (!result.ok) return
    expect(result.value.preset?.generationParameters).toEqual({
      temperature: 0.4,
      max_tokens: 2048,
      stop: ['<|end|>']
    })
  })

  it('rejects an unknown generation parameter inside the bundle', () => {
    const result = parseAgentDefinition(
      withPreset({ preset: ENVELOPE, generationParameters: { temperature: 0.4, seed: 7 } })
    )

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'UNKNOWN_FIELD',
          path: ['preset', 'generationParameters', 'seed'],
          location: {
            kind: 'field',
            agent: 'Property Management',
            field: 'preset.generationParameters.seed'
          }
        })
      ]
    })
  })

  it('rejects an unknown key inside the bundle', () => {
    const result = parseAgentDefinition(
      withPreset({ preset: ENVELOPE, apiPresetId: 'user-local-openrouter' })
    )

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'UNKNOWN_FIELD',
          path: ['preset', 'apiPresetId'],
          location: {
            kind: 'field',
            agent: 'Property Management',
            field: 'preset.apiPresetId'
          }
        })
      ]
    })
  })

  it('requires the envelope', () => {
    const result = parseAgentDefinition(withPreset({ generationParameters: { temperature: 1 } }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toEqual(
      expect.objectContaining({
        path: ['preset', 'preset'],
        location: expect.objectContaining({ field: 'preset.preset' })
      })
    )
  })

  describe('lorebook selection', () => {
    const withLorebooks = (lorebooks: unknown): unknown =>
      withPreset({ preset: ENVELOPE, lorebooks })

    it('accepts the session lorebook set', () => {
      const result = parseAgentDefinition(withLorebooks({ mode: 'session' }))

      expect(result.ok ? [] : result.errors).toEqual([])
      if (!result.ok) return
      expect(result.value.preset?.lorebooks).toEqual({ mode: 'session' })
    })

    it('accepts the session set narrowed by entry include/exclude', () => {
      const result = parseAgentDefinition(
        withLorebooks({
          mode: 'session',
          entries: { include: ['Economy', 'Factions'], exclude: ['Spoilers'] }
        })
      )

      expect(result.ok ? [] : result.errors).toEqual([])
      if (!result.ok) return
      expect(result.value.preset?.lorebooks).toEqual({
        mode: 'session',
        entries: { include: ['Economy', 'Factions'], exclude: ['Spoilers'] }
      })
    })

    it('accepts an explicit lorebook list', () => {
      const result = parseAgentDefinition(
        withLorebooks({ mode: 'explicit', lorebooks: ['World Politics'] })
      )

      expect(result.ok ? [] : result.errors).toEqual([])
      if (!result.ok) return
      expect(result.value.preset?.lorebooks).toEqual({
        mode: 'explicit',
        lorebooks: ['World Politics']
      })
    })

    it('accepts an explicit list narrowed by entry exclude', () => {
      const result = parseAgentDefinition(
        withLorebooks({
          mode: 'explicit',
          lorebooks: ['World Politics', 'Trade Routes'],
          entries: { exclude: ['Draft notes'] }
        })
      )

      expect(result.ok ? [] : result.errors).toEqual([])
      if (!result.ok) return
      expect(result.value.preset?.lorebooks?.entries).toEqual({ exclude: ['Draft notes'] })
    })

    it('rejects an explicit selection with no lorebooks', () => {
      const result = parseAgentDefinition(withLorebooks({ mode: 'explicit', lorebooks: [] }))

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.errors[0]).toEqual(
        expect.objectContaining({
          path: ['preset', 'lorebooks', 'lorebooks'],
          location: expect.objectContaining({ field: 'preset.lorebooks.lorebooks' })
        })
      )
    })

    it('rejects an unknown lorebook selection mode', () => {
      const result = parseAgentDefinition(withLorebooks({ mode: 'card' }))

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.errors[0]?.path).toEqual(['preset', 'lorebooks', 'mode'])
    })

    it('rejects an entry filter that narrows nothing', () => {
      const result = parseAgentDefinition(withLorebooks({ mode: 'session', entries: {} }))

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.errors[0]).toEqual(
        expect.objectContaining({
          message: 'entries must narrow with include or exclude',
          path: ['preset', 'lorebooks', 'entries']
        })
      )
    })

    it('rejects an entry named in both include and exclude', () => {
      const result = parseAgentDefinition(
        withLorebooks({ mode: 'session', entries: { include: ['Economy'], exclude: ['Economy'] } })
      )

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.errors[0]).toEqual(
        expect.objectContaining({
          message: 'entry "Economy" cannot be both included and excluded',
          path: ['preset', 'lorebooks', 'entries', 'exclude', 0]
        })
      )
    })

    it('rejects an unknown key inside the entry filter', () => {
      const result = parseAgentDefinition(
        withLorebooks({ mode: 'session', entries: { include: ['Economy'], depth: 3 } })
      )

      expect(result).toEqual({
        ok: false,
        errors: [
          expect.objectContaining({
            code: 'UNKNOWN_FIELD',
            path: ['preset', 'lorebooks', 'entries', 'depth']
          })
        ]
      })
    })
  })
})
