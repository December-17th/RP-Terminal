import { describe, it, expect, vi, beforeEach } from 'vitest'

// maybeCompact orchestrates several DB/LLM-backed services. Mock them all so we can drive the full
// control flow (gates, happy path, fail-open, concurrency) without a DB or network. The pure helpers
// it uses (compactionRange/parseMemories/floorsToTranscript) are tested in compaction.test.ts.
vi.mock('../../src/main/services/settingsService', () => ({ getSettings: vi.fn() }))
vi.mock('../../src/main/services/presetService', () => ({ getActivePreset: vi.fn() }))
vi.mock('../../src/main/services/chatService', () => ({
  getChat: vi.fn(),
  getMemoryState: vi.fn(),
  setMemoryState: vi.fn()
}))
vi.mock('../../src/main/services/floorService', () => ({ getAllFloors: vi.fn() }))
vi.mock('../../src/main/services/memoryStore', () => ({ appendEntries: vi.fn() }))
vi.mock('../../src/main/services/apiService', () => ({ streamProvider: vi.fn() }))
vi.mock('../../src/main/services/logService', () => ({ log: vi.fn() }))

import { maybeCompact, utilityComplete } from '../../src/main/services/compactionService'
import { getSettings } from '../../src/main/services/settingsService'
import { getActivePreset } from '../../src/main/services/presetService'
import { getChat, getMemoryState, setMemoryState } from '../../src/main/services/chatService'
import { getAllFloors } from '../../src/main/services/floorService'
import { appendEntries } from '../../src/main/services/memoryStore'
import { streamProvider } from '../../src/main/services/apiService'
import type { Settings } from '../../src/main/types/models'

const eventsCollection = {
  id: 'events',
  shape: 'stream',
  enabled: true,
  write: { trigger: 'checkpoint', prompt: 'SUMMARIZE' },
  retrieval: { mode: 'keyword', count: 5, tokenBudget: 600 },
  inject: { label: 'Earlier events' }
}

const settings = (memoryOver: Record<string, unknown> = {}): Settings =>
  ({
    memory: {
      enabled: true,
      collections: [eventsCollection],
      keep_recent: 10,
      checkpoint_turns: 6,
      utility_api_preset_id: '',
      ...memoryOver
    },
    api: { provider: 'openai', endpoint: 'e', api_key: 'k', model: 'm' },
    api_presets: []
  }) as unknown as Settings

const floor = (n: number): Record<string, unknown> => ({
  floor: n,
  user_message: { content: `u${n}` },
  response: { content: `a${n}` }
})
const floorsRange = (fromInc: number, toExcl: number): unknown[] => {
  const out: unknown[] = []
  for (let i = fromInc; i < toExcl; i++) out.push(floor(i))
  return out
}

