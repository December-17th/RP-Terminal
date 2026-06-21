import { runSlash } from './slash'
import * as audioService from './audioService'

/**
 * Shared host-side RPC dispatcher for the sandboxed runtime — used by both card
 * scripts (CardScriptHost) and standalone plugins (PluginHost). It maps each
 * `rpt` method to a required permission, gates it through `ctx.ensure(...)`, and
 * forwards engine calls over IPC. The two callers differ only in their `ensure`
 * (card scripts auto-grant low-risk caps; plugins enforce the manifest) and in
 * how they resolve the active chat — so all method logic lives here, once.
 */

export interface DispatchCtx {
  profileId: string
  /** Active chat id for local vars / chat reads / generate; null when none open. */
  getChatId: () => string | null
  /** Owning card id (card scripts only) — used for the `character` variable scope. */
  cardId?: string
  /** Resolve a permission: true = allowed, false = denied (may prompt + persist). */
  ensure: (permission: string) => Promise<boolean>
  /** Show a transient toast. */
  toast: (msg: string) => void
  /** Plugin requested a visible panel (standalone plugins only; no-op for cards). */
  registerPanel?: (def: any) => void
  /** A script/plugin requested an action button (rendered in the menu above the input). */
  registerButton?: (def: any) => void
  /** Register a slash command owned by this frame. */
  registerCommand?: (name: string, description?: string) => void
  /** Push local-scope var writes into the chat store so status widgets update live. */
  syncLocalVars: (store: Record<string, any>) => void
  /** Run a full generation turn (resolves when the new floor lands). */
  triggerGenerate: (text: string) => Promise<void>
  isGenerating: () => boolean
  /** Storage namespace owner (e.g. `plugin:<id>` or `card:<id>`). */
  storageOwner: string
  /** Plugin id for host-mediated net.fetch (undefined → net unavailable, e.g. cards). */
  netOwner?: string
}

const permDenied = (perm: string): never => {
  throw new Error('permission denied: ' + perm)
}

