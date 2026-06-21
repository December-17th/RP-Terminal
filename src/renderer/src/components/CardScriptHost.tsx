import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useToastStore } from '../stores/toastStore'
import { useScriptsStore } from '../stores/scriptsStore'
import { useCardScriptsStore } from '../stores/cardScriptsStore'
import { useToolbarStore } from '../stores/toolbarStore'
import { buildScriptSrcDoc, CardScript } from '../plugin/bridgeShim'
import { buildMvuEvents } from '../plugin/mvuEvents'
import { chatTransitionEvents, messageMutationEvents, TAVERN_EVENTS } from '../plugin/events'
import { dispatchRpc } from '../plugin/dispatch'
import { registerFrameCommand } from '../plugin/slash'

interface Props {
  profileId: string
  chatId: string
  cardId: string
  cardName: string
  scripts: CardScript[]
}

interface Grants {
  enabled?: boolean
  generate?: boolean
  remoteScripts?: boolean
  trusted?: boolean
}

/**
 * Card-script runtime (P1) — the host half. Mounts the active card's scripts in
 * a sandboxed (`allow-scripts`, opaque-origin) iframe and brokers their
 * postMessage RPC: variable/chat reads and (permission-gated) generation are
 * forwarded to the engine over IPC; UI calls (toasts) and host→script events are
 * handled here. Keyed by card+chat at the mount site, so switching either gives
 * a fresh sandbox.
 */
