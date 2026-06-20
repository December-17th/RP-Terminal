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
const MAX_DETAIL = 20000
const buffer: LogEntry[] = []

/**
 * Record a log entry: keep it in a rolling buffer, mirror it to the process
 * stdout/stderr (so it shows in the terminal/dev output), and push it to every
 * open window for the in-app Logs panel.
 */
export const log = (level: LogLevel, label: string, detail?: unknown): void => {
  let detailStr: string | undefined
  if (detail !== undefined) {
    detailStr = typeof detail === 'string' ? detail : safeStringify(detail)
    if (detailStr.length > MAX_DETAIL) detailStr = detailStr.slice(0, MAX_DETAIL) + '\n…(truncated)'
  }

  const entry: LogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    level,
    label,
    detail: detailStr
  }

  buffer.push(entry)
  if (buffer.length > MAX_ENTRIES) buffer.shift()

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
}

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
