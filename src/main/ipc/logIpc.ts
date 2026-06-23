import { IpcMain } from 'electron'
import * as logService from '../services/logService'

export const registerLogIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('get-logs', () => logService.getLogs())
  ipcMain.handle('clear-logs', () => logService.clearLogs())
}
