import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useToastStore } from '../stores/toastStore'
import { useScriptsStore } from '../stores/scriptsStore'
import { usePresetStore } from '../stores/presetStore'
import { useCardScriptsStore } from '../stores/cardScriptsStore'
import { useToolbarStore } from '../stores/toolbarStore'
import { buildScriptSrcDoc, isModuleScript, CardScript } from '../plugin/bridgeShim'
import { remoteImportUrls, inlineRemoteModuleGraph, ModuleSource } from '../plugin/sourceRewrite'
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

// Remote module graphs are immutable per URL-set, so cache them across reloads (chat/preset
// switches) instead of re-fetching the CDN every time the frame rebuilds.
const moduleGraphCache = new Map<string, ModuleSource[]>()

/**
 * A static `import 'https://…'` can't resolve natively in the opaque (process-isolated) frame,
 * so for each module script with remote imports we host-fetch the module graph and inline it as
 * self-contained `data:` URLs (the same trick `$.load()` uses). Grant-gated by the caller; on any
 * failure the script is left untouched (its import then fails in-frame and surfaces to the Logs
 * panel). Returns a new list — never mutates the input.
 */
const inlineRemoteImports = async (
  profileId: string,
  cardId: string,
  scripts: CardScript[]
): Promise<CardScript[]> =>
  Promise.all(
    scripts.map(async (s) => {
      if (!isModuleScript(s.code)) return s
      const urls = remoteImportUrls(s.code)
      if (urls.length === 0) return s
      const key = urls.slice().sort().join('|')
      try {
        let graph = moduleGraphCache.get(key)
        if (!graph) {
          graph = await window.api.scriptFetchModuleGraph(profileId, cardId, urls)
          if (graph && graph.length) moduleGraphCache.set(key, graph)
        }
        if (graph && graph.length) return { ...s, code: inlineRemoteModuleGraph(s.code, graph) }
      } catch {
        /* leave as-is — the native import will fail and report to the Logs panel */
      }
      return s
    })
  )

interface Grants {
  enabled?: boolean
  generate?: boolean
  remoteScripts?: boolean
  trusted?: boolean
  /** The user already made an explicit trust decision (import-time modal / legacy prompt). */
  decided?: boolean
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
  // Trust grant (may this world load & run remote code), settable from the Scripts panel's
  // grant button. Reactive so granting/revoking re-resolves the runtime without re-opening.
  const trustedGrant = useCardScriptsStore((s) => s.trustedByCard[cardId])
  // The auto-prompt fires at most once per card mount; after that the grant button is the path.
  const promptedRef = useRef(false)
  const [height, setHeight] = useState(0)
  const [srcDoc, setSrcDoc] = useState('')
  const [scriptCount, setScriptCount] = useState(0)
  const [grantsLoaded, setGrantsLoaded] = useState(false)
  // Trust (full `rpt` caps for this world) lives in the persisted grants and is read in
  // `ensure`; the frame stays process-isolated (opaque sandbox) regardless.
  // Watchdog state (mirrors MessageScriptFrame): detect a wedged frame and let the user
  // reload (fresh process) or stop it. Works because the frame is in its own process.
  const [hung, setHung] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  const lastAliveRef = useRef(0)

  // Card-embedded scripts feed the runtime as the World scope; a change to them (or to the
  // profile scripts store) re-triggers a refetch of the merged, import-resolved set.
  const storeScripts = useScriptsStore((s) => s.scripts)
  // Preset-scoped scripts only run while their preset is active; switching presets must
  // re-resolve the merged runtime set (the active preset id is applied main-side).
  const activePresetId = usePresetStore((s) => s.activeId)
  const scriptsKey = useMemo(
    () => (scripts || []).map((s) => `${s.name}:${s.code.length}`).join('|'),
    [scripts]
  )

