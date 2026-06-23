import { IpcMain } from 'electron'
import * as wcvManager from '../services/wcvManager'
import * as floorService from '../services/floorService'
import * as generationService from '../services/generationService'
import * as lorebookService from '../services/lorebookService'
import * as chatService from '../services/chatService'
import * as scriptApiService from '../services/scriptApiService'
import * as settingsService from '../services/settingsService'
import { log } from '../services/logService'
import { LorebookEntry, LorebookEntrySchema } from '../types/character'
import { FloorFile } from '../types/chat'

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

// The chat-array index space SillyTavern.chat / getChatMessages / setChatMessages share: per floor, the
// (optional) user message then the assistant message. Maps an index → its source floor + role so a card's
// write can be applied back to the right floor.
const chatIndexMap = (floors: FloorFile[]): Array<{ floorIdx: number; isUser: boolean }> => {
  const map: Array<{ floorIdx: number; isUser: boolean }> = []
  floors.forEach((f, i) => {
    if (f.user_message?.content) map.push({ floorIdx: i, isUser: true })
    map.push({ floorIdx: i, isUser: false })
  })
  return map
}

// After a card mutates the chat (edit / delete): re-fold <UpdateVariable> into stat_data, push it to the
// host native panels + sibling WCVs, and reload the host chat UI.
const afterChatMutation = (profileId: string, chatId: string): void => {
  const rebuilt = generationService.reevaluateVariables(profileId, chatId)
  const latest = rebuilt[rebuilt.length - 1]
  if (latest) {
    wcvManager.pushHostVars(chatId, latest.variables)
    wcvManager.notifyVarsChanged(chatId, latest.variables.stat_data ?? {})
  }
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
    // The greeting/scenario content changed → re-fold its <UpdateVariable> into stat_data (same as the
    // Re-evaluate button) so the MVU UIs get the opening state, then push it to the host + sibling WCVs.
    const rebuilt = generationService.reevaluateVariables(ctx.profileId, ctx.chatId)
    const latest = rebuilt[rebuilt.length - 1]
    if (latest) {
      wcvManager.pushHostVars(ctx.chatId, latest.variables)
      wcvManager.notifyVarsChanged(ctx.chatId, latest.variables.stat_data ?? {})
    }
    log('info', 'wcv saveChat', `${assistant.length} assistant msg(s) → floors + reevaluated`)
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

  // Edit message content by chat-array index (TH setChatMessages). Each index maps back to its floor +
  // role; then re-fold + reload. (Content only for now — swipes/role edits are a follow-up.)
  ipcMain.handle('wcv-host-set-chat-messages', (e, messages) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return false
    const floors = floorService.getAllFloors(ctx.profileId, ctx.chatId)
    const map = chatIndexMap(floors)
    const touched = new Set<number>()
    for (const m of Array.isArray(messages) ? messages : []) {
      const id = typeof m?.message_id === 'number' ? m.message_id : -1
      const slot = id >= 0 ? map[id] : undefined
      if (!slot || typeof m?.message !== 'string') continue
      if (slot.isUser) floors[slot.floorIdx].user_message.content = m.message
      else floors[slot.floorIdx].response.content = m.message
      touched.add(slot.floorIdx)
    }
    for (const fi of touched) floorService.saveFloor(ctx.profileId, ctx.chatId, floors[fi])
    if (touched.size) afterChatMutation(ctx.profileId, ctx.chatId)
    log('info', 'wcv setChatMessages', `${touched.size} floor(s) edited`)
    return touched.size > 0
  })

  // Delete messages (TH deleteChatMessages). Our model couples user+assistant per floor, so this
  // TRUNCATES from the earliest targeted message's floor onward (the common "delete from here / undo").
  ipcMain.handle('wcv-host-delete-chat-messages', (e, messageIds) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return false
    const floors = floorService.getAllFloors(ctx.profileId, ctx.chatId)
    const map = chatIndexMap(floors)
    const ids = (Array.isArray(messageIds) ? messageIds : [messageIds]).filter(
      (n): n is number => typeof n === 'number'
    )
    const floorIdxs = ids
      .map((id) => map[id]?.floorIdx)
      .filter((n): n is number => typeof n === 'number')
    if (!floorIdxs.length) return false
    const fromFloor = floors[Math.min(...floorIdxs)]?.floor
    if (typeof fromFloor !== 'number') return false
    chatService.truncateFloors(ctx.profileId, ctx.chatId, fromFloor)
    afterChatMutation(ctx.profileId, ctx.chatId)
    log('info', 'wcv deleteChatMessages', `truncated from floor ${fromFloor}`)
    return true
  })
}
