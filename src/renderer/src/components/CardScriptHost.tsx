import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useToastStore } from '../stores/toastStore'
import { buildScriptSrcDoc, CardScript } from '../plugin/bridgeShim'
import { dispatchRpc } from '../plugin/dispatch'

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
  const [enabled, setEnabled] = useState(true)
  const [height, setHeight] = useState(0)

  const srcDoc = useMemo(() => buildScriptSrcDoc(scripts), [scripts])

  // Load persisted grants (enable state + sensitive caps) for this card.
  useEffect(() => {
    let alive = true
    window.api.pluginGetGrants(profileId, cardId).then((g: Grants) => {
      if (!alive) return
      grantsRef.current = g || {}
      setEnabled(g?.enabled !== false)
    })
    return () => {
      alive = false
    }
  }, [profileId, cardId])

  const post = (msg: any): void => {
    frameRef.current?.contentWindow?.postMessage(msg, '*')
  }
  const emit = (name: string, payload: any): void => {
    post({ __rptevent: 1, name, payload })
  }

  const pushToast = (msg: string): void => useToastStore.getState().push(msg)

  // Card scripts auto-grant low-risk caps; `generate` prompts once per card.
  const ensure = async (perm: string): Promise<boolean> => {
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
  const handleRpc = (method: string, args: any[]): Promise<any> =>
    dispatchRpc(method, args, {
      profileId,
      getChatId: () => chatId,
      ensure,
      toast: pushToast,
      syncLocalVars: (store) => useChatStore.getState().setLatestFloorVariables(store),
      triggerGenerate: (text) => useChatStore.getState().sendAction(profileId, text),
      isGenerating: () => useChatStore.getState().isGenerating
    })

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
    })
  }, [])

  const toggleEnabled = (): void => {
    const next = !enabled
    setEnabled(next)
    setHeight(0)
    window.api.pluginSetGrants(profileId, cardId, { enabled: next }).then((g: Grants) => {
      grantsRef.current = g || {}
    })
  }

  return (
    <div className="rpt-script-panel">
      <div className="rpt-script-head">
        <span className="rpt-script-title">
          ⚙ Card Scripts <span className="rpt-script-count">{scripts.length}</span>
        </span>
        <button
          className={`rpt-script-toggle ${enabled ? 'on' : ''}`}
          title={enabled ? 'Disable this card’s scripts' : 'Enable this card’s scripts'}
          onClick={toggleEnabled}
        >
          {enabled ? 'On' : 'Off'}
        </button>
      </div>

      {enabled ? (
        <iframe
          ref={frameRef}
          className="rpt-script-frame"
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          style={{ height: height || 1 }}
          title="card scripts"
        />
      ) : (
        <div className="rpt-script-off">Scripts disabled.</div>
      )}
    </div>
  )
}