describe('maybeCompact', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Happy-path defaults: 16 floors, nothing compacted, keep_recent 10 / checkpoint 6 → batch [0,6).
    vi.mocked(getActivePreset).mockReturnValue({
      parameters: { temperature: 0.9, max_tokens: 100 }
    } as never)
    vi.mocked(getSettings).mockReturnValue(settings())
    vi.mocked(getChat).mockReturnValue({ floor_count: 16 } as never)
    vi.mocked(getMemoryState).mockReturnValue({ last_compacted_floor: -1 })
    vi.mocked(getAllFloors).mockReturnValue(floorsRange(0, 16) as never)
    vi.mocked(streamProvider).mockResolvedValue(
      '{"memories":[{"summary":"the duel on the bridge","keywords":["duel","bridge"],"salience":0.8}]}'
    )
  })

  it('summarizes the aged-out batch with correct provenance and advances the pointer', async () => {
    await maybeCompact('p', 'c')
    expect(appendEntries).toHaveBeenCalledTimes(1)
    const call = vi.mocked(appendEntries).mock.calls[0]
    expect(call[0]).toBe('p')
    expect(call[1]).toBe('c')
    expect(call[2]).toBe('events')
    expect(call[3]).toEqual([
      {
        summary: 'the duel on the bridge',
        keywords: ['duel', 'bridge'],
        salience: 0.8,
        turnStart: 0,
        turnEnd: 5 // batch [0,6) → floors 0..5
      }
    ])
    expect(setMemoryState).toHaveBeenCalledWith('p', 'c', { last_compacted_floor: 5 })
  })

  it('only sends the aged-out floors (not the verbatim window) to the summarizer', async () => {
    await maybeCompact('p', 'c')
    const transcript = vi.mocked(streamProvider).mock.calls[0][1][1].content as string
    expect(transcript).toContain('User: u0')
    expect(transcript).toContain('Assistant: a5')
    expect(transcript).not.toContain('u6') // floor 6 is still verbatim (keep_recent)
  })

  it('does nothing when memory is disabled', async () => {
    vi.mocked(getSettings).mockReturnValue(settings({ enabled: false }))
    await maybeCompact('p', 'c')
    expect(streamProvider).not.toHaveBeenCalled()
    expect(appendEntries).not.toHaveBeenCalled()
    expect(setMemoryState).not.toHaveBeenCalled()
  })

  it('does nothing when no checkpoint stream collection is enabled', async () => {
    vi.mocked(getSettings).mockReturnValue(settings({ collections: [] }))
    await maybeCompact('p', 'c')
    expect(streamProvider).not.toHaveBeenCalled()
    expect(appendEntries).not.toHaveBeenCalled()
  })

  it('does nothing until a full batch has aged past keep_recent', async () => {
    vi.mocked(getChat).mockReturnValue({ floor_count: 15 } as never) // end=5, 5-0 < 6
    await maybeCompact('p', 'c')
    expect(streamProvider).not.toHaveBeenCalled()
    expect(appendEntries).not.toHaveBeenCalled()
  })

  it('is idempotent — no re-compaction once the pointer has advanced past the batch', async () => {
    vi.mocked(getMemoryState).mockReturnValue({ last_compacted_floor: 5 }) // already did [0,6)
    await maybeCompact('p', 'c') // start=6, end=6 → null
    expect(streamProvider).not.toHaveBeenCalled()
    expect(appendEntries).not.toHaveBeenCalled()
  })

  it('fail-open: leaves history and the pointer untouched when the utility call throws', async () => {
    vi.mocked(streamProvider).mockRejectedValue(new Error('429 rate limit'))
    await expect(maybeCompact('p', 'c')).resolves.toBeUndefined() // never throws
    expect(appendEntries).not.toHaveBeenCalled()
    expect(setMemoryState).not.toHaveBeenCalled()
  })

  it('defers when the reply has no parseable memories', async () => {
    vi.mocked(streamProvider).mockResolvedValue('the model refused to answer')
    await maybeCompact('p', 'c')
    expect(appendEntries).not.toHaveBeenCalled()
    expect(setMemoryState).not.toHaveBeenCalled()
  })

  it('serializes concurrent compaction for the same chat (no duplicate summaries)', async () => {
    let resolveCall!: (s: string) => void
    vi.mocked(streamProvider).mockReturnValue(
      new Promise<string>((res) => {
        resolveCall = res
      })
    )
    const first = maybeCompact('p', 'c') // acquires the lock, awaits the pending utility call
    const second = maybeCompact('p', 'c') // sees the lock → early return
    resolveCall('{"memories":[{"summary":"x"}]}')
    await Promise.all([first, second])
    expect(streamProvider).toHaveBeenCalledTimes(1)
    expect(appendEntries).toHaveBeenCalledTimes(1)
  })
})

describe('utilityComplete (connection routing)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getActivePreset).mockReturnValue({
      parameters: { temperature: 0.9, max_tokens: 100 }
    } as never)
    vi.mocked(streamProvider).mockResolvedValue('ok')
  })

  it('routes to the configured utility preset connection', async () => {
    vi.mocked(getSettings).mockReturnValue({
      memory: { utility_api_preset_id: 'fast' },
      api: { provider: 'openai', endpoint: 'a', api_key: 'k1', model: 'big' },
      api_presets: [
        {
          id: 'fast',
          name: 'Fast',
          provider: 'anthropic',
          endpoint: 'b',
          api_key: 'k2',
          model: 'haiku'
        }
      ]
    } as never)
    await utilityComplete('p', { user: 'hi' })
    expect(vi.mocked(streamProvider).mock.calls[0][0].api).toEqual({
      provider: 'anthropic',
      endpoint: 'b',
      api_key: 'k2',
      model: 'haiku'
    })
  })

  it('falls back to the active connection when the utility preset is unset/unknown', async () => {
    vi.mocked(getSettings).mockReturnValue({
      memory: { utility_api_preset_id: 'nope' },
      api: { provider: 'openai', endpoint: 'a', api_key: 'k1', model: 'big' },
      api_presets: []
    } as never)
    await utilityComplete('p', { user: 'hi' })
    expect(vi.mocked(streamProvider).mock.calls[0][0].api.model).toBe('big')
  })

  it('sends system + user messages and merges sampler params (temp 0.3 + max_tokens)', async () => {
    vi.mocked(getSettings).mockReturnValue({
      memory: { utility_api_preset_id: '' },
      api: {},
      api_presets: []
    } as never)
    await utilityComplete('p', { system: 'SYS', user: 'USR', maxTokens: 500 })
    const [, messages, params] = vi.mocked(streamProvider).mock.calls[0]
    expect(messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USR' }
    ])
    expect(params).toMatchObject({ temperature: 0.3, max_tokens: 500 })
  })
})
