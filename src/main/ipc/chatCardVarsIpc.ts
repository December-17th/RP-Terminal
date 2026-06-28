import { ipcMain } from 'electron'
import { getChatCardVars, setChatCardVars } from '../services/chatCardVarsService'

// Per-chat card KV for the INLINE transport (the renderer passes profileId+chatId explicitly; the WCV
// transport resolves them from e.sender in wcvIpc).
export function registerChatCardVarsIpc(): void {
  ipcMain.handle('chat-card-vars-get', (_e, profileId: string, chatId: string) =>
    getChatCardVars(String(profileId), String(chatId))
  )
  ipcMain.handle('chat-card-vars-set', (_e, profileId: string, chatId: string, vars: any) => {
    setChatCardVars(String(profileId), String(chatId), vars && typeof vars === 'object' ? vars : {})
    return true
  })
}
