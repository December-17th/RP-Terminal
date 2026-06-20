import { useEffect, useState, useRef } from 'react';
import { useProfileStore } from './stores/profileStore';
import { useCharacterStore } from './stores/characterStore';
import { useChatStore } from './stores/chatStore';
import { useSettingsStore } from './stores/settingsStore';
import { usePresetStore } from './stores/presetStore';
import Markdown from 'react-markdown';
import { LayoutRenderer } from './components/LayoutRenderer';
import { LorebookManager } from './components/LorebookManager';
import { PresetManager } from './components/PresetManager';

type PanelTab = 'characters' | 'sessions' | 'preset' | 'lorebook' | 'api';

export default function App() {
  const { profiles, activeProfile, loadProfiles, createProfile } = useProfileStore();
  const { settings, loadSettings, updateSettings } = useSettingsStore();
  const { characters, activeCharacter, loadCharacters, setActiveCharacter, importMockCharacter } = useCharacterStore();
  const { chats, activeChatId, floors, isGenerating, error, loadChats, createChat, setActiveChat, sendAction } = useChatStore();

  const [newProfileName, setNewProfileName] = useState('');
  const [actionInput, setActionInput] = useState('');
  const [presetName, setPresetName] = useState<string>('');
  const [panel, setPanel] = useState<PanelTab>('characters');

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const loadPreset = async (profileId: string) => {
    const preset = await window.api.getPreset(profileId);
    setPresetName(preset?.name || '');
  };

  useEffect(() => {
    loadProfiles();
  }, []);

  useEffect(() => {
    if (activeProfile) {
      loadSettings(activeProfile.id);
      loadCharacters(activeProfile.id);
      loadChats(activeProfile.id);
      loadPreset(activeProfile.id);
    }
  }, [activeProfile]);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [floors]);

  if (!activeProfile) {
    return (
      <div style={{ padding: 20 }}>
        <h2>RP Terminal</h2>
        <div>
          <h3>Select Profile</h3>
          {profiles.map(p => (
            <button key={p.id} onClick={() => useProfileStore.getState().setActiveProfile(p)} style={{ display: 'block', margin: '5px 0' }}>
              {p.name}
            </button>
          ))}
          <div style={{ marginTop: 20 }}>
            <input value={newProfileName} onChange={e => setNewProfileName(e.target.value)} placeholder="New Profile Name" />
            <button onClick={() => createProfile(newProfileName)} style={{ marginTop: 10 }}>Create</button>
          </div>
        </div>
      </div>
    );
  }

  const importPreset = async () => {
    const name = await window.api.importPresetDialog(activeProfile.id);
    if (name) {
      await usePresetStore.getState().load(activeProfile.id);
      loadPreset(activeProfile.id);
    }
  };

  const tab = (key: PanelTab, label: string, disabled = false) => (
    <button
      className={`nav-tab ${panel === key ? 'active' : ''}`}
      disabled={disabled}
      onClick={() => setPanel(key)}
    >
      {label}
    </button>
  );

  const renderPanel = () => {
    switch (panel) {
      case 'api':
        return (
          <div className="panel">
            <div className="panel-header"><h3>API Settings</h3></div>
            <div className="panel-body">
              <label className="field-label">Provider</label>
              <select
                value={settings?.api?.provider || 'openai'}
                onChange={e => updateSettings(activeProfile.id, { api: { ...settings!.api, provider: e.target.value } })}
                style={{ width: '100%', marginBottom: 10 }}
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="openrouter">OpenRouter</option>
                <option value="custom">Custom (OpenAI Compatible)</option>
              </select>
              <label className="field-label">Endpoint URL</label>
              <input type="text" placeholder="https://api.openai.com/v1" value={settings?.api?.endpoint || ''}
                onChange={e => updateSettings(activeProfile.id, { api: { ...settings!.api, endpoint: e.target.value } })} style={{ marginBottom: 10 }} />
              <label className="field-label">API Key</label>
              <input type="password" placeholder="sk-..." value={settings?.api?.api_key || ''}
                onChange={e => updateSettings(activeProfile.id, { api: { ...settings!.api, api_key: e.target.value } })} style={{ marginBottom: 10 }} />
              <label className="field-label">Model</label>
              <input type="text" placeholder="e.g. gpt-4o" value={settings?.api?.model || ''}
                onChange={e => updateSettings(activeProfile.id, { api: { ...settings!.api, model: e.target.value } })} />
            </div>
          </div>
        );

      case 'characters':
        return (
          <div className="panel">
            <div className="panel-header">
              <h3>Characters</h3>
              <div className="panel-header-actions">
                <button onClick={() => useCharacterStore.getState().importCharacter(activeProfile.id)}>Import</button>
                <button className="btn-ghost" onClick={() => importMockCharacter(activeProfile.id)}>+ Mock</button>
              </div>
            </div>
            <div className="panel-body">
              {characters.length === 0 && <div style={{ opacity: 0.6, fontStyle: 'italic' }}>No characters. Import a card or add the mock guide.</div>}
              {characters.map(c => (
                <button
                  key={c.id}
                  className={`panel-list-item ${activeCharacter?.id === c.id ? 'btn-accent' : ''}`}
                  onClick={() => { setActiveCharacter(c); setPanel('sessions'); }}
                >
                  {c.card.data.name}
                </button>
              ))}
            </div>
          </div>
        );

      case 'sessions':
        return (
          <div className="panel">
            <div className="panel-header">
              <h3>Sessions</h3>
              {activeCharacter && (
                <div className="panel-header-actions">
                  <button onClick={() => createChat(activeProfile.id, activeCharacter.id)}>+ New</button>
                </div>
              )}
            </div>
            <div className="panel-body">
              {!activeCharacter ? (
                <div style={{ opacity: 0.6, fontStyle: 'italic' }}>Select a character first.</div>
              ) : (
                <>
                  <div style={{ fontSize: '0.85em', color: 'var(--rpt-text-secondary)', marginBottom: 8 }}>
                    {activeCharacter.card.data.name}
                  </div>
                  {chats.filter(c => c.character_id === activeCharacter.id).length === 0 && (
                    <div style={{ opacity: 0.6, fontStyle: 'italic' }}>No sessions yet. Start a new one.</div>
                  )}
                  {chats.filter(c => c.character_id === activeCharacter.id).map(c => (
                    <button
                      key={c.id}
                      className={`panel-list-item ${activeChatId === c.id ? 'btn-accent' : ''}`}
                      onClick={() => setActiveChat(activeProfile.id, c.id)}
                    >
                      {new Date(c.updated_at).toLocaleString()}
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>
        );

      case 'preset':
        return <PresetManager profileId={activeProfile.id} onImport={importPreset} />;

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
            <div className="panel-header"><h3>Lorebook</h3></div>
            <div className="panel-body"><div style={{ opacity: 0.6, fontStyle: 'italic' }}>Select a character first.</div></div>
          </div>
        );
    }
  };

  return (
    <>
      <div className="top-nav">
        <span className="nav-brand">RP Terminal</span>
        <div className="nav-tabs">
          {tab('characters', 'Characters')}
          {tab('sessions', 'Sessions', !activeCharacter)}
          {tab('preset', 'Preset')}
          {tab('lorebook', 'Lorebook', !activeCharacter)}
          {tab('api', 'API')}
        </div>
        <span className="nav-status">
          {activeProfile.name} · {activeCharacter?.card.data.name || 'no character'} · {presetName || 'Default Preset'}
        </span>
      </div>

      <div className="app-body">
        <div className="sidebar-left">{renderPanel()}</div>

        <div className="main-content">
          {activeChatId ? (
            <>
              <div className="floor-list">
                {floors.map(f => (
                  <div key={f.floor} className="floor-block">
                    {f.user_message.content && (
                      <div className="user-action">&gt; {f.user_message.content}</div>
                    )}
                    <div><Markdown>{f.response.content}</Markdown></div>
                  </div>
                ))}
                {isGenerating && (
                  <div className="floor-block">
                    <div className="user-action">&gt; {actionInput}</div>
                    <div><em>Generating...</em></div>
                  </div>
                )}
                {error && (
                  <div className="floor-block" style={{ borderColor: '#e74c3c', color: '#e74c3c' }}>
                    Error: {error}
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className="action-input-container">
                <textarea
                  className="action-input"
                  value={actionInput}
                  onChange={e => setActionInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (!isGenerating && actionInput.trim()) {
                        sendAction(activeProfile.id, actionInput.trim());
                        setActionInput('');
                      }
                    }
                  }}
                  placeholder="What do you do?"
                  disabled={isGenerating}
                />
                <button
                  disabled={isGenerating || !actionInput.trim()}
                  onClick={() => {
                    sendAction(activeProfile.id, actionInput.trim());
                    setActionInput('');
                  }}
                >
                  Act
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
              <h3 style={{ borderBottom: '1px solid var(--rpt-border)', paddingBottom: 10 }}>RPG Status</h3>
              <div style={{ marginTop: 20 }}>
                {activeCharacter.card.data.extensions?.rp_terminal?.ui_layout?.length ? (
                  <LayoutRenderer layoutSchema={activeCharacter.card.data.extensions.rp_terminal.ui_layout} />
                ) : (
                  <div style={{ opacity: 0.6 }}><em>(Card does not define a UI Layout)</em></div>
                )}
              </div>
            </div>
          ) : (
            <div style={{ opacity: 0.5 }}>Waiting for session...</div>
          )}
        </div>
      </div>
    </>
  );
}
