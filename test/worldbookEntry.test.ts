import { describe, it, expect } from 'vitest'
import { nativeToThEntry, thToNativeEntry } from '../src/shared/thRuntime/worldbookEntry'

describe('nativeToThEntry (read: native → TavernHelper)', () => {
  it('maps keys/constant/secondary to strategy and exposes name/extra', () => {
    const th = nativeToThEntry(
      {
        keys: ['alpha', 'beta'],
        secondary_keys: ['gamma'],
        constant: true,
        selective: false,
        content: 'body',
        comment: 'My Entry',
        enabled: true,
        extra: { cw_project_id: 'p1' }
      },
      3
    )
    expect(th.uid).toBe(3)
    expect(th.name).toBe('My Entry')
    expect(th.strategy.type).toBe('constant')
    expect(th.strategy.keys).toEqual(['alpha', 'beta'])
    expect(th.strategy.keys_secondary.keys).toEqual(['gamma'])
    expect(th.extra).toEqual({ cw_project_id: 'p1' })
    // a card's diff reads entry.strategy.keys — it must exist, not throw
    expect(() => JSON.stringify(th.strategy.keys)).not.toThrow()
  })

  it('a non-constant entry becomes a selective (green) strategy', () => {
    const th = nativeToThEntry({ keys: ['k'], constant: false, comment: 'x' }, 0)
    expect(th.strategy.type).toBe('selective')
    expect(th.strategy.keys).toEqual(['k'])
  })
})

describe('thToNativeEntry (write: TavernHelper → native)', () => {
  it('a constant TH entry keeps its keywords AND constant flag (the workshop bug)', () => {
    const native = thToNativeEntry({
      name: 'Downloaded',
      content: 'c',
      enabled: true,
      strategy: {
        type: 'constant',
        keys: ['one', 'two'],
        keys_secondary: { logic: 'and_any', keys: [] }
      },
      extra: { cw_project_id: 'p1' }
    })
    expect(native.constant).toBe(true) // ← always-on, the fix
    expect(native.keys).toEqual(['one', 'two']) // ← keywords preserved, the fix
    expect(native.comment).toBe('Downloaded')
    expect(native.content).toBe('c')
    expect(native.extra).toEqual({ cw_project_id: 'p1' })
  })

  it('coerces RegExp keys to strings and marks selective when secondary keys exist', () => {
    const native = thToNativeEntry({
      strategy: { type: 'selective', keys: [/abc/i], keys_secondary: { keys: ['s'] } }
    })
    expect(native.keys).toEqual(['abc'])
    expect(native.constant).toBe(false)
    expect(native.selective).toBe(true)
    expect(native.secondary_keys).toEqual(['s'])
  })
})

describe('round-trip native → TH → native', () => {
  it('preserves keys, constant, comment, content, and extra', () => {
    const original = {
      keys: ['a', 'b'],
      secondary_keys: [],
      constant: true,
      selective: false,
      content: 'hello',
      comment: 'Title',
      enabled: true,
      insertion_order: 50,
      insertion_depth: null,
      case_sensitive: true,
      probability: 100,
      extra: { cw_entry_key: 'e1' }
    }
    const back = thToNativeEntry(nativeToThEntry(original, 0))
    expect(back.keys).toEqual(['a', 'b'])
    expect(back.constant).toBe(true)
    expect(back.comment).toBe('Title')
    expect(back.content).toBe('hello')
    expect(back.insertion_order).toBe(50)
    expect(back.case_sensitive).toBe(true) // round-trips (was being reset to false)
    expect(back.extra).toEqual({ cw_entry_key: 'e1' })
  })
})
