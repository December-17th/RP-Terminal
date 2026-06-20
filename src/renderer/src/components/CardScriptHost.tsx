import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../stores/chatStore'
import { buildScriptSrcDoc, CardScript } from '../plugin/bridgeShim'

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

interface Toast {
  id: number
  msg: string
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
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastSeq = useRef(0)

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

  const pushToast = (msg: string): void => {
    const id = ++toastSeq.current
    setToasts((t) => [...t, { id, msg }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200)
  }

  // Dispatch one permission-checked RPC from a script. Throws → reported to the
  // script as a rejected promise.
  const handleRpc = async (method: string, args: any[]): Promise<any> => {
    switch (method) {
      case 'vars': {
        const res = await window.api.pluginVars(profileId, chatId, args[0])
        // Keep the status-panel widgets in sync with local-var writes.
        if (res && res.scope === 'local') {
          useChatStore.getState().setLatestFloorVariables(res.store)
        }
        return res ? res.value : undefined
      }
      case 'chat.getMessages':
        return window.api.pluginGetMessages(profileId, chatId)
      case 'chat.getLastMessage': {
        const msgs = await window.api.pluginGetMessages(profileId, chatId)
        return msgs.length ? msgs[msgs.length - 1].response : ''
      }
      case 'generate':
        return doGenerate(String(args[0] ?? ''))
      case 'ui.toast':
        pushToast(String(args[0] ?? ''))
        return true
      default:
        throw new Error('unknown method: ' + method)
    }
  }

  // `generate` is a sensitive capability — prompt once per card, then remember.
  const doGenerate = async (text: string): Promise<boolean> => {
    if (useChatStore.getState().isGenerating) {
      throw new Error('busy: a generation is already running')
    }
    if (!grantsRef.current.generate) {
      const ok = window.confirm(
        `The scripts in "${cardName}" want to trigger an AI generation:\n\n` +
          `"${text.slice(0, 200)}${text.length > 200 ? '…' : ''}"\n\n` +
          `Allow card scripts to start generations? (You can change this later.)`
      )
      if (!ok) throw new Error('permission denied: generate')
      grantsRef.current = await window.api.pluginSetGrants(profileId, cardId, { generate: true })
    }
    await useChatStore.getState().sendAction(profileId, text)
    return true
  }

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

      {toasts.length > 0 && (
        <div className="rpt-toast-stack">
          {toasts.map((t) => (
            <div key={t.id} className="rpt-toast">
              {t.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
