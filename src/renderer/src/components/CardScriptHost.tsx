import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useToastStore } from '../stores/toastStore'
import { useScriptsStore } from '../stores/scriptsStore'
import { useCardScriptsStore } from '../stores/cardScriptsStore'
import { buildScriptSrcDoc, CardScript } from '../plugin/bridgeShim'
import { buildMvuEvents } from '../plugin/mvuEvents'
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
  // Master on/off lives in the Scripts (left) panel now; the right panel is game-UI only.
  const enabled = useCardScriptsStore((s) => s.enabledByCard[cardId] ?? true)
  const [height, setHeight] = useState(0)
  const [srcDoc, setSrcDoc] = useState('')
  const [scriptCount, setScriptCount] = useState(0)
  const [grantsLoaded, setGrantsLoaded] = useState(false)

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
  // scope store scripts), with remote `import` directives resolved in main. The first remote
  // load prompts once per world; the grant is then persisted (and the fetch cached).
  useEffect(() => {
    if (!enabled || !grantsLoaded) return
    let alive = true
    ;(async () => {
      const allow = grantsRef.current.remoteScripts === true
      let res = await window.api.getRuntimeScripts(profileId, cardId, chatId, allow)
      if (!alive) return
      if (res?.remoteHosts?.length && !allow) {
        const ok = window.confirm(
          `Scripts in "${cardName}" load code from the internet:\n\n` +
            res.remoteHosts.map((h: string) => '  • ' + h).join('\n') +
            `\n\nAllow remote scripts for this world? (fetched once, then cached)`
        )
        if (ok) {
          grantsRef.current = await window.api.pluginSetGrants(profileId, cardId, {
            remoteScripts: true
          })
          res = await window.api.getRuntimeScripts(profileId, cardId, chatId, true)
          if (!alive) return
        }
      }
      const list = res?.scripts || []
      setScriptCount(list.length)
      setSrcDoc(buildScriptSrcDoc(list))
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

  const pushToast = (msg: string): void => useToastStore.getState().push(msg)

  // Card scripts auto-grant low-risk caps; `net` is never allowed (no manifest
  // allow-list); `generate` prompts once per card.
  const ensure = async (perm: string): Promise<boolean> => {
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

  const handleRpc = (method: string, args: any[]): Promise<any> =>
    dispatchRpc(method, args, {
      profileId,
      getChatId: () => chatId,
      ensure,
      toast: pushToast,
      registerCommand,
      storageOwner: 'card:' + cardId,
      syncLocalVars: (store) => useChatStore.getState().setLatestFloorVariables(store),
      triggerGenerate: (text) => useChatStore.getState().sendAction(profileId, text),
      isGenerating: () => useChatStore.getState().isGenerating
    })

  // Unregister this frame's slash commands when it unmounts.
  useEffect(() => {
    const cleanups = cmdCleanups.current
    return () => {
      cleanups.forEach((off) => off())
      cleanups.clear()
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
      } else if (d.__rpt) {
        handleRpc(String(d.method), Array.isArray(d.args) ? d.args : [])
          .then((result) => post({ __rptres: 1, id: d.id, ok: true, result }))
          .catch((err) =>
            post({ __rptres: 1, id: d.id, ok: false, error: err?.message || String(err) })
          )
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
    // handleRpc closes over current props; the effect re-binds when they change.
  }, [profileId, chatId, cardId, cardName])

  // Forward generation/chat lifecycle to scripts so reactive UIs can refresh.
  useEffect(() => {
    return useChatStore.subscribe((state, prev) => {
      if (state.isGenerating !== prev.isGenerating) {
        emit(state.isGenerating ? 'generation:start' : 'generation:end', {})
      }
      if (state.floors.length !== prev.floors.length) {
        emit('chat:changed', { floors: state.floors.length })
      }
      // A new floor landed — replay this turn's MVU variable changes to the scripts
      // (mag_* events) so MagVarUpdate front-end UIs refresh.
      if (state.floors.length > prev.floors.length) {
        const latest = state.floors[state.floors.length - 1]
        for (const ev of buildMvuEvents(latest?.variables)) emit(ev.name, ev.payload)
      }
    })
  }, [])

  // The right panel is reserved for game UI — render only the script-produced UI (the
  // sandboxed iframe), no management chrome. The master on/off toggle lives in the Scripts
  // (left) panel. Disabled, or nothing to run → render nothing here.
  if (!enabled || scriptCount === 0) return null

  return (
    <iframe
      ref={frameRef}
      className="rpt-script-frame"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      style={{ height: height || 1 }}
      title="card scripts"
    />
  )
}
