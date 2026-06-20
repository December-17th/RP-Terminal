import { create } from 'zustand'

export type LogLevel = 'info' | 'request' | 'response' | 'error'

export interface LogEntry {
  id: string
  ts: string
  level: LogLevel
  label: string
  detail?: string
}

interface LogState {
  entries: LogEntry[]
  load: () => Promise<void>
  add: (entry: LogEntry) => void
  clear: () => Promise<void>
}

const MAX = 500

export const useLogStore = create<LogState>((set) => ({
  entries: [],
  load: async () => {
    const entries = await window.api.getLogs()
    set({ entries: entries || [] })
  },
  add: (entry) =>
    set((state) => {
      const entries = [...state.entries, entry]
      if (entries.length > MAX) entries.splice(0, entries.length - MAX)
      return { entries }
    }),
  clear: async () => {
    await window.api.clearLogs()
    set({ entries: [] })
  }
}))
