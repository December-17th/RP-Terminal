import { useChatStore } from '../stores/chatStore'
import { useT } from '../i18n'

/** Below the floor stage: the regenerate + manage-floors buttons. */
export function ChatToolbar({
  canRegenerate,
  onRegenerate,
  onManageFloors
}: {
  canRegenerate: boolean
  onRegenerate: () => void
  onManageFloors?: () => void
}): React.ReactElement {
  const isGenerating = useChatStore((s) => s.isGenerating)
  const t = useT()

  return (
    <div className="chat-toolbar">
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
      {onManageFloors && (
        <button
          className="btn-ghost"
          disabled={isGenerating}
          title={t('floors.title')}
          onClick={onManageFloors}
        >
          ☰ {t('floors.button')}
        </button>
      )}
    </div>
  )
}