  // Load persisted grants (enable state + sensitive caps) for this card.
  useEffect(() => {
    let alive = true
    setGrantsLoaded(false)
    promptedRef.current = false // re-allow the one-time prompt for the newly active card
    window.api.pluginGetGrants(profileId, cardId).then((g: Grants) => {
      if (!alive) return
      grantsRef.current = g || {}
      useCardScriptsStore.getState().seed(cardId, g?.enabled !== false)
      useCardScriptsStore.getState().seedTrust(cardId, g?.trusted === true)
      useCardScriptsStore.getState().seedDecided(cardId, g?.decided === true)
      setGrantsLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [profileId, cardId])

  // Build the sandboxed document from the MERGED runtime scripts (card-embedded + active-
  // scope store scripts). Scripts that import remote ES modules need the per-card
  // `remoteScripts` grant; their remote imports are host-fetched and inlined as `data:` URLs
  // (the opaque frame can't import cross-origin natively). The first such world prompts once;
  // the grant then persists.
  useEffect(() => {
    if (!enabled || !grantsLoaded) return
    let alive = true
    ;(async () => {
      const res = await window.api.getRuntimeScripts(profileId, cardId, chatId)
      if (!alive) return
      // Trust comes from the reactive store (seeded from grants, set by the Scripts panel's
      // grant button) so granting/revoking there re-runs this effect.
      let trust = trustedGrant === true || grantsRef.current.trusted === true
      let allow = trust || grantsRef.current.remoteScripts === true
      // Scripts that load remote ES modules need the remote-loading grant. Auto-prompt at most
      // once per card mount (the first time we see remote scripts); thereafter the user grants
      // via the Scripts panel button — so a later grant/revoke there doesn't re-prompt.
      if (res?.remoteHosts?.length && !promptedRef.current && !grantsRef.current.decided) {
        promptedRef.current = true
        const ok =
          !trust &&
          window.confirm(
            `Scripts in "${cardName}" load & run code from the internet:\n\n` +
              res.remoteHosts.map((h: string) => '  • ' + h).join('\n') +
              `\n\nGrant this world's scripts FULL access to app features (generate, fetch, ` +
              `write chat & lore)? They still run sandboxed in their own process — they can't ` +
              `read your API keys or app memory directly. Grant this ONLY for a world you trust.`
          )
        if (ok) {
          grantsRef.current = await window.api.pluginSetGrants(profileId, cardId, {
            trusted: true,
            remoteScripts: true
          })
          useCardScriptsStore.getState().seedTrust(cardId, true)
          trust = true
          allow = true
        }
      }
      const list = res?.scripts || []
      // Inline any remote module imports (host-fetched) so they resolve in the opaque frame —
      // only when remote loading is allowed for this world.
      const prepared = allow ? await inlineRemoteImports(profileId, cardId, list) : list
      if (!alive) return
      // The frame is about to reload and re-register; drop this card's stale buttons first
      // so a button from a now-removed script doesn't linger in the menu.
      btnKeys.current.forEach((k) => useToolbarStore.getState().remove(k))
      btnKeys.current.clear()
      setScriptCount(prepared.length)
      setSrcDoc(buildScriptSrcDoc(prepared, { allowRemote: allow, trusted: trust }))
    })()
    return () => {
      alive = false
    }
  }, [
    profileId,
    cardId,
    chatId,
    cardName,
    enabled,
    grantsLoaded,
    scriptsKey,
    storeScripts,
    activePresetId,
    trustedGrant
  ])

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
    // A trusted world has full rpt caps (still process-isolated), so its calls are unrestricted.
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
      // Any message proves the frame's event loop is alive → reset the watchdog.
      lastAliveRef.current = Date.now()
      if (d.__rptpong) {
        setHung(false)
        return
      }

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

  // Heartbeat the frame; flag it hung if it stops answering (likely an infinite loop in a
  // card script). The frame is process-isolated, so this timer keeps firing even when the
  // frame is wedged. Resets on (re)mount via reloadNonce.
  useEffect(() => {
    if (!enabled || stopped || !srcDoc) return
    // Ref reset (not state) avoids a synchronous re-render; `hung` is cleared by the pong
    // handler and the Reload/Stop buttons.
    lastAliveRef.current = Date.now()
    const id = setInterval(() => {
      post({ __rptping: 1, t: Date.now() })
      if (Date.now() - lastAliveRef.current > 12000) setHung(true)
    }, 3000)
    return () => clearInterval(id)
  }, [enabled, stopped, srcDoc, reloadNonce])

  // The right panel is reserved for game UI — render only the script-produced UI (the
  // sandboxed iframe), no management chrome. The master on/off toggle lives in the Scripts
  // (left) panel. Disabled, or nothing to run → render nothing here.
  if (!enabled || scriptCount === 0) return null

  if (stopped) {
    return (
      <div className="message-card-gate">
        <span className="message-card-gate-label">⏹ Card UI stopped</span>
        <button
          className="btn-accent"
          onClick={() => {
            setStopped(false)
            setReloadNonce((n) => n + 1)
          }}
        >
          ▶ Restart
        </button>
      </div>
    )
  }

  return (
    <div className="message-card-host">
      {hung && (
        <div className="message-card-hung">
          <span className="message-card-hung-label">⚠ This card UI stopped responding.</span>
          <button
            className="btn-accent"
            onClick={() => {
              setHung(false)
              setReloadNonce((n) => n + 1)
            }}
          >
            Reload
          </button>
          <button
            onClick={() => {
              setHung(false)
              setStopped(true)
            }}
          >
            Stop
          </button>
        </div>
      )}
      <iframe
        // Remount (fresh process) on Reload. Opaque sandbox (no allow-same-origin) keeps the
        // frame process-isolated, so a runaway script can't freeze the host.
        key={reloadNonce}
        ref={frameRef}
        className="rpt-script-frame"
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        style={{ height: height || 1 }}
        title="card scripts"
      />
    </div>
  )
}
