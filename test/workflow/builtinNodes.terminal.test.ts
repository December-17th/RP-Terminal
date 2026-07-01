import { describe, it, expect, vi } from 'vitest'
import { persistFloor, compactMemory } from '../../src/main/services/generation/persistFloor'
import {
  outputWriteFloor,
  memoryCompact
} from '../../src/main/services/nodes/builtin/generationNodes'
import { RunContext } from '../../src/main/services/nodes/types'

vi.mock('../../src/main/services/generation/persistFloor', () => ({
  persistFloor: vi.fn(),
  compactMemory: vi.fn()
}))

const baseCtx: RunContext = {
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
}

describe('output.writeFloor', () => {
  it('builds persistFloor args from its inputs and returns { outputs: { floor } }', () => {
    const gen = { profileId: 'p1', chatId: 'c1', userAction: 'hi' }
    const sendMessages = [{ role: 'user', content: 'hi' }]
    const variables = { stat_data: { hp: 10 } }
    const parsed = { text: 'clean', events: [{ type: 'note' }] }
    const metrics = { turn: {}, cumulative: {} }
    const floor = { floor: 1, chat_id: 'c1' }
    vi.mocked(persistFloor).mockReturnValue(floor as any)

    const result = outputWriteFloor.run(baseCtx, {
      gen,
      raw: 'raw text',
      sendMessages,
      variables,
      parsed,
      metrics
    })

    expect(persistFloor).toHaveBeenCalledWith(gen, {
      userAction: 'hi',
      raw: 'raw text',
      sendMessages,
      events: parsed.events,
      variables,
      metrics
    })
    expect(result).toEqual({ outputs: { floor } })
  })

  it('declares isMainOutputCapable', () => {
    expect(outputWriteFloor.isMainOutputCapable).toBe(true)
  })
})

describe('memory.compact', () => {
  it('calls compactMemory(profileId, chatId) and returns no outputs', () => {
    const gen = { profileId: 'p1', chatId: 'c1', userAction: 'hi' }

    const result = memoryCompact.run(baseCtx, { gen })

    expect(compactMemory).toHaveBeenCalledWith('p1', 'c1')
    expect(result).toEqual({ outputs: {} })
  })
})
