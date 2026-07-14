import { describe, expect, it } from 'vitest'
import { shouldOpenWcvDevTools } from '../src/main/services/wcvDevTools'

describe('shouldOpenWcvDevTools', () => {
  it('keeps detached DevTools closed unless explicitly enabled', () => {
    expect(shouldOpenWcvDevTools({})).toBe(false)
    expect(shouldOpenWcvDevTools({ RPT_OPEN_WCV_DEVTOOLS: '0' })).toBe(false)
    expect(shouldOpenWcvDevTools({ RPT_OPEN_WCV_DEVTOOLS: '1' })).toBe(true)
  })
})
