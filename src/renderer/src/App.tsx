import { useEffect, useState, useRef, useMemo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { useProfileStore } from './stores/profileStore'
import { useCharacterStore } from './stores/characterStore'
import { useChatStore } from './stores/chatStore'
import { useSettingsStore } from './stores/settingsStore'
import { usePresetStore } from './stores/presetStore'
import { LayoutRenderer } from './components/LayoutRenderer'
import { LorebookManager } from './components/LorebookManager'
import { ScriptManager } from './components/ScriptManager'
import { PresetManager } from './components/PresetManager'
import { LogsPanel } from './components/LogsPanel'
import { RegexPanel } from './components/RegexPanel'
import { MessageContent } from './components/MessageContent'
import { FpsOverlay } from './components/FpsOverlay'
import { CardScriptHost } from './components/CardScriptHost'
import { StatView } from './components/StatView'
import { isPlainObject } from './components/statViewHelpers'
import { PersonaPanel } from './components/PersonaPanel'
import { ApiSettingsPanel } from './components/ApiSettingsPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { PluginHost } from './components/PluginHost'
import { useLogStore } from './stores/logStore'
import { useRegexStore } from './stores/regexStore'
import { usePluginsStore } from './stores/pluginsStore'
import { useToastStore } from './stores/toastStore'
import { useToolbarStore } from './stores/toolbarStore'
import { initSlash, isSlashLine, runSlash, listCommands, SlashCommand } from './plugin/slash'

type PanelTab =
  | 'world'
  | 'sessions'
  | 'persona'
  | 'preset'
  | 'lorebook'
  | 'scripts'
  | 'regex'
  | 'api'
  | 'settings'
  | 'logs'

/** Single shared toast surface for the sandboxed runtime (card scripts + plugins). */
function ToastStack() {
  const toasts = useToastStore((s) => s.toasts)
  if (!toasts.length) return null
  return (
    <div className="rpt-toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className="rpt-toast">
          {t.msg}
        </div>
      ))}
    </div>
  )
}

interface MenuItem {
  label: string
  onClick: () => void
  danger?: boolean
}

function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}) {
  useEffect(() => {
    const close = (): void => onClose()
    // Defer so the opening right-click doesn't immediately dismiss it.
    const t = setTimeout(() => {
      window.addEventListener('click', close)
      window.addEventListener('contextmenu', close)
      window.addEventListener('resize', close)
    })
    return () => {
      clearTimeout(t)
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('resize', close)
    }
  }, [])

  return createPortal(
    <div className="context-menu" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
      {items.map((it) => (
        <button
          key={it.label}
          className={`context-menu-item ${it.danger ? 'danger' : ''}`}
          onClick={() => {
            it.onClick()
            onClose()
          }}
        >
          {it.label}
        </button>
      ))}
    </div>,
    document.body
  )
}

/**
 * Isolated streaming view — subscribes only to streamingText so the high-frequency
 * per-frame updates re-render just this tiny node, not the whole chat (which would
 * reconcile every prior message + card iframe each frame and tank the FPS).
 */
function StreamingView({ pendingUserMsg }: { pendingUserMsg: string }) {
  const streamingText = useChatStore((s) => s.streamingText)
  const endRef = useRef<HTMLDivElement>(null)
  // Keep the latest streamed text in view as it grows (scoped to this node so the
  // high-frequency updates don't re-render the rest of the chat).
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [streamingText])
  return (
    <div className="floor-block">
      {pendingUserMsg && <div className="user-action">&gt; {pendingUserMsg}</div>}
      {streamingText ? (
        <div className="streaming-text">{streamingText}</div>
      ) : (
        <em className="generating-pulse">Generating…</em>
      )}
      <div ref={endRef} />
    </div>
  )
}

