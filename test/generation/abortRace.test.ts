import { afterEach, describe, expect, it, vi } from 'vitest'

import { ABORTED_BY_SIGNAL, raceAbortSignal } from '../../src/main/services/generation/abortRace'

// Final-review Finding 3: the turn's blocksNextTurn barrier wait is raced against the turn's own abort,
// so a hung/never-settling barrier cannot pin every next turn with no escape but the Workspace stop.

afterEach(() => {
  vi.useRealTimers()
})

describe('raceAbortSignal', () => {
  it('resolves ABORTED when the signal fires before the work settles (a hung barrier is escapable)', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    // A barrier that would only settle far in the future — the turn must not have to wait for it.
    const hung = new Promise<'settled'>((resolve) => setTimeout(() => resolve('settled'), 60_000))

    const race = raceAbortSignal(hung, controller.signal)
    controller.abort()

    await expect(race).resolves.toBe(ABORTED_BY_SIGNAL)
  })

  it('resolves with the work value when it settles before any abort', async () => {
    const controller = new AbortController()
    await expect(raceAbortSignal(Promise.resolve('done'), controller.signal)).resolves.toBe('done')
  })

  it('resolves ABORTED immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    // The work would resolve, but an already-Stopped turn never waits on it.
    await expect(raceAbortSignal(Promise.resolve('done'), controller.signal)).resolves.toBe(
      ABORTED_BY_SIGNAL
    )
  })

  it('treats a work rejection as ABORTED (could-not-wait == stopped)', async () => {
    const controller = new AbortController()
    await expect(
      raceAbortSignal(Promise.reject(new Error('boom')), controller.signal)
    ).resolves.toBe(ABORTED_BY_SIGNAL)
  })
})
