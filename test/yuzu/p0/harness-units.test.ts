import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  buildCheckpointKey,
  formatCheckpointAppend,
  formatProgress,
  makeResultSink,
  paramsFromEnv,
  parseCheckpointJsonl,
  parseLocalProviders,
  resolveResumePath,
  RESULTS_DIR,
  runsPerProviderFromEnv
} from './_harnessProviders'
import { fixtureContext } from '../../../src/shared/yuzu/p0/fixtureContext'

const apiServiceLoad = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../../src/main/services/apiService', () => {
  apiServiceLoad.count += 1
  return {}
})

describe('P0 harness configuration', () => {
  it('does not load the real API service during normal module discovery', () => {
    expect(apiServiceLoad.count).toBe(0)
  })

  it('keeps valid provider entries and warns while skipping malformed entries', () => {
    const warn = vi.fn()
    const providers = parseLocalProviders(
      [
        {
          name: 'valid',
          provider: 'openai',
          endpoint: 'https://example.test/v1',
          api_key: 'secret',
          model: 'model',
          rpm_limit: 10,
          max_concurrent: 2
        },
        {
          name: 'valid',
          provider: 'openai',
          endpoint: 'https://other.test/v1',
          api_key: 'other-secret',
          model: 'other-model'
        },
        { name: 'missing-fields' },
        null
      ],
      warn
    )

    expect(providers).toHaveLength(1)
    expect(providers[0].name).toBe('valid')
    expect(warn).toHaveBeenCalledTimes(3)
  })

  it('uses safe defaults for invalid numeric environment values', () => {
    const warn = vi.fn()
    const env = {
      YUZU_P0_RUNS: '0',
      YUZU_P0_TEMP: '-1',
      YUZU_P0_MAX_TOKENS: '-4'
    }

    expect(runsPerProviderFromEnv(env, warn)).toBe(20)
    expect(paramsFromEnv(env, warn)).toEqual({ temperature: 0.8, max_tokens: 1500 })
    expect(warn).toHaveBeenCalledTimes(3)
    expect(paramsFromEnv({ YUZU_P0_TEMP: '0' }, warn).temperature).toBe(0)
    expect(paramsFromEnv({ YUZU_P0_TEMP: '2' }, warn).temperature).toBe(2)
  })

  it('loads valid checkpoint lines while warning and skipping malformed records', () => {
    const warn = vi.fn()
    const valid = {
      ts: 't',
      providerName: 'provider',
      model: 'model',
      format: 'json',
      checkpointKey: 'test-key',
      attempt1: { raw: '{}', latencyMs: 1, applied: [], ok: true, failures: [] },
      outcome: 'valid'
    }
    const contradictory = { ...valid, attempt1: { ...valid.attempt1, ok: false } }
    const invalidFallback = {
      ...valid,
      attempt1: { ...valid.attempt1, ok: false },
      repair: { ...valid.attempt1, ok: false },
      outcome: 'fallback',
      fallbackScene: { bad: true }
    }
    const records = parseCheckpointJsonl(
      [valid, 'not-json', { ts: 'missing fields' }, contradictory, invalidFallback]
        .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
        .join('\n'),
      warn
    )

    expect(records).toEqual([valid])
    expect(warn).toHaveBeenCalledTimes(4)
    expect(formatProgress(2, 5, valid)).toBe('[2/5] provider / model (json): valid')
    expect(formatCheckpointAppend(valid, true)).toBe(`\n${JSON.stringify(valid)}\n`)
  })

  it('constrains resume files and preserves records after a partial checkpoint tail', () => {
    expect(resolveResumePath(join(RESULTS_DIR, 'allowed.jsonl'))).toBe(
      resolve(RESULTS_DIR, 'allowed.jsonl')
    )
    expect(() => resolveResumePath(join(RESULTS_DIR, 'wrong.txt'))).toThrow(/\.jsonl/)
    expect(() => resolveResumePath(join(RESULTS_DIR, '..', 'outside.jsonl'))).toThrow(/results/i)

    mkdirSync(RESULTS_DIR, { recursive: true })
    const path = join(RESULTS_DIR, `.harness-unit-${process.pid}.jsonl`)
    const record = {
      ts: 'first',
      providerName: 'provider',
      model: 'model',
      checkpointKey: 'test-key',
      format: 'json' as const,
      attempt1: { raw: '{}', latencyMs: 1, applied: [], ok: true, failures: [] },
      outcome: 'valid' as const
    }
    try {
      writeFileSync(path, `${JSON.stringify(record)}\n{"partial"`, 'utf-8')
      const sink = makeResultSink('', 'test-key', path, vi.fn())
      sink.onRecord({ ...record, ts: 'second' })
      expect(parseCheckpointJsonl(readFileSync(path, 'utf-8'), vi.fn())).toHaveLength(2)
    } finally {
      if (existsSync(path)) unlinkSync(path)
    }
  })

  it('fingerprints experiment configuration without including API credentials', () => {
    const provider = {
      name: 'provider',
      provider: 'openai',
      endpoint: 'https://example.test/v1',
      api_key: 'first-secret',
      model: 'model'
    }
    const first = buildCheckpointKey('json', fixtureContext, [provider], {
      temperature: 0.8,
      max_tokens: 1500
    })
    const credentialOnlyChange = buildCheckpointKey(
      'json',
      fixtureContext,
      [{ ...provider, api_key: 'second-secret' }],
      { temperature: 0.8, max_tokens: 1500 }
    )
    const experimentChange = buildCheckpointKey('inline', fixtureContext, [provider], {
      temperature: 0.8,
      max_tokens: 1500
    })

    expect(credentialOnlyChange).toBe(first)
    expect(experimentChange).not.toBe(first)
  })
})
