import React, { useState } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useT } from '../../i18n'
import './workflowEditor.css'

// The composed-prompt PREVIEW for the two plot-recall planner nodes (memory.recall, notes.maintain),
// mirroring MemoryMaintainPanel's MemoryPreview: an on-demand button composes EXACTLY what a run would
// send for the active chat — via the same exported cores the node's run() uses — so the planner prompt
// is visible in the editor BEFORE a model call is burned. One parameterized component, styled with the
// shared rpt-mm-preview classes so it matches the memory.maintain preview.

interface PreviewMessage {
  role: string
  content: string
}

type PreviewKind = 'recall' | 'notes'

/** Per-kind wiring: the preload preview method + the localized-string namespace. */
const KINDS: Record<PreviewKind, { i18n: string }> = {
  recall: { i18n: 'workflowEditor.recallPreview' },
  notes: { i18n: 'workflowEditor.notesPreview' }
}

export default function PromptPreviewPanel({
  profileId,
  config,
  kind
}: {
  profileId: string
  /** The node's current config — passed to the preview so it matches what a run would send. */
  config: Record<string, unknown>
  kind: PreviewKind
}): React.JSX.Element | null {
  const t = useT()
  const activeChatId = useChatStore((s) => s.activeChatId)
  const [messages, setMessages] = useState<PreviewMessage[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!activeChatId) {
    return <div className="rpt-mm-note">{t('workflowEditor.memoryMaintain.noChat')}</div>
  }

  const ns = KINDS[kind].i18n

  const run = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const res =
        kind === 'recall'
          ? await window.api.previewRecallPlanner(profileId, activeChatId, config)
          : await window.api.previewNotesMaintain(profileId, activeChatId, config)
      if (res.error || !res.messages) {
        setError(t(`${ns}.error`))
        setMessages(null)
      } else {
        setMessages(res.messages)
      }
    } catch {
      setError(t(`${ns}.error`))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rpt-mm rpt-mm-preview">
      <div className="rpt-mm-section-title">{t(`${ns}.title`)}</div>
      <button
        type="button"
        className="rpt-mm-preview-btn"
        onClick={() => void run()}
        disabled={loading}
      >
        {loading ? t(`${ns}.loading`) : t(`${ns}.button`)}
      </button>
      {error && <div className="rpt-mm-error">{error}</div>}
      {messages &&
        messages.map((m, i) => (
          <div key={i} className="rpt-mm-preview-msg">
            <span className="rpt-mm-preview-role">{m.role}</span>
            <pre className="rpt-assemble-preview-text">{m.content}</pre>
          </div>
        ))}
    </div>
  )
}
