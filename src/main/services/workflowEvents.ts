import { BrowserWindow } from 'electron'
import { WorkflowRunTrace } from '../../shared/workflow/trace'

/**
 * Push one turn's workflow run trace to open renderers (spec §13 "Run/trace panel"): per-node
 * ran/skipped/failed + timing + output previews. Broadcast to all windows (the logService
 * pattern); the renderer filters by chatId and keeps only the latest trace per chat.
 */
export const notifyWorkflowTrace = (trace: WorkflowRunTrace): void => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('workflow-trace', trace)
}

/** One opt-in node output panel delta (spec D4): the renderer appends it to the node's
 *  collapsible chat panel, keyed by (chatId, nodeId), labeled by the doc's panel.label. */
export interface WorkflowPanelDelta {
  chatId: string
  nodeId: string
  label?: string
  delta: string
}

export const notifyWorkflowPanel = (payload: WorkflowPanelDelta): void => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('workflow-panel', payload)
}

/** One live side-agent activity edge (agent-activity-indicator): a `calls-llm` node OTHER than the
 *  narrator (llm.sample) started ('start') or finished ('end') its API request. The engine emits this
 *  around each announced node so the chat can show a "Recalling memories…" ghost (pre) / "Updating
 *  memory…" chip (post). Broadcast to all windows (the notifyWorkflowTrace pattern); the renderer keys
 *  by chatId. Purely advisory — never affects the run. */
export interface WorkflowActivity {
  chatId: string
  nodeId: string
  nodeType: string
  phase: 'pre' | 'post'
  state: 'start' | 'end'
}

export const notifyWorkflowActivity = (payload: WorkflowActivity): void => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('workflow-activity', payload)
}
