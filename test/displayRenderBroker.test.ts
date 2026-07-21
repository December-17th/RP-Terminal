import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DisplayRenderBroker } from '../src/main/ipc/displayRenderBroker'

// The main-side render broker (ADR 0023): it correlates a WCV card's renderFloors invoke with the
// renderer's display-render-response, clamps the batch, and never hangs the card (timeout → []).
// Timers are injected so the timeout path is deterministic without real time.

type Sent = { channel: string; payload: any }

const setup = (over: { timeoutMs?: number; maxBatch?: number } = {}) => {
  const sent: Sent[] = []
  const timers = new Map<number, () => void>()
  let timerSeq = 0
  const broker = new DisplayRenderBroker({
    send: (channel, payload) => sent.push({ channel, payload }),
    timeoutMs: over.timeoutMs ?? 10_000,
    maxBatch: over.maxBatch ?? 32,
    setTimer: (fn) => {
      const id = ++timerSeq
      timers.set(id, fn)
      return id
    },
    clearTimer: (t) => {
      timers.delete(t as number)
    }
  })
  const fireTimer = (id: number): void => {
    const fn = timers.get(id)
    timers.delete(id)
    fn?.()
  }
  return { broker, sent, timers, fireTimer }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('DisplayRenderBroker — correlation + timeout + clamp', () => {
  it('forwards a request and resolves with the matching response views', async () => {
    const { broker, sent } = setup()
    const p = broker.request({ profileId: 'p', chatId: 'c', from: 0, to: 2 })
    expect(sent).toHaveLength(1)
    expect(sent[0].channel).toBe('display-render-request')
    const { reqId, from, to } = sent[0].payload
    expect(from).toBe(0)
    expect(to).toBe(2)
    const views = [{ floorIndex: 0 }, { floorIndex: 1 }, { floorIndex: 2 }]
    broker.resolve(reqId, views)
    await expect(p).resolves.toBe(views)
  })

  it('resolves [] on timeout (renderer never replied)', async () => {
    const { broker, sent, fireTimer } = setup({ timeoutMs: 5000 })
    const p = broker.request({ profileId: 'p', chatId: 'c', from: 0, to: 0 })
    expect(sent).toHaveLength(1)
    fireTimer(1) // the request's timeout fires
    await expect(p).resolves.toEqual([])
  })

  it('a late response after timeout is ignored (no throw, no double-resolve)', async () => {
    const { broker, sent, fireTimer } = setup()
    const p = broker.request({ profileId: 'p', chatId: 'c', from: 0, to: 0 })
    const { reqId } = sent[0].payload
    fireTimer(1)
    await expect(p).resolves.toEqual([])
    expect(() => broker.resolve(reqId, [{ floorIndex: 0 }])).not.toThrow()
  })

  it('clamps the batch to maxBatch floors (to ≤ from + maxBatch - 1)', () => {
    const { broker, sent } = setup({ maxBatch: 32 })
    broker.request({ profileId: 'p', chatId: 'c', from: 10, to: 999 })
    expect(sent[0].payload.from).toBe(10)
    expect(sent[0].payload.to).toBe(41) // 10 + 32 - 1
  })

  it('does not over-clamp a window already within the cap', () => {
    const { broker, sent } = setup({ maxBatch: 32 })
    broker.request({ profileId: 'p', chatId: 'c', from: 5, to: 9 })
    expect(sent[0].payload.to).toBe(9)
  })

  it('resolves [] without sending for an inverted range (to < from)', async () => {
    const { broker, sent } = setup()
    const p = broker.request({ profileId: 'p', chatId: 'c', from: 5, to: 2 })
    expect(sent).toHaveLength(0)
    await expect(p).resolves.toEqual([])
  })

  it('forwards the panel chatScope so the renderer indexes floors identically', () => {
    const { broker, sent } = setup()
    const scope = { messages: [{ role: 'assistant', content: 'x' }] }
    broker.request({ profileId: 'p', chatId: 'c', from: 0, to: 0, scope })
    expect(sent[0].payload.scope).toBe(scope)
  })

  it('a mismatched reqId does not resolve a pending request', async () => {
    const { broker, sent } = setup()
    const p = broker.request({ profileId: 'p', chatId: 'c', from: 0, to: 0 })
    broker.resolve(9999, [{ floorIndex: 0 }]) // unknown id — ignored
    let settled = false
    void p.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    broker.resolve(sent[0].payload.reqId, []) // real id settles it
    await expect(p).resolves.toEqual([])
  })
})
