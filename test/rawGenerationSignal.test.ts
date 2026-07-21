import { describe, expect, it, vi } from 'vitest'

/**
 * Classic Narrator plan, Milestone 4 — the raw-provider input to `hasActiveBackgroundWork()`.
 *
 * `combatService` (adjudication, enemy turns) and `duelService` (narration) call `generateRaw`
 * DIRECTLY from their own IPC handlers, entirely outside `generationService`'s `activeTurns` guard.
 * That work writes to the chat, so if the signal misses it the app quits and silently discards it.
 * This pins the accessor to the same map those calls populate: true while a raw call is in flight,
 * false once it settles.
 */

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const streaming = vi.hoisted(() => ({ current: null as null | { promise: Promise<string> } }))
vi.mock('../src/main/services/apiService', () => ({
  streamProvider: vi.fn(() => streaming.current!.promise)
}))
vi.mock('../src/main/services/settingsService', () => ({ getSettings: () => ({}) }))
vi.mock('../src/main/services/presetService', () => ({
  getActivePreset: () => ({ parameters: {} })
}))
vi.mock('../src/main/services/chatService', () => ({ getChat: () => null }))
vi.mock('../src/main/services/floorService', () => ({ getAllFloors: () => [] }))
vi.mock('../src/main/services/logService', () => ({ log: vi.fn() }))

const { generateRaw, hasActiveRawGeneration } =
  await import('../src/main/services/generation/rawGenerate')

describe('hasActiveRawGeneration', () => {
  it('is true while a combat/duel-style raw generation is in flight, false once it settles', async () => {
    expect(hasActiveRawGeneration()).toBe(false)

    const provider = deferred<string>()
    streaming.current = provider
    // Exactly the shape combatService.ts / duelService.ts call: no turn is involved.
    const narration = generateRaw('p', 'chat-1', { systemPrompt: 'Adjudicate.', userInput: 'hit' })

    expect(hasActiveRawGeneration()).toBe(true)

    provider.resolve('the blow lands')
    await narration
    expect(hasActiveRawGeneration()).toBe(false)
  })

  it('stays true while a raw call is still running after another has settled', async () => {
    const first = deferred<string>()
    streaming.current = first
    const a = generateRaw('p', 'chat-a', { userInput: 'a' })
    const second = deferred<string>()
    streaming.current = second
    const b = generateRaw('p', 'chat-b', { userInput: 'b' })

    first.resolve('done')
    await a
    expect(hasActiveRawGeneration()).toBe(true)

    second.resolve('done')
    await b
    expect(hasActiveRawGeneration()).toBe(false)
  })
})
