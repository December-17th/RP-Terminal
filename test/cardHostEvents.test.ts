import { describe, it, expect } from 'vitest'
import { emitCardHostEvent, onCardHostEvent } from '../src/renderer/src/cardBridge/cardHostEvents'

describe('cardHostEvents', () => {
  it('delivers an emitted event to every subscriber', () => {
    const a: any[] = []
    const b: any[] = []
    const offA = onCardHostEvent((n, p) => a.push([n, p]))
    const offB = onCardHostEvent((n, p) => b.push([n, p]))
    emitCardHostEvent('generation_ended', { x: 1 })
    expect(a).toEqual([['generation_ended', { x: 1 }]])
    expect(b).toEqual([['generation_ended', { x: 1 }]])
    offA()
    offB()
  })

  it('unsubscribe stops delivery', () => {
    const got: string[] = []
    const off = onCardHostEvent((n) => got.push(n))
    emitCardHostEvent('a')
    off()
    emitCardHostEvent('b')
    expect(got).toEqual(['a'])
  })

  it('a throwing subscriber does not break the others', () => {
    const got: string[] = []
    const off1 = onCardHostEvent(() => {
      throw new Error('boom')
    })
    const off2 = onCardHostEvent((n) => got.push(n))
    emitCardHostEvent('x')
    expect(got).toEqual(['x'])
    off1()
    off2()
  })
})
