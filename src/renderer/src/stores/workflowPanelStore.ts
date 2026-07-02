import { create } from 'zustand'

/** One node's opt-in output panel for the current/last turn (spec D4). */
export interface NodePanel {
  nodeId: string
  label?: string
  text: string
}

/**
 * Per-chat node output panels (spec D4). Fed by the `workflow-panel` IPC event; panels belong
 * to the LATEST turn only — App clears a chat's panels when its next generation starts, so a
 * settled turn keeps its panels visible until the next one begins.
 */
interface WorkflowPanelState {
  panels: Record<string, NodePanel[]>
  append: (p: { chatId: string; nodeId: string; label?: string; delta: string }) => void
  clear: (chatId: string) => void
}

export const useWorkflowPanelStore = create<WorkflowPanelState>((set) => ({
  panels: {},
  append: ({ chatId, nodeId, label, delta }) =>
    set((s) => {
      const list = s.panels[chatId] ?? []
      const existing = list.find((p) => p.nodeId === nodeId)
      const next = existing
        ? list.map((p) => (p.nodeId === nodeId ? { ...p, text: p.text + delta } : p))
        : [...list, { nodeId, label, text: delta }]
      return { panels: { ...s.panels, [chatId]: next } }
    }),
  clear: (chatId) =>
    set((s) => {
      if (!s.panels[chatId]) return s
      const { [chatId]: _dropped, ...rest } = s.panels
      return { panels: rest }
    })
}))
