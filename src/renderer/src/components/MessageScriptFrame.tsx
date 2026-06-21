import { useEffect, useRef, useState } from 'react'
import { useProfileStore } from '../stores/profileStore'
import { useChatStore } from '../stores/chatStore'
import { useCharacterStore } from '../stores/characterStore'
import { useToastStore } from '../stores/toastStore'
import { buildMessageHtmlDoc } from '../plugin/bridgeShim'
import { dispatchRpc } from '../plugin/dispatch'
import { buildMvuEvents } from '../plugin/mvuEvents'
import { chatTransitionEvents, messageMutationEvents, TAVERN_EVENTS } from '../plugin/events'

/**
 * TH-6 — an interactive HTML block embedded in a chat message ("frontend card"). The
 * model-authored markup + its <script> tags run in the SAME opaque-origin,
 * no-`allow-same-origin` sandbox as card scripts (via buildMessageHtmlDoc + the rpt API),
 * but at LEAST privilege: message HTML is less trusted than card scripts, so only safe
 * read/display caps are granted (no generate / net / chat:write / worldbook:write / slash),
 * and network stays off. The runtime events (TH-1/2) are forwarded so the UI stays reactive.
 */

// The only capabilities a model-authored message UI may use.
const ALLOWED_CAPS = new Set([
  'vars:read',
  'vars:write',
  'chat:read',
  'ui:toast',
  'card:read',
  'worldbook:read',
  'preset:read',
  'regex:read',
  // Remote text fetch for .load() frontend cards — re-gated by the world grant in main.
  'remote:fetch'
])

