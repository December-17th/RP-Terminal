// src/preload/wcvHost.ts
//
// WCV transport adapter for the unified TH runtime (shared/thRuntime). It wraps the same `ipcRenderer`
// channels wcvPreload used directly; the WCV preload has NO per-slot ctx — main resolves the calling
// panel's session from `e.sender`, so these methods call IPC WITHOUT passing ctx (the placeholder ctx is
// only here to satisfy the Host interface). The quickjs EJS engine stays in the preload and is injected
// via deps.evalTemplate / deps.evalTemplateError.
//
// The bulk of the adapter is GENERATED from `WCV_CHANNEL_SPEC` (shared/thRuntime/wcvChannelSpec.ts) by a
// generic loop over `{ channel, kind, fallback }`: `sync` → `sendSync` (try/catch → fallback, and fall
// back on a null/undefined result), `invoke` → `ipcRenderer.invoke`, `send` → `ipcRenderer.send`. The
// members not in the spec (the "residue": event subscriptions, injected EJS deps, shape-normalizing
// worldbook getters, createChat, formatRegex) are hand-written below and spread on top. Adding a WCV
// capability = a spec row + this stays untouched (ADR 0013).
import { ipcRenderer } from 'electron'
import type { Host, CardCtx } from '../shared/thRuntime/types'
import type { VarsOrigin } from '../shared/thRuntime/types'
import { WCV_CHANNEL_SPEC } from '../shared/thRuntime/wcvChannelSpec'
import type { WcvSpecMember } from '../shared/thRuntime/wcvChannelSpec'

type Deps = {
  ctx: CardCtx
  evalTemplate: (tmpl: string, data?: any) => string
  evalTemplateError: (tmpl: string, data?: any) => string | null
  prepareContext: (data?: any) => any
}

// Build one member function from its spec entry. `sync` blocks (sendSync) and falls back on throw OR a
// null/undefined result (matching every `|| fallback` the hand-written adapter used — `??` here also
// preserves valid falsy values like '' / false that `||` would have discarded). `invoke`/`send` forward
// their args unchanged.
const buildMember = (spec: (typeof WCV_CHANNEL_SPEC)[WcvSpecMember]): ((...args: any[]) => any) => {
  const { channel, kind, fallback } = spec
  if (kind === 'sync') {
    return (...args: any[]): any => {
      try {
        const r = ipcRenderer.sendSync(channel, ...args)
        return r ?? fallback
      } catch {
        return fallback
      }
    }
  }
  if (kind === 'send') {
    return (...args: any[]): any => ipcRenderer.send(channel, ...args)
  }
  return (...args: any[]): any => ipcRenderer.invoke(channel, ...args)
}

export function createWcvHost(deps: Deps): Host {
  // Generic pass over the spec — one member per row.
  const generated = {} as Record<WcvSpecMember, (...args: any[]) => any>
  for (const member of Object.keys(WCV_CHANNEL_SPEC) as WcvSpecMember[]) {
    generated[member] = buildMember(WCV_CHANNEL_SPEC[member])
  }

  const wbNames = (): any => ipcRenderer.sendSync('wcv-host-get-worldbook-names-sync')

  // Hand-written residue (same bodies as before) spread over the generated members.
  return {
    ...(generated as unknown as Host),
    ctx: deps.ctx,
    // Worldbook getters normalize main's response shape (not a static fallback ⇒ residue).
    worldbookNames: () => {
      const r = wbNames()
      return { primary: r?.primary ?? null, additional: r?.additional || [] }
    },
    getWorldbook: async (name) => {
      const entries = await ipcRenderer.invoke('wcv-host-get-worldbook', name)
      return { entries: Array.isArray(entries) ? entries : (entries?.entries ?? []) }
    },
    getWorldbookById: async (id) => {
      const r = await ipcRenderer.invoke('wcv-host-get-worldbook-by-id', id)
      return { name: r?.name, entries: Array.isArray(r?.entries) ? r.entries : [] }
    },
    // createChat has no main-side channel (the WCV never spawns a chat) — deferred empty id.
    createChat: () => Promise.resolve(''),
    // formatRegex's natural fallback is the INPUT text, which the static table can't express, so it stays
    // hand-written and keeps its original body (no try/catch — a throw here surfaces, as before).
    formatRegex: (t) => ipcRenderer.sendSync('wcv-host-format-regex', t),
    onVarsChanged: (cb) => {
      // Forward the origin (2nd IPC arg) so the runtime fires MVU events only for non-card-write changes
      // (a card's own write echoed back must not re-fire its events and loop — the WS-3 fix). Absent ⇒
      // undefined meta ⇒ the runtime treats it as a fold (events fire) for back-compat.
      const l = (_e: any, v: any, origin?: VarsOrigin): void =>
        cb(v, origin ? { origin } : undefined)
      ipcRenderer.on('wcv-vars-changed', l)
      return () => ipcRenderer.removeListener('wcv-vars-changed', l)
    },
    onHostEvent: (cb) => {
      const l = (_e: any, d: any): void => d && d.name && cb(d.name, d.payload)
      ipcRenderer.on('wcv-event', l)
      return () => ipcRenderer.removeListener('wcv-event', l)
    },
    evalTemplate: deps.evalTemplate,
    evalTemplateError: deps.evalTemplateError,
    prepareContext: deps.prepareContext
  }
}
