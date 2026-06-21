import { useEffect, useMemo, useRef, useState } from 'react'
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
  'regex:read'
])

export function MessageScriptFrame({ html }: { html: string }): React.ReactElement | null {
  const profileId = useProfileStore((s) => s.activeProfile?.id ?? null)
  const chatId = useChatStore((s) => s.activeChatId)
  const cardId = useCharacterStore((s) => s.activeCharacter?.id ?? null)

  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(80)
  const srcDoc = useMemo(() => buildMessageHtmlDoc(html, { allowRemote: false }), [html])

  const post = (msg: unknown): void => frameRef.current?.contentWindow?.postMessage(msg, '*')
  const emit = (name: string, payload: unknown): void => post({ __rptevent: 1, name, payload })
  const streamAccum = useRef('')

  const handleRpc = (method: string, args: unknown[]): Promise<unknown> =>
    dispatchRpc(method, args, {
      profileId: profileId || '',
      getChatId: () => chatId,
      cardId: cardId || undefined,
      ensure: async (perm: string) => ALLOWED_CAPS.has(perm),
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
  return (
    <iframe
      ref={frameRef}
      className="card-frame"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      style={{ width: '100%', height, border: 0, display: 'block' }}
      title="message script"
    />
  )
}
