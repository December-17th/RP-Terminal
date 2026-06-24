import { useChatStore } from '../stores/chatStore'

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

  return (
    <div className="chat-toolbar">
      <div
        className={`mode-switch ${fsmEnabled ? '' : 'disabled'}`}
        role="tablist"
        aria-label="Session mode"
      >
        {(['explore', 'dialogue', 'combat'] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={activeChatMode === m}
            className={`mode-btn ${activeChatMode === m ? 'active' : ''}`}
            disabled={isGenerating || !fsmEnabled}
            title={
              fsmEnabled
                ? `Switch to ${m} mode`
                : 'Set Agent Mode to Manual or Agentic in Preferences to switch scenes'
            }
            onClick={() => setMode(profileId, m)}
          >
            {m[0].toUpperCase() + m.slice(1)}
          </button>
        ))}
      </div>
      {canRegenerate && (
        <button
          className="btn-ghost"
          disabled={isGenerating}
          title="Re-roll the last response"
          onClick={onRegenerate}
        >
          ↻ Regenerate
        </button>
      )}
    </div>
  )
}
