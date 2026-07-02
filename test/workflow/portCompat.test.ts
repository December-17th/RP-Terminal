import { describe, it, expect } from 'vitest'
import { portCompatible } from '../../src/shared/workflow/types'

describe('portCompatible', () => {
  it('accepts identical types', () => {
    expect(portCompatible('Messages', 'Messages')).toBe(true)
    expect(portCompatible('Signal', 'Signal')).toBe(true)
  })

  it('rejects mismatched concrete types', () => {
    expect(portCompatible('Text', 'Messages')).toBe(false)
    expect(portCompatible('Signal', 'Text')).toBe(false)
    expect(portCompatible('Error', 'Vars')).toBe(false)
  })

  it('treats Any as a wildcard in both directions', () => {
    expect(portCompatible('Any', 'Messages')).toBe(true)
    expect(portCompatible('Error', 'Any')).toBe(true)
    expect(portCompatible('Any', 'Any')).toBe(true)
  })

  it('only Signal sources may feed a Signal input (gating counts source type)', () => {
    // An Any→Signal wire would validate yet never gate anything — the engine's signal-gating
    // looks at the SOURCE port type — so it is rejected instead of being silently useless.
    expect(portCompatible('Any', 'Signal')).toBe(false)
    expect(portCompatible('Text', 'Signal')).toBe(false)
    expect(portCompatible('Signal', 'Signal')).toBe(true)
    // Signal→Any stays legal ("run util.log when this fires" patterns).
    expect(portCompatible('Signal', 'Any')).toBe(true)
  })
})
