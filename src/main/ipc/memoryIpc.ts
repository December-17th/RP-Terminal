import { IpcMain } from 'electron'
import * as memoryStore from '../services/memoryStore'

/**
 * Memory data-management IPC. The renderer's Memory view browses and corrects the stored
 * episodic memories for the active chat (docs/episodic-memory-design.md §11.F / §17).
 */
export const registerMemoryIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('memory-list', (_, profileId, chatId) =>
    memoryStore.getAllEntries(profileId, chatId)
  )
  ipcMain.handle('memory-update', (_, profileId, chatId, id, patch) =>
    memoryStore.updateEntry(profileId, chatId, id, patch)
  )
  ipcMain.handle('memory-delete', (_, profileId, chatId, id) =>
    memoryStore.deleteEntry(profileId, chatId, id)
  )
}
