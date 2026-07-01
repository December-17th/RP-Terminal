import { describe, it, expect } from 'vitest'
import { createRegistry } from '../../src/main/services/nodes/registry'
import { NodeImpl } from '../../src/main/services/nodes/types'

const impl = (type: string): NodeImpl => ({
  type,
  title: type,
  inputs: [{ name: 'in', type: 'Text' }],
  outputs: [{ name: 'out', type: 'Text' }],
  run: () => ({ outputs: { out: type } })
})

describe('createRegistry', () => {
  it('looks up impls by type', () => {
    const reg = createRegistry([impl('a'), impl('b')])
    expect(reg.get('a')?.type).toBe('a')
    expect(reg.has('b')).toBe(true)
    expect(reg.get('missing')).toBeUndefined()
  })

  it('exposes descriptors (ports without run) for validation', () => {
    const reg = createRegistry([impl('a')])
    const d = reg.descriptors()
    expect(d.get('a')?.outputs).toEqual([{ name: 'out', type: 'Text' }])
    // the descriptor must not carry run()
    expect('run' in (d.get('a') as object)).toBe(false)
  })

  it('throws on a duplicate node type', () => {
    expect(() => createRegistry([impl('a'), impl('a')])).toThrow(/duplicate node type/)
  })
})
