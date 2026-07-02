import { create } from 'zustand'
import type { WorkflowRunTrace } from '../../../shared/workflow/trace'

/**
 * Last workflow run trace per chat (spec §13 run/trace panel). Fed by the `workflow-trace`
 * IPC event — subscribed once in App so traces from turns that ran while the panel was closed
 * are still there when it opens. Only the latest trace per chat is kept (it reflects the last
 * turn, like the engine's own trace).
 */
interface WorkflowTraceState {
  traces: Record<string, WorkflowRunTrace>
  put: (trace: WorkflowRunTrace) => void
}

export const useWorkflowTraceStore = create<WorkflowTraceState>((set) => ({
  traces: {},
  put: (trace) => set((s) => ({ traces: { ...s.traces, [trace.chatId]: trace } }))
}))
