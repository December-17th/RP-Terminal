import { useWorkflowPanelStore } from '../stores/workflowPanelStore'
import { useT } from '../i18n'

/**
 * Opt-in node output panels (workflow spec D4): a workflow node with `panel.show` surfaces its
 * completed output here as a labeled, collapsed-by-default section — the reasoning panel's
 * component family, generalized. Panels belong to the chat's latest turn (the store clears them
 * when the next turn starts), so they render under the streaming view and the settled last floor.
 */
export function NodePanels({ chatId }: { chatId: string }): React.ReactElement | null {
  const t = useT()
  const panels = useWorkflowPanelStore((s) => s.panels[chatId])
  if (!panels?.length) return null
  return (
    <>
      {panels.map((p) => (
        <details key={p.nodeId} className="reasoning-block">
          <summary className="reasoning-summary">{p.label || t('chat.nodePanel')}</summary>
          <div className="reasoning-content">{p.text}</div>
        </details>
      ))}
    </>
  )
}