export const CardScriptHost: React.FC<Props> = ({
  profileId,
  chatId,
  cardId,
  cardName,
  scripts
}) => {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const grantsRef = useRef<Grants>({})
  const cmdCleanups = useRef(new Map<string, () => void>())
  const btnKeys = useRef(new Set<string>())
  // Master on/off lives in the Scripts (left) panel now; the right panel is game-UI only.
  const enabled = useCardScriptsStore((s) => s.enabledByCard[cardId] ?? true)
  const [height, setHeight] = useState(0)
  const [srcDoc, setSrcDoc] = useState('')
  const [scriptCount, setScriptCount] = useState(0)
  const [grantsLoaded, setGrantsLoaded] = useState(false)
  // A trusted world runs its card scripts same-origin (native ES-module imports / ST-style
  // runtime) at the cost of full app access — the trust grant covers the world's own scripts.
  const [trusted, setTrusted] = useState(false)

  // Card-embedded scripts feed the runtime as the World scope; a change to them (or to the
  // profile scripts store) re-triggers a refetch of the merged, import-resolved set.
  const storeScripts = useScriptsStore((s) => s.scripts)
  const scriptsKey = useMemo(
    () => (scripts || []).map((s) => `${s.name}:${s.code.length}`).join('|'),
    [scripts]
  )

  // Load persisted grants (enable state + sensitive caps) for this card.
  useEffect(() => {
    let alive = true
    setGrantsLoaded(false)
    window.api.pluginGetGrants(profileId, cardId).then((g: Grants) => {
      if (!alive) return
      grantsRef.current = g || {}
      useCardScriptsStore.getState().seed(cardId, g?.enabled !== false)
      setGrantsLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [profileId, cardId])

  // Build the sandboxed document from the MERGED runtime scripts (card-embedded + active-
  // scope store scripts). Scripts that import remote ES modules load them natively (1B) —
  // which needs the per-card `remoteScripts` grant (it relaxes the iframe CSP to allow the
  // CDN). The first such world prompts once; the grant then persists.
  useEffect(() => {
    if (!enabled || !grantsLoaded) return
    let alive = true
    ;(async () => {
      const res = await window.api.getRuntimeScripts(profileId, cardId, chatId)
      if (!alive) return
      let trust = grantsRef.current.trusted === true
      let allow = trust || grantsRef.current.remoteScripts === true
      // Scripts that load remote ES modules need a same-origin (trusted) runtime — the
      // opaque sandbox can't import cross-origin modules. Prompt once for full trust.
      if (res?.remoteHosts?.length && !trust) {
        const ok = window.confirm(
          `Scripts in "${cardName}" load & run code from the internet:\n\n` +
            res.remoteHosts.map((h: string) => '  • ' + h).join('\n') +
            `\n\nRun this world's scripts with FULL TRUST (a native runtime, the way ` +
            `SillyTavern runs them)? Grant this ONLY for a world you trust — its code can ` +
            `read app data, including your API keys.`
        )
        if (ok) {
          grantsRef.current = await window.api.pluginSetGrants(profileId, cardId, {
            trusted: true,
            remoteScripts: true
          })
          trust = true
          allow = true
        }
      }
      const list = res?.scripts || []
      // The frame is about to reload and re-register; drop this card's stale buttons first
      // so a button from a now-removed script doesn't linger in the menu.
      btnKeys.current.forEach((k) => useToolbarStore.getState().remove(k))
      btnKeys.current.clear()
      setScriptCount(list.length)
      setTrusted(trust)
      setSrcDoc(buildScriptSrcDoc(list, { allowRemote: allow, trusted: trust }))
    })()
    return () => {
      alive = false
    }
  }, [profileId, cardId, chatId, cardName, enabled, grantsLoaded, scriptsKey, storeScripts])

  const post = (msg: any): void => {
    frameRef.current?.contentWindow?.postMessage(msg, '*')
  }
  const emit = (name: string, payload: any): void => {
    post({ __rptevent: 1, name, payload })
  }
  // Accumulates the in-flight response so STREAM_TOKEN_RECEIVED carries the full text
  // so far (ST/TH semantics), reset at the start of each generation.
  const streamAccum = useRef('')

  const pushToast = (msg: string): void => useToastStore.getState().push(msg)

  // Card scripts auto-grant low-risk caps; `net` is never allowed (no manifest
  // allow-list); `generate` prompts once per card.
  const ensure = async (perm: string): Promise<boolean> => {
    // A trusted (same-origin) world already has full app access, so its rpt calls are
    // unrestricted.
    if (grantsRef.current.trusted) return true
    if (perm === 'net') return false
    if (perm !== 'generate') return true
    if (grantsRef.current.generate) return true
    const ok = window.confirm(
      `The scripts in "${cardName}" want to trigger AI generation.\n\n` +
        `Allow card scripts to start generations? (You can change this later.)`
    )
    if (!ok) return false
    grantsRef.current = await window.api.pluginSetGrants(profileId, cardId, { generate: true })
    return true
  }

  // Dispatch one permission-checked RPC from a script (shared with PluginHost).
  // Throws → reported to the script as a rejected promise.
  const registerCommand = (name: string, description?: string): void => {
    const key = name.toLowerCase()
    if (cmdCleanups.current.has(key)) return
    cmdCleanups.current.set(
      key,
      registerFrameCommand(key, (args, raw) => emit('slash:' + key, { args, raw }), description)
    )
  }

  // A script-contributed action button → lands in the menu above the input; clicking it
  // posts `button:<id>` back to this card's frame. Keyed by card so it's cleaned up on unmount.
  const registerButton = (def: any): void => {
    const id = String((def && def.id) || (def && def.label) || 'button')
    const key = 'card:' + cardId + '::' + id
    btnKeys.current.add(key)
    useToolbarStore.getState().add({
      key,
      label: String((def && def.label) || (def && def.id) || 'Button'),
      onClick: () => emit('button:' + id, {})
    })
  }

  const handleRpc = (method: string, args: any[]): Promise<any> =>
    dispatchRpc(method, args, {
      profileId,
      getChatId: () => chatId,
      cardId,
      ensure,
      toast: pushToast,
      registerCommand,
      registerButton,
      storageOwner: 'card:' + cardId,
      syncLocalVars: (store) => useChatStore.getState().setLatestFloorVariables(store),
      triggerGenerate: (text) => useChatStore.getState().sendAction(profileId, text),
      isGenerating: () => useChatStore.getState().isGenerating
    })

  // Keep the postMessage handler pointed at the LATEST dispatcher so a prop change or a
  // hot reload never leaves it calling a stale closure (which silently drops newly-wired
  // RPCs like ui.registerButton).
  const handleRpcRef = useRef(handleRpc)
  handleRpcRef.current = handleRpc

  // Unregister this frame's slash commands + toolbar buttons when it unmounts.
  useEffect(() => {
    const cleanups = cmdCleanups.current
    const keys = btnKeys.current
    return () => {
      cleanups.forEach((off) => off())
      cleanups.clear()
      keys.forEach((k) => useToolbarStore.getState().remove(k))
      keys.clear()
    }
  }, [])

  // RPC + lifecycle messages from the sandboxed frame.
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== frameRef.current?.contentWindow) return
      const d = e.data
      if (!d || typeof d !== 'object') return

      if (d.__rptresize) {
        setHeight(Math.min(Math.max(0, Number(d.height) || 0), 1200))
      } else if (d.__rptlog) {
        window.api.pluginLog(cardName, String(d.msg))
      } else if (d.__rptready) {
        emit('ready', {})
        // This host remounts per card+chat, so a fresh frame == a (re)loaded chat.
        emit(TAVERN_EVENTS.CHAT_CHANGED, { chatId })
      } else if (d.__rpt) {
        handleRpcRef
          .current(String(d.method), Array.isArray(d.args) ? d.args : [])
          .then((result) => post({ __rptres: 1, id: d.id, ok: true, result }))
          .catch((err) =>
            post({ __rptres: 1, id: d.id, ok: false, error: err?.message || String(err) })
          )
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
    // Uses handleRpcRef so it always dispatches through the latest closure.
  }, [profileId, chatId, cardId, cardName])

  // Forward generation/chat lifecycle to scripts so reactive UIs can refresh — both the
  // legacy rpt.v1 names and the canonical tavern_events (TH-1).
  useEffect(() => {
    return useChatStore.subscribe((state, prev) => {
      for (const ev of chatTransitionEvents(
        { isGenerating: prev.isGenerating, floorCount: prev.floors.length },
        { isGenerating: state.isGenerating, floorCount: state.floors.length }
      )) {
        if (ev.name === TAVERN_EVENTS.GENERATION_STARTED) streamAccum.current = ''
        emit(ev.name, ev.payload)
      }
      // Per-message edits/swipes/deletes → MESSAGE_UPDATED/SWIPED/DELETED.
      for (const ev of messageMutationEvents(
        prev.floors.map((f) => ({
          floor: f.floor,
          content: f.response.content,
          swipeId: f.swipe_id ?? 0
        })),
        state.floors.map((f) => ({
          floor: f.floor,
          content: f.response.content,
          swipeId: f.swipe_id ?? 0
        }))
      )) {
        emit(ev.name, ev.payload)
      }
      // A new floor landed — replay this turn's MVU variable changes to the scripts
      // (mag_* events) so MagVarUpdate front-end UIs refresh.
      if (state.floors.length > prev.floors.length) {
        const latest = state.floors[state.floors.length - 1]
        for (const ev of buildMvuEvents(latest?.variables)) emit(ev.name, ev.payload)
      }
    })
  }, [])

  // Forward streamed tokens to scripts as STREAM_TOKEN_RECEIVED (full text so far),
  // for this chat only. Mirrors ST/TH where the listener gets the accumulated message.
  useEffect(() => {
    return window.api.onGenerationDelta(({ chatId: cid, delta }) => {
      if (cid !== chatId) return
      streamAccum.current += delta
      emit(TAVERN_EVENTS.STREAM_TOKEN_RECEIVED, streamAccum.current)
    })
  }, [chatId])

  // The right panel is reserved for game UI — render only the script-produced UI (the
  // sandboxed iframe), no management chrome. The master on/off toggle lives in the Scripts
  // (left) panel. Disabled, or nothing to run → render nothing here.
  if (!enabled || scriptCount === 0) return null

  return (
    <iframe
      ref={frameRef}
      className="rpt-script-frame"
      // Trusted worlds run their scripts same-origin (native runtime, full access);
      // otherwise the opaque sandbox.
      sandbox={trusted ? 'allow-scripts allow-same-origin' : 'allow-scripts'}
      srcDoc={srcDoc}
      style={{ height: height || 1 }}
      title="card scripts"
    />
  )
}
