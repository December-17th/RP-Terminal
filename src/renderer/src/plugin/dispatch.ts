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
  /** Resolve a permission: true = allowed, false = denied (may prompt + persist). */
  ensure: (permission: string) => Promise<boolean>
  /** Show a transient toast. */
  toast: (msg: string) => void
  /** Plugin requested a visible panel (standalone plugins only; no-op for cards). */
  registerPanel?: (def: any) => void
  /** Push local-scope var writes into the chat store so status widgets update live. */
  syncLocalVars: (store: Record<string, any>) => void
  /** Run a full generation turn (resolves when the new floor lands). */
  triggerGenerate: (text: string) => Promise<void>
  isGenerating: () => boolean
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
      // Global scope ignores chatId; local scope needs the active chat.
      const res = await window.api.pluginVars(ctx.profileId, ctx.getChatId() || '', action)
      if (res && res.scope === 'local') ctx.syncLocalVars(res.store)
      return res ? res.value : undefined
    }
    case 'chat.getMessages': {
      if (!(await ctx.ensure('chat:read'))) permDenied('chat:read')
      const chatId = ctx.getChatId()
      return chatId ? window.api.pluginGetMessages(ctx.profileId, chatId) : []
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
    default:
      throw new Error('unknown method: ' + method)
  }
}
