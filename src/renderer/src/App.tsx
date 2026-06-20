import { useEffect, useState, useRef, useMemo } from 'react'
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
import { PluginsPanel } from './components/PluginsPanel'
import { PluginHost } from './components/PluginHost'
import { useLogStore } from './stores/logStore'
import { useRegexStore } from './stores/regexStore'
import { usePluginsStore } from './stores/pluginsStore'
import { useToastStore } from './stores/toastStore'

type PanelTab =
  | 'world'
  | 'sessions'
  | 'preset'
  | 'lorebook'
  | 'scripts'
  | 'regex'
  | 'plugins'
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
  return (
    <div className="floor-block">
      {pendingUserMsg && <div className="user-action">&gt; {pendingUserMsg}</div>}
      {streamingText ? (
        <div className="streaming-text">{streamingText}</div>
      ) : (
        <em className="generating-pulse">Generating…</em>
      )}
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
  const { settings, loadSettings, updateSettings } = useSettingsStore()
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
    floors,
    isGenerating,
    error,
    loadChats,
    createChat,
    setActiveChat,
    sendAction,
    regenerate,
    stopGeneration,
    deleteChat,
    editFloor
  } = useChatStore(
    useShallow((s) => ({
      chats: s.chats,
      activeChatId: s.activeChatId,
      floors: s.floors,
      isGenerating: s.isGenerating,
      error: s.error,
      loadChats: s.loadChats,
      createChat: s.createChat,
      setActiveChat: s.setActiveChat,
      sendAction: s.sendAction,
      regenerate: s.regenerate,
      stopGeneration: s.stopGeneration,
      deleteChat: s.deleteChat,
      editFloor: s.editFloor
    }))
  )

  const activePresetName = usePresetStore((s) => s.preset?.name)
  const regexRules = useRegexStore((s) => s.rules)
  const cardCss = activeCharacter?.card.data.extensions?.rp_terminal?.css as string | undefined

  // Apply display regex (beautification) to each stored response at render time.
  const renderedFloors = useMemo(
    () =>
      floors.map((f) => ({
        floor: f.floor,
        user: f.user_message.content,
        rawResponse: f.response.content,
        html: useRegexStore.getState().apply(f.response.content)
      })),
    [floors, regexRules]
  )

  const [newProfileName, setNewProfileName] = useState('')
  const [actionInput, setActionInput] = useState('')
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

  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadProfiles()
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

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [floors])

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
        return (
          <div className="panel">
            <div className="panel-header">
              <h3>API Settings</h3>
            </div>
            <div className="panel-body">
              <label className="field-label">Provider</label>
              <select
                value={settings?.api?.provider || 'openai'}
                onChange={(e) =>
                  updateSettings(activeProfile.id, {
                    api: { ...settings!.api, provider: e.target.value }
                  })
                }
                style={{ width: '100%', marginBottom: 10 }}
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="openrouter">OpenRouter</option>
                <option value="custom">Custom (OpenAI Compatible)</option>
              </select>
              <label className="field-label">Endpoint URL</label>
              <input
                type="text"
                placeholder="https://api.openai.com/v1"
                value={settings?.api?.endpoint || ''}
                onChange={(e) =>
                  updateSettings(activeProfile.id, {
                    api: { ...settings!.api, endpoint: e.target.value }
                  })
                }
                style={{ marginBottom: 10 }}
              />
              <label className="field-label">API Key</label>
              <input
                type="password"
                placeholder="sk-..."
                value={settings?.api?.api_key || ''}
                onChange={(e) =>
                  updateSettings(activeProfile.id, {
                    api: { ...settings!.api, api_key: e.target.value }
                  })
                }
                style={{ marginBottom: 10 }}
              />
              <label className="field-label">Model</label>
              <input
                type="text"
                placeholder="e.g. gpt-4o"
                value={settings?.api?.model || ''}
                onChange={(e) =>
                  updateSettings(activeProfile.id, {
                    api: { ...settings!.api, model: e.target.value }
                  })
                }
              />

              <label className="field-label" style={{ marginTop: 16 }}>
                Your Persona Name
              </label>
              <input
                type="text"
                placeholder="User"
                value={settings?.persona?.name ?? 'User'}
                onChange={(e) =>
                  updateSettings(activeProfile.id, {
                    persona: { ...settings!.persona, name: e.target.value }
                  })
                }
              />
              <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
                Replaces {'{{user}}'} in prompts, cards and lorebooks.
              </div>

              <label className="field-label" style={{ marginTop: 16 }}>
                Max Context (tokens)
              </label>
              <input
                type="number"
                min={1000}
                step={1000}
                placeholder="32000"
                value={settings?.generation?.max_context_tokens ?? 32000}
                onChange={(e) =>
                  updateSettings(activeProfile.id, {
                    generation: {
                      ...settings!.generation,
                      max_context_tokens: Number(e.target.value) || 32000
                    }
                  })
                }
              />
              <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 4 }}>
                Oldest turns are trimmed to keep the prompt under this estimate. Raise it for
                large-context models.
              </div>
            </div>
          </div>
        )

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

      case 'plugins':
        return <PluginsPanel profileId={activeProfile.id} />

      case 'settings':
        return (
          <div className="panel">
            <div className="panel-header">
              <h3>Settings</h3>
            </div>
            <div className="panel-body">
              <label className="field-label">Chat Font Size (px)</label>
              <input
                type="number"
                min={10}
                max={28}
                value={settings?.ui?.font_size ?? 16}
                onChange={(e) =>
                  updateSettings(activeProfile.id, {
                    ui: { ...settings!.ui, font_size: Number(e.target.value) || 16 }
                  })
                }
              />

              <label
                className="entry-toggles"
                style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 18 }}
              >
                <input
                  type="checkbox"
                  checked={settings?.ui?.show_fps ?? false}
                  onChange={(e) =>
                    updateSettings(activeProfile.id, {
                      ui: { ...settings!.ui, show_fps: e.target.checked }
                    })
                  }
                />
                Show FPS counter (bottom-right)
              </label>

              <div
                style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginTop: 18 }}
              >
                UI preferences. API keys, persona and context budget live in the API tab.
              </div>
            </div>
          </div>
        )

      case 'logs':
        return <LogsPanel />
    }
  }

  return (
    <>
      <div className="top-nav">
        <span className="nav-brand">RP Terminal</span>
        <div className="nav-tabs">
          {tab('world', 'World')}
          {tab('sessions', 'Sessions', !activeCharacter)}
          {tab('preset', 'Preset')}
          {tab('lorebook', 'Lorebook', !activeCharacter)}
          {tab('scripts', 'Scripts', !activeCharacter)}
          {tab('regex', 'Regex')}
          {tab('plugins', 'Plugins')}
          {tab('api', 'API')}
          {tab('settings', 'Settings')}
          {tab('logs', 'Logs')}
        </div>
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
              <div className="floor-list">
                {renderedFloors.map((f) => {
                  const editingUser = editing?.floor === f.floor && editing.field === 'user'
                  const editingResp = editing?.floor === f.floor && editing.field === 'response'
                  const saveEdit = () => {
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
                            setMenu({
                              x: e.clientX,
                              y: e.clientY,
                              floor: f.floor,
                              field: 'user',
                              value: f.user
                            })
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
                            setMenu({
                              x,
                              y,
                              floor: f.floor,
                              field: 'response',
                              value: f.rawResponse
                            })
                          }
                        />
                      )}
                    </div>
                  )
                })}
                {isGenerating && <StreamingView pendingUserMsg={pendingUserMsg} />}
                {error && (
                  <div className="floor-block" style={{ borderColor: '#e74c3c', color: '#e74c3c' }}>
                    Error: {error}
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {floors.some((f) => f.user_message.content) && (
                <div className="chat-toolbar">
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
                </div>
              )}

              <div className="action-input-container">
                <textarea
                  className="action-input"
                  value={actionInput}
                  onChange={(e) => setActionInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      if (!isGenerating && actionInput.trim()) {
                        setPendingUserMsg(actionInput.trim())
                        sendAction(activeProfile.id, actionInput.trim())
                        setActionInput('')
                      }
                    }
                  }}
                  placeholder="What do you do?"
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
                    if (!actionInput.trim()) return
                    setPendingUserMsg(actionInput.trim())
                    sendAction(activeProfile.id, actionInput.trim())
                    setActionInput('')
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
                {activeCharacter.card.data.extensions?.rp_terminal?.ui_layout?.length ? (
                  <LayoutRenderer
                    layoutSchema={activeCharacter.card.data.extensions.rp_terminal.ui_layout}
                  />
                ) : (
                  <div style={{ opacity: 0.6 }}>
                    <em>(Card does not define a UI Layout)</em>
                  </div>
                )}
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
        </div>
      </div>

      {settings?.ui?.show_fps && <FpsOverlay />}

      {/* App-wide standalone-plugin runtime (headless) + shared toast surface. */}
      <PluginHost profileId={activeProfile.id} />
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
