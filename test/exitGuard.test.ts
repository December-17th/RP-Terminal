import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createExitGuard, type ExitGuardEvent } from '../src/main/exitGuard'

// Classic Narrator plan, Milestone 4 — active-work exit warning.
//
// Two suites:
//   1. the exit guard's decision logic (the part `src/main/index.ts` wires electron into), and
//   2. the ONE `hasActiveBackgroundWork` signal, which unions three read-only accessors.
//
// `src/main/index.ts` itself stays untested: it is a wiring file that imports electron and the whole
// sqlite-backed service graph at module scope. The decision it makes lives in exitGuard.ts precisely
// so it can be tested without that graph.

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const closeEvent = (): ExitGuardEvent & { prevented: number } => {
  const event = {
    prevented: 0,
    preventDefault() {
      event.prevented += 1
    }
  }
  return event
}

describe('exit guard', () => {
  it('does nothing at all when there is no active work', () => {
    const confirmDiscard = vi.fn(async () => true)
    const quit = vi.fn()
    const guard = createExitGuard({
      hasActiveBackgroundWork: () => false,
      confirmDiscard,
      quit
    })

    const event = closeEvent()
    guard.handleExitRequest(event)

    // Unchanged behavior: the exit is not stopped, no dialog is opened, nothing is awaited.
    expect(event.prevented).toBe(0)
    expect(confirmDiscard).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
    expect(guard.isPrompting).toBe(false)
  })

  it('stops the exit and prompts when work is active', () => {
    const confirmDiscard = vi.fn(async () => false)
    const guard = createExitGuard({
      hasActiveBackgroundWork: () => true,
      confirmDiscard,
      quit: vi.fn()
    })

    const event = closeEvent()
    guard.handleExitRequest(event)

    expect(event.prevented).toBe(1)
    expect(confirmDiscard).toHaveBeenCalledTimes(1)
  })

  it('keeps the app open when the prompt is cancelled, and prompts again on the next close', async () => {
    const answer = vi.fn<() => Promise<boolean>>()
    const quit = vi.fn()
    const guard = createExitGuard({
      hasActiveBackgroundWork: () => true,
      confirmDiscard: answer,
      quit
    })

    answer.mockResolvedValueOnce(false)
    const first = closeEvent()
    guard.handleExitRequest(first)
    await vi.waitFor(() => expect(guard.isPrompting).toBe(false))

    expect(first.prevented).toBe(1)
    expect(quit).not.toHaveBeenCalled()

    // Work continues, so a SUBSEQUENT close still prompts (the cancel did not latch anything).
    answer.mockResolvedValueOnce(true)
    const second = closeEvent()
    guard.handleExitRequest(second)
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))

    expect(second.prevented).toBe(1)
    expect(answer).toHaveBeenCalledTimes(2)
  })

  it('re-issues the quit once when the prompt is confirmed, and lets every later exit through', async () => {
    const confirmDiscard = vi.fn(async () => true)
    const quit = vi.fn()
    const guard = createExitGuard({
      hasActiveBackgroundWork: () => true,
      confirmDiscard,
      quit
    })

    guard.handleExitRequest(closeEvent())
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))

    // The re-issued app.quit() cascades: window `close` then `before-quit`. Both must pass straight
    // through to the existing will-quit cleanup, un-prompted and un-prevented.
    const cascadeClose = closeEvent()
    const cascadeBeforeQuit = closeEvent()
    guard.handleExitRequest(cascadeClose)
    guard.handleExitRequest(cascadeBeforeQuit)

    expect(cascadeClose.prevented).toBe(0)
    expect(cascadeBeforeQuit.prevented).toBe(0)
    expect(confirmDiscard).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('does not stack dialogs or double-quit when a second close arrives while the prompt is open', async () => {
    const pending = deferred<boolean>()
    const confirmDiscard = vi.fn(() => pending.promise)
    const quit = vi.fn()
    const guard = createExitGuard({
      hasActiveBackgroundWork: () => true,
      confirmDiscard,
      quit
    })

    const first = closeEvent()
    guard.handleExitRequest(first)
    expect(guard.isPrompting).toBe(true)

    // A second Cmd-Q while the dialog is up: still prevented, but NO second dialog.
    const second = closeEvent()
    guard.handleExitRequest(second)
    const third = closeEvent()
    guard.handleExitRequest(third)

    expect(second.prevented).toBe(1)
    expect(third.prevented).toBe(1)
    expect(confirmDiscard).toHaveBeenCalledTimes(1)

    pending.resolve(true)
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
    expect(quit).toHaveBeenCalledTimes(1)
    expect(confirmDiscard).toHaveBeenCalledTimes(1)
  })

  it('stays open and reports a failing dialog instead of wedging shut', async () => {
    const onError = vi.fn()
    const quit = vi.fn()
    const guard = createExitGuard({
      hasActiveBackgroundWork: () => true,
      confirmDiscard: async () => {
        throw new Error('dialog failed')
      },
      quit,
      onError
    })

    const event = closeEvent()
    guard.handleExitRequest(event)
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))

    expect(event.prevented).toBe(1)
    expect(quit).not.toHaveBeenCalled()
    // Recoverable: the next close attempt prompts again rather than being swallowed by a stuck flag.
    expect(guard.isPrompting).toBe(false)
  })
})

