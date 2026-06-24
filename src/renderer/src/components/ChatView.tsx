import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '../stores/chatStore'
import { useCharacterStore } from '../stores/characterStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useRegexStore } from '../stores/regexStore'
import { StreamingView } from './StreamingView'
import { FloorBlock, type FloorMenuTarget } from './FloorBlock'
import { ChatToolbar } from './ChatToolbar'
import { ScriptActionsBar } from './ScriptActionsBar'
import { Composer } from './Composer'
import { ContextMenu } from './ContextMenu'
import { expandMacros } from '../../../shared/macros'
import {
  stripRptEvents,
  stripThinking,
  hasThinking,
  extractThinking
} from '../../../shared/responseView'
import { renderTemplate } from '../plugin/renderTemplate'

/**
 * The center column: the paginated floor stage, the mode/regenerate toolbar, the
 * script-actions menu, and the composer. Owns all chat-scoped UI state (pagination,
 * the pending user message, inline edit + its context menu); reads turn data + actions
 * from the chat store. The high-frequency streaming text is isolated in <StreamingView/>
 * so per-frame updates don't re-render the whole chat.
 */
export function ChatView({ profileId }: { profileId: string }): React.ReactElement {
  const {
    floors,
    isGenerating,
    error,
    activeChatId,
    sendAction,
    regenerate,
    stopGeneration,
    editFloor,
    swipe
  } = useChatStore(
    useShallow((s) => ({
      floors: s.floors,
      isGenerating: s.isGenerating,
      error: s.error,
      activeChatId: s.activeChatId,
      sendAction: s.sendAction,
      regenerate: s.regenerate,
      stopGeneration: s.stopGeneration,
      editFloor: s.editFloor,
      swipe: s.swipe
    }))
  )
  const activeCharacter = useCharacterStore((s) => s.activeCharacter)
  const settings = useSettingsStore((s) => s.settings)
  const regexRules = useRegexStore((s) => s.rules)

  const [pendingUserMsg, setPendingUserMsg] = useState('')
  const [editing, setEditing] = useState<{ floor: number; field: 'user' | 'response' } | null>(null)
  const [editText, setEditText] = useState('')
  const [menu, setMenu] = useState<FloorMenuTarget | null>(null)
  // Which floor (page) the chat history is showing — one floor at a time.
  const [viewIndex, setViewIndex] = useState(0)
  const viewportRef = useRef<HTMLDivElement>(null)

  // ST-PT [RENDER:*]: active render-marker templates for this session (evaluated per-message below).
  const [renderMarkers, setRenderMarkers] = useState<{ before: string[]; after: string[] }>({
    before: [],
    after: []
  })
  useEffect(() => {
    if (!activeChatId) return
    window.api
      .getRenderMarkers(profileId, activeChatId)
      .then(setRenderMarkers)
      .catch(() => setRenderMarkers({ before: [], after: [] }))
  }, [activeChatId, profileId])

  const cardCss = activeCharacter?.card.data.extensions?.rp_terminal?.css as string | undefined
  const personaName = settings?.persona?.name || 'User'
  const charName = activeCharacter?.card.data.name || 'Character'

  // Render-time transform of each stored response: EJS template eval (Phase C final pass, with this
  // floor's vars) → macros (TH-5) → display regex (beautification). The model's raw output stays
  // stored; this is display-only.
  const renderedFloors = useMemo(
    () =>
      floors.map((f) => {
        // Stored content is the FULL raw response. Strip only our own state tags here and KEEP the
        // <thinking> block so the card's display regex can fold/beautify it (if it doesn't, the reasoning
        // is moved to a dedicated expandable section below the prompt — see the regex handling below, not
        // stripped). The card's regex also folds its <UpdateVariable> blocks, so disabling it shows the
        // original — and nothing is ever truncated in storage.
        const evaled = renderTemplate(stripRptEvents(f.response.content), f.variables, 'final')
        // [RENDER:*]: wrap with the active render-marker templates (each evaled with this floor's vars).
        const renderOn =
          settings?.templates?.enabled !== false && settings?.templates?.render?.enabled !== false
        const wrap = (tmpls: string[]): string =>
          renderOn
            ? tmpls
                .map((t) => renderTemplate(t, f.variables, 'final'))
                .filter(Boolean)
                .join('\n\n')
            : ''
        const body = [wrap(renderMarkers.before), evaled, wrap(renderMarkers.after)]
          .filter(Boolean)
          .join('\n\n')
        const withMacros = expandMacros(body, {
          user: personaName,
          char: charName,
          vars: f.variables
        })
        const regexed = useRegexStore.getState().apply(withMacros, {
          user: personaName,
          char: charName
        })
        // If the card's display regex folded <thinking> (none remain), keep its inline beautified
        // block. Otherwise DON'T strip it away — pull the reasoning into a dedicated expandable section
        // (rendered under the player prompt in FloorBlock) and drop only the raw block from the body.
        const foldedByCard = !hasThinking(regexed)
        return {
          floor: f.floor,
          user: f.user_message.content,
          rawResponse: f.response.content,
          html: foldedByCard ? regexed : stripThinking(regexed),
          thinking: foldedByCard ? '' : extractThinking(f.response.content),
          swipeId: f.swipe_id ?? 0,
          swipeCount: f.swipes?.length ?? 1
        }
      }),
    [floors, regexRules, personaName, charName, settings?.templates, renderMarkers]
  )

  // Paginated floor view: jump to the newest floor when the floor set changes
  // (new turn, chat switch), and to the in-flight (streaming) page while generating.
  useEffect(() => {
    setViewIndex(Math.max(0, floors.length - 1))
  }, [floors.length, activeChatId])

  useEffect(() => {
    if (isGenerating) setViewIndex(floors.length)
  }, [isGenerating])

  // Reset scroll to the top of the floor when the visible page changes.
  useEffect(() => {
    viewportRef.current?.scrollTo({ top: 0 })
  }, [viewIndex])

  if (!activeChatId) {
    return (
      <div style={{ margin: 'auto', opacity: 0.5 }}>
        {activeCharacter ? 'Select or create a session.' : 'Select a character.'}
      </div>
    )
  }

  // One floor per page. While generating, an extra trailing page shows the live
  // streaming response. `viewIndex` is clamped here so it stays in range as the
  // floor count changes.
  const pageCount = renderedFloors.length + (isGenerating ? 1 : 0)
  const page = Math.min(Math.max(viewIndex, 0), Math.max(pageCount - 1, 0))
  const showStreaming = isGenerating && page >= renderedFloors.length
  const currentFloor = showStreaming ? undefined : renderedFloors[page]
  // The FSM scene switcher is active in 'manual'/'agentic' agent modes; 'off' greys it out.
  const fsmEnabled = settings?.agent?.mode === 'manual' || settings?.agent?.mode === 'agentic'
  const canRegenerate = floors.some((f) => f.user_message.content)

  const saveEdit = (): void => {
    if (editing) editFloor(profileId, editing.floor, editing.field, editText)
    setEditing(null)
  }

  const handleSend = (text: string): void => {
    setPendingUserMsg(text)
    sendAction(profileId, text)
  }

  const handleRegenerate = (): void => {
    const lastUser = [...floors].reverse().find((f) => f.user_message.content)
    setPendingUserMsg(lastUser?.user_message.content || '')
    regenerate(profileId)
  }

  return (
    <>
      <div className="floor-stage">
        <div className="floor-viewport" ref={viewportRef}>
          {showStreaming ? (
            <StreamingView pendingUserMsg={pendingUserMsg} />
          ) : currentFloor ? (
            <FloorBlock
              f={currentFloor}
              cardCss={cardCss}
              editing={editing}
              editText={editText}
              isLast={page === renderedFloors.length - 1}
              isGenerating={isGenerating}
              onEditTextChange={setEditText}
              onSaveEdit={saveEdit}
              onCancelEdit={() => setEditing(null)}
              onOpenMenu={setMenu}
              onSwipe={(dir) => swipe(profileId, currentFloor.floor, dir)}
            />
          ) : (
            <div className="floor-empty">No messages yet.</div>
          )}
          {error && (
            <div className="floor-block" style={{ borderColor: '#e74c3c', color: '#e74c3c' }}>
              Error: {error}
            </div>
          )}
        </div>
        {pageCount > 0 && (
          <>
            <button
              className="pager-btn pager-prev"
              title="Previous floor"
              disabled={page <= 0}
              onClick={() => setViewIndex(Math.max(0, page - 1))}
            >
              ↩
            </button>
            <span className="floor-pageinfo">
              [{page + 1}/{pageCount}]
            </span>
            <button
              className="pager-btn pager-next"
              title="Next floor"
              disabled={page >= pageCount - 1}
              onClick={() => setViewIndex(Math.min(pageCount - 1, page + 1))}
            >
              ↪
            </button>
          </>
        )}
      </div>

      <ChatToolbar
        profileId={profileId}
        fsmEnabled={fsmEnabled}
        canRegenerate={canRegenerate}
        onRegenerate={handleRegenerate}
      />

      <ScriptActionsBar />

      <Composer isGenerating={isGenerating} onSendMessage={handleSend} onStop={stopGeneration} />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: '✎ Edit message',
              onClick: () => {
                setEditing({ floor: menu.floor, field: menu.field })
                setEditText(menu.value)
              }
            }
          ]}
        />
      )}
    </>
  )
}
