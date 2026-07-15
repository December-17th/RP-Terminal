import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { log, getLogs, clearLogs, setFullTrace } from '../src/main/services/logService'

// logService imports BrowserWindow from 'electron' — resolved to test/mocks/electron.ts
// (getAllWindows() → []), so `log()` runs without a live Electron runtime.

describe('logService bounded detail', () => {
  beforeEach(() => {
    clearLogs()
    setFullTrace(false)
    // Silence the stdout/stderr mirror so the test output stays clean.
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    clearLogs()
    setFullTrace(false)
    vi.restoreAllMocks()
  })

  it('truncates an oversized detail to the per-entry cap with an original-length marker', () => {
    const CAP = 16 * 1024
    const big = 'x'.repeat(CAP + 5000)
    log('request', 'huge', big)

    const entry = getLogs()[0]
    expect(entry.detail).toBeDefined()
    const detail = entry.detail as string
    // Bounded: cap + marker, far below the original.
    expect(detail.length).toBeLessThan(big.length)
    expect(detail.startsWith('x'.repeat(CAP))).toBe(true)
    // Marker names the true original length.
    expect(detail).toContain(`[truncated, ${big.length} chars total]`)
  })

  it('leaves a small detail untouched (no marker)', () => {
    log('info', 'small', 'hello world')
    const entry = getLogs()[0]
    expect(entry.detail).toBe('hello world')
    expect(entry.detail).not.toContain('truncated')
  })

  it('evicts oldest entries once the total ring byte-budget is exceeded', () => {
    // Use full_trace so each entry stores a full 1MB (bypassing the 16KB per-entry cap);
    // 30MB of payload well exceeds the 8MB ring budget and forces eviction long before
    // the 500-entry count cap would.
    setFullTrace(true)
    const oneEntryPayload = 'y'.repeat(1024 * 1024) // 1MB each
    const count = 30
    for (let i = 0; i < count; i++) log('request', `req-${i}`, oneEntryPayload)

    const logs = getLogs()
    // Byte budget evicted far below the 500 count cap.
    expect(logs.length).toBeLessThan(500)
    expect(logs.length).toBeGreaterThan(0)
    // Total retained detail stays within the 8MB budget.
    const totalBytes = logs.reduce((sum, e) => sum + (e.detail?.length ?? 0), 0)
    expect(totalBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    // The surviving entries are the most-recent ones.
    expect(logs[logs.length - 1].label).toBe(`req-${count - 1}`)
    expect(logs[0].label).not.toBe('req-0')
  })

  it('full_trace bypass keeps the entire untruncated detail', () => {
    setFullTrace(true)
    const big = 'z'.repeat(200_000)
    log('response', 'full', big)

    const entry = getLogs()[0]
    expect(entry.detail).toBe(big)
    expect(entry.detail).not.toContain('truncated')
  })

  it('never empties the ring even if a single entry exceeds the byte budget', () => {
    setFullTrace(true) // store one huge (> 8MB) untruncated entry
    log('request', 'giant', 'q'.repeat(9 * 1024 * 1024))
    expect(getLogs().length).toBe(1)
  })
})
