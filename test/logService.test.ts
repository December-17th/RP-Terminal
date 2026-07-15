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

  it('truncates an oversized detail to the per-entry BYTE cap, marker included within it', () => {
    const CAP = 16 * 1024
    const big = 'x'.repeat(CAP + 5000)
    log('request', 'huge', big)

    const entry = getLogs()[0]
    expect(entry.detail).toBeDefined()
    const detail = entry.detail as string
    // Bounded INCLUDING the marker (S1): prefix + marker together fit the cap.
    expect(Buffer.byteLength(detail, 'utf8')).toBeLessThanOrEqual(CAP)
    // Marker names the true original byte size.
    expect(detail).toContain(`[truncated, ${Buffer.byteLength(big, 'utf8')} bytes total]`)
  })

  it('accounts in UTF-8 bytes, not JS string length (multibyte/CJK)', () => {
    const CAP = 16 * 1024
    // 8K CJK chars = 8K UTF-16 units but ~24KB UTF-8 — over the byte cap despite a small .length.
    const cjk = '汉'.repeat(8 * 1024)
    expect(cjk.length).toBeLessThan(CAP) // the old length-based check would NOT truncate this
    log('request', 'cjk', cjk)

    const detail = getLogs()[0].detail as string
    expect(Buffer.byteLength(detail, 'utf8')).toBeLessThanOrEqual(CAP)
    expect(detail).toContain('bytes total]')
    // The byte-boundary cut never leaves a split multibyte char (no U+FFFD before the marker).
    expect(detail).not.toContain('�')
  })

  it('survives details JSON.stringify cannot serialize (symbols/functions) — S3', () => {
    expect(() => log('info', 'weird', Symbol('nope'))).not.toThrow()
    expect(getLogs()[0].detail).toContain('Symbol(nope)')
    expect(() => log('info', 'fn', () => 1)).not.toThrow()
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

  it('full_trace keeps large details untruncated up to the ring budget', () => {
    setFullTrace(true)
    const big = 'z'.repeat(200_000)
    log('response', 'full', big)

    const entry = getLogs()[0]
    expect(entry.detail).toBe(big)
    expect(entry.detail).not.toContain('truncated')
  })

  it('full_trace stays HARD-bounded: a single entry can never exceed the total ring budget (S2)', () => {
    setFullTrace(true)
    log('request', 'giant', 'q'.repeat(9 * 1024 * 1024)) // > 8MB
    const logs = getLogs()
    expect(logs.length).toBe(1) // ring never empties…
    // …but the entry itself is capped at the ring budget, marker included.
    expect(Buffer.byteLength(logs[0].detail as string, 'utf8')).toBeLessThanOrEqual(
      8 * 1024 * 1024
    )
    expect(logs[0].detail).toContain('bytes total]')
  })
})
