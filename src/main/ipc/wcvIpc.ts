import { IpcMain } from 'electron'
import * as wcvManager from '../services/wcvManager'
import * as floorService from '../services/floorService'
import * as generationService from '../services/generationService'
import * as lorebookService from '../services/lorebookService'
import * as chatService from '../services/chatService'
import * as chatWriteService from '../services/chatWriteService'
import * as scriptApiService from '../services/scriptApiService'
import * as settingsService from '../services/settingsService'
import { log } from '../services/logService'
import { LorebookEntry, LorebookEntrySchema } from '../types/character'

// Coerce a TavernHelper-shaped worldbook entry (from getWorldbook, possibly edited or freshly built by a
// card) back into a valid LorebookEntry. `name` → comment; unknown fields (uid) are dropped by the schema;
// our other fields round-trip because getWorldbook returns them, so a full replace is lossless.
const toLoreEntry = (te: unknown): LorebookEntry => {
  const src = (te && typeof te === 'object' ? te : {}) as Record<string, unknown>
  const { uid: _uid, name, ...rest } = src
  void _uid
  return LorebookEntrySchema.parse({
    ...rest,
    comment: String(name ?? rest.comment ?? ''),
    enabled: rest.enabled !== false
  })
}

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

// Push the re-folded latest-floor vars to the host native panels + sibling WCVs (after a card mutation).
const pushVars = (chatId: string, latest: { variables: any } | null): void => {
  if (latest) {
    wcvManager.pushHostVars(chatId, latest.variables)
    wcvManager.notifyVarsChanged(chatId, latest.variables.stat_data ?? {})
  }
}
// After an edit / delete: re-fold <UpdateVariable> into stat_data (via chatWriteService), push it, and
// reload the host chat UI.
const afterChatMutation = (profileId: string, chatId: string): void => {
  pushVars(chatId, chatWriteService.afterChatMutation(profileId, chatId))
  wcvManager.pushHostReload(chatId)
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
  // Inline card → host: content height (auto-size the message slot) and wheel deltas (scroll the
  // message list past the overlay). Resolve the slot from the sender so only that frame reacts.
  ipcMain.on('wcv-content-size', (e, size) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (ctx) wcvManager.pushSlotSize(ctx.slotId, Math.round(Number(size?.height)) || 0)
  })
  ipcMain.on('wcv-wheel', (e, d) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (ctx) wcvManager.pushWheel(ctx.slotId, Number(d?.dy) || 0)
  })
  // Host → card panels: the latest stat_data changed (model turn / edit) — refresh their mirrors.
  ipcMain.on('wcv-broadcast-vars', (_e, chatId, statData) =>
    wcvManager.notifyVarsChanged(chatId, statData)
  )
  // Host → card panels: a TavernHelper lifecycle/mutation event (computed from the chat-store transition).
  ipcMain.on('wcv-broadcast-event', (_e, chatId, name, payload) =>
    wcvManager.notifyEvent(chatId, name, payload)
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
    // Return the FULL entry fields (+ TH aliases uid/name) so a card's write round-trips losslessly.
    const out = lb.entries.map((en, i) => ({ ...en, uid: i, name: en.comment || `Entry ${i + 1}` }))
    log(
      'info',
      'wcv getWorldbook',
      `${out.length} entries (${out.filter((o) => /^\[DLC\]/.test(o.name)).length} DLC) → card`
    )
    return out
  })

  // Persist a worldbook the card modified — a FULL replace (TavernHelper replaceWorldbookEntries):
  // add / remove / edit / toggle. Lossless because getWorldbook returns the full fields; new entries
  // (built by the card) get schema defaults.
  ipcMain.handle('wcv-host-replace-worldbook', (e, _name, entries) => {
    const c = cardLoreCtx(e.sender.id)
    if (!c) return false
    const lb = lorebookService.getLorebookById(c.profileId, c.characterId)
    if (!lb) return false
    lb.entries = (Array.isArray(entries) ? entries : []).map(toLoreEntry)
    lorebookService.saveLorebookById(c.profileId, c.characterId, lb)
    log('info', 'wcv replaceWorldbook', `${lb.entries.length} entries → card book`)
    return true
  })

  // --- Character / preset / regex reads (Track C0) — sync, ctx-scoped via scriptApiService ---
  ipcMain.on('wcv-host-get-char-data', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    e.returnValue = ctx
      ? scriptApiService.getCharData(ctx.profileId, ctx.chatId, ctx.characterId)
      : null
  })
  ipcMain.on('wcv-host-get-char-avatar', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    e.returnValue = ctx
      ? scriptApiService.getCharAvatarPath(ctx.profileId, ctx.chatId, ctx.characterId)
      : null
  })
  ipcMain.on('wcv-host-get-preset', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    e.returnValue = ctx ? scriptApiService.getPresetInfo(ctx.profileId) : null
  })
  ipcMain.on('wcv-host-get-preset-names', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    e.returnValue = ctx ? scriptApiService.listPresetNames(ctx.profileId) : []
  })
  // Persona display name (ctx-scoped settings) — so WCV chat shows the real user name, not "User".
  ipcMain.on('wcv-host-get-persona-name', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    try {
      e.returnValue = ctx
        ? settingsService.getSettings(ctx.profileId).persona?.name || 'User'
        : 'User'
    } catch {
      e.returnValue = 'User'
    }
  })
  ipcMain.on('wcv-host-get-regexes', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    e.returnValue = ctx
      ? scriptApiService.listRegexes(ctx.profileId, { cardId: ctx.characterId, chatId: ctx.chatId })
      : []
  })
  ipcMain.on('wcv-host-format-regex', (e, text) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    e.returnValue = ctx
      ? scriptApiService.formatWithRegex(
          ctx.profileId,
          { cardId: ctx.characterId, chatId: ctx.chatId },
          text
        )
      : String(text ?? '')
  })

  // --- Generation requests (Track C0) — the card REQUESTS; the host runs it (AI key stays in main). ---
  // generate(text) = a normal visible turn (new floor); generateRaw(config) = a one-off completion → text.
  ipcMain.handle('wcv-host-generate', async (e, text) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return ''
    const floor = await generationService.generate(ctx.profileId, ctx.chatId, String(text ?? ''))
    wcvManager.pushHostReload(ctx.chatId) // a new floor → refresh the host chat UI + sibling WCVs
    return floor?.response?.content ?? ''
  })
  ipcMain.handle('wcv-host-generate-raw', async (e, config) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return ''
    return generationService.generateRaw(ctx.profileId, ctx.chatId, config || {})
  })

  // Persist a chat the card mutated (e.g. a greeting-swipe selection): assistant messages → floors in
  // order (content + swipes/swipe_id). Re-fold + push vars, but NO host reload — the card calls
  // reloadCurrentChat itself after saveChat.
  ipcMain.handle('wcv-host-save-chat', (e, chat) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return false
    if (!chatWriteService.saveChat(ctx.profileId, ctx.chatId, chat)) return false
    pushVars(ctx.chatId, chatWriteService.afterChatMutation(ctx.profileId, ctx.chatId))
    log('info', 'wcv saveChat', 'assistant msgs → floors + reevaluated')
    return true
  })

  // Ask the host renderer to reload the active chat's floors (after saveChat changed message content).
  ipcMain.handle('wcv-host-reload-chat', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (ctx) wcvManager.pushHostReload(ctx.chatId)
    return true
  })

  // Raw floor rows for the calling panel's session (the unified TH runtime maps these to TH/ST message
  // shapes itself — same source the renderer uses). SYNC so the runtime's sync getters can read floors.
  ipcMain.on('wcv-host-get-floors-sync', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) {
      e.returnValue = []
      return
    }
    try {
      e.returnValue = floorService.getAllFloors(ctx.profileId, ctx.chatId)
    } catch {
      e.returnValue = []
    }
  })

  // Edit message content by chat-array index (TH setChatMessages); then re-fold + reload.
  ipcMain.handle('wcv-host-set-chat-messages', (e, messages) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return false
    const n = chatWriteService.setChatMessages(ctx.profileId, ctx.chatId, messages)
    if (n) afterChatMutation(ctx.profileId, ctx.chatId)
    log('info', 'wcv setChatMessages', `${n} floor(s) edited`)
    return n > 0
  })

  // Delete messages (TH deleteChatMessages) — truncates from the earliest targeted message's floor.
  ipcMain.handle('wcv-host-delete-chat-messages', (e, messageIds) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return false
    if (!chatWriteService.deleteChatMessages(ctx.profileId, ctx.chatId, messageIds)) return false
    afterChatMutation(ctx.profileId, ctx.chatId)
    log('info', 'wcv deleteChatMessages', 'truncated')
    return true
  })
}