export function MessageScriptFrame({ html }: { html: string }): React.ReactElement | null {
  const profileId = useProfileStore((s) => s.activeProfile?.id ?? null)
  const chatId = useChatStore((s) => s.activeChatId)
  const cardId = useCharacterStore((s) => s.activeCharacter?.id ?? null)

  const frameRef = useRef<HTMLIFrameElement>(null)
  // A generous default so full-page frontend cards (Vue apps sized to 100vh, which can't
  // grow a content-driven scrollHeight) are usable; the ResizeObserver shrinks/grows it
  // to real content for non-full-page blocks.
  const [height, setHeight] = useState(560)
  const [srcDoc, setSrcDoc] = useState('')
  // Frontend cards run arbitrary (card-author + CDN) UI code in a same-process iframe — a
  // buggy one (e.g. an ST card looping without the ST runtime) can freeze the whole app.
  // So don't auto-run: opening a session stays responsive; the user clicks to run the UI.
  const [running, setRunning] = useState(false)
  // A trusted world's frontend cards run same-origin (native ES-module imports / ST-style
  // runtime), at the cost of full app access — only for a world whose card the user trusts.
  const [trusted, setTrusted] = useState(false)
  const trustedRef = useRef(false)
  trustedRef.current = trusted

  // Build the sandbox doc once the world's grants are known. A frontend card that pulls a
  // remote UI prompts once for FULL TRUST (per-world): granting runs it same-origin so it
  // works natively. Declining leaves it sandboxed (network only if previously granted).
  useEffect(() => {
    if (!profileId || !running) return
    let alive = true
    ;(async () => {
      const wantsRemote = /https?:\/\//i.test(html)
      let trust = false
      let allow = false
      if (cardId) {
        const g = await window.api.pluginGetGrants(profileId, cardId)
        trust = g?.trusted === true
        allow = trust || g?.remoteScripts === true
        if (!trust && wantsRemote) {
          const ok = window.confirm(
            'A UI embedded in this message needs FULL TRUST to run — a native (same-origin) ' +
              'runtime, the way SillyTavern frontend cards work.\n\n' +
              "Grant this ONLY for a world whose card you made or trust: a trusted world's code " +
              'can read app data, including your API keys.\n\n' +
              'Trust this world and run its UI natively?'
          )
          if (ok) {
            await window.api.pluginSetGrants(profileId, cardId, { trusted: true, remoteScripts: true })
            trust = true
            allow = true
          }
        }
      }
      if (wantsRemote && !allow) {
        window.api.pluginLog(
          'message-html',
          cardId
            ? 'frontend card blocked — full trust declined for this world (re-render to be re-prompted)'
            : 'frontend card blocked — no active world to attach the trust grant to'
        )
      }
      window.api.pluginLog(
        'message-html',
        `frame built: trusted=${trust}, allowRemote=${allow} (cardId=${cardId ?? 'none'})`
      )
      if (!alive) return
      setTrusted(trust)
      setSrcDoc(buildMessageHtmlDoc(html, { allowRemote: allow, trusted: trust }))
    })()
    return () => {
      alive = false
    }
  }, [html, profileId, cardId, running])

  const post = (msg: unknown): void => frameRef.current?.contentWindow?.postMessage(msg, '*')
  const emit = (name: string, payload: unknown): void => post({ __rptevent: 1, name, payload })
  const streamAccum = useRef('')

  const handleRpc = (method: string, args: unknown[]): Promise<unknown> =>
    dispatchRpc(method, args, {
      profileId: profileId || '',
      getChatId: () => chatId,
      cardId: cardId || undefined,
      // A trusted (same-origin) frame already has full app access, so its rpt calls are
      // unrestricted; an untrusted frame is limited to the safe read/display caps.
      ensure: async (perm: string) => trustedRef.current || ALLOWED_CAPS.has(perm),
      toast: (m) => useToastStore.getState().push(m),
      syncLocalVars: (store) => useChatStore.getState().setLatestFloorVariables(store),
      triggerGenerate: async () => {
        throw new Error('generation is not allowed from message HTML')
      },
      isGenerating: () => useChatStore.getState().isGenerating,
      storageOwner: 'message:' + (cardId || 'unknown')
    })
  const handleRpcRef = useRef(handleRpc)
  handleRpcRef.current = handleRpc

  // RPC + lifecycle messages from the sandboxed frame.
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== frameRef.current?.contentWindow) return
      const d = e.data
      if (!d || typeof d !== 'object') return
      if (d.__rptresize) {
        setHeight(Math.min(Math.max(0, Number(d.height) || 0), 1200))
      } else if (d.__rptlog) {
        window.api.pluginLog('message-html', String(d.msg))
      } else if (d.__rptready) {
        emit(TAVERN_EVENTS.CHAT_CHANGED, { chatId })
        // Seed the current MVU state so a freshly mounted front-end paints immediately.
        const floors = useChatStore.getState().floors
        for (const ev of buildMvuEvents(floors[floors.length - 1]?.variables)) emit(ev.name, ev.payload)
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
  }, [chatId, cardId, profileId])

  // Forward runtime events (TH-1/2 + mag_*) so the embedded UI stays reactive.
  useEffect(() => {
    return useChatStore.subscribe((state, prev) => {
      for (const ev of chatTransitionEvents(
        { isGenerating: prev.isGenerating, floorCount: prev.floors.length },
        { isGenerating: state.isGenerating, floorCount: state.floors.length }
      )) {
        if (ev.name === TAVERN_EVENTS.GENERATION_STARTED) streamAccum.current = ''
        emit(ev.name, ev.payload)
      }
      const desc = (f: { floor: number; response: { content: string }; swipe_id?: number }) => ({
        floor: f.floor,
        content: f.response.content,
        swipeId: f.swipe_id ?? 0
      })
      for (const ev of messageMutationEvents(prev.floors.map(desc), state.floors.map(desc))) {
        emit(ev.name, ev.payload)
      }
      if (state.floors.length > prev.floors.length) {
        for (const ev of buildMvuEvents(state.floors[state.floors.length - 1]?.variables)) {
          emit(ev.name, ev.payload)
        }
      }
    })
  }, [])

  useEffect(() => {
    return window.api.onGenerationDelta(({ chatId: cid, delta }) => {
      if (cid !== chatId) return
      streamAccum.current += delta
      emit(TAVERN_EVENTS.STREAM_TOKEN_RECEIVED, streamAccum.current)
    })
  }, [chatId])

  if (!profileId) return null
  // Until the user opts in, show a lightweight gate instead of auto-running the UI.
  if (!running) {
    return (
      <div className="message-card-gate">
        <span className="message-card-gate-label">⛶ Interactive UI in this message</span>
        <button className="btn-accent" onClick={() => setRunning(true)}>
          ▶ Run
        </button>
        <span className="message-card-gate-note">
          runs the card&apos;s own UI code (may request Full Trust)
        </span>
      </div>
    )
  }
  return (
    <iframe
      ref={frameRef}
      className="card-frame"
      // Trusted worlds run same-origin (native runtime, full access); otherwise the opaque
      // sandbox. allow-same-origin + allow-scripts is intentional here — it IS the trust grant.
      sandbox={trusted ? 'allow-scripts allow-same-origin' : 'allow-scripts'}
      srcDoc={srcDoc}
      style={{ width: '100%', height, border: 0, display: 'block' }}
      title="message script"
    />
  )
}
