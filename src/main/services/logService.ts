import { BrowserWindow } from 'electron'

export type LogLevel = 'info' | 'request' | 'response' | 'error'

export interface LogEntry {
  id: string
  ts: string
  level: LogLevel
  label: string
  detail?: string
}

const MAX_ENTRIES = 500
// Per-entry cap on the `detail` string (bytes/chars). Anything longer is stored
// truncated with a marker naming the original length.
const MAX_DETAIL_BYTES = 16 * 1024
// Total byte budget for retained `detail` across the ring. When exceeded, oldest
// entries are evicted even if the ring is under MAX_ENTRIES.
const MAX_RING_BYTES = 8 * 1024 * 1024

const buffer: LogEntry[] = []
// Sum of retained `detail` lengths, kept in step with `buffer` for O(1) budgeting.
let ringBytes = 0

// When true, `detail` is kept full (untruncated) — an opt-in escape hatch for
// deep debugging, gated on the `settings.logs.full_trace` flag (default off).
// Toggled via setFullTrace() from the settings layer to avoid an import cycle
// (logService is imported very early and must not depend on the settings service).
let fullTrace = false

/** Enable/disable full untruncated trace capture. Called from the settings layer. */
export const setFullTrace = (on: boolean): void => {
  fullTrace = !!on
}

/**
 * Record a log entry: keep it in a rolling buffer, mirror it to the process
 * stdout/stderr (so it shows in the terminal/dev output), and push it to every
 * open window for the in-app Logs panel.
 *
 * `detail` is BOUNDED to keep memory in check — request prompts and AI responses
 * can be very large (100KB+), and without a cap a single 500-entry ring can grow
 * to ~100MB. Each entry's detail is truncated to MAX_DETAIL_BYTES with a marker
 * naming the original length, and the ring evicts oldest entries once the total
 * retained detail exceeds MAX_RING_BYTES. Set `settings.logs.full_trace` (→
 * setFullTrace(true)) to bypass truncation when full traces are needed for
 * debugging.
 */
export const log = (level: LogLevel, label: string, detail?: unknown): void => {
  let detailStr: string | undefined
  if (detail !== undefined) {
    const raw = typeof detail === 'string' ? detail : safeStringify(detail)
    detailStr = fullTrace ? raw : boundDetail(raw)
  }

  const entry: LogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    level,
    label,
    detail: detailStr
  }

  buffer.push(entry)
  ringBytes += detailStr ? detailStr.length : 0
  // Evict by count, then by total byte budget (never empty the ring entirely).
  while (buffer.length > MAX_ENTRIES) evictOldest()
  while (ringBytes > MAX_RING_BYTES && buffer.length > 1) evictOldest()

  const line = `[${level}] ${label}${detailStr ? '\n' + detailStr : ''}`
  if (level === 'error') console.error(line)
  else console.log(line)

  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('log-event', entry)
  }
}

export const getLogs = (): LogEntry[] => buffer

export const clearLogs = (): void => {
  buffer.length = 0
  ringBytes = 0
}

const evictOldest = (): void => {
  const removed = buffer.shift()
  if (removed?.detail) ringBytes -= removed.detail.length
}

/** Truncate an oversized detail string to the per-entry cap, appending a marker
 *  that names the original length so nothing silently disappears. */
const boundDetail = (raw: string): string => {
  if (raw.length <= MAX_DETAIL_BYTES) return raw
  return raw.slice(0, MAX_DETAIL_BYTES) + `… [truncated, ${raw.length} chars total]`
}

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
