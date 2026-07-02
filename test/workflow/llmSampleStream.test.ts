import { describe, it, expect, vi, beforeEach } from 'vitest'

// llm.sample `stream` config (spec §8/D4): stream=false keeps a side-branch LLM's reply out of
// the chat stream (its result surfaces via the node's output panel instead); default streams.

const { callModel } = vi.hoisted(() => ({ callModel: vi.fn() }))
vi.mock('../../src/main/services/generation/callModel', () => ({ callModel }))

import { llmSample } from '../../src/main/services/nodes/builtin/generationNodes'
import { RunContext } from '../../src/main/services/nodes/types'

const ctx = (streamMain: (d: string) => void): RunContext => ({
  signal: new AbortController().signal,
  streamMain,
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
})

const inputs = { gen: {}, sendMessages: [], params: {} }

describe('llm.sample stream config', () => {
  beforeEach(() => {
    callModel.mockReset().mockImplementation(async (_g, _m, _p, onDelta) => {
      onDelta('side result')
      return { raw: 'side result', rawUsage: null, stopped: false }
    })
  })

  it('streams to chat by default (config {})', async () => {
    const deltas: string[] = []
    const r = await llmSample.run(ctx((d) => deltas.push(d)), inputs, { id: 'n1', config: {} })
    expect(deltas).toEqual(['side result'])
    expect(r).toEqual({ outputs: { raw: 'side result', rawUsage: null } })
  })

  it('stream=false keeps the reply out of the chat stream but still returns it', async () => {
    const deltas: string[] = []
    const r = await llmSample.run(ctx((d) => deltas.push(d)), inputs, {
      id: 'n1',
      config: { stream: false }
    })
    expect(deltas).toEqual([])
    expect(r).toEqual({ outputs: { raw: 'side result', rawUsage: null } })
  })
})
