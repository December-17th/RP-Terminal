import { useChatStore } from '../stores/chatStore'
import { useT } from '../i18n'

/** Below the floor stage: the FSM scene switcher + the regenerate button. */
export function ChatToolbar({
  profileId,
  fsmEnabled,
  canRegenerate,
  onRegenerate
}: {
  profileId: string
  fsmEnabled: boolean
  canRegenerate: boolean
  onRegenerate: () => void
}): React.ReactElement {
  const activeChatMode = useChatStore((s) => s.activeChatMode)
  const isGenerating = useChatStore((s) => s.isGenerating)
  const setMode = useChatStore((s) => s.setMode)
  const t = useT()

  return (
    <div className="chat-toolbar">
      <div
        className={`mode-switch ${fsmEnabled ? '' : 'disabled'}`}
        role="tablist"
        aria-label={t('chat.sessionMode')}
      >
        {(['explore', 'dialogue', 'combat'] as const).map((m) => {
          const label = t('chat.mode' + m.charAt(0).toUpperCase() + m.slice(1))
          return (
            <button
              key={m}
              role="tab"
              aria-selected={activeChatMode === m}
              className={`mode-btn ${activeChatMode === m ? 'active' : ''}`}
              disabled={isGenerating || !fsmEnabled}
              title={
                fsmEnabled ? t('chat.switchToMode', { mode: label }) : t('chat.modeDisabledHint')
              }
              onClick={() => setMode(profileId, m)}
            >
              {label}
            </button>
          )
        })}
      </div>
      {canRegenerate && (
        <button
          className="btn-ghost"
          disabled={isGenerating}
          title={t('chat.regenerateTitle')}
          onClick={onRegenerate}
        >
          ↻ {t('chat.regenerate')}
        </button>
      )}
    </div>
  )
}
