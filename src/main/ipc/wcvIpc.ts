import { IpcMain } from 'electron'
import * as wcvManager from '../services/wcvManager'
import { computeDuelPreview } from '../services/duelPreviewService'
import { getChatCardVars, setChatCardVars } from '../services/chatCardVarsService'
import * as floorService from '../services/floorService'
import * as generationService from '../services/generationService'
import * as lorebookService from '../services/lorebookService'
import * as chatService from '../services/chatService'
import * as chatWriteService from '../services/chatWriteService'
import * as scriptApiService from '../services/scriptApiService'
import * as regexService from '../services/regexService'
import * as pluginStorageService from '../services/pluginStorageService'
import * as pluginService from '../services/pluginService'
import * as settingsService from '../services/settingsService'
import * as worldAssetService from '../services/worldAssetService'
import { getActivePresetId } from '../services/presetService'
import { log } from '../services/logService'
import { ArtifactScope } from '../../shared/artifactScope'
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

// TH regex `{type}` option → store scope: character ⇒ this card's world bucket (owner = cardId), global ⇒
// global, preset ⇒ the active preset's. (`getTavernRegexes`/`replaceTavernRegexes`.)
const regexScopeFor = (
  profileId: string,
  characterId: string,
  option: any
): { scope: ArtifactScope; owner?: string } => {
  const t = option && option.type
  if (t === 'global') return { scope: 'global' }
  if (t === 'preset') return { scope: 'preset', owner: getActivePresetId(profileId) || undefined }
  return { scope: 'world', owner: characterId }
}

