import { create } from 'zustand'
import type { AgentRunEvent, AgentRunRecord, AgentRunSummary } from '../../../shared/agentRuntime'

interface AgentRunState {
  byChat: Record<string, Record<string, AgentRunSummary>>
  loadingByChat: Record<string, boolean>
  errorByChat: Record<string, boolean>
  revision: number
  revisionByChat: Record<string, Record<string, number>>
  deletedRevisionByChat: Record<string, Record<string, number>>
  hydrationByChat: Record<string, { generation: number; baseRevision: number }>
  apply: (event: AgentRunEvent) => void
  beginHydrate: (chatId: string) => number
  hydrate: (chatId: string, records: AgentRunRecord[], generation: number) => boolean
  failHydrate: (chatId: string, generation: number) => void
}

export const useAgentRunStore = create<AgentRunState>((set) => ({
  byChat: {},
  loadingByChat: {},
  errorByChat: {},
  revision: 0,
  revisionByChat: {},
  deletedRevisionByChat: {},
  hydrationByChat: {},
  apply: (event) =>
    set((state) => {
      const revision = state.revision + 1
      if (event.type !== 'deleted') {
        return {
          revision,
          byChat: {
            ...state.byChat,
            [event.run.chatId]: {
              ...(state.byChat[event.run.chatId] ?? {}),
              [event.run.invocationId]: event.run
            }
          },
          revisionByChat: {
            ...state.revisionByChat,
            [event.run.chatId]: {
              ...(state.revisionByChat[event.run.chatId] ?? {}),
              [event.run.invocationId]: revision
            }
          }
        }
      }
      const chat = state.byChat[event.chatId]
      const nextChat = { ...(chat ?? {}) }
      delete nextChat[event.invocationId]
      const byChat = { ...state.byChat }
      if (Object.keys(nextChat).length) byChat[event.chatId] = nextChat
      else delete byChat[event.chatId]
      return {
        revision,
        byChat,
        deletedRevisionByChat: {
          ...state.deletedRevisionByChat,
          [event.chatId]: {
            ...(state.deletedRevisionByChat[event.chatId] ?? {}),
            [event.invocationId]: revision
          }
        }
      }
    }),
  beginHydrate: (chatId) =>
    {
      let generation = 0
      set((state) => {
        generation = (state.hydrationByChat[chatId]?.generation ?? 0) + 1
        return {
          hydrationByChat: {
            ...state.hydrationByChat,
            [chatId]: { generation, baseRevision: state.revision }
          },
          loadingByChat: { ...state.loadingByChat, [chatId]: true },
          errorByChat: { ...state.errorByChat, [chatId]: false }
        }
      })
      return generation
    },
  hydrate: (chatId, records, generation) => {
    let accepted = false
    set((state) => {
      const hydration = state.hydrationByChat[chatId]
      if (!hydration || hydration.generation !== generation) return state
      accepted = true
      const hydrated = Object.fromEntries(
        records.map((record) => [
          record.invocationId,
          {
            invocationId: record.invocationId,
            chatId: record.chatId,
            floor: record.floor,
            agentName: record.agentName,
            status: record.status,
            startedAt: record.startedAt,
            ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
            notification: record.notification,
            ...(record.failure ? { failure: record.failure } : {}),
            ...(record.provider?.model ? { model: record.provider.model } : {}),
            metrics: record.metrics
          }
        ])
      )
      const current = state.byChat[chatId] ?? {}
      for (const [invocationId, run] of Object.entries(current)) {
        if ((state.revisionByChat[chatId]?.[invocationId] ?? 0) > hydration.baseRevision) {
          hydrated[invocationId] = run
        }
      }
      for (const [invocationId, revision] of Object.entries(
        state.deletedRevisionByChat[chatId] ?? {}
      )) {
        if (revision > hydration.baseRevision) delete hydrated[invocationId]
      }
      return {
        byChat: { ...state.byChat, [chatId]: hydrated },
        loadingByChat: { ...state.loadingByChat, [chatId]: false },
        errorByChat: { ...state.errorByChat, [chatId]: false }
      }
    })
    return accepted
  },
  failHydrate: (chatId, generation) =>
    set((state) => {
      if (state.hydrationByChat[chatId]?.generation !== generation) return state
      return {
        loadingByChat: { ...state.loadingByChat, [chatId]: false },
        errorByChat: { ...state.errorByChat, [chatId]: true }
      }
    })
}))

export const recentAgentRuns = (
  byChat: AgentRunState['byChat'],
  chatId: string,
  limit = 5
): AgentRunSummary[] =>
  Object.values(byChat[chatId] ?? {})
    .filter((run) => run.status === 'running')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .concat(
      Object.values(byChat[chatId] ?? {})
        .filter((run) => run.status !== 'running')
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit)
    )
