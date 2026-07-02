import { describe, it, expect, vi, beforeEach } from 'vitest'

// Spec §10 failure primitives around callModel: class-A retry/backoff, fallback connection,
// validator + corrective retry, NodeRunFailure give-up. callModel itself is mocked — these
// tests pin the orchestration.

const { callModel } = vi.hoisted(() => ({ callModel: vi.fn() }))
vi.mock('../../src/main/services/generation/callModel', () => ({ callModel }))
vi.mock('../../src/main/services/logService', () => ({ log: () => {} }))

import {
  callModelResilient,
  validateOutput
} from '../../src/main/services/generation/resilientCall'
import { NodeRunFailure } from '../../src/main/services/nodes/types'
import type { GenContext } from '../../src/main/services/generation/types'

const gen = {
  settings: {
    api: { provider: 'openai', endpoint: 'https://primary/v1', api_key: 'k', model: 'm' },
    api_presets: [
      {
        id: 'fb1',
        name: 'Backup',
        provider: 'anthropic',
        endpoint: 'https://backup/v1',
        api_key: 'k2',
        model: 'm2',
        rpm_limit: 5
      }
    ]
  }
} as unknown as GenContext

const ok = (raw: string): { raw: string; rawUsage: unknown; stopped: boolean } => ({
  raw,
  rawUsage: null,
  stopped: false
})

const signal = (): AbortSignal => new AbortController().signal
const noDelta = (): string[] => []