export const dispatchRpc = async (method: string, args: any[], ctx: DispatchCtx): Promise<any> => {
  switch (method) {
    case 'vars': {
      const action = args[0] || { op: 'get' }
      const perm = action.op === 'get' ? 'vars:read' : 'vars:write'
      if (!(await ctx.ensure(perm))) permDenied(perm)
      // The `character` scope is bound to the owning card; the host supplies the id so a
      // script can't address another card's vars.
      if (action.scope === 'character') action.cardId = ctx.cardId
      // Global scope ignores chatId; local/message scope needs the active chat.
      const res = await window.api.pluginVars(ctx.profileId, ctx.getChatId() || '', action)
      // local + message (latest floor) writes feed the live status widgets.
      if (res && (res.scope === 'local' || res.scope === 'message')) ctx.syncLocalVars(res.store)
      return res ? res.value : undefined
    }
    case 'chat.getMessages': {
      if (!(await ctx.ensure('chat:read'))) permDenied('chat:read')
      const chatId = ctx.getChatId()
      return chatId ? window.api.pluginGetMessages(ctx.profileId, chatId) : []
    }
    case 'chat.setMessage': {
      if (!(await ctx.ensure('chat:write'))) permDenied('chat:write')
      const chatId = ctx.getChatId()
      if (!chatId) return false
      return window.api.pluginSetMessage(ctx.profileId, chatId, Number(args[0]), args[1] || {})
    }
    case 'chat.createMessage': {
      if (!(await ctx.ensure('chat:write'))) permDenied('chat:write')
      const chatId = ctx.getChatId()
      if (!chatId) return -1
      return window.api.pluginCreateMessage(ctx.profileId, chatId, args[0] || {})
    }
    case 'chat.deleteMessages': {
      if (!(await ctx.ensure('chat:write'))) permDenied('chat:write')
      const chatId = ctx.getChatId()
      if (!chatId) return false
      return window.api.pluginDeleteMessages(ctx.profileId, chatId, Number(args[0]))
    }
    case 'chat.getLastMessage': {
      if (!(await ctx.ensure('chat:read'))) permDenied('chat:read')
      const chatId = ctx.getChatId()
      if (!chatId) return ''
      const msgs = await window.api.pluginGetMessages(ctx.profileId, chatId)
      return msgs.length ? msgs[msgs.length - 1].response : ''
    }
    case 'generate': {
      if (!(await ctx.ensure('generate'))) permDenied('generate')
      if (ctx.isGenerating()) throw new Error('busy: a generation is already running')
      if (!ctx.getChatId()) throw new Error('no active session to generate in')
      await ctx.triggerGenerate(String(args[0] ?? ''))
      return true
    }
    case 'generate.raw': {
      if (!(await ctx.ensure('generate'))) permDenied('generate')
      return window.api.generateRaw(ctx.profileId, ctx.getChatId() || '', args[0] || {})
    }
    case 'generate.stop': {
      // Low-risk: stopping is always allowed.
      const chatId = ctx.getChatId()
      if (chatId) await window.api.abortGeneration(chatId)
      return true
    }
    case 'generate.image': {
      if (!(await ctx.ensure('generate'))) permDenied('generate')
      return window.api.generateImage(ctx.profileId, String(args[0] ?? ''))
    }
    case 'ui.toast': {
      if (!(await ctx.ensure('ui:toast'))) permDenied('ui:toast')
      ctx.toast(String(args[0] ?? ''))
      return true
    }
    case 'ui.registerPanel': {
      if (!(await ctx.ensure('ui:panel'))) permDenied('ui:panel')
      ctx.registerPanel?.(args[0] || {})
      return true
    }
    case 'ui.registerButton': {
      if (!(await ctx.ensure('ui:button'))) permDenied('ui:button')
      ctx.registerButton?.(args[0] || {})
      return true
    }
    case 'storage': {
      if (!(await ctx.ensure('storage'))) permDenied('storage')
      return window.api.pluginStorage(ctx.profileId, ctx.storageOwner, args[0] || { op: 'all' })
    }
    case 'net.fetch': {
      if (!(await ctx.ensure('net'))) permDenied('net')
      if (!ctx.netOwner) throw new Error('net is not available here')
      return window.api.pluginNetFetch(ctx.netOwner, String(args[0] ?? ''), args[1] || {})
    }
    // --- TH-3 read/CRUD API (card · worldbook · preset · regex). ---
    case 'card.getData': {
      if (!(await ctx.ensure('card:read'))) permDenied('card:read')
      return window.api.scriptCardData(ctx.profileId, ctx.getChatId() || '', ctx.cardId)
    }
    case 'card.getAvatarPath': {
      if (!(await ctx.ensure('card:read'))) permDenied('card:read')
      return window.api.scriptCardAvatar(ctx.profileId, ctx.getChatId() || '', ctx.cardId)
    }
    case 'lore.list': {
      if (!(await ctx.ensure('worldbook:read'))) permDenied('worldbook:read')
      return window.api.scriptWorldbookList(ctx.profileId)
    }
    case 'lore.get': {
      if (!(await ctx.ensure('worldbook:read'))) permDenied('worldbook:read')
      return window.api.scriptWorldbookGet(ctx.profileId, ctx.getChatId() || '', args[0], ctx.cardId)
    }
    case 'lore.setEntries': {
      if (!(await ctx.ensure('worldbook:write'))) permDenied('worldbook:write')
      return window.api.scriptWorldbookSet(
        ctx.profileId,
        ctx.getChatId() || '',
        args[0],
        args[1],
        ctx.cardId
      )
    }
    case 'preset.get': {
      if (!(await ctx.ensure('preset:read'))) permDenied('preset:read')
      return window.api.scriptPresetGet(ctx.profileId)
    }
    case 'preset.list': {
      if (!(await ctx.ensure('preset:read'))) permDenied('preset:read')
      return window.api.scriptPresetList(ctx.profileId)
    }
    case 'regex.format': {
      if (!(await ctx.ensure('regex:read'))) permDenied('regex:read')
      const scope = { cardId: ctx.cardId ?? null, chatId: ctx.getChatId() }
      return window.api.scriptRegexFormat(ctx.profileId, scope, String(args[0] ?? ''), args[1])
    }
    case 'regex.list': {
      if (!(await ctx.ensure('regex:read'))) permDenied('regex:read')
      const scope = { cardId: ctx.cardId ?? null, chatId: ctx.getChatId() }
      return window.api.scriptRegexList(ctx.profileId, scope)
    }
    case 'net.fetchText': {
      // Host-mediated text fetch (the .load / frontend-card path). The world's
      // remoteScripts grant is the real gate, re-checked in main.
      if (!(await ctx.ensure('remote:fetch'))) permDenied('remote:fetch')
      return window.api.scriptFetchText(ctx.profileId, ctx.cardId, String(args[0] ?? ''))
    }
    // --- TH-7 audio (runs in the trusted parent, not the sandbox). ---
    case 'audio.playBgm': {
      if (!(await ctx.ensure('audio'))) permDenied('audio')
      return audioService.playBgm(String(args[0] ?? ''), args[1] || {})
    }
    case 'audio.pauseBgm': {
      if (!(await ctx.ensure('audio'))) permDenied('audio')
      return audioService.pauseBgm()
    }
    case 'audio.resumeBgm': {
      if (!(await ctx.ensure('audio'))) permDenied('audio')
      return audioService.resumeBgm()
    }
    case 'audio.stopBgm': {
      if (!(await ctx.ensure('audio'))) permDenied('audio')
      return audioService.stopBgm()
    }
    case 'audio.setVolume': {
      if (!(await ctx.ensure('audio'))) permDenied('audio')
      return audioService.setBgmVolume(Number(args[0]))
    }
    case 'audio.playSfx': {
      if (!(await ctx.ensure('audio'))) permDenied('audio')
      return audioService.playSfx(String(args[0] ?? ''), args[1] || {})
    }
    case 'slash.run': {
      if (!(await ctx.ensure('slash'))) permDenied('slash')
      return runSlash(String(args[0] ?? ''))
    }
    case 'slash.register': {
      if (!(await ctx.ensure('slash'))) permDenied('slash')
      ctx.registerCommand?.(String(args[0] ?? ''), args[1] ? String(args[1]) : undefined)
      return true
    }
    default:
      throw new Error('unknown method: ' + method)
  }
}
