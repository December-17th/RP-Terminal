import { IpcMain } from 'electron'
import * as wcvManager from '../services/wcvManager'
import * as floorService from '../services/floorService'
import * as generationService from '../services/generationService'
import * as lorebookService from '../services/lorebookService'
import * as chatService from '../services/chatService'
import * as characterService from '../services/characterService'
import { log } from '../services/logService'

// Resolve the calling card UI's character (its lorebook is its character_book, stored at id ==
// characterId). Prefer the slot ctx; fall back to the chat row — the renderer's activeCharacter can be
// empty when a chat is opened directly, but the chat always knows its character.
const cardLoreCtx = (senderId: number): { profileId: string; characterId: string } | null => {
  const ctx = wcvManager.contextFor(senderId)
  if (!ctx) return null
  const characterId =
    ctx.characterId || chatService.getChat(ctx.profileId, ctx.chatId)?.character_id || ''
  return characterId ? { profileId: ctx.profileId, characterId } : null
}

/**
 * WebContentsView card-UI panel IPC (spike). Position commands are fire-and-forget (`on`);
 * the host-bridge reads/writes are request/response (`handle`). The bridge resolves the
 * calling panel's session from its webContents id (set when the view was created), so a card
 * page can only touch its own session's message variables.
 */
export const registerWcvIpc = (ipcMain: IpcMain): void => {
  ipcMain.on('wcv-ensure', (_e, id, bounds, url, ctx) => wcvManager.ensure(id, bounds, url, ctx))
  ipcMain.on('wcv-set-bounds', (_e, id, bounds) => wcvManager.setBounds(id, bounds))
  ipcMain.on('wcv-set-visible', (_e, id, visible) => wcvManager.setVisible(id, visible))
  ipcMain.on('wcv-destroy', (_e, id) => wcvManager.destroy(id))
  // Host → card panels: the latest stat_data changed (model turn / edit) — refresh their mirrors.
  ipcMain.on('wcv-broadcast-vars', (_e, chatId, statData) =>
    wcvManager.notifyVarsChanged(chatId, statData)
  )
  // Card → host: set RP Terminal's chat input box (the onboarding finish's "inject prompt").
  ipcMain.on('wcv-host-set-input', (e, text) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (ctx) wcvManager.pushHostInput(ctx.chatId, String(text ?? ''))
  })

  // Read the latest floor's message variables (stat_data) for the calling panel's session.
  ipcMain.handle('wcv-host-get-vars', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return {}
    const floors = floorService.getAllFloors(ctx.profileId, ctx.chatId)
    return floors[floors.length - 1]?.variables?.stat_data ?? {}
  })

  // Synchronous variant: the shim hydrates its mirror with this at preload load, so stat_data is
  // present BEFORE the card's React app first renders (an async read would land after default render).
  ipcMain.on('wcv-host-get-vars-sync', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) {
      e.returnValue = {}
      return
    }
    const floors = floorService.getAllFloors(ctx.profileId, ctx.chatId)
    e.returnValue = floors[floors.length - 1]?.variables?.stat_data ?? {}
  })

  // Write JSONPatch ops to the latest floor's stat_data via the same bridge the model uses,
  // then push the result to the host renderer (native panels) and any sibling WCVs.
  ipcMain.handle('wcv-host-apply-vars', (e, ops) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return null
    const floors = floorService.getAllFloors(ctx.profileId, ctx.chatId)
    const latest = floors[floors.length - 1]
    if (!latest) return null
    const floor = generationService.applyVariableOps(ctx.profileId, ctx.chatId, latest.floor, ops)
    const statData = floor?.variables?.stat_data ?? {}
    wcvManager.pushHostVars(ctx.chatId, floor?.variables)
    wcvManager.notifyVarsChanged(ctx.chatId, statData)
    return statData
  })

  // Replace the latest floor's stat_data wholesale (Mvu.replaceMvuData / replaceVariables from the card).
  ipcMain.handle('wcv-host-set-vars', (e, statData) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return null
    const floors = floorService.getAllFloors(ctx.profileId, ctx.chatId)
    const latest = floors[floors.length - 1]
    if (!latest) return null
    latest.variables = { ...latest.variables, stat_data: statData }
    floorService.saveFloor(ctx.profileId, ctx.chatId, latest)
    wcvManager.pushHostVars(ctx.chatId, latest.variables)
    wcvManager.notifyVarsChanged(ctx.chatId, statData)
    return statData
  })

  // --- Worldbook (lorebook) bridge ---
  // A card's own lorebook is its character_book (stored under id == characterId). The card's home reads
  // its expansions/cores (getCharWorldbookNames → getWorldbook) and toggles them (updateWorldbookWith →
  // replace). The worldbook `name` arg is the card's own book, so we resolve to its character regardless.
  // SYNC: cards call getCharWorldbookNames WITHOUT await (it's synchronous in TavernHelper). An async
  // Promise return makes `.primary` read as undefined → the card bails before getWorldbook. Return inline.
  ipcMain.on('wcv-host-get-worldbook-names-sync', (e) => {
    const c = cardLoreCtx(e.sender.id)
    if (!c) {
      e.returnValue = { primary: null, additional: [] }
      return
    }
    const lb = lorebookService.getLorebookById(c.profileId, c.characterId)
    log(
      'info',
      'wcv worldbook',
      `char ${c.characterId.slice(0, 8)} → ${lb ? `${lb.entries.length} entries` : 'no book'}`
    )
    e.returnValue = { primary: lb ? lb.name || c.characterId : null, additional: [] }
  })

  // Entries of the card's worldbook, mapped to the TavernHelper entry shape (the card reads .name +
  // .enabled). `uid` is the array index, used to match writes back without losing our other fields.
  ipcMain.handle('wcv-host-get-worldbook', (e) => {
    const c = cardLoreCtx(e.sender.id)
    if (!c) return []
    const lb = lorebookService.getLorebookById(c.profileId, c.characterId)
    if (!lb) return []
    const out = lb.entries.map((en, i) => ({
      uid: i,
      name: en.comment || `Entry ${i + 1}`,
      comment: en.comment || '',
      enabled: en.enabled,
      content: en.content,
      keys: en.keys
    }))
    log('info', 'wcv getWorldbook', `${out.length} entries (${out.filter((o) => /^\[DLC\]/.test(o.name)).length} DLC) → card`)
    return out
  })

  // Persist a worldbook the card modified — apply enabled toggles back onto our entries (matched by
  // uid, falling back to name/comment) so every other field is preserved.
  ipcMain.handle('wcv-host-replace-worldbook', (e, _name, entries) => {
    const c = cardLoreCtx(e.sender.id)
    if (!c) return false
    const lb = lorebookService.getLorebookById(c.profileId, c.characterId)
    if (!lb) return false
    for (const te of Array.isArray(entries) ? entries : []) {
      const i = typeof te?.uid === 'number' ? te.uid : -1
      const target =
        i >= 0 && i < lb.entries.length
          ? lb.entries[i]
          : lb.entries.find((en) => (en.comment || '') === (te?.name ?? te?.comment ?? ''))
      if (target) target.enabled = te?.enabled !== false
    }
    lorebookService.saveLorebookById(c.profileId, c.characterId, lb)
    return true
  })

  // --- ST chat array (SillyTavern.chat) — for the home's "start game" (greeting-swipe select + reload) ---
  // SYNC: the shim builds SillyTavern.chat from this at load. Each floor → its (optional) user message +
  // the assistant message, carrying its swipes; floor 0's swipes default to the card's greetings
  // (first_mes + alternate_greetings) so a swipe pick has something to select.
  ipcMain.on('wcv-host-get-chat-sync', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) {
      e.returnValue = []
      return
    }
    const characterId =
      ctx.characterId || chatService.getChat(ctx.profileId, ctx.chatId)?.character_id || ''
    const card = characterId ? characterService.getCharacter(ctx.profileId, characterId) : null
    const name = (card?.data as { name?: string })?.name || 'Character'
    const greetings = card
      ? [
          (card.data as { first_mes?: string }).first_mes,
          ...((card.data as { alternate_greetings?: string[] }).alternate_greetings || [])
        ].filter((g): g is string => !!g)
      : []
    const floors = floorService.getAllFloors(ctx.profileId, ctx.chatId)
    const chat: Array<Record<string, unknown>> = []
    floors.forEach((f, i) => {
      if (f.user_message?.content)
        chat.push({
          is_user: true,
          name: 'You',
          mes: f.user_message.content,
          send_date: f.timestamp,
          swipes: [f.user_message.content],
          swipe_id: 0,
          extra: {}
        })
      // The greeting floor's swipes are the card's greetings (first_mes + alternate_greetings) — the
      // home's "start game" picks a scenario by index here. Prefer them over any short stored floor
      // swipes; later floors use their own response swipes.
      const swipes =
        i === 0 && greetings.length
          ? greetings
          : f.swipes && f.swipes.length
            ? f.swipes
            : [f.response?.content ?? '']
      chat.push({
        is_user: false,
        name,
        mes: f.response?.content ?? '',
        send_date: f.timestamp,
        swipes,
        swipe_id: f.swipe_id ?? 0,
        extra: {}
      })
    })
    log(
      'info',
      'wcv getChat',
      `${chat.length} msg(s), greeting swipes=${(chat[0]?.swipes as string[] | undefined)?.length ?? 0}`
    )
    e.returnValue = chat
  })

  // Persist a chat the card mutated (e.g. a greeting-swipe selection): map assistant messages back to
  // floors in order, updating content + swipes/swipe_id; user messages are read-only here.
  ipcMain.handle('wcv-host-save-chat', (e, chat) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx || !Array.isArray(chat)) return false
    const floors = floorService.getAllFloors(ctx.profileId, ctx.chatId)
    const assistant = chat.filter((m) => m && !m.is_user)
    assistant.forEach((m, i) => {
      const f = floors[i]
      if (!f) return
      if (typeof m.mes === 'string') f.response.content = m.mes
      if (Array.isArray(m.swipes)) f.swipes = m.swipes
      if (typeof m.swipe_id === 'number') f.swipe_id = m.swipe_id
      floorService.saveFloor(ctx.profileId, ctx.chatId, f)
    })
    log('info', 'wcv saveChat', `${assistant.length} assistant msg(s) → floors`)
    return true
  })

  // Ask the host renderer to reload the active chat's floors (after saveChat changed message content).
  ipcMain.handle('wcv-host-reload-chat', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (ctx) wcvManager.pushHostReload(ctx.chatId)
    return true
  })

  // Map the chat's floors → TavernHelper-style message objects (sync; getChatMessages from the card).
  ipcMain.on('wcv-host-get-messages-sync', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) {
      e.returnValue = []
      return
    }
    const floors = floorService.getAllFloors(ctx.profileId, ctx.chatId)
    const msgs: Array<{ role: string; message: string }> = []
    for (const f of floors) {
      if (f.user_message?.content) msgs.push({ role: 'user', message: f.user_message.content })
      msgs.push({ role: 'assistant', message: f.response?.content ?? '' })
    }
    e.returnValue = msgs
  })
}
