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
// Per-entry cap on the `detail` string, in UTF-8 BYTES (not JS string length — CJK/multibyte logs
// would otherwise blow past the budget by up to 3-4x). Anything longer is stored truncated, and the
// truncation marker itself fits WITHIN the cap.
const MAX_DETAIL_BYTES = 16 * 1024
// Total UTF-8 byte budget for retained `detail` across the ring. When exceeded, oldest entries are
// evicted even if the ring is under MAX_ENTRIES. This bound is HARD: even full_trace entries are
// individually capped at MAX_RING_BYTES, so the ring can never retain more than MAX_RING_BYTES of
// detail in total.
const MAX_RING_BYTES = 8 * 1024 * 1024

const buffer: LogEntry[] = []
// Sum of retained `detail` UTF-8 bytes, kept in step with `buffer` for O(1) budgeting.
let ringBytes = 0

// When true, the per-entry cap is raised from MAX_DETAIL_BYTES to MAX_RING_BYTES — an opt-in escape
// hatch for deep debugging (settings.logs.full_trace, default off). Deliberately NOT unbounded: the
// ring's total budget stays hard either way. Toggled via setFullTrace() from the settings layer to
// avoid an import cycle (logService is imported very early and must not depend on settings).
let fullTrace = false

/** Raise the per-entry detail cap to the full ring budget. Called from the settings layer. */
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
 * to ~100MB. Each entry's detail is truncated to the per-entry byte cap (16KB, or
 * the whole 8MB ring budget under full_trace) with a marker naming the original
 * size, and the ring evicts oldest entries once the total retained detail exceeds
 * MAX_RING_BYTES.
 */
export const log = (level: LogLevel, label: string, detail?: unknown): void => {
  let detailStr: string | undefined
  if (detail !== undefined) {
    const raw = typeof detail === 'string' ? detail : safeStringify(detail)
    detailStr = boundDetail(raw, fullTrace ? MAX_RING_BYTES : MAX_DETAIL_BYTES)
  }

  const entry: LogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    level,
    label,
    detail: detailStr
  }

  buffer.push(entry)
  ringBytes += detailStr ? Buffer.byteLength(detailStr, 'utf8') : 0
  // Evict by count, then by total byte budget. The per-entry cap ≤ MAX_RING_BYTES guarantees the
  // budget is satisfiable even when a single (full_trace) entry remains.
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
  if (removed?.detail) ringBytes -= Buffer.byteLength(removed.detail, 'utf8')
}

/** Truncate an oversized detail string so that PREFIX + MARKER fits within `maxBytes` (UTF-8),
 *  never splitting a multibyte character (a split tail decodes to U+FFFD and is dropped). The
 *  marker names the original byte size so nothing silently disappears. */
const boundDetail = (raw: string, maxBytes: number): string => {
  const rawBytes = Buffer.byteLength(raw, 'utf8')
  if (rawBytes <= maxBytes) return raw
  const marker = `… [truncated, ${rawBytes} bytes total]`
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'))
  const prefix = Buffer.from(raw, 'utf8')
    .subarray(0, budget)
    .toString('utf8')
    .replace(/�+$/, '')
  return prefix + marker
}

const safeStringify = (value: unknown): string => {
  try {
    // JSON.stringify returns undefined for symbols/functions/undefined — fall back to String()
    // so boundDetail never sees a non-string (S3).
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}
