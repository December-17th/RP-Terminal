import { describe, expect, it, vi } from 'vitest'

import {
  CardToolRegistryError,
  createCardToolRegistry,
  type CardToolScope
} from '../../src/main/services/agentRuntime/tools/CardToolRegistry'

const scope: CardToolScope = {
  profileId: 'profile-a',
  chatId: 'chat-a',
  characterId: 'card-a',
  senderId: 101
}

const definition = {
  name: 'advance-clock',
  description: 'Advance the calendar.',
  inputSchema: { type: 'object' },
  required: true,
  transactionMode: 'transactional' as const,
  parallelSafe: false
}

const binding = {
  name: definition.name,
  inputSchema: definition.inputSchema,
  transactionMode: definition.transactionMode,
  parallelSafe: definition.parallelSafe
}

const differentScope = { ...scope, chatId: 'chat-b', senderId: 202 }

describe('CardToolRegistry', () => {
  it('routes a scoped tool call through a correlated request and stages card-authored operations', async () => {
    const send = vi.fn()
    const registry = createCardToolRegistry()
    registry.register({ scope, binding, send })

    const resolved = registry.resolve(definition, scope)
    expect(resolved).toBeDefined()

    const staged: unknown[] = []
    const pending = resolved!.execute(
      { days: 3 },
      {
        stage: (operation) => staged.push(operation),
        beginExternalEffect: vi.fn()
      }
    )

    expect(send).toHaveBeenCalledWith('wcv-agent-tool-request', {
      requestId: expect.any(String),
      sequence: 1,
      name: 'advance-clock',
      input: { days: 3 },
      transactionMode: 'transactional'
    })
    const requestId = send.mock.calls[0][1].requestId as string

    expect(
      registry.complete({
        senderId: scope.senderId,
        requestId,
        result: { advanced: true },
        operations: [{ type: 'increment', payload: { path: 'variables.day', value: 3 } }]
      })
    ).toBe(true)

    await expect(pending).resolves.toEqual({ advanced: true })
    expect(staged).toEqual([{ type: 'increment', payload: { path: 'variables.day', value: 3 } }])
  })

  it('keeps callback sequence numbers monotonically ordered even when calls settle out of order', async () => {
    const send = vi.fn()
    const registry = createCardToolRegistry()
    registry.register({ scope, binding, send })
    const resolved = registry.resolve(definition, scope)!

    const first = resolved.execute({ days: 1 }, { stage: vi.fn(), beginExternalEffect: vi.fn() })
    const second = resolved.execute({ days: 2 }, { stage: vi.fn(), beginExternalEffect: vi.fn() })
    const [firstRequest, secondRequest] = send.mock.calls.map(([, request]) => request)

    expect(firstRequest.sequence).toBe(1)
    expect(secondRequest.sequence).toBe(2)
    registry.complete({
      senderId: scope.senderId,
      requestId: secondRequest.requestId,
      result: { days: 2 }
    })
    registry.complete({
      senderId: scope.senderId,
      requestId: firstRequest.requestId,
      result: { days: 1 }
    })

    await expect(Promise.all([first, second])).resolves.toEqual([{ days: 1 }, { days: 2 }])
  })

  it('rejects a conflicting (different-definition) duplicate name in a bound scope with a typed error', () => {
    const registry = createCardToolRegistry()
    registry.register({ scope, binding, send: vi.fn() })

    // Same name, DIFFERENT input schema = a genuine conflict, not a double-mount → still rejected.
    const conflicting = { ...binding, inputSchema: { type: 'object', required: ['days'] } }
    expect(() => registry.register({ scope, binding: conflicting, send: vi.fn() })).toThrowError(
      expect.objectContaining({ code: 'CARD_TOOL_DUPLICATE' })
    )
  })

  it('lets a second mount take over an identical tool (last-registration-wins) and routes to it', async () => {
    const registry = createCardToolRegistry()
    const firstSend = vi.fn()
    const secondSend = vi.fn()
    // First mount registers; a second live mount of the same card (new sender, same scope) re-registers
    // the identical binding. It must NOT throw — the later registration takes over the name.
    registry.register({ scope, binding, send: firstSend })
    expect(() =>
      registry.register({ scope: { ...scope, senderId: 202 }, binding, send: secondSend })
    ).not.toThrow()

    // Model tool requests now route to the second (current) mount; the first mount's send is inert.
    const pending = registry
      .resolve(definition, scope)!
      .execute({ days: 1 }, { stage: vi.fn(), beginExternalEffect: vi.fn() })
    expect(secondSend).toHaveBeenCalledTimes(1)
    expect(firstSend).not.toHaveBeenCalled()

    const requestId = secondSend.mock.calls[0][1].requestId as string
    expect(registry.complete({ senderId: 202, requestId, result: { advanced: true } })).toBe(true)
    await expect(pending).resolves.toEqual({ advanced: true })
  })

  it('does not resolve an implementation outside its authoritative mounted scope', () => {
    const registry = createCardToolRegistry()
    registry.register({ scope, binding, send: vi.fn() })

    expect(registry.resolve(definition, differentScope)).toBeUndefined()
  })

  it('rejects a spoofed callback sender without applying it to a pending request', async () => {
    const send = vi.fn()
    const registry = createCardToolRegistry()
    registry.register({ scope, binding, send })
    const pending = registry
      .resolve(definition, scope)!
      .execute({ days: 1 }, { stage: vi.fn(), beginExternalEffect: vi.fn() })
    const requestId = send.mock.calls[0][1].requestId as string

    expect(() =>
      registry.complete({ senderId: 999, requestId, result: { advanced: true } })
    ).toThrowError(expect.objectContaining({ code: 'CARD_TOOL_SCOPE_REJECTED' }))

    registry.complete({ senderId: scope.senderId, requestId, result: { advanced: true } })
    await expect(pending).resolves.toEqual({ advanced: true })
  })

  it('aborts a callback, notifies the card, and ignores its late result', async () => {
    const send = vi.fn()
    const registry = createCardToolRegistry()
    registry.register({ scope, binding, send })
    const controller = new AbortController()
    const pending = registry
      .resolve(definition, scope)!
      .execute(
        { days: 1 },
        { signal: controller.signal, stage: vi.fn(), beginExternalEffect: vi.fn() }
      )
    const requestId = send.mock.calls[0][1].requestId as string

    controller.abort('floor deleted')

    await expect(pending).rejects.toMatchObject({ code: 'CARD_TOOL_ABORTED' })
    expect(send).toHaveBeenLastCalledWith('wcv-agent-tool-abort', { requestId })
    expect(
      registry.complete({ senderId: scope.senderId, requestId, result: { advanced: true } })
    ).toBe(false)
  })

  it('terminates callbacks on unmount and rejects their late results', async () => {
    const send = vi.fn()
    const registry = createCardToolRegistry()
    registry.register({ scope, binding, send })
    const pending = registry
      .resolve(definition, scope)!
      .execute({ days: 1 }, { stage: vi.fn(), beginExternalEffect: vi.fn() })
    const requestId = send.mock.calls[0][1].requestId as string

    expect(registry.unregisterSender(scope.senderId)).toBe(1)
    await expect(pending).rejects.toMatchObject({ code: 'CARD_TOOL_UNMOUNTED' })
    expect(registry.resolve(definition, scope)).toBeUndefined()
    expect(
      registry.complete({ senderId: scope.senderId, requestId, result: { advanced: true } })
    ).toBe(false)
  })

  it('marks a non-transactional external boundary before dispatching the card handler', async () => {
    const beginExternalEffect = vi.fn()
    const send = vi.fn(() => expect(beginExternalEffect).toHaveBeenCalledTimes(1))
    const registry = createCardToolRegistry()
    const nonTransactional = {
      ...binding,
      transactionMode: 'non-transactional' as const
    }
    registry.register({ scope, binding: nonTransactional, send })
    const pending = registry
      .resolve({ ...definition, transactionMode: 'non-transactional' }, scope)!
      .execute({ days: 1 }, { stage: vi.fn(), beginExternalEffect })
    const requestId = send.mock.calls[0][1].requestId as string

    registry.complete({ senderId: scope.senderId, requestId, result: { advanced: true } })
    await expect(pending).resolves.toEqual({ advanced: true })
    expect(beginExternalEffect).toHaveBeenCalledTimes(1)
  })

  it('rejects a same-sender callback from another card scope without settling the owner request', async () => {
    const send = vi.fn()
    const registry = createCardToolRegistry()
    registry.register({ scope, binding, send })
    const pending = registry
      .resolve(definition, scope)!
      .execute({ days: 1 }, { stage: vi.fn(), beginExternalEffect: vi.fn() })
    const requestId = send.mock.calls[0][1].requestId as string

    expect(() =>
      registry.complete({
        senderId: scope.senderId,
        scope: { ...scope, chatId: 'chat-b' },
        requestId,
        result: { advanced: false }
      })
    ).toThrowError(expect.objectContaining({ code: 'CARD_TOOL_SCOPE_REJECTED' }))

    registry.complete({ senderId: scope.senderId, scope, requestId, result: { advanced: true } })
    await expect(pending).resolves.toEqual({ advanced: true })
  })

  it('unregisters and settles only callbacks for one scoped registration', async () => {
    const send = vi.fn()
    const registry = createCardToolRegistry()
    const otherBinding = { ...binding, name: 'read-clock' }
    const otherDefinition = { ...definition, name: 'read-clock' }
    registry.register({ scope, binding, send })
    registry.register({ scope, binding: otherBinding, send })
    const removed = registry
      .resolve(definition, scope)!
      .execute({ days: 1 }, { stage: vi.fn(), beginExternalEffect: vi.fn() })
    const retained = registry
      .resolve(otherDefinition, scope)!
      .execute({}, { stage: vi.fn(), beginExternalEffect: vi.fn() })
    const removedRequestId = send.mock.calls[0][1].requestId as string
    const retainedRequestId = send.mock.calls[1][1].requestId as string

    expect(registry.unregister(scope.senderId, binding.name, scope)).toBe(true)
    await expect(removed).rejects.toMatchObject({ code: 'CARD_TOOL_UNMOUNTED' })
    expect(registry.resolve(otherDefinition, scope)).toBeDefined()
    registry.complete({
      senderId: scope.senderId,
      scope,
      requestId: retainedRequestId,
      result: { current: 7 }
    })
    await expect(retained).resolves.toEqual({ current: 7 })
    expect(
      registry.complete({
        senderId: scope.senderId,
        scope,
        requestId: removedRequestId,
        result: null
      })
    ).toBe(false)
  })

  it('rejects an oversized tool result before it can stage operations', async () => {
    const send = vi.fn()
    const registry = createCardToolRegistry({ maxResultBytes: 16 })
    registry.register({ scope, binding, send })
    const stage = vi.fn()
    const pending = registry
      .resolve(definition, scope)!
      .execute({ days: 1 }, { stage, beginExternalEffect: vi.fn() })
    const requestId = send.mock.calls[0][1].requestId as string

    expect(() =>
      registry.complete({ senderId: scope.senderId, requestId, result: { value: 'too large' } })
    ).toThrowError(expect.objectContaining({ code: 'CARD_TOOL_RESULT_TOO_LARGE' }))
    expect(stage).not.toHaveBeenCalled()
    await expect(pending).rejects.toMatchObject({ code: 'CARD_TOOL_RESULT_TOO_LARGE' })
  })
})
