import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '../stores/chatStore'
import { useCharacterStore } from '../stores/characterStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useRegexStore } from '../stores/regexStore'
import { StreamingView } from './StreamingView'
import { NodePanels } from './NodePanels'
import { FloorBlock, type FloorMenuTarget, type RenderedFloor } from './FloorBlock'
import { ChatToolbar } from './ChatToolbar'
import { ScriptActionsBar } from './ScriptActionsBar'
import { Composer } from './Composer'
import { ContextMenu } from './ContextMenu'
import { FloorManagerModal } from './FloorManagerModal'
import { expandMacros } from '../../../shared/macros'
import { stripRptEvents, stripThinking, extractThinking } from '../../../shared/responseView'
import { renderTemplate } from '../plugin/renderTemplate'
import { useUiStore } from '../stores/uiStore'
import { useAgentFailureStore } from '../stores/agentFailureStore'
import {
  useRecallFailOpenStore,
  shouldShowRecallBanner
} from '../stores/recallFailOpenStore'
import {
  useAgentActivityStore,
  currentActivityLabelKey
} from '../stores/agentActivityStore'
import { useT } from '../i18n'
import { AgentRunActivity } from './AgentRunActivity'

// Local copy of the workflow editors' `inEditable` shape (do NOT import across modules): true when
// focus is inside a text-entry element, so keyboard paging never fires while typing in the composer.
const inEditable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable)

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
  const activeChatMode = useChatStore((s) => s.activeChatMode)
  const duelPopupOpen = useUiStore((s) => s.duelPopupOpen)
  const openDuelPopup = useUiStore((s) => s.openDuelPopup)
  const settings = useSettingsStore((s) => s.settings)
  const regexRules = useRegexStore((s) => s.rules)
  // Last headless-agent failure for THIS chat (App records it off the workflow-trace flow) — shown as
  // a dismissible banner above the composer so a silent background-agent failure is never missed.
  const agentFailure = useAgentFailureStore((s) => (activeChatId ? s.failures[activeChatId] : undefined))
  const clearAgentFailure = useAgentFailureStore((s) => s.clear)
  // Plot-recall (A3): consecutive pre-turn recall fail-opens for THIS chat (App tallies them off the
  // workflow-trace flow). After the threshold, warn that turns are silently running without memory.
  const recallStreak = useRecallFailOpenStore((s) => (activeChatId ? s.counts[activeChatId] ?? 0 : 0))
  const recallDismissed = useRecallFailOpenStore((s) =>
    activeChatId ? !!s.dismissed[activeChatId] : false
  )
  const dismissRecall = useRecallFailOpenStore((s) => s.dismiss)
  const showRecallBanner = !!activeChatId && shouldShowRecallBanner(recallStreak, recallDismissed)
  // Post-phase side-agent (memory.maintain / notes.maintain / agent.llm): background LLM work that runs
  // AFTER the reply is already shown, so a quieter status chip (above the toolbar) — not a blocking ghost.
  const postActivityKey = useAgentActivityStore((s) =>
    activeChatId ? currentActivityLabelKey(s.active, activeChatId, 'post') : null
  )

  const [pendingUserMsg, setPendingUserMsg] = useState('')
  const [editing, setEditing] = useState<{ floor: number; field: 'user' | 'response' } | null>(null)
  const [editText, setEditText] = useState('')
  const [menu, setMenu] = useState<FloorMenuTarget | null>(null)
  const [floorsOpen, setFloorsOpen] = useState(false)
  // Which floor (page) the chat history is showing — one floor at a time.
  const [viewIndex, setViewIndex] = useState(0)
  // Jump-to-floor: when open, the page indicator swaps for a number input.
  const [jumpOpen, setJumpOpen] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const t = useT()

  // ST-PT [RENDER:*]: active render-marker templates for this session (evaluated per-message below).
  const [renderMarkers, setRenderMarkers] = useState<{ before: string[]; after: string[] }>({
    before: [],
    after: []
  })
  useEffect(() => {
    if (!activeChatId) return
    // Bail out when the fetched markers EQUAL the current state (returning prev skips the
    // re-render): the display-transform memo below deps on this object, and a fresh-but-equal
    // object would re-run the whole per-floor pipeline (quickjs eval + display regex — seconds
    // on a heavy beautification card) for nothing on every session load.
    const same = (a: string[], b: string[]): boolean =>
      a.length === b.length && a.every((s, i) => s === b[i])
    const update = (next: { before: string[]; after: string[] }): void =>
      setRenderMarkers((prev) =>
        same(prev.before, next.before) && same(prev.after, next.after) ? prev : next
      )
    window.api
      .getRenderMarkers(profileId, activeChatId)
      .then(update)
      .catch(() => update({ before: [], after: [] }))
  }, [activeChatId, profileId])

  const cardCss = activeCharacter?.card.data.extensions?.rp_terminal?.css as string | undefined
  const reasoningTemplate = activeCharacter?.card.data.extensions?.rp_terminal
    ?.reasoning_template as string | undefined
  const personaName = settings?.persona?.name || 'User'
  const charName = activeCharacter?.card.data.name || 'Character'

  // The floor stage paginates — exactly ONE floor is visible at a time (or the streaming page while
  // generating). So derive the page geometry from `floors.length` (the transform below is 1:1 with
  // floors, so its length always equals floors.length).
  const pageCount = floors.length + (isGenerating ? 1 : 0)
  const page = Math.min(Math.max(viewIndex, 0), Math.max(pageCount - 1, 0))
  const showStreaming = isGenerating && page >= floors.length

  // The settings the transform actually reads, as primitives — the memo deps on these VALUES, not
  // on the `settings.templates` object, whose identity churns on every settings (re)load without
  // its values changing (each churn would re-run the whole transform). Kept as THREE separate
  // booleans because renderTemplate treats them differently (master off → strip tags; render-time
  // off → raw text) — collapsing them into one flag would miss a master toggle while render-time
  // is off (review finding on PR #60).
  const templatesOn = settings?.templates?.enabled !== false
  const renderEnabled = settings?.templates?.render?.enabled !== false
  const finalPassOn = settings?.templates?.render?.final_pass !== false

  // The one visible floor (undefined while the streaming page is showing). Extracted so the memo
  // deps on THIS floor, not the whole floors array.
  const visibleFloor = showStreaming ? undefined : floors[page]

  // Render-time transform of the VISIBLE floor only: EJS template eval (Phase C final pass, with this
  // floor's vars) → macros (TH-5) → display regex (beautification). The model's raw output stays
  // stored; this is display-only. Transforming just `floors[page]` (not every floor) is the load-perf
  // fix: `renderTemplate` runs a synchronous quickjs eval (~1ms) for any body/[RENDER:*] marker that
  // contains `<%`, so mapping it over the whole history froze the main thread for seconds when a long
  // session was opened (cost was O(history)). Per-page it's O(1) in history length; useMemo caches so
  // unrelated re-renders (typing, opening a menu) don't re-eval, and paging re-evals only the newly
  // visible floor. Regex depth-scoping is disabled on this path (display rules are pre-filtered), so a
  // floor transforms identically in isolation as it did inside the old full-history map.
  // PERF INVARIANT: the dep list must stay VALUE-stable across a session load — a heavy display
  // regex (e.g. a workshop beautification pasting ~165KB HTML per match) makes each recompute cost
  // seconds, so an identity-churning dep multiplies a one-time cost into minutes (manual-pass
  // finding 05). No object-identity deps except the floor itself, the loaded rule set, and the
  // (bail-out-guarded) renderMarkers.
  const currentFloor = useMemo<RenderedFloor | undefined>(() => {
    const f = visibleFloor
    if (!f) return undefined
    // Stored content is the FULL raw response. Strip our own state tags; the <thinking> block is
    // kept here only so renderTemplate/macros see the same text — it's removed before the display
    // regex (below) and routed to the ReasoningPanel, so a card regex can NEVER rewrite reasoning
    // into inline UI. The regex still folds the card's <UpdateVariable> blocks in the body, and
    // nothing is ever truncated in storage.
    const evaled = renderTemplate(stripRptEvents(f.response.content), f.variables, 'final')
    // [RENDER:*]: wrap with the active render-marker templates (each evaled with this floor's vars).
    const wrap = (tmpls: string[]): string =>
      templatesOn && renderEnabled
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
    // The display regex applies to the BODY ONLY — reasoning (<thinking>) is owned by the
    // ReasoningPanel and must never be rewritten into inline UI by a card regex. So strip the
    // reasoning out before the regex runs and route it to the panel via `thinking`.
    const applyRegex = (t: string): string =>
      useRegexStore.getState().apply(t, { user: personaName, char: charName })
    return {
      floor: f.floor,
      user: f.user_message.content,
      rawResponse: f.response.content,
      html: applyRegex(stripThinking(withMacros)),
      // Reasoning display regex (ST placement 6) transforms the <think> text for the ReasoningPanel.
      thinking: useRegexStore
        .getState()
        .applyReasoning(extractThinking(f.response.content), {
          user: personaName,
          char: charName
        }),
      // Plot-recall: pass the STORED plot_block through verbatim (display-only; PlotPanel applies the
      // placement-1 beautification regex + routes the html itself). Not derived from response.content.
      plotBlock: f.plot_block,
      swipeId: f.swipe_id ?? 0,
      swipeCount: f.swipes?.length ?? 1
    }
    // `regexRules` and `finalPassOn` are deliberate "extra" deps: the memo body reads the rules
    // via useRegexStore.getState() and renderTemplate('final') reads final_pass from the settings
    // store, so a change in either must re-run the transform though neither is referenced directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store-read inputs, see comment above
  }, [
    visibleFloor,
    regexRules,
    personaName,
    charName,
    templatesOn,
    renderEnabled,
    finalPassOn,
    renderMarkers
  ])

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

  // Keyboard paging: ArrowLeft/ArrowRight page the floor stage, but only when no conflicting UI
  // state owns the keyboard (inline edit, context menu, floors modal) and focus is not in a
  // text-entry element (so composer typing never pages). Modifier keys are left to the browser.
  useEffect(() => {
    if (pageCount === 0) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (editing || menu || floorsOpen) return
      if (inEditable(e.target) || e.ctrlKey || e.altKey || e.metaKey) return
      if (e.key === 'ArrowLeft') {
        setViewIndex(Math.max(0, page - 1))
        e.preventDefault()
      } else if (e.key === 'ArrowRight') {
        setViewIndex(Math.min(pageCount - 1, page + 1))
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [page, pageCount, editing, menu, floorsOpen])

  if (!activeChatId) {
    return (
      <div style={{ margin: 'auto', opacity: 0.5 }}>
        {activeCharacter ? t('chat.selectSession') : t('chat.selectCharacter')}
      </div>
    )
  }

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

  // Combat (Track Combat / P7): when the latest turn carried a combat-start cue and we're
  // not already in combat, offer to spin up the encounter from the world's combat bundle.
  const latestVars = floors.length ? floors[floors.length - 1]?.variables : undefined
  const combatCue =
    latestVars && typeof latestVars.combat_cue === 'object' && latestVars.combat_cue
      ? (latestVars.combat_cue as { enemies?: string; map?: string; roster?: unknown; mode?: 'grid' | 'duel' })
      : null
  const enterCombat = async (): Promise<void> => {
    if (!activeChatId) return
    try {
      if (combatCue?.mode === 'duel') {
        await window.api.duelStartFromCue(profileId, activeChatId, combatCue)
        // Duel mode is renderer-transient by convention — main's persisted ChatMode has no 'duel'
        // (types/chat CHAT_MODES), so the persisting setMode → setChatMode would COERCE 'duel' to
        // 'explore' and its chat-mode-changed broadcast would slam the mode back, closing the popup
        // a split-second after it opens. Mirror the tool-node path (toolNodes.toolStartDuel): flip
        // the renderer mode directly, no DB write.
        useChatStore.setState({ activeChatMode: 'duel' })
      } else {
        await window.api.combatStartFromCard(profileId, activeChatId, combatCue)
        useChatStore.getState().setMode(profileId, 'combat')
      }
    } catch (e) {
      // A genuine failure (bad roster, build error) shouldn't be silent — surface it so a blank
      // CombatView is diagnosable. (A world with no combat bundle just throws here harmlessly.)
      console.error('Enter combat/duel failed:', e)
    }
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
              reasoningTemplate={reasoningTemplate}
              editing={editing}
              editText={editText}
              isLast={page === floors.length - 1}
              isGenerating={isGenerating}
              onEditTextChange={setEditText}
              onSaveEdit={saveEdit}
              onCancelEdit={() => setEditing(null)}
              onOpenMenu={setMenu}
              onSwipe={(dir) => swipe(profileId, currentFloor.floor, dir)}
            />
          ) : (
            <div className="floor-empty">{t('chat.noMessages')}</div>
          )}
          {activeChatId && (showStreaming || page === floors.length - 1) && (
            <NodePanels chatId={activeChatId} />
          )}
          {error && (
            <div
              className="floor-block"
              style={{ borderColor: 'var(--rpt-danger)', color: 'var(--rpt-danger)' }}
            >
              {t('chat.errorPrefix')}
              {error}
            </div>
          )}
        </div>
        {pageCount > 0 && (
          <>
            <button
              className="pager-btn pager-prev"
              title={t('chat.prevFloor')}
              disabled={page <= 0}
              onClick={() => setViewIndex(Math.max(0, page - 1))}
            >
              ↩
            </button>
            {jumpOpen ? (
              <input
                className="floor-pagejump"
                type="number"
                min={1}
                max={pageCount}
                autoFocus
                defaultValue={page + 1}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const n = Number((e.target as HTMLInputElement).value)
                    if (Number.isFinite(n)) {
                      setViewIndex(Math.min(pageCount - 1, Math.max(1, n) - 1))
                    }
                    setJumpOpen(false)
                  } else if (e.key === 'Escape') {
                    setJumpOpen(false)
                  }
                }}
                onBlur={() => setJumpOpen(false)}
              />
            ) : (
              <button
                className="floor-pageinfo"
                title={t('chat.jumpToFloor')}
                onClick={() => setJumpOpen(true)}
              >
                [{page + 1}/{pageCount}]
              </button>
            )}
            <button
              className="pager-btn pager-next"
              title={t('chat.nextFloor')}
              disabled={page >= pageCount - 1}
              onClick={() => setViewIndex(Math.min(pageCount - 1, page + 1))}
            >
              ↪
            </button>
          </>
        )}
      </div>

      {combatCue && activeChatMode !== 'combat' && activeChatMode !== 'duel' ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            padding: '6px 10px',
            margin: '6px 0',
            borderRadius: 6,
            border: '1px solid var(--rpt-accent, #5b8def)',
            background: 'var(--rpt-accent-soft, rgba(91,141,239,0.12))',
            fontSize: 13
          }}
        >
          <span>{t('combat.cueDetected')}</span>
          <button className="btn-accent" style={{ fontSize: 12 }} onClick={enterCombat}>
            ⚔ {combatCue.mode === 'duel' ? t('combat.enterDuel') : t('combat.enter')}
          </button>
        </div>
      ) : null}

      {/* A duel is live but its popup was dismissed — offer to bring it back (the popup floats over
          chat, so the underlying chat stays interactive while a duel runs). */}
      {activeChatMode === 'duel' && !duelPopupOpen ? (
        <div style={{ display: 'flex', justifyContent: 'center', margin: '6px 0' }}>
          <button className="btn-accent" style={{ fontSize: 12 }} onClick={() => openDuelPopup()}>
            ⚔ {t('duel.reopen')}
          </button>
        </div>
      ) : null}

      {agentFailure && activeChatId ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            padding: '6px 10px',
            margin: '6px 0',
            borderRadius: 6,
            border: '1px solid var(--rpt-danger, #d9534f)',
            background: 'var(--rpt-danger-soft, rgba(217,83,79,0.12))',
            fontSize: 13
          }}
        >
          <span>
            {t('agent.headlessFailed', {
              reason:
                agentFailure.reason.length > 200
                  ? agentFailure.reason.slice(0, 200) + '…'
                  : agentFailure.reason
            })}
          </span>
          <button
            title={t('common.dismiss')}
            style={{
              flex: '0 0 auto',
              background: 'none',
              border: 'none',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
              padding: '0 2px'
            }}
            onClick={() => clearAgentFailure(activeChatId)}
          >
            ×
          </button>
        </div>
      ) : null}

      {showRecallBanner && activeChatId ? (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            padding: '6px 10px',
            margin: '6px 0',
            borderRadius: 6,
            border: '1px solid var(--rpt-warning, #e0a23c)',
            background: 'var(--rpt-warning-soft, rgba(224,162,60,0.14))',
            fontSize: 13
          }}
        >
          <span>{t('recall.failOpenBanner', { n: recallStreak })}</span>
          <button
            title={t('common.dismiss')}
            style={{
              flex: '0 0 auto',
              background: 'none',
              border: 'none',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
              padding: '0 2px'
            }}
            onClick={() => dismissRecall(activeChatId)}
          >
            ×
          </button>
        </div>
      ) : null}

      {postActivityKey ? (
        <div className="agent-activity-chip" role="status">
          <span className="agent-activity-dot" aria-hidden="true" />
          {t(postActivityKey)}
        </div>
      ) : null}

      {activeChatId ? <AgentRunActivity profileId={profileId} chatId={activeChatId} /> : null}

      <ChatToolbar
        canRegenerate={canRegenerate}
        onRegenerate={handleRegenerate}
        onManageFloors={() => setFloorsOpen(true)}
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
              label: t('chat.editMessage'),
              onClick: () => {
                setEditing({ floor: menu.floor, field: menu.field })
                setEditText(menu.value)
              }
            }
          ]}
        />
      )}

      {floorsOpen && (
        <FloorManagerModal profileId={profileId} onClose={() => setFloorsOpen(false)} />
      )}
    </>
  )
}
