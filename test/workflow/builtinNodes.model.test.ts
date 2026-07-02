import { describe, it, expect, vi } from 'vitest'
import { callModel } from '../../src/main/services/generation/callModel'
import { parseResponse, computeMetrics } from '../../src/main/services/generation/parseResponse'
import { foldState } from '../../src/main/services/generation/foldState'
import {
  llmSample,
  parseResponseNode,
  applyState
} from '../../src/main/services/nodes/builtin/generationNodes'
import { RunContext } from '../../src/main/services/nodes/types'

vi.mock('../../src/main/services/generation/callModel', () => ({
  callModel: vi.fn()
}))
vi.mock('../../src/main/services/generation/parseResponse', () => ({
  parseResponse: vi.fn(),
  computeMetrics: vi.fn()
}))
vi.mock('../../src/main/services/generation/foldState', () => ({
  foldState: vi.fn()
}))

const baseCtx: RunContext = {
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
}

describe('llm.sample', () => {
  it('calls callModel with gen/sendMessages/params and streams via ctx.streamMain', async () => {
    const gen = { profileId: 'p1' }
    const sendMessages = [{ role: 'user', content: 'hi' }]
    const params = { max_tokens: 100 }
    // Since spec §10 the node delegates through callModelResilient, whose delta wrapper forwards
    // to ctx.streamMain — assert the DELTAS arrive there, not the callback's identity.
    vi.mocked(callModel).mockImplementation(async (_g, _m, _p, onDelta) => {
      onDelta('hel')
      onDelta('lo')
      return { raw: 'hello', rawUsage: { tokens: 5 }, stopped: false }
    })

    const streamMain = vi.fn()
    const ctx: RunContext = { ...baseCtx, streamMain }
    const result = await llmSample.run(ctx, { gen, sendMessages, params })

    expect(callModel).toHaveBeenCalledTimes(1)
    const [gotGen, gotMessages, gotParams, , gotSignal] = vi.mocked(callModel).mock.calls[0]
    expect([gotGen, gotMessages, gotParams, gotSignal]).toEqual([
      gen,
      sendMessages,
      params,
      ctx.signal
    ])
    expect(streamMain.mock.calls.map((c) => c[0])).toEqual(['hel', 'lo'])
    expect(result).toEqual({ outputs: { raw: 'hello', rawUsage: { tokens: 5 } } })
  })

  it('returns no outputs when callModel returns null (abort-with-empty)', async () => {
    vi.mocked(callModel).mockResolvedValue(null)

    const result = await llmSample.run(baseCtx, { gen: {}, sendMessages: [], params: {} })

    expect(result).toEqual({ outputs: {} })
  })
})

describe('parse.response', () => {
  it('delegates to parseResponse + computeMetrics and maps outputs', () => {
    const gen = { profileId: 'p1' }
    const sendMessages = [{ role: 'user', content: 'hi' }]
    const rawUsage = { tokens: 5 }
    const parsed = { text: 'clean', events: [] }
    const mvu = { commands: [], patches: [] }
    const metrics = { turn: {}, cumulative: {} }
    vi.mocked(parseResponse).mockReturnValue({ cleaned: 'clean', parsed, mvu } as any)
    vi.mocked(computeMetrics).mockReturnValue(metrics as any)

    const result = parseResponseNode.run(baseCtx, { gen, raw: 'raw text', sendMessages, rawUsage })

    expect(parseResponse).toHaveBeenCalledWith('raw text')
    expect(computeMetrics).toHaveBeenCalledWith(gen, sendMessages, 'raw text', rawUsage)
    expect(result).toEqual({ outputs: { parsed, mvu, metrics } })
  })
})

describe('apply.state', () => {
  it('delegates to foldState with gen/parsed/mvu/raw and returns variables', () => {
    const gen = { profileId: 'p1' }
    const parsed = { text: 'clean', events: [] }
    const mvu = { commands: [], patches: [] }
    const variables = { stat_data: { hp: 10 } }
    vi.mocked(foldState).mockReturnValue(variables)

    const result = applyState.run(baseCtx, { gen, parsed, mvu, raw: 'raw text' })

    expect(foldState).toHaveBeenCalledWith(gen, parsed, mvu, 'raw text')
    expect(result).toEqual({ outputs: { variables } })
  })
})
