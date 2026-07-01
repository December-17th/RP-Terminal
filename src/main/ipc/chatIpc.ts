import { IpcMain } from 'electron'
import * as chatService from '../services/chatService'
import * as floorService from '../services/floorService'
import * as generationService from '../services/generationService'
import * as chatWriteService from '../services/chatWriteService'
import * as combatService from '../services/combatService'
import * as logService from '../services/logService'
import * as usageMetricsService from '../services/usageMetricsService'

export const registerChatIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('get-chats', (_, profileId) => chatService.getChats(profileId))
  ipcMain.handle('create-chat', (_, profileId, charId) => chatService.createChat(profileId, charId))
  ipcMain.handle('get-floors', (_, profileId, chatId) => {
    const chat = chatService.getChat(profileId, chatId)
    return chat ? floorService.getAllFloors(profileId, chatId, chat.floor_count) : []
  })
  ipcMain.handle('backfill-usage-metrics', (_, profileId, chatId) =>
    usageMetricsService.backfillUsageMetrics(profileId, chatId)
  )
  // Re-apply the stored <UpdateVariable> updates to rebuild stat_data (no regeneration).
  ipcMain.handle('reevaluate-variables', (_, profileId, chatId) =>
    generationService.reevaluateVariables(profileId, chatId)
  )
  // Variable write-back: apply JSONPatch ops to a floor's stat_data (panel UI editing state).
  ipcMain.handle('apply-variable-ops', (_, profileId, chatId, floor, ops) =>
    generationService.applyVariableOps(profileId, chatId, floor, ops)
  )
  // Variables-view whole-object write: replace a floor's stat_data wholesale (manual JSON edit).
  ipcMain.handle('variables-set-stat-data', (_, profileId, chatId, floor, statData) =>
    generationService.setFloorStatData(profileId, chatId, floor, statData)
  )
  ipcMain.handle('delete-chat', (_, profileId, chatId) => chatService.deleteChat(profileId, chatId))
  ipcMain.handle('edit-floor', (_, profileId, chatId, floorIndex, userContent, responseContent) =>
    chatService.editFloorContent(profileId, chatId, floorIndex, userContent, responseContent)
  )

  // TavernHelper chat-WRITE (SP3) — the same chatWriteService the WCV path uses, reached from the inline
  // card host via window.api (explicit ctx). Each mutation re-folds <UpdateVariable> into stat_data; the
  // renderer reloads its own floors after (no host push needed — it IS the host).
  ipcMain.handle('chat-set-messages', (_, profileId, chatId, messages) => {
    const n = chatWriteService.setChatMessages(profileId, chatId, messages)
    if (n) chatWriteService.afterChatMutation(profileId, chatId)
    return n > 0
  })
  ipcMain.handle('chat-delete-messages', (_, profileId, chatId, ids) => {
    const ok = chatWriteService.deleteChatMessages(profileId, chatId, ids)
    if (ok) chatWriteService.afterChatMutation(profileId, chatId)
    return ok
  })
  ipcMain.handle('chat-save', (_, profileId, chatId, chat) => {
    if (!chatWriteService.saveChat(profileId, chatId, chat)) return false
    chatWriteService.afterChatMutation(profileId, chatId)
    return true
  })

  ipcMain.handle('generate', async (event, profileId, chatId, userAction) => {
    try {
      return await generationService.generate(profileId, chatId, userAction, (delta) =>
        event.sender.send('generation-delta', { chatId, delta })
      )
    } catch (err: any) {
      logService.log('error', '✗ generate failed', err?.message || String(err))
      throw err
    }
  })
  ipcMain.handle('regenerate', async (event, profileId, chatId) => {
    try {
      const floor = await generationService.regenerate(profileId, chatId, (delta) =>
        event.sender.send('generation-delta', { chatId, delta })
      )
      // Re-rolling the latest message rewrites the narrative that an active fight branched from
      // (e.g. the message that emitted <rpt-combat-start>) — so abandon the stale encounter.
      combatService.clearEncounter(chatId)
      return floor
    } catch (err: any) {
      logService.log('error', '✗ regenerate failed', err?.message || String(err))
      throw err
    }
  })
  ipcMain.handle('abort-generation', (_, chatId) => generationService.abortGeneration(chatId))

  // TH-4 generation control: a custom one-off generation (not persisted, not streamed to
  // the chat view) + an image-generation hook.
  ipcMain.handle('generate-raw', async (_, profileId, chatId, config) => {
    try {
      return await generationService.generateRaw(profileId, chatId, config)
    } catch (err: any) {
      logService.log('error', '✗ generate-raw failed', err?.message || String(err))
      throw err
    }
  })
  ipcMain.handle('generate-image', (_, profileId, prompt) =>
    generationService.generateImage(profileId, prompt)
  )

  // TH-2 swipes: switch the active alternate, or generate a new one for the latest floor.
  // Either changes the active message, so a fight that branched from it is abandoned (clearEncounter).
  ipcMain.handle('set-active-swipe', (_, profileId, chatId, floorIndex, swipeId) => {
    const r = floorService.setActiveSwipe(profileId, chatId, floorIndex, swipeId)
    combatService.clearEncounter(chatId)
    return r
  })
  ipcMain.handle('generate-swipe', async (event, profileId, chatId) => {
    try {
      const floor = await generationService.generateSwipe(profileId, chatId, (delta) =>
        event.sender.send('generation-delta', { chatId, delta })
      )
      combatService.clearEncounter(chatId)
      return floor
    } catch (err: any) {
      logService.log('error', '✗ swipe failed', err?.message || String(err))
      throw err
    }
  })

  // Per-session active lorebook selection + FSM mode (Phase H).
  ipcMain.handle('get-chat-lorebooks', (_, profileId, chatId) =>
    chatService.getChatLorebookIds(profileId, chatId)
  )
  // ST-PT [RENDER:*]: the active render-marker templates for this session (the renderer wraps each message).
  ipcMain.handle('get-render-markers', (_, profileId, chatId) =>
    generationService.getRenderMarkers(profileId, chatId)
  )
  ipcMain.handle('set-chat-lorebooks', (_, profileId, chatId, ids) =>
    chatService.setChatLorebookIds(profileId, chatId, ids)
  )
  ipcMain.handle('get-chat-mode', (_, profileId, chatId) =>
    chatService.getChatMode(profileId, chatId)
  )
  ipcMain.handle('set-chat-mode', (_, profileId, chatId, mode) =>
    chatService.setChatMode(profileId, chatId, mode)
  )
}