// ── The signal ───────────────────────────────────────────────────────────────────────────────────
// activeWork.ts is deliberately a thin union so the three owners can be mocked; the accessors
// themselves are exercised against their real owners elsewhere (invocationRuntime.test.ts for the
// Agent side; the turn/trigger guards are module-private Maps/Sets whose size the accessor returns).

const mockAgentRuntime = vi.hoisted(() => ({ hasActiveAgentWork: vi.fn(() => false) }))
vi.mock('../src/main/services/agentRuntime/InvocationRuntimeService', () => mockAgentRuntime)

const mockGeneration = vi.hoisted(() => ({ hasActiveTurns: vi.fn(() => false) }))
vi.mock('../src/main/services/generationService', () => mockGeneration)

const mockHeadless = vi.hoisted(() => ({ hasActiveTriggerEvaluation: vi.fn(() => false) }))
vi.mock('../src/main/services/headlessRunService', () => mockHeadless)

const mockRaw = vi.hoisted(() => ({ hasActiveRawGeneration: vi.fn(() => false) }))
vi.mock('../src/main/services/generation/rawGenerate', () => mockRaw)

const mockBackfill = vi.hoisted(() => ({ hasActiveBackfill: vi.fn(() => false) }))
vi.mock('../src/main/services/tableBackfillService', () => mockBackfill)

const mockRefill = vi.hoisted(() => ({ hasActiveRefill: vi.fn(() => false) }))
vi.mock('../src/main/services/tableRefillService', () => mockRefill)

const { hasActiveBackgroundWork } = await import('../src/main/services/activeWork')

describe('hasActiveBackgroundWork', () => {
  beforeEach(() => {
    mockAgentRuntime.hasActiveAgentWork.mockReturnValue(false)
    mockGeneration.hasActiveTurns.mockReturnValue(false)
    mockHeadless.hasActiveTriggerEvaluation.mockReturnValue(false)
    mockRaw.hasActiveRawGeneration.mockReturnValue(false)
    mockBackfill.hasActiveBackfill.mockReturnValue(false)
    mockRefill.hasActiveRefill.mockReturnValue(false)
  })

  it('is false when every source is idle', () => {
    expect(hasActiveBackgroundWork()).toBe(false)
  })

  it('is true for an in-flight Agent invocation', () => {
    mockAgentRuntime.hasActiveAgentWork.mockReturnValue(true)
    expect(hasActiveBackgroundWork()).toBe(true)
  })

  it('is true for an in-flight Classic turn', () => {
    mockGeneration.hasActiveTurns.mockReturnValue(true)
    expect(hasActiveBackgroundWork()).toBe(true)
  })

  // combatService / duelService drive generateRaw from their own IPC handlers, outside activeTurns.
  it('is true for an in-flight combat or duel raw generation', () => {
    mockRaw.hasActiveRawGeneration.mockReturnValue(true)
    expect(hasActiveBackgroundWork()).toBe(true)
  })

  // Long-running multi-batch LLM jobs over callModelResilient — invisible to activeControllers.
  it('is true for a manual table backfill mid-job', () => {
    mockBackfill.hasActiveBackfill.mockReturnValue(true)
    expect(hasActiveBackgroundWork()).toBe(true)
  })

  it('is true for a manual table refill mid-job', () => {
    mockRefill.hasActiveRefill.mockReturnValue(true)
    expect(hasActiveBackgroundWork()).toBe(true)
  })

  it('is true for an in-flight trigger evaluation', () => {
    mockHeadless.hasActiveTriggerEvaluation.mockReturnValue(true)
    expect(hasActiveBackgroundWork()).toBe(true)
  })
})