describe('callModelResilient', () => {
  // Braces matter: mockReset() returns the mock, and a beforeEach RETURN value is treated by
  // vitest as a teardown hook — it would call the mock with no args after every test.
  beforeEach(() => {
    callModel.mockReset()
  })

  it('empty config = exactly one callModel call, streaming live', async () => {
    callModel.mockImplementation(async (_g, _m, _p, onDelta) => {
      onDelta('hello')
      return ok('hello')
    })
    const deltas: string[] = []
    const r = await callModelResilient(gen, [], {}, (d) => deltas.push(d), signal())
    expect(r).toEqual(ok('hello'))
    expect(callModel).toHaveBeenCalledTimes(1)
    expect(deltas).toEqual(['hello'])
  })

  it('retries a class-A failure and succeeds; a post-stream retry fills silently', async () => {
    callModel
      .mockImplementationOnce(async (_g, _m, _p, onDelta) => {
        onDelta('partial ') // streamed, then the connection died
        throw new Error('ECONNRESET')
      })
      .mockImplementationOnce(async (_g, _m, _p, onDelta) => {
        onDelta('full reply')
        return ok('full reply')
      })
    const deltas: string[] = []
    const r = await callModelResilient(
      gen,
      [],
      {},
      (d) => deltas.push(d),
      signal(),
      { retries: 1, backoff_ms: 0 }
    )
    expect(r).toEqual(ok('full reply'))
    expect(callModel).toHaveBeenCalledTimes(2)
    // The retry does NOT re-stream over the partial text — the floor carries the real reply.
    expect(deltas).toEqual(['partial '])
  })

  it('gives up as class A with the burned attempt count', async () => {
    callModel.mockRejectedValue(new Error('API Error: 500'))
    const err = await callModelResilient(gen, [], {}, () => {}, signal(), {
      retries: 1,
      backoff_ms: 0
    }).catch((e) => e)
    expect(err).toBeInstanceOf(NodeRunFailure)
    expect(err.kind).toBe('A')
    expect(err.attempts).toBe(2)
    expect(err.message).toBe('API Error: 500')
  })

  it('an abort (callModel → null) is returned immediately, never retried', async () => {
    callModel.mockResolvedValue(null)
    const r = await callModelResilient(gen, [], {}, () => {}, signal(), {
      retries: 3,
      backoff_ms: 0
    })
    expect(r).toBeNull()
    expect(callModel).toHaveBeenCalledTimes(1)
  })

  it('falls back to the alternate preset connection after the primary exhausts', async () => {
    callModel
      .mockRejectedValueOnce(new Error('auth failed'))
      .mockImplementationOnce(async (g: GenContext) => ok(`via ${g.settings.api.endpoint}`))
    const r = await callModelResilient(gen, [], {}, () => {}, signal(), {
      backoff_ms: 0,
      fallback_preset_id: 'fb1'
    })
    expect(r?.raw).toBe('via https://backup/v1')
    // The fallback carries the preset's whole connection, rpm_limit included.
    const fbGen = callModel.mock.calls[1][0] as GenContext
    expect(fbGen.settings.api).toEqual({
      provider: 'anthropic',
      endpoint: 'https://backup/v1',
      api_key: 'k2',
      model: 'm2',
      rpm_limit: 5
    })
  })

  it('a dangling fallback preset id is skipped (primary failure surfaces)', async () => {
    callModel.mockRejectedValue(new Error('boom'))
    const err = await callModelResilient(gen, [], {}, () => {}, signal(), {
      backoff_ms: 0,
      fallback_preset_id: 'missing'
    }).catch((e) => e)
    expect(err.kind).toBe('A')
    expect(callModel).toHaveBeenCalledTimes(1)
  })

  it('validator failure triggers ONE corrective re-ask with the assistant echo + nudge', async () => {
    callModel.mockImplementationOnce(async () => ok('   ')).mockImplementationOnce(async () => ok('real content'))
    const base = [{ role: 'user' as const, content: 'go' }]
    const r = await callModelResilient(gen, base, {}, noDelta as never, signal(), {
      validator: 'non_empty'
    })
    expect(r?.raw).toBe('real content')
    const corrective = callModel.mock.calls[1][1] as Array<{ role: string; content: string }>
    expect(corrective[0]).toEqual(base[0])
    expect(corrective[1]).toEqual({ role: 'assistant', content: '   ' })
    expect(corrective[2].role).toBe('user')
    expect(corrective[2].content).toContain('Validation error: output is empty')
  })

  it('validator exhaustion is a class-B give-up with code validator', async () => {
    callModel.mockResolvedValue(ok('not json at all'))
    const err = await callModelResilient(gen, [], {}, () => {}, signal(), {
      validator: 'json',
      validator_retries: 1,
      backoff_ms: 0
    }).catch((e) => e)
    expect(err).toBeInstanceOf(NodeRunFailure)
    expect(err.kind).toBe('B')
    expect(err.code).toBe('validator')
    expect(err.attempts).toBe(2) // initial + 1 corrective
  })

  it('validator exhaustion on the primary still tries the fallback connection', async () => {
    callModel
      .mockResolvedValueOnce(ok('')) // primary, empty
      .mockResolvedValueOnce(ok('')) // primary corrective, still empty
      .mockImplementationOnce(async (g: GenContext) => ok(`good from ${g.settings.api.model}`))
    const r = await callModelResilient(gen, [], {}, () => {}, signal(), {
      validator: 'non_empty',
      validator_retries: 1,
      backoff_ms: 0,
      fallback_preset_id: 'fb1'
    })
    expect(r?.raw).toBe('good from m2')
    expect(callModel).toHaveBeenCalledTimes(3)
  })
})

describe('validateOutput', () => {
  it('non_empty / none', () => {
    expect(validateOutput('x', { validator: 'non_empty' }).ok).toBe(true)
    expect(validateOutput('  \n ', { validator: 'non_empty' }).ok).toBe(false)
    expect(validateOutput('', {}).ok).toBe(true)
    expect(validateOutput('', { validator: 'none' }).ok).toBe(true)
  })

  it('regex (dotall) + invalid pattern', () => {
    expect(
      validateOutput('a\nb END', { validator: 'regex', validator_pattern: 'a.*END' }).ok
    ).toBe(true)
    expect(validateOutput('nope', { validator: 'regex', validator_pattern: '^yes$' }).ok).toBe(
      false
    )
    const bad = validateOutput('x', { validator: 'regex', validator_pattern: '(' })
    expect(bad.ok).toBe(false)
  })

  it('json: plain, fenced, embedded in prose', () => {
    expect(validateOutput('{"a":1}', { validator: 'json' }).ok).toBe(true)
    expect(validateOutput('```json\n{"a": 1}\n```', { validator: 'json' }).ok).toBe(true)
    expect(validateOutput('Sure! Here: {"a":[1,2]} done.', { validator: 'json' }).ok).toBe(true)
    expect(validateOutput('no structure here', { validator: 'json' }).ok).toBe(false)
  })
})