function EditArea({
  value,
  onChange,
  onSave,
  onCancel
}: {
  value: string
  onChange: (v: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  // Auto-size to the content so the editor matches the message.
  useEffect(() => {
    const el = ref.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
  }, [value])

  return (
    <div className="edit-area">
      <textarea
        ref={ref}
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            onSave()
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      <div className="edit-actions">
        <button className="btn-accent" onClick={onSave}>
          Save
        </button>
        <button className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <span className="edit-hint">Ctrl+Enter to save · Esc to cancel</span>
      </div>
    </div>
  )
}

export default function App() {
  const { profiles, activeProfile, loadProfiles, createProfile } = useProfileStore()
  const { settings, loadSettings } = useSettingsStore()
  const {
    characters,
    activeCharacter,
    loadCharacters,
    setActiveCharacter,
    importMockCharacter,
    deleteCharacter
  } = useCharacterStore()
  // Select everything EXCEPT streamingText, so App doesn't re-render per streamed
  // frame (that high-frequency state lives in <StreamingView/>).
  const {
    chats,
    activeChatId,
    activeChatMode,
    floors,
    isGenerating,
    error,
    loadChats,
    createChat,
    setActiveChat,
    setMode,
    sendAction,
    regenerate,
    stopGeneration,
    deleteChat,
    editFloor
  } = useChatStore(
    useShallow((s) => ({
      chats: s.chats,
      activeChatId: s.activeChatId,
      activeChatMode: s.activeChatMode,
      floors: s.floors,
      isGenerating: s.isGenerating,
      error: s.error,
      loadChats: s.loadChats,
      createChat: s.createChat,
      setActiveChat: s.setActiveChat,
      setMode: s.setMode,
      sendAction: s.sendAction,
      regenerate: s.regenerate,
      stopGeneration: s.stopGeneration,
      deleteChat: s.deleteChat,
      editFloor: s.editFloor
    }))
  )

  const activePresetName = usePresetStore((s) => s.preset?.name)
  const toolbarButtons = useToolbarStore((s) => s.buttons)
  const regexRules = useRegexStore((s) => s.rules)
  const cardCss = activeCharacter?.card.data.extensions?.rp_terminal?.css as string | undefined
  const personaName = settings?.persona?.name || 'User'
  const charName = activeCharacter?.card.data.name || 'Character'

  // Apply display regex (beautification) to each stored response at render time.
  const renderedFloors = useMemo(
    () =>
      floors.map((f) => ({
        floor: f.floor,
        user: f.user_message.content,
        rawResponse: f.response.content,
        html: useRegexStore.getState().apply(f.response.content, { user: personaName, char: charName })
      })),
    [floors, regexRules, personaName, charName]
  )

  const [newProfileName, setNewProfileName] = useState('')
  const [actionInput, setActionInput] = useState('')
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [panel, setPanel] = useState<PanelTab>('world')
  const [pendingUserMsg, setPendingUserMsg] = useState('')
  const [editing, setEditing] = useState<{ floor: number; field: 'user' | 'response' } | null>(null)
  const [editText, setEditText] = useState('')
  const [menu, setMenu] = useState<{
    x: number
    y: number
    floor: number
    field: 'user' | 'response'
    value: string
  } | null>(null)
  // Which floor (page) the chat history is showing — one floor at a time.
  const [viewIndex, setViewIndex] = useState(0)

  const viewportRef = useRef<HTMLDivElement>(null)
  const actionRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    loadProfiles()
    initSlash() // register built-in slash commands once
    // Live streaming text for the active chat's in-flight response.
    const unsubDelta = window.api.onGenerationDelta(({ chatId, delta }) => {
      if (chatId === useChatStore.getState().activeChatId) {
        useChatStore.getState().appendDelta(delta)
      }
    })
    // Live log stream for the Logs panel.
    const unsubLog = window.api.onLog((entry) => useLogStore.getState().add(entry))
    return () => {
      unsubDelta()
      unsubLog()
    }
  }, [])

  useEffect(() => {
    if (activeProfile) {
      loadSettings(activeProfile.id)
      loadCharacters(activeProfile.id)
      loadChats(activeProfile.id)
      usePresetStore.getState().load(activeProfile.id)
      useRegexStore.getState().load(activeProfile.id)
      usePluginsStore.getState().load(activeProfile.id)
    }
  }, [activeProfile])

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

  // Apply the chat font size preference to the message area.
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--rpt-chat-font',
      `${settings?.ui?.font_size ?? 16}px`
    )
  }, [settings?.ui?.font_size])

  if (!activeProfile) {
    return (
      <div style={{ padding: 20 }}>
        <h2>RP Terminal</h2>
        <div>
          <h3>Select Profile</h3>
          {profiles.map((p) => (
            <button
              key={p.id}
              onClick={() => useProfileStore.getState().setActiveProfile(p)}
              style={{ display: 'block', margin: '5px 0' }}
            >
              {p.name}
            </button>
          ))}
          <div style={{ marginTop: 20 }}>
            <input
              value={newProfileName}
              onChange={(e) => setNewProfileName(e.target.value)}
              placeholder="New Profile Name"
            />
            <button onClick={() => createProfile(newProfileName)} style={{ marginTop: 10 }}>
              Create
            </button>
          </div>
        </div>
      </div>
    )
  }

  const tab = (key: PanelTab, label: string, disabled = false) => (
    <button
      className={`nav-tab ${panel === key ? 'active' : ''}`}
      disabled={disabled}
      onClick={() => setPanel(key)}
    >
      {label}
    </button>
  )

  const renderPanel = () => {
    switch (panel) {
      case 'api':
        return <ApiSettingsPanel profileId={activeProfile.id} />

      case 'persona':
        return <PersonaPanel profileId={activeProfile.id} />

      case 'world':
        return (
          <div className="panel">
            <div className="panel-header">
              <h3>World</h3>
              <div className="panel-header-actions">
                <button
                  onClick={() => useCharacterStore.getState().importCharacter(activeProfile.id)}
                >
                  Import
                </button>
                <button className="btn-ghost" onClick={() => importMockCharacter(activeProfile.id)}>
                  + Mock
                </button>
              </div>
            </div>
            <div className="panel-body">
              {characters.length === 0 && (
                <div style={{ opacity: 0.6, fontStyle: 'italic' }}>
                  No worlds yet. Import a character card or add the mock guide.
                </div>
              )}
              {characters.map((c) => (
                <div key={c.id} className="panel-list-row">
                  <button
                    className={`panel-list-item ${activeCharacter?.id === c.id ? 'btn-accent' : ''}`}
                    onClick={() => {
                      setActiveCharacter(c)
                      setPanel('sessions')
                    }}
                  >
                    {c.card.data.name}
                  </button>
                  <button
                    className="btn-ghost danger row-del"
                    title="Delete character"
                    onClick={() => {
                      if (
                        confirm(
                          `Delete character "${c.card.data.name}" and its lorebook? This cannot be undone.`
                        )
                      ) {
                        deleteCharacter(activeProfile.id, c.id)
                      }
                    }}
                  >
                    🗑
                  </button>
                </div>
              ))}
            </div>
          </div>
        )

      case 'sessions':
        return (
          <div className="panel">
            <div className="panel-header">
              <h3>Sessions</h3>
              {activeCharacter && (
                <div className="panel-header-actions">
                  <button onClick={() => createChat(activeProfile.id, activeCharacter.id)}>
                    + New
                  </button>
                </div>
              )}
            </div>
            <div className="panel-body">
              {!activeCharacter ? (
                <div style={{ opacity: 0.6, fontStyle: 'italic' }}>Select a character first.</div>
              ) : (
                <>
                  <div
                    style={{
                      fontSize: '0.85em',
                      color: 'var(--rpt-text-secondary)',
                      marginBottom: 8
                    }}
                  >
                    {activeCharacter.card.data.name}
                  </div>
                  {chats.filter((c) => c.character_id === activeCharacter.id).length === 0 && (
                    <div style={{ opacity: 0.6, fontStyle: 'italic' }}>
                      No sessions yet. Start a new one.
                    </div>
                  )}
                  {chats
                    .filter((c) => c.character_id === activeCharacter.id)
                    .map((c) => {
                      const last = c.floor_index?.[c.floor_index.length - 1]
                      const previewText = last?.response_preview || 'Empty session'
                      return (
                        <div
                          key={c.id}
                          className={`session-card ${activeChatId === c.id ? 'active' : ''}`}
                          onClick={() => setActiveChat(activeProfile.id, c.id)}
                        >
                          <div className="session-card-top">
                            <span className="session-time">
                              {new Date(c.updated_at).toLocaleString()}
                            </span>
                            <span className="session-count">{c.floor_count ?? 0} ✦</span>
                            <button
                              className="btn-ghost danger session-del"
                              title="Delete session"
                              onClick={(e) => {
                                e.stopPropagation()
                                if (confirm('Delete this session? This cannot be undone.')) {
                                  deleteChat(activeProfile.id, c.id)
                                }
                              }}
                            >
                              🗑
                            </button>
                          </div>
                          <div className="session-preview">{previewText}</div>
                        </div>
                      )
                    })}
                </>
              )}
            </div>
          </div>
        )

      case 'preset':
        return <PresetManager profileId={activeProfile.id} />

      case 'lorebook':
        return activeCharacter ? (
          <LorebookManager
            key={activeCharacter.id}
            profileId={activeProfile.id}
            characterId={activeCharacter.id}
            characterName={activeCharacter.card.data.name}
            chatId={activeChatId}
          />
        ) : (
          <div className="panel">
            <div className="panel-header">
              <h3>Lorebook</h3>
            </div>
            <div className="panel-body">
              <div style={{ opacity: 0.6, fontStyle: 'italic' }}>Select a World first.</div>
            </div>
          </div>
        )

      case 'scripts':
        return activeCharacter ? (
          <ScriptManager
            key={activeCharacter.id}
            profileId={activeProfile.id}
            characterId={activeCharacter.id}
            characterName={activeCharacter.card.data.name}
            card={activeCharacter.card}
          />
        ) : (
          <div className="panel">
            <div className="panel-header">
              <h3>Scripts</h3>
            </div>
            <div className="panel-body">
              <div style={{ opacity: 0.6, fontStyle: 'italic' }}>Select a World first.</div>
            </div>
          </div>
        )

      case 'regex':
        return <RegexPanel profileId={activeProfile.id} />

      case 'settings':
        return <SettingsPanel profileId={activeProfile.id} />

      case 'logs':
        return <LogsPanel />
    }
  }

  // Slash-command autocomplete: while the box holds just "/" + a partial command
  // name (no space yet), show a menu of matching commands above the input.
  // (Plain consts, not a hook — this code lives after the early `activeProfile`
  // return, so a `useMemo` here would violate the Rules of Hooks.)
  const slashQueryMatch = actionInput.match(/^\/(\S*)$/)
  const slashQuery = slashQueryMatch ? slashQueryMatch[1].toLowerCase() : null
  const slashItems =
    slashQuery === null ? [] : listCommands().filter((c) => c.name.startsWith(slashQuery))
  const slashOpen = slashQuery !== null && !slashDismissed && slashItems.length > 0
  const slashActive = Math.min(slashIndex, slashItems.length - 1)

  // Accept a command from the menu: fill the box with "/name " ready for args.
  const completeCommand = (cmd: SlashCommand): void => {
    setActionInput('/' + cmd.name + ' ')
    setSlashDismissed(false)
    setSlashIndex(0)
    requestAnimationFrame(() => actionRef.current?.focus())
  }

  // Submit the action box: a leading "/" runs a slash command (output toasted)
  // instead of starting a generation.
  const submitAction = (): void => {
    const text = actionInput.trim()
    if (!text) return
    if (isSlashLine(text)) {
      runSlash(text).then((out) => {
        if (out) useToastStore.getState().push(out)
      })
      setActionInput('')
      return
    }
    setPendingUserMsg(text)
    sendAction(activeProfile.id, text)
    setActionInput('')
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
  // RPG state for the right panel: the latest floor's stat_data (MVU / R3) + the card's
  // declarative ui_layout (if any). Either or both drive the status panel.
  const latestVars = floors.length ? floors[floors.length - 1]?.variables : undefined
  const statData = isPlainObject(latestVars?.stat_data) ? latestVars!.stat_data : undefined
  const uiLayout = activeCharacter?.card.data.extensions?.rp_terminal?.ui_layout

  // Render a single floor block (user action + AI response) with inline edit + menu.
  const renderFloorBlock = (f: (typeof renderedFloors)[number]): ReactNode => {
    const editingUser = editing?.floor === f.floor && editing.field === 'user'
    const editingResp = editing?.floor === f.floor && editing.field === 'response'
    const saveEdit = (): void => {
      if (editing) editFloor(activeProfile.id, editing.floor, editing.field, editText)
      setEditing(null)
    }
    return (
      <div key={f.floor} className="floor-block">
        {editingUser ? (
          <EditArea
            value={editText}
            onChange={setEditText}
            onSave={saveEdit}
            onCancel={() => setEditing(null)}
          />
        ) : f.user ? (
          <div
            className="user-action"
            title="Right-click for options"
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, floor: f.floor, field: 'user', value: f.user })
            }}
          >
            &gt; {f.user}
          </div>
        ) : null}
        {editingResp ? (
          <EditArea
            value={editText}
            onChange={setEditText}
            onSave={saveEdit}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <MessageContent
            content={f.html}
            css={cardCss}
            onContextMenu={(x, y) =>
              setMenu({ x, y, floor: f.floor, field: 'response', value: f.rawResponse })
            }
          />
        )}
      </div>
    )
  }

  return (
    <>
      <div className="top-nav">
        <span className="nav-brand">RP Terminal</span>
        <div className="nav-tabs">
          {tab('world', 'World')}
          {tab('sessions', 'Sessions', !activeCharacter)}
          {tab('persona', 'Persona')}
          {tab('preset', 'Preset')}
          {tab('lorebook', 'Lorebook', !activeCharacter)}
          {tab('scripts', 'Scripts', !activeCharacter)}
          {tab('regex', 'Regex')}
          {tab('api', 'API')}
          {tab('settings', 'Settings')}
          {tab('logs', 'Logs')}
        </div>
        {toolbarButtons.length > 0 && (
          <div className="nav-ext">
            {toolbarButtons.map((b) => (
              <button key={b.key} className="nav-ext-btn" title={b.label} onClick={b.onClick}>
                {b.label}
              </button>
            ))}
          </div>
        )}
        <span className="nav-status">
          {activeProfile.name} · {activeCharacter?.card.data.name || 'no world'} ·{' '}
          {activePresetName || 'no preset'}
        </span>
      </div>

      <div className="app-body">
        <div className="sidebar-left">{renderPanel()}</div>

        <div className="main-content">
          {activeChatId ? (
            <>
              <div className="floor-stage">
                <div className="floor-viewport" ref={viewportRef}>
                  {showStreaming ? (
                    <StreamingView pendingUserMsg={pendingUserMsg} />
                  ) : currentFloor ? (
                    renderFloorBlock(currentFloor)
                  ) : (
                    <div className="floor-empty">No messages yet.</div>
                  )}
                  {error && (
                    <div
                      className="floor-block"
                      style={{ borderColor: '#e74c3c', color: '#e74c3c' }}
                    >
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
                          : 'Set Agent Mode to Manual or Agentic in Settings to switch scenes'
                      }
                      onClick={() => setMode(activeProfile.id, m)}
                    >
                      {m[0].toUpperCase() + m.slice(1)}
                    </button>
                  ))}
                </div>
                {floors.some((f) => f.user_message.content) && (
                  <button
                    className="btn-ghost"
                    disabled={isGenerating}
                    title="Re-roll the last response"
                    onClick={() => {
                      const lastUser = [...floors].reverse().find((f) => f.user_message.content)
                      setPendingUserMsg(lastUser?.user_message.content || '')
                      regenerate(activeProfile.id)
                    }}
                  >
                    ↻ Regenerate
                  </button>
                )}
              </div>

              <div className="action-input-container">
                {slashOpen && (
                  <div className="slash-menu" role="listbox">
                    {slashItems.map((c, i) => (
                      <button
                        key={c.name}
                        type="button"
                        role="option"
                        aria-selected={i === slashActive}
                        className={`slash-item ${i === slashActive ? 'active' : ''}`}
                        // mousedown (not click) + preventDefault keeps the textarea focused
                        onMouseDown={(e) => {
                          e.preventDefault()
                          completeCommand(c)
                        }}
                        onMouseEnter={() => setSlashIndex(i)}
                      >
                        <span className="slash-name">/{c.name}</span>
                        <span className="slash-desc">{c.description}</span>
                      </button>
                    ))}
                  </div>
                )}
                <textarea
                  ref={actionRef}
                  className="action-input"
                  value={actionInput}
                  onChange={(e) => {
                    setActionInput(e.target.value)
                    setSlashDismissed(false)
                    setSlashIndex(0)
                  }}
                  onKeyDown={(e) => {
                    if (slashOpen) {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault()
                        setSlashIndex(
                          (i) => (Math.min(i, slashItems.length - 1) + 1) % slashItems.length
                        )
                        return
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault()
                        setSlashIndex(
                          (i) =>
                            (Math.min(i, slashItems.length - 1) - 1 + slashItems.length) %
                            slashItems.length
                        )
                        return
                      }
                      if (e.key === 'Enter' || e.key === 'Tab') {
                        e.preventDefault()
                        completeCommand(slashItems[slashActive])
                        return
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setSlashDismissed(true)
                        return
                      }
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      if (!isGenerating) submitAction()
                    }
                  }}
                  placeholder="What do you do?  (type / for commands)"
                  disabled={isGenerating}
                />
                <button
                  className={`send-btn ${isGenerating ? 'stop' : ''}`}
                  title={isGenerating ? 'Stop generation' : 'Send'}
                  disabled={!isGenerating && !actionInput.trim()}
                  onClick={() => {
                    if (isGenerating) {
                      stopGeneration()
                      return
                    }
                    submitAction()
                  }}
                >
                  {isGenerating ? '■' : '⏎'}
                </button>
              </div>
            </>
          ) : (
            <div style={{ margin: 'auto', opacity: 0.5 }}>
              {activeCharacter ? 'Select or create a session.' : 'Select a character.'}
            </div>
          )}
        </div>

        <div className="sidebar-right">
          {activeChatId && activeCharacter ? (
            <div>
              <h3 style={{ borderBottom: '1px solid var(--rpt-border)', paddingBottom: 10 }}>
                RPG Status
              </h3>
              <div style={{ marginTop: 20 }}>
                {uiLayout?.length ? <LayoutRenderer layoutSchema={uiLayout} /> : null}
                {statData && Object.keys(statData).length ? <StatView data={statData} /> : null}
                {!uiLayout?.length && !(statData && Object.keys(statData).length) ? (
                  <div style={{ opacity: 0.6 }}>
                    <em>(No RPG state for this session yet)</em>
                  </div>
                ) : null}
              </div>
              {activeCharacter.card.data.extensions?.rp_terminal?.scripts?.length ? (
                <CardScriptHost
                  key={`${activeCharacter.id}:${activeChatId}`}
                  profileId={activeProfile.id}
                  chatId={activeChatId}
                  cardId={activeCharacter.id}
                  cardName={activeCharacter.card.data.name}
                  scripts={activeCharacter.card.data.extensions.rp_terminal.scripts}
                />
              ) : null}
            </div>
          ) : (
            <div style={{ opacity: 0.5 }}>Waiting for session...</div>
          )}
          {/* App-wide standalone-plugin runtime: panels render here, headless
              plugins stay mounted but hidden. Kept outside the session
              conditional so plugin iframes never reparent/reload. */}
          <PluginHost profileId={activeProfile.id} />
        </div>
      </div>

      {settings?.ui?.show_fps && <FpsOverlay />}

      <ToastStack />

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
