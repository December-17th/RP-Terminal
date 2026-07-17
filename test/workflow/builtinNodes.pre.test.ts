import { describe, it, expect, vi } from 'vitest'
import { buildGenContext } from '../../src/main/services/generation/genContext'
import { matchWorldInfo, assemblePrompt } from '../../src/main/services/generation/assemble'
import {
  inputContext,
  promptAssemble
} from '../../src/main/services/nodes/builtin/generationNodes'
import { RunContext } from '../../src/main/services/nodes/types'

vi.mock('../../src/main/services/generation/genContext', () => ({
  buildGenContext: vi.fn()
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

    // issue 12: input.context now forwards the turn's generationType into buildGenContext (4th arg).
    const ctx: RunContext = {
      ...baseCtx,
      profileId: 'p1',
      chatId: 'c1',
      userAction: 'hi',
      generationType: 'regenerate'
    }
    const result = inputContext.run(ctx, {})

    expect(buildGenContext).toHaveBeenCalledWith('p1', 'c1', 'hi', 'regenerate')
    expect(result).toEqual({ outputs: { gen } })
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

  it('stamps the execution record onto the shared gen (issue 09), without exposing it as a port', () => {
    const gen: any = { profileId: 'p1' }
    const record = { version: 1, entries: [], wire: [], stats: {} }
    vi.mocked(matchWorldInfo).mockReturnValue([] as any)
    vi.mocked(assemblePrompt).mockReturnValue({
      sendMessages: [],
      params: {},
      record
    } as any)

    const result = promptAssemble.run(baseCtx, { gen, block: '' })

    // The record rides `gen` (so the terminal write stage persists it) — never the output ports.
    expect(gen.executionRecord).toBe(record)
    expect(result.outputs).not.toHaveProperty('record')
  })
})
