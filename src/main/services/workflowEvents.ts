import { BrowserWindow } from 'electron'
import { WorkflowRunTrace } from '../../shared/workflow/trace'

/**
 * Push one turn's workflow run trace to open renderers (spec §13 "Run/trace panel"): per-node
 * ran/skipped/failed + timing + output previews. Broadcast to all windows (the memoryEvents /
 * logService pattern); the renderer filters by chatId and keeps only the latest trace per chat.
 */
export const notifyWorkflowTrace = (trace: WorkflowRunTrace): void => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('workflow-trace', trace)
}
