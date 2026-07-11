import { IpcMain } from 'electron'
import * as notesMemoryService from '../services/notesMemoryService'

/**
 * IPC for the per-chat plot-recall NOTES store (plot-recall WP2): read/write the human-editable
 * markdown notes file backing grep-based agentic recall. The Notes tab (WP7) binds to these; the
 * recall/maintainer nodes (WP4/WP6) call the service directly, not this surface.
 */
export const registerNotesMemoryIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('chat-notes-get', (_, profileId: string, chatId: string) =>
    notesMemoryService.readNotes(profileId, chatId)
  )
  ipcMain.handle('chat-notes-set', (_, profileId: string, chatId: string, notes: string) => {
    notesMemoryService.writeNotes(profileId, chatId, typeof notes === 'string' ? notes : '')
  })
}
