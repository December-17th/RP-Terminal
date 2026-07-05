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
  // SYNC read for the inline transport's getChatVars (cardBridge/host.ts). Each inline frame reload spins up
  // a fresh host, and the card reads its saved session KV SYNCHRONOUSLY at boot to paint its settings UI — an
  // async fetch would return {} until it lands, so the card renders defaults over saved state. Mirrors the
  // WCV transport's `wcv-host-chat-vars-get-sync`.
  ipcMain.on('chat-card-vars-get-sync', (e, profileId: string, chatId: string) => {
    e.returnValue = getChatCardVars(String(profileId), String(chatId))
  })
}