// A card regex write re-renders the chat (regexes affect display); debounce so a card can't thrash it.
const regexReloadTimers = new Map<string, ReturnType<typeof setTimeout>>()
const debouncedRegexReload = (chatId: string): void => {
  const prev = regexReloadTimers.get(chatId)
  if (prev) clearTimeout(prev)
  regexReloadTimers.set(
    chatId,
    setTimeout(() => {
      regexReloadTimers.delete(chatId)
      wcvManager.pushHostReload(chatId)
    }, 300)
  )
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
  // Duck/restore ALL card views at once — a full-screen DOM overlay (workflow editor) can't
  // cover native views, so the renderer hides them for the overlay's lifetime.
  ipcMain.on('wcv-set-all-visible', (_e, visible) => wcvManager.setAllVisible(!!visible))
  ipcMain.on('wcv-destroy', (_e, id) => wcvManager.destroy(id))
  // A card script in a WCV threw / rejected — surface it to the main log (it'd otherwise only show in the
  // WCV devtools). Includes the calling slot for context.
  ipcMain.on('wcv-card-error', (e, msg) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    log('error', `wcv card-script${ctx ? ` [${ctx.slotId}]` : ''}`, String(msg))
  })
  // A card script (replaceScriptButtons) declared its action buttons → push them to the renderer toolbar.
  ipcMain.on('wcv-register-button', (e, buttons) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (ctx) {
      const list = Array.isArray(buttons) ? buttons : []
      wcvManager.pushCardButtons(ctx.slotId, ctx.chatId, ctx.characterId, list)
      log(
        'info',
        'wcv card buttons',
        list
          .map((b: any) => b && b.name)
          .filter(Boolean)
          .join(', ') || '(none)'
      )
    }
  })
  // The user clicked a card-script button in the toolbar → deliver it as the button-named event to the
  // chat's card WCVs (the script's eventOn(getButtonEvent(name)) fires).
  ipcMain.on('wcv-button-click', (_e, chatId, name) => {
    wcvManager.notifyEvent(String(chatId), String(name), undefined)
  })
  // A card script's overlay opened/closed (a full-screen inset:0 element appeared/left) → expand the
  // card-script WCV to a full-window modal, or restore it to its panel rect.
  ipcMain.on('wcv-overlay', (e, has) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (ctx) wcvManager.setModal(ctx.slotId, !!has)
  })
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
    // null = the write changed nothing (no-op). Don't push/broadcast — that re-fires the card's own MVU
    // events and loops. Just hand back the current stat_data.
    if (!floor) return latest.variables?.stat_data ?? {}
    const statData = floor.variables?.stat_data ?? {}
    wcvManager.pushHostVars(ctx.chatId, floor.variables)
    // Don't echo the write back to the card that made it — that would re-fire its own MVU events and
    // loop if it writes on them. Siblings + the host (native panels) still refresh.
    wcvManager.notifyVarsChanged(ctx.chatId, statData, e.sender.id)
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
    // Don't echo back to the writer (see wcv-host-apply-vars) — avoids a self-triggered MVU event loop.
    wcvManager.notifyVarsChanged(ctx.chatId, statData, e.sender.id)
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
    wcvManager.pushLorebookChanged(c.characterId) // refresh the lorebook editor if it's open
    log('info', 'wcv replaceWorldbook', `${lb.entries.length} entries → card book`)
    return true
  })

  // --- Worldbook CRUD/bind over the full library (trusted cards). list/chat-ids are SYNC. ---
  ipcMain.on('wcv-host-list-worldbooks-sync', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    e.returnValue = ctx ? lorebookService.listLorebooks(ctx.profileId) : []
  })
  ipcMain.on('wcv-host-chat-worldbook-ids-sync', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    const ids = ctx ? chatService.getChatLorebookIds(ctx.profileId, ctx.chatId) : null
    e.returnValue = ids ?? (ctx?.characterId ? [ctx.characterId] : [])
  })
  ipcMain.handle('wcv-host-create-worldbook', (e, name) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return ''
    const id = lorebookService.createLorebook(ctx.profileId, String(name ?? 'New Worldbook')).id
    wcvManager.pushLorebookChanged(id)
    return id
  })
  ipcMain.handle('wcv-host-delete-worldbook', (e, id) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return false
    lorebookService.deleteLorebookById(ctx.profileId, String(id))
    wcvManager.pushLorebookChanged(String(id))
    return true
  })
  ipcMain.handle('wcv-host-get-worldbook-by-id', (e, id) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return { entries: [] }
    const lb = lorebookService.getLorebookById(ctx.profileId, String(id))
    return lb ? { name: lb.name, entries: lb.entries } : { entries: [] }
  })
  ipcMain.handle('wcv-host-save-worldbook-by-id', (e, id, entries) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return
    const lb = lorebookService.getLorebookById(ctx.profileId, String(id)) || {
      name: '',
      entries: []
    }
    lb.entries = (Array.isArray(entries) ? entries : []).map(toLoreEntry)
    lorebookService.saveLorebookById(ctx.profileId, String(id), lb)
    wcvManager.pushLorebookChanged(String(id)) // refresh the lorebook editor if it's open
  })
  ipcMain.handle('wcv-host-bind-worldbook', (e, id, on) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return
    const cur =
      chatService.getChatLorebookIds(ctx.profileId, ctx.chatId) ??
      (ctx.characterId ? [ctx.characterId] : [])
    const next = on ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter((x) => x !== id)
    chatService.setChatLorebookIds(ctx.profileId, ctx.chatId, next)
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
      ? scriptApiService.listRegexes(ctx.profileId, {
          cardId: ctx.characterId,
          chatId: ctx.chatId,
          presetId: getActivePresetId(ctx.profileId)
        })
      : []
  })
  ipcMain.on('wcv-host-format-regex', (e, text) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    e.returnValue = ctx
      ? scriptApiService.formatWithRegex(
          ctx.profileId,
          {
            cardId: ctx.characterId,
            chatId: ctx.chatId,
            presetId: getActivePresetId(ctx.profileId)
          },
          text
        )
      : String(text ?? '')
  })

  // Full TavernHelper-shaped regexes for a scope (getTavernRegexes({type})). SYNC (cards call w/o await).
  ipcMain.on('wcv-host-get-regexes-full', (e, option) => {
    const c = cardLoreCtx(e.sender.id)
    if (!c) {
      e.returnValue = []
      return
    }
    const { scope, owner } = regexScopeFor(c.profileId, c.characterId, option)
    e.returnValue = regexService.getTavernRegexesByScope(c.profileId, scope, owner)
  })
  // isCharacterTavernRegexesEnabled — RPT keeps the card's world-scoped regexes active while the card is
  // open; there's no per-card disable toggle, so report enabled.
  ipcMain.on('wcv-host-is-char-regex-enabled', (e) => {
    e.returnValue = true
  })
  // Replace a scope's regexes (replaceTavernRegexes / updateTavernRegexesWith) → store, then reload chat.
  ipcMain.handle('wcv-host-replace-regexes', (e, regexes, option) => {
    const c = cardLoreCtx(e.sender.id)
    if (!c) return false
    const { scope, owner } = regexScopeFor(c.profileId, c.characterId, option)
    regexService.replaceTavernRegexes(
      c.profileId,
      scope,
      owner,
      Array.isArray(regexes) ? regexes : []
    )
    const ctx = wcvManager.contextFor(e.sender.id)
    if (ctx) debouncedRegexReload(ctx.chatId)
    log('info', 'wcv replaceTavernRegexes', `${(regexes || []).length} regex(es) → ${scope}`)
    return true
  })

  // Active chat id for SillyTavern.getCurrentChatId() (the WCV ctx is empty; resolve from e.sender). SYNC.
  ipcMain.on('wcv-host-get-chat-id-sync', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    e.returnValue = ctx?.chatId ?? ''
  })
  // Script-scope vars (getVariables({type:'script'})) — the card's own KV (owner card:<id>), NOT stat_data.
  ipcMain.on('wcv-host-script-vars-get-sync', (e) => {
    const c = cardLoreCtx(e.sender.id)
    e.returnValue = c
      ? pluginStorageService.storageOp(c.profileId, 'card:' + c.characterId, { op: 'all' }) || {}
      : {}
  })
  // Persist the whole script-var object (updateVariablesWith({type:'script'}) returns all): set new keys,
  // drop removed ones.
  ipcMain.handle('wcv-host-script-vars-set', (e, vars) => {
    const c = cardLoreCtx(e.sender.id)
    if (!c) return false
    const owner = 'card:' + c.characterId
    const next = vars && typeof vars === 'object' ? vars : {}
    const cur = pluginStorageService.storageOp(c.profileId, owner, { op: 'all' }) || {}
    for (const k of Object.keys(next)) {
      pluginStorageService.storageOp(c.profileId, owner, { op: 'set', key: k, value: next[k] })
    }
    for (const k of Object.keys(cur)) {
      if (!(k in next)) pluginStorageService.storageOp(c.profileId, owner, { op: 'remove', key: k })
    }
    return true
  })

  // Chat-scope vars (getVariables({type:'chat'})) — a per-chat card-owned KV, NOT stat_data. SYNC read.
  ipcMain.on('wcv-host-chat-vars-get-sync', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    e.returnValue = ctx ? getChatCardVars(ctx.profileId, ctx.chatId) : {}
  })
  // Persist the whole per-chat KV object (replaceVariables / updateVariablesWith with type:'chat').
  ipcMain.handle('wcv-host-chat-vars-set', (e, vars) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return false
    setChatCardVars(ctx.profileId, ctx.chatId, vars && typeof vars === 'object' ? vars : {})
    return true
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

  // Global (per-profile) variables for a card's triggerSlash /setglobalvar / /getglobalvar — the same
  // template-globals store pluginService exposes to the renderer slash path.
  ipcMain.handle('wcv-host-get-global-vars', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    return ctx ? pluginService.getVars(ctx.profileId, ctx.chatId).global : {}
  })
  ipcMain.handle('wcv-host-set-global-var', (e, key, value) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (ctx)
      pluginService.pluginVars(ctx.profileId, ctx.chatId, {
        op: 'set',
        scope: 'global',
        key,
        value
      })
  })

  // Ask the host renderer to reload the active chat's floors (after saveChat changed message content).
  ipcMain.handle('wcv-host-reload-chat', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (ctx) wcvManager.pushHostReload(ctx.chatId)
    return true
  })

  // Resolve a World Assets portrait URL for the calling card's world (rptasset://… or null). Mood-aware.
  ipcMain.handle('wcv-host-asset-url', (e, name, type, mood) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return null
    const ids =
      chatService.getChatLorebookIds(ctx.profileId, ctx.chatId) ??
      (ctx.characterId ? [ctx.characterId] : [])
    return worldAssetService.assetUrlForWorld(ctx.profileId, ids, String(name ?? ''), type, mood)
  })

  // Engine-computed duel build preview for the calling panel's active chat (read-only).
  ipcMain.handle('wcv-host-duel-preview', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return null
    return computeDuelPreview(ctx.profileId, ctx.chatId, ctx.characterId)
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
