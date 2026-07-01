import { describe, it, expect, vi } from 'vitest'
import { buildGenContext } from '../../src/main/services/generation/genContext'
import { recallMemory } from '../../src/main/services/generation/memoryRecall'
import { matchWorldInfo, assemblePrompt } from '../../src/main/services/generation/assemble'
import {
  inputContext,
  memoryRecallNode,
  promptAssemble
} from '../../src/main/services/nodes/builtin/generationNodes'
import { RunContext } from '../../src/main/services/nodes/types'

vi.mock('../../src/main/services/generation/genContext', () => ({
  buildGenContext: vi.fn()
}))
vi.mock('../../src/main/services/generation/memoryRecall', () => ({
  recallMemory: vi.fn()
}))
vi.mock('../../src/main/services/generation/assemble', () => ({
  matchWorldInfo: vi.fn(),
  assemblePrompt: vi.fn()
}))

const baseCtx: RunContext = {
  signal: new AbortController().signal,
  streamMain: () => {},
  emitPanel: () => {},
  getNodeState: () => undefined,
  setNodeState: () => {}
}

describe('input.context', () => {
  it('calls buildGenContext with the turn seed and returns it on the gen port', () => {
    const gen = { profileId: 'p1', chatId: 'c1', userAction: 'hi' }
    vi.mocked(buildGenContext).mockReturnValue(gen as any)

    const ctx: RunContext = { ...baseCtx, profileId: 'p1', chatId: 'c1', userAction: 'hi' }
    const result = inputContext.run(ctx, {})

    expect(buildGenContext).toHaveBeenCalledWith('p1', 'c1', 'hi')
    expect(result).toEqual({ outputs: { gen } })
  })
})

describe('memory.recall', () => {
  it('calls recallMemory with the gen input and returns block on the block port', async () => {
    const gen = { profileId: 'p1' }
    vi.mocked(recallMemory).mockResolvedValue({ block: 'recalled text', rows: [] })

    const result = await memoryRecallNode.run(baseCtx, { gen })

    expect(recallMemory).toHaveBeenCalledWith(gen)
    expect(result).toEqual({ outputs: { block: 'recalled text' } })
  })
})

describe('prompt.assemble', () => {
  it('matches world info then assembles the prompt, returning sendMessages + params', () => {
    const gen = { profileId: 'p1' }
    const matched = [{ comment: 'entry' }]
    const sendMessages = [{ role: 'user', content: 'hi' }]
    const params = { max_tokens: 100 }
    vi.mocked(matchWorldInfo).mockReturnValue(matched as any)
    vi.mocked(assemblePrompt).mockReturnValue({ sendMessages, params } as any)

    const result = promptAssemble.run(baseCtx, { gen, block: 'memory block' })

    expect(matchWorldInfo).toHaveBeenCalledWith(gen)
    expect(assemblePrompt).toHaveBeenCalledWith(gen, matched, 'memory block')
    expect(result).toEqual({ outputs: { sendMessages, params } })
  })
})
