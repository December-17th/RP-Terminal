import { IpcMain, IpcMainEvent, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import * as wcvManager from '../services/wcvManager'
import { pickAndImportAssetForCard } from './worldAssetIpc'
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
import * as extensionSettingsService from '../services/extensionSettingsService'
import * as worldAssetService from '../services/worldAssetService'
import * as characterService from '../services/characterService'
import * as presetService from '../services/presetService'
import { getActivePresetId } from '../services/presetService'
import { log } from '../services/logService'
import { ArtifactScope } from '../../shared/artifactScope'
import { LorebookEntry, LorebookEntrySchema, getRpExt } from '../types/character'
import type { OverlayDecl } from '../services/wcvOverlay'
// The Host-member channels are registered THROUGH the shared Channel Spec (ADR 0013): a member-keyed
// `WcvHostImpls` map, typed against `WcvSpecMember`, drives `registerHostChannels` — so a spec member with
// no main-side implementation is a COMPILE error, not a runtime gap. The channel strings + call kinds come
// from `WCV_CHANNEL_SPEC`; the four residue channels that still cross IPC read their names from
// `WCV_RESIDUE_CHANNELS`. Non-Host channels (slot lifecycle, geometry, colorscheme, broadcast, async
// get-vars) stay hand-registered below — they have no spec row.
import { WCV_CHANNEL_SPEC, WCV_RESIDUE_CHANNELS } from '../../shared/thRuntime/wcvChannelSpec'
import type { WcvSpecMember } from '../../shared/thRuntime/wcvChannelSpec'

// Resolve an overlay id against a card's declared `panel_ui.overlays` (PM-A7). Returns the surface to
// mount, or null when the id isn't declared by that card (⇒ the request is rejected + warned, main-side).
const resolveOverlayDecl = (
  profileId: string,
  characterId: string,
  overlayId: string
): OverlayDecl | null => {
  if (!characterId) return null
  const card = characterService.getCharacter(profileId, characterId)
  if (!card) return null
  const ov = getRpExt(card)?.panel_ui?.overlays?.find((o) => o?.id === overlayId)
  return ov?.entry ? { entry: ov.entry, title: ov.title } : null
}

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
const pushVars = (
  chatId: string,
  latest: { variables: any } | null,
  exceptWebContentsId: number
): void => {
  if (latest) {
    wcvManager.pushHostVars(chatId, latest.variables)
    // card-initiated ⇒ card-write: every caller here is a CARD mutation, so exclude the writer and tag the
    // sibling/host echo card-write. Siblings refresh caches but do NOT re-fire MVU variable events (those
    // fire only on the model fold — the WS-3 stance; mirrors wcv-host-apply-vars).
    wcvManager.notifyVarsChanged(
      chatId,
      latest.variables.stat_data ?? {},
      exceptWebContentsId,
      'card-write'
    )
  }
}
// After an edit / delete: re-fold <UpdateVariable> into stat_data (via chatWriteService), push it, and
// reload the host chat UI.
const afterChatMutation = (
  profileId: string,
  chatId: string,
  exceptWebContentsId: number
): void => {
  pushVars(chatId, chatWriteService.afterChatMutation(profileId, chatId), exceptWebContentsId)
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

// The electron event a Host-channel impl receives first. Sync/send arrive as IpcMainEvent, invoke as
// IpcMainInvokeEvent; both carry `.sender.id`, which every impl uses to resolve its slot ctx.
type WcvEvt = IpcMainEvent | IpcMainInvokeEvent

/**
 * Member-keyed implementation map for the Host channels. Typed `Record<WcvSpecMember, …>`, so a spec member
 * without an entry here is a COMPILE error — main-side completeness is checked, not hoped for (ADR 0013).
 * Each impl keeps its own ctx resolution (`wcvManager.contextFor(e.sender.id)` / `cardLoreCtx`) and its
 * distinct null-ctx behavior — ctx resolution is deliberately NOT centralized. Sync impls just RETURN their
 * value; `registerHostChannels` handles the `e.returnValue` plumbing.
 */
type WcvHostImpls = { [K in WcvSpecMember]: (e: WcvEvt, ...args: any[]) => any }

/**
 * Register every Host channel from the spec: `sync` → `ipcMain.on` writing `e.returnValue`; `invoke` →
 * `ipcMain.handle`; `send` → `ipcMain.on` (fire-and-forget). Registration becomes mechanical; the impls
 * hold the real logic.
 */
const registerHostChannels = (ipcMain: IpcMain, impls: WcvHostImpls): void => {
  for (const member of Object.keys(WCV_CHANNEL_SPEC) as WcvSpecMember[]) {
    const { channel, kind } = WCV_CHANNEL_SPEC[member]
    const impl = impls[member]
    if (kind === 'sync') {
      ipcMain.on(channel, (e, ...a) => {
        e.returnValue = impl(e, ...a)
      })
    } else if (kind === 'invoke') {
      ipcMain.handle(channel, (e, ...a) => impl(e, ...a))
    } else {
      ipcMain.on(channel, (e, ...a) => {
        impl(e, ...a)
      })
    }
  }
}

/**
 * WebContentsView card-UI panel IPC (spike). Position commands are fire-and-forget (`on`);
 * the host-bridge reads/writes are request/response (`handle`). The bridge resolves the
 * calling panel's session from its webContents id (set when the view was created), so a card
 * page can only touch its own session's message variables.
 */
export const registerWcvIpc = (ipcMain: IpcMain): void => {
  // Ctx-binding wall (card-trust-boundary issue 03). A WCV card page runs with contextIsolation off, so
  // page code can capture the preload's `ipcRenderer` and reach ANY channel — main-side ctx binding is the
  // real boundary, not the preload. Most WCV handlers already resolve the session from `e.sender.id`
  // (wcvManager.contextFor) and take no caller-supplied ids, so they're inherently bound. The few channels
  // below are the host RENDERER's (they legitimately target an arbitrary chat and pass ctx explicitly); a
  // WCV card reaching them via a captured ipcRenderer must NOT act outside its own slot. `slotCtxIf` returns
  // the sender's bound slot when it IS a WCV page (⇒ override its args), or null when it's the host renderer
  // (⇒ trust its args). The one real in-app harm the PRD names is CROSS-PROFILE reach; deletes/writes within
  // the bound profile stay allowed (no capability gating here).
  const slotCtxIf = (senderId: number): ReturnType<typeof wcvManager.contextFor> =>
    wcvManager.contextFor(senderId)

  // Slots whose teardown is deferred but not yet run (see `wcv-destroy`). A re-`ensure` for the same id
  // (React runs a cleanup→body pair on every dep change: dataUrl settling after mount, session switch,
  // StrictMode double-mount) must CANCEL the pending destroy — otherwise the deferred close fires a turn
  // later and kills the freshly (re)bound view, blanking the card.
  const pendingDestroy = new Set<string>()

  ipcMain.on('wcv-ensure', (e, id, bounds, url, ctx) => {
    // Creating/(re)binding a slot's (profileId, chatId) is a host-renderer privilege — it's how the bound
    // identity is SET. A WCV card page must never call it (it would rebind an existing slot to another
    // profile: the cross-profile hole). The host renderer's webContents is not itself a slot ⇒ allowed.
    if (slotCtxIf(e.sender.id)) return
    pendingDestroy.delete(id) // this slot is being reused — abort any queued teardown
    wcvManager.ensure(id, bounds, url, ctx)
  })
  ipcMain.on('wcv-set-bounds', (_e, id, bounds) => wcvManager.setBounds(id, bounds))
  ipcMain.on('wcv-set-visible', (_e, id, visible) => wcvManager.setVisible(id, visible))
  // Duck/restore ALL card views at once — a full-screen DOM overlay (workflow editor) can't
  // cover native views, so the renderer hides them for the overlay's lifetime.
  ipcMain.on('wcv-set-all-visible', (_e, visible) => wcvManager.setAllVisible(!!visible))
  // React unmounts every card view synchronously when the user leaves a session. Do not close a
  // WebContentsView inside that renderer IPC callback: Chromium may still be in a
  // DisallowJavascriptExecutionScope, and webContents.close() can then fatally re-enter V8. Crossing
  // one main-loop boundary keeps the native teardown outside the guarded IPC dispatch. The pending-set
  // guard makes the deferral safe against a same-tick re-`ensure` (remount): if the slot was re-bound in
  // the meantime, `wcv-ensure` cleared the flag and we skip the stale close.
  ipcMain.on('wcv-destroy', (_e, id) => {
    pendingDestroy.add(id)
    setImmediate(() => {
      if (!pendingDestroy.delete(id)) return // re-ensured before this ran → keep the live view
      wcvManager.destroy(id)
    })
  })
  // Runtime authorization changes must stop the old document before resolving its replacement.
  // Keep the close outside the renderer IPC callback, but acknowledge only after that deferred
  // teardown has run. Host-renderer only: a card page cannot destroy arbitrary slots.
  ipcMain.handle('wcv-destroy-await', async (e, id) => {
    if (slotCtxIf(e.sender.id)) return false
    pendingDestroy.add(id)
    return new Promise<boolean>((resolve) => {
      setImmediate(() => {
        if (pendingDestroy.delete(id)) wcvManager.destroy(id)
        resolve(true)
      })
    })
  })
  // A card page's initial panel geometry (its window-x + viewport width, for seam-sliced backgrounds).
  // SYNC so the page has it BEFORE first paint; subsequent updates arrive via the `wcv-panel-geometry`
  // push on every bounds change (wcvManager.pushGeometry).
  ipcMain.on('wcv-get-panel-geometry-sync', (e) => {
    e.returnValue = wcvManager.geometryFor(e.sender.id)
  })
  // Panel chat scope (general): the preload reads this at load and hands it to createThRuntime so the
  // card's chat reads reflect the panel's own messages (chat-READ-only). null ⇒ unscoped (real chat).
  // Resolved from the sender's slot (like geometry), so a WCV can only read its OWN scope.
  ipcMain.on('wcv-get-chat-scope-sync', (e) => {
    e.returnValue = wcvManager.chatScopeFor(e.sender.id)
  })
  // A card script in a WCV threw / rejected — surface it to the main log (it'd otherwise only show in the
  // WCV devtools). Includes the calling slot for context.
  ipcMain.on('wcv-card-error', (e, msg) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    log('error', `wcv card-script${ctx ? ` [${ctx.slotId}]` : ''}`, String(msg))
  })
  // The user clicked a card-script button in the toolbar → deliver it as the button-named event to the
  // chat's card WCVs (the script's eventOn(getButtonEvent(name)) fires).
  ipcMain.on('wcv-button-click', (e, chatId, name) => {
    // Host renderer → card panels. A WCV card reaching this (captured ipcRenderer) may only fire button
    // events into its OWN chat's panels, so override the target with its bound chatId.
    const slot = slotCtxIf(e.sender.id)
    wcvManager.notifyEvent(String(slot ? slot.chatId : chatId), String(name), undefined)
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
  // Host → card panels: the latest stat_data changed (model turn / edit / card-write echo) — refresh their
  // mirrors. Forward the renderer-tagged origin so a card's own write echoed back here doesn't re-fire its
  // MVU events and loop (WS-3 fix). Undefined origin ⇒ notifyVarsChanged defaults to 'model-fold'.
  ipcMain.on('wcv-broadcast-vars', (e, chatId, statData, origin) => {
    // Host renderer → card panels. A WCV card reaching this may only push vars into its OWN chat's panels
    // (which it can already do via wcv-host-apply-vars) — override the target with its bound chatId.
    const slot = slotCtxIf(e.sender.id)
    wcvManager.notifyVarsChanged(String(slot ? slot.chatId : chatId), statData, undefined, origin)
  })
  // Host → card panels: a TavernHelper lifecycle/mutation event (computed from the chat-store transition).
  ipcMain.on('wcv-broadcast-event', (e, chatId, name, payload) => {
    // Host renderer → card panels; a WCV card may only broadcast into its own chat (bound chatId).
    const slot = slotCtxIf(e.sender.id)
    wcvManager.notifyEvent(String(slot ? slot.chatId : chatId), name, payload)
  })
  // Card → sibling card panels: a card-authored coordination event (e.g. the poem stage's
  // `self:fold` / `stage:cast-changed`). Chat resolved from the sender (a card can't target another
  // session); the sender is excluded so its own page doesn't receive the event it just broadcast. The
  // event name is opaque to RPT — cards pick their own, so this stays card-agnostic.
  ipcMain.on('wcv-host-broadcast-event', (e, name, payload) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (ctx) wcvManager.notifyEvent(ctx.chatId, String(name ?? ''), payload, e.sender.id)
  })

  ipcMain.on('wcv-host-set-play-theme-reply', (_e, id, ok) =>
    wcvManager.resolveSetPlayTheme(Number(id), !!ok)
  )
  // The host renderer pushes its current effective play theme so the WCV sync getter can read it.
  ipcMain.on('set-play-theme-cache', (_e, snap) => wcvManager.setPlayThemeSnapshot(snap))

  // --- App light/dark mode sync (WCV mode sync) ---
  // The renderer pushes RPT's IN-APP light/dark axis (set-colorscheme-cache) on every app-theme change;
  // a WCV card reads it synchronously at boot (wcv-get-colorscheme-sync) and gets pushed changes. Mirrors
  // the play-theme snapshot relay above, so WCV surfaces follow the app theme, not the OS scheme.
  ipcMain.on('set-colorscheme-cache', (_e, scheme) => wcvManager.setColorSchemeSnapshot(scheme))
  ipcMain.on('wcv-get-colorscheme-sync', (e) => {
    e.returnValue = wcvManager.colorSchemeSnapshotValue()
  })
  // Card→app direction: a WCV card called rptHost.setColorScheme. ctx resolves from e.sender so a card
  // sets the scheme only for ITS OWN play session; main relays it to the renderer (the effective-scheme
  // authority). Returns true when accepted (bound slot + a host window to receive the relay).
  ipcMain.handle('wcv-host-set-colorscheme', (e, scheme) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return false
    return wcvManager.requestSetColorScheme(ctx.chatId, scheme)
  })

  // Inline transport: an inline card (in the renderer, not a WCV) passes its ctx explicitly — main can't
  // resolve it from e.sender. Same overlay mechanism; the id is validated against the active card's
  // panel_ui.overlays. The characterId falls back to the chat row (parity with the WCV/inline hosts).
  ipcMain.handle('overlay-request', (e, profileId, chatId, characterId, overlayId) => {
    // Inline cards run in the host renderer and pass ctx explicitly (main can't resolve them from
    // e.sender). A WCV card page could reach this inline-transport channel via a captured ipcRenderer;
    // if the sender IS a bound WCV slot, ignore its supplied ids and use the slot's own ctx (so it can't
    // open an overlay resolved against another profile's card). Renderer senders keep the explicit ctx.
    const slot = slotCtxIf(e.sender.id)
    const pid = slot ? slot.profileId : String(profileId ?? '')
    const chid = slot ? slot.chatId : String(chatId ?? '')
    const cid = slot
      ? slot.characterId || chatService.getChat(pid, chid)?.character_id || ''
      : String(characterId ?? '') || chatService.getChat(pid, chid)?.character_id || ''
    const id = String(overlayId ?? '')
    return wcvManager.requestOverlay(id, resolveOverlayDecl(pid, cid, id))
  })
  ipcMain.handle('overlay-close', () => {
    wcvManager.closeOverlay()
    return true
  })

  // Read the latest floor's message variables (stat_data) for the calling panel's session.
  ipcMain.handle('wcv-host-get-vars', (e) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return {}
    const floors = floorService.getAllFloors(ctx.profileId, ctx.chatId)
    return floors[floors.length - 1]?.variables?.stat_data ?? {}
  })

  // --- Residue Host channels that still cross IPC (hand-written both sides; names from the spec's
  // WCV_RESIDUE_CHANNELS so they can't drift). Their bodies don't fit the generic loop: the worldbook
  // getters normalize main's response shape; format-regex's fallback is the input text. ---

  // A card's own lorebook is its character_book (stored under id == characterId). The card's home reads
  // its expansions/cores (getCharWorldbookNames → getWorldbook) and toggles them (updateWorldbookWith →
  // replace). The worldbook `name` arg is the card's own book, so we resolve to its character regardless.
  // SYNC: cards call getCharWorldbookNames WITHOUT await (it's synchronous in TavernHelper). An async
  // Promise return makes `.primary` read as undefined → the card bails before getWorldbook. Return inline.
  ipcMain.on(WCV_RESIDUE_CHANNELS.worldbookNames, (e) => {
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
  ipcMain.handle(WCV_RESIDUE_CHANNELS.getWorldbook, (e) => {
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

  ipcMain.handle(WCV_RESIDUE_CHANNELS.getWorldbookById, (e, id) => {
    const ctx = wcvManager.contextFor(e.sender.id)
    if (!ctx) return { entries: [] }
    const lb = lorebookService.getLorebookById(ctx.profileId, String(id))
    return lb ? { name: lb.name, entries: lb.entries } : { entries: [] }
  })

  // TH regex formatting for a bit of text (formatMessageWithRegex): apply the card's active display
  // regexes to `text`. SYNC (cards call without await); the fallback is the INPUT text (⇒ residue).
  ipcMain.on(WCV_RESIDUE_CHANNELS.formatRegex, (e, text) => {
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

  // --- Host channels: registered THROUGH the spec (member-keyed, compile-checked complete). ---
  const hostImpls: WcvHostImpls = {
    // --- VarsHost ---
    // Synchronous stat_data read: the shim hydrates its mirror with this at preload load, so stat_data is
    // present BEFORE the card's React app first renders (an async read would land after default render).
    statData: (e) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (!ctx) return {}
      const floors = floorService.getAllFloors(ctx.profileId, ctx.chatId)
      return floors[floors.length - 1]?.variables?.stat_data ?? {}
    },
    // Write JSONPatch ops to the latest floor's stat_data via the same bridge the model uses,
    // then push the result to the host renderer (native panels) and any sibling WCVs.
    applyVariableOps: (e, ops) => {
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
      // Don't echo the write back to the card that made it, AND tag the sibling echo card-write so no panel
      // re-fires MVU events for another panel's programmatic write (faithful MVU + closes the INDIRECT loop:
      // pushHostVars → host setLatestFloorVariables → wcv-broadcast-vars would otherwise re-fire events).
      wcvManager.notifyVarsChanged(ctx.chatId, statData, e.sender.id, 'card-write')
      return statData
    },
    // Replace the latest floor's stat_data wholesale (Mvu.replaceMvuData / replaceVariables from the card).
    setVariables: (e, statData) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (!ctx) return null
      const floors = floorService.getAllFloors(ctx.profileId, ctx.chatId)
      const latest = floors[floors.length - 1]
      if (!latest) return null
      const floor = generationService.replaceVariablesFromCard(
        ctx.profileId,
        ctx.chatId,
        latest.floor,
        statData
      )
      if (!floor) return null
      wcvManager.pushHostVars(ctx.chatId, floor.variables)
      // Don't echo back to the writer, and tag card-write so siblings/host don't re-fire MVU events for this
      // programmatic replace (see wcv-host-apply-vars) — avoids the self-triggered MVU event loop.
      wcvManager.notifyVarsChanged(ctx.chatId, statData, e.sender.id, 'card-write')
      return statData
    },
    // Script-scope vars (getVariables({type:'script'})) — the card's own KV (owner card:<id>), NOT stat_data.
    getScriptVars: (e) => {
      const c = cardLoreCtx(e.sender.id)
      return c
        ? pluginStorageService.storageOp(c.profileId, 'card:' + c.characterId, { op: 'all' }) || {}
        : {}
    },
    // Persist the whole script-var object (updateVariablesWith({type:'script'}) returns all): set new keys,
    // drop removed ones.
    setScriptVars: (e, vars) => {
      const c = cardLoreCtx(e.sender.id)
      if (!c) return false
      const owner = 'card:' + c.characterId
      const next = vars && typeof vars === 'object' ? vars : {}
      const cur = pluginStorageService.storageOp(c.profileId, owner, { op: 'all' }) || {}
      for (const k of Object.keys(next)) {
        pluginStorageService.storageOp(c.profileId, owner, { op: 'set', key: k, value: next[k] })
      }
      for (const k of Object.keys(cur)) {
        if (!(k in next))
          pluginStorageService.storageOp(c.profileId, owner, { op: 'remove', key: k })
      }
      return true
    },
    // Chat-scope vars (getVariables({type:'chat'})) — a per-chat card-owned KV, NOT stat_data. SYNC read.
    getChatVars: (e) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      return ctx ? getChatCardVars(ctx.profileId, ctx.chatId) : {}
    },
    // Persist the whole per-chat KV object (replaceVariables / updateVariablesWith with type:'chat').
    setChatVars: (e, vars) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (!ctx) return false
      setChatCardVars(ctx.profileId, ctx.chatId, vars && typeof vars === 'object' ? vars : {})
      return true
    },
    // Global (per-profile) variables for a card's triggerSlash /setglobalvar / /getglobalvar — the same
    // template-globals store pluginService exposes to the renderer slash path.
    getGlobalVars: (e) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      return ctx ? pluginService.getVars(ctx.profileId, ctx.chatId).global : {}
    },
    setGlobalVar: (e, key, value) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (ctx)
        pluginService.pluginVars(ctx.profileId, ctx.chatId, {
          op: 'set',
          scope: 'global',
          key,
          value
        })
    },
    // Whole-object global vars (getVariables/replaceVariables({type:'global'})) — SYNC read so a card
    // reads its saved settings before it first renders; parity with the inline transport.
    getGlobalVarsSync: (e) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      return ctx ? pluginService.getGlobalVars(ctx.profileId) : {}
    },
    setGlobalVars: (e, vars) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (ctx)
        pluginService.setGlobalVars(ctx.profileId, vars && typeof vars === 'object' ? vars : {})
    },
    // TavernHelper extensionSettings durable backing (issue 19). SYNC read (card reads its saved
    // settings at boot); whole-object write is what saveSettingsDebounced flushes. Per-profile store.
    getExtensionSettingsSync: (e) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      // Unresolved ctx = a FAILED read, not a genuinely-empty store: return `undefined` (NOT `{}`) so the
      // shared runtime's hydration gate (thRuntime/index.ts, B fix 62bc5b3) treats it as not-hydrated and
      // suppresses the settings flush, instead of clobbering valid stored settings with an empty bag. The
      // real store returns `{}` for a genuinely-empty profile; only the ctx-miss path signals undefined.
      return ctx ? extensionSettingsService.getExtensionSettings(ctx.profileId) : undefined
    },
    setExtensionSettings: (e, settings) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (ctx)
        extensionSettingsService.setExtensionSettings(
          ctx.profileId,
          settings && typeof settings === 'object' ? settings : {}
        )
    },

    // --- WorldbookHost ---
    // Persist a worldbook the card modified — a FULL replace (TavernHelper replaceWorldbookEntries):
    // add / remove / edit / toggle. Lossless because getWorldbook returns the full fields; new entries
    // (built by the card) get schema defaults.
    saveWorldbook: (e, _name, entries) => {
      const c = cardLoreCtx(e.sender.id)
      if (!c) return false
      const lb = lorebookService.getLorebookById(c.profileId, c.characterId)
      if (!lb) return false
      lb.entries = (Array.isArray(entries) ? entries : []).map(toLoreEntry)
      lorebookService.saveLorebookById(c.profileId, c.characterId, lb)
      wcvManager.pushLorebookChanged(c.characterId) // refresh the lorebook editor if it's open
      log('info', 'wcv replaceWorldbook', `${lb.entries.length} entries → card book`)
      return true
    },
    // list/chat-ids are SYNC. CRUD/bind over the full library (trusted cards).
    listWorldbooks: (e) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      return ctx ? lorebookService.listLorebooks(ctx.profileId) : []
    },
    chatWorldbookIds: (e) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      const ids = ctx ? chatService.getChatLorebookIds(ctx.profileId, ctx.chatId) : null
      return ids ?? (ctx?.characterId ? [ctx.characterId] : [])
    },
    createWorldbook: (e, name) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (!ctx) return ''
      const id = lorebookService.createLorebook(ctx.profileId, String(name ?? 'New Worldbook')).id
      wcvManager.pushLorebookChanged(id)
      return id
    },
    deleteWorldbook: (e, id) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (!ctx) return false
      lorebookService.deleteLorebookById(ctx.profileId, String(id))
      wcvManager.pushLorebookChanged(String(id))
      return true
    },
    saveWorldbookById: (e, id, entries) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (!ctx) return
      const lb = lorebookService.getLorebookById(ctx.profileId, String(id)) || {
        name: '',
        entries: []
      }
      lb.entries = (Array.isArray(entries) ? entries : []).map(toLoreEntry)
      lorebookService.saveLorebookById(ctx.profileId, String(id), lb)
      wcvManager.pushLorebookChanged(String(id)) // refresh the lorebook editor if it's open
    },
    bindWorldbook: (e, id, on) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (!ctx) return
      const cur =
        chatService.getChatLorebookIds(ctx.profileId, ctx.chatId) ??
        (ctx.characterId ? [ctx.characterId] : [])
      const next = on ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter((x) => x !== id)
      chatService.setChatLorebookIds(ctx.profileId, ctx.chatId, next)
    },

    // --- ChatHost ---
    // Raw floor rows for the calling panel's session (the unified TH runtime maps these to TH/ST message
    // shapes itself — same source the renderer uses). SYNC so the runtime's sync getters can read floors.
    floors: (e) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (!ctx) return []
      try {
        return floorService.getAllFloors(ctx.profileId, ctx.chatId)
      } catch {
        return []
      }
    },
    // Active chat id for SillyTavern.getCurrentChatId() (the WCV ctx is empty; resolve from e.sender). SYNC.
    currentChatId: (e) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      return ctx?.chatId ?? ''
    },
    // Persona display name (ctx-scoped settings) — so WCV chat shows the real user name, not "User".
    personaName: (e) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      try {
        return ctx ? settingsService.getSettings(ctx.profileId).persona?.name || 'User' : 'User'
      } catch {
        return 'User'
      }
    },
    // Active persona description for {{persona}}. UNGATED (ST parity): the macro returns the bio
    // regardless of the inject toggle — only prompt injection respects it (promptBuilder). SYNC.
    personaDescription: (e) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      try {
        return ctx ? settingsService.getSettings(ctx.profileId).persona?.description || '' : ''
      } catch {
        return ''
      }
    },
    // Edit message content by chat-array index (TH setChatMessages); then re-fold + reload.
    setChatMessages: (e, messages) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (!ctx) return false
      const n = chatWriteService.setChatMessages(ctx.profileId, ctx.chatId, messages)
      if (n) afterChatMutation(ctx.profileId, ctx.chatId, e.sender.id)
      log('info', 'wcv setChatMessages', `${n} floor(s) edited`)
      return n > 0
    },
    // Delete messages (TH deleteChatMessages) — truncates from the earliest targeted message's floor.
    deleteChatMessages: (e, messageIds) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (!ctx) return false
      if (!chatWriteService.deleteChatMessages(ctx.profileId, ctx.chatId, messageIds)) return false
      afterChatMutation(ctx.profileId, ctx.chatId, e.sender.id)
      log('info', 'wcv deleteChatMessages', 'truncated')
      return true
    },
    // Persist a chat the card mutated (e.g. a greeting-swipe selection): assistant messages → floors in
    // order (content + swipes/swipe_id). Re-fold + push vars, but NO host reload — the card calls
    // reloadCurrentChat itself after saveChat.
    saveChat: (e, chat) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (!ctx) return false
      const r = chatWriteService.saveChat(ctx.profileId, ctx.chatId, chat)
      if (!r.ok) return false
      // No-op echo → zero writes, nothing to re-fold or push (audit P1-4).
      if (r.changedFrom !== null) {
        pushVars(
          ctx.chatId,
          chatWriteService.afterChatMutation(ctx.profileId, ctx.chatId, r.changedFrom),
          e.sender.id
        )
        log('info', 'wcv saveChat', `assistant msgs → floors + reevaluated from ${r.changedFrom}`)
      }
      return true
    },
    // Ask the host renderer to reload the active chat's floors (after saveChat changed message content).
    reloadChat: (e) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (ctx) wcvManager.pushHostReload(ctx.chatId)
      return true
    },
    // --- Character / preset reads (Track C0) — sync, ctx-scoped via scriptApiService ---
    charData: (e) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      return ctx ? scriptApiService.getCharData(ctx.profileId, ctx.chatId, ctx.characterId) : null
    },
    charAvatarPath: (e) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      return ctx
        ? scriptApiService.getCharAvatarPath(ctx.profileId, ctx.chatId, ctx.characterId)
        : null
    },
    // getPreset('in_use'): the active preset as a Host preset view (name/settings/prompts/prompts_unused/
    // extensions). The shared runtime maps it to the TavernHelper shape; both transports inherit that.
    preset: (e) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      return ctx ? presetService.getActivePresetView(ctx.profileId) : null
    },
    presetNames: (e) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      return ctx ? scriptApiService.listPresetNames(ctx.profileId) : []
    },
    // Persist a card's preset edits (the 狐神抚 control surface). The runtime already merged the card's
    // mutated view onto the current normalized view, so this is a full normalized-preset-shaped patch.
    savePreset: (e, patch) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      return ctx ? presetService.saveActivePreset(ctx.profileId, patch) : false
    },

    // --- RegexHost ---
    regexes: (e) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      return ctx
        ? scriptApiService.listRegexes(ctx.profileId, {
            cardId: ctx.characterId,
            chatId: ctx.chatId,
            presetId: getActivePresetId(ctx.profileId)
          })
        : []
    },
    // Full TavernHelper-shaped regexes for a scope (getTavernRegexes({type})). SYNC (cards call w/o await).
    regexesFull: (e, option) => {
      const c = cardLoreCtx(e.sender.id)
      if (!c) return []
      const { scope, owner } = regexScopeFor(c.profileId, c.characterId, option)
      return regexService.getTavernRegexesByScope(c.profileId, scope, owner)
    },
    // isCharacterTavernRegexesEnabled — RPT keeps the card's world-scoped regexes active while the card is
    // open; there's no per-card disable toggle, so report enabled.
    isCharacterRegexesEnabled: () => true,
    // Replace a scope's regexes (replaceTavernRegexes / updateTavernRegexesWith) → store, then reload chat.
    replaceRegexes: (e, regexes, option) => {
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
    },

    // --- SurfaceHost ---
    // Card → host: set RP Terminal's chat input box (the onboarding finish's "inject prompt").
    setInput: (e, text) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (ctx) wcvManager.pushHostInput(ctx.chatId, String(text ?? ''))
    },
    // Card → host: "press the send button" — submit the current input-box content as the player's
    // turn (the /trigger mapping; see shared/thRuntime's triggerSlash fallback).
    submitInput: (e) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (ctx) wcvManager.pushHostSubmit(ctx.chatId)
    },
    // A card script (replaceScriptButtons) declared its action buttons → push them to the renderer toolbar.
    setButtons: (e, buttons) => {
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
    },
    // --- Full-play-area overlay surfaces (PM-A7) ---
    // WCV transport: the calling card panel requests/closes an overlay; ctx resolves from e.sender. The id
    // is validated against THAT card's panel_ui.overlays (undeclared ⇒ rejected + warned). Returns whether
    // the overlay is open afterward.
    requestOverlay: (e, overlayId) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (!ctx) return false
      const id = String(overlayId ?? '')
      return wcvManager.requestOverlay(id, resolveOverlayDecl(ctx.profileId, ctx.characterId, id))
    },
    closeOverlay: () => {
      wcvManager.closeOverlay()
      return true
    },
    // --- Runtime play theme (runtime-theme-api-design §5) ---
    // WCV transport: main can't derive the effective tokens (they live in the renderer), so it RELAYS the
    // set to the host renderer and returns the renderer's derive/AA verdict. ctx resolves from e.sender so
    // a card themes only its own play session. The sync getter returns the renderer-pushed snapshot.
    setPlayTheme: (e, theme, opts) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (!ctx) return false
      return wcvManager.requestSetPlayTheme(ctx.chatId, theme, opts)
    },
    getPlayThemeSync: () => wcvManager.playThemeSnapshotValue(),

    // --- AssetHost ---
    // Resolve a World Assets portrait URL for the calling card's world (rptasset://… or null). Mood-aware.
    assetUrl: (e, name, type, mood) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (!ctx) return null
      const ids =
        chatService.getChatLorebookIds(ctx.profileId, ctx.chatId) ??
        (ctx.characterId ? [ctx.characterId] : [])
      return worldAssetService.assetUrlForWorld(ctx.profileId, ids, String(name ?? ''), type, mood)
    },
    sceneAssetUrl: (e, location, type) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (!ctx) return null
      const ids =
        chatService.getChatLorebookIds(ctx.profileId, ctx.chatId) ??
        (ctx.characterId ? [ctx.characterId] : [])
      return worldAssetService.sceneAssetUrlForWorld(
        ctx.profileId,
        ids,
        String(location ?? ''),
        type
      )
    },
    // Card-facing asset enumeration (WA-3): the calling WCV panel's ctx resolves from e.sender (like
    // wcv-host-asset-url). Same id precedence + category inference as assetUrl; returns [] on any miss.
    assetList: (e, name, type) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (!ctx) return []
      const ids =
        chatService.getChatLorebookIds(ctx.profileId, ctx.chatId) ??
        (ctx.characterId ? [ctx.characterId] : [])
      return worldAssetService.assetListForWorld(ctx.profileId, ids, String(name ?? ''), type)
    },
    // Card-facing picker-backed import (WA-3): main opens the OS image picker, copies into the calling
    // card's primary world, returns the new rptasset:// URL (null on cancel/invalid). ctx from e.sender; a
    // WCV's webContents doesn't map to a BrowserWindow, so fall back to the app's window for the dialog.
    requestAssetImport: (e, arg) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (!ctx) return null
      const ids =
        chatService.getChatLorebookIds(ctx.profileId, ctx.chatId) ??
        (ctx.characterId ? [ctx.characterId] : [])
      const win =
        BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0] ?? null
      return pickAndImportAssetForCard(
        win,
        ctx.profileId,
        ids,
        String(arg?.name ?? ''),
        String(arg?.type ?? ''),
        arg?.variant != null ? String(arg.variant) : undefined
      )
    },

    // --- GenHost ---
    // Generation requests (Track C0) — the card REQUESTS; the host runs it (AI key stays in main).
    // generate(text) = a normal visible turn (new floor); generateRaw(config) = a one-off completion → text.
    generate: async (e, text) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (!ctx) return ''
      // source 'script': a card-initiated turn — refused while any turn is in flight, and PREEMPTED
      // by the player's own send if one arrives mid-flight (player priority, generationService).
      const floor = await generationService.generate(
        ctx.profileId,
        ctx.chatId,
        String(text ?? ''),
        () => {},
        'script'
      )
      wcvManager.pushHostReload(ctx.chatId) // a new floor → refresh the host chat UI + sibling WCVs
      return floor?.response?.content ?? ''
    },
    generateRaw: async (e, config) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (!ctx) return ''
      return generationService.generateRaw(ctx.profileId, ctx.chatId, config || {})
    },
    // Engine-computed duel build preview for the calling panel's active chat (read-only).
    getDuelPreview: (e) => {
      const ctx = wcvManager.contextFor(e.sender.id)
      if (!ctx) return null
      return computeDuelPreview(ctx.profileId, ctx.chatId, ctx.characterId)
    }
  }

  registerHostChannels(ipcMain, hostImpls)
}
