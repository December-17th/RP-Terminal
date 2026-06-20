import { useEffect, useState, useRef } from 'react';
import { useProfileStore } from './stores/profileStore';
import { useCharacterStore } from './stores/characterStore';
import { useChatStore } from './stores/chatStore';
import { useSettingsStore } from './stores/settingsStore';
import Markdown from 'react-markdown';
import { LayoutRenderer } from './components/LayoutRenderer';

export default function App() {
  const { profiles, activeProfile, loadProfiles, createProfile } = useProfileStore();
  const { settings, loadSettings, updateSettings } = useSettingsStore();
  const { characters, activeCharacter, loadCharacters, setActiveCharacter, importMockCharacter } = useCharacterStore();
  const { chats, activeChatId, floors, isGenerating, loadChats, createChat, setActiveChat, sendAction } = useChatStore();

  const [newProfileName, setNewProfileName] = useState('');
  const [actionInput, setActionInput] = useState('');

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadProfiles();
  }, []);

  useEffect(() => {
    if (activeProfile) {
      loadSettings(activeProfile.id);
      loadCharacters(activeProfile.id);
      loadChats(activeProfile.id);
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
        <h2>RP Terminal MVP</h2>
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

  return (
    <>
      <div className="sidebar-left">
        <h3>{activeProfile.name}</h3>
        
        <div>
          <h4>Settings</h4>
          <select 
            value={settings?.api?.provider || 'openai'} 
            onChange={e => updateSettings(activeProfile.id, { api: { ...settings!.api, provider: e.target.value } })}
            style={{ width: '100%', marginBottom: 5, padding: 8, backgroundColor: 'var(--rpt-bg-primary)', color: 'var(--rpt-text-primary)', border: '1px solid var(--rpt-border)', borderRadius: 4 }}
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="openrouter">OpenRouter</option>
            <option value="custom">Custom (OpenAI Compatible)</option>
          </select>
          <input 
            type="text" 
            placeholder="API Endpoint URL" 
            value={settings?.api?.endpoint || ''} 
            onChange={e => updateSettings(activeProfile.id, { api: { ...settings!.api, endpoint: e.target.value } })}
            style={{ marginBottom: 5 }}
          />
          <input 
            type="password" 
            placeholder="API Key" 
            value={settings?.api?.api_key || ''} 
            onChange={e => updateSettings(activeProfile.id, { api: { ...settings!.api, api_key: e.target.value } })}
            style={{ marginBottom: 5 }}
          />
          <input 
            type="text" 
            placeholder="Model (e.g. gpt-4o)" 
            value={settings?.api?.model || ''} 
            onChange={e => updateSettings(activeProfile.id, { api: { ...settings!.api, model: e.target.value } })}
          />
        </div>

        <div>
          <h4>Characters</h4>
          {characters.map(c => (
            <button key={c.id} onClick={() => setActiveCharacter(c)} style={{ display: 'block', margin: '5px 0', width: '100%', opacity: activeCharacter?.id === c.id ? 1 : 0.7 }}>
              {c.card.data.name}
            </button>
          ))}
          <button onClick={() => useCharacterStore.getState().importCharacter(activeProfile.id)} style={{ width: '100%', marginTop: 5 }}>+ Import Character File</button>
          <button onClick={() => importMockCharacter(activeProfile.id)} style={{ width: '100%', marginTop: 5, backgroundColor: 'var(--rpt-bg-secondary)', border: '1px solid var(--rpt-border)' }}>+ Add Mock Guide</button>
        </div>

        {activeCharacter && (
          <div>
            <h4>Sessions</h4>
            <button onClick={() => createChat(activeProfile.id, activeCharacter.id)} style={{ width: '100%' }}>+ New Session</button>
            {chats.filter(c => c.character_id === activeCharacter.id).map(c => (
              <button key={c.id} onClick={() => setActiveChat(activeProfile.id, c.id)} style={{ display: 'block', margin: '5px 0', width: '100%', opacity: activeChatId === c.id ? 1 : 0.7 }}>
                {new Date(c.updated_at).toLocaleString()}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="main-content">
        {activeChatId ? (
          <>
            <div className="floor-list">
              {floors.map(f => (
                <div key={f.floor} className="floor-block">
                  <div className="user-action">
                    &gt; {f.user_message.content}
                  </div>
                  <div>
                    <Markdown>{f.response.content}</Markdown>
                  </div>
                </div>
              ))}
              {isGenerating && (
                <div className="floor-block">
                  <div className="user-action">&gt; {actionInput}</div>
                  <div><em>Generating...</em></div>
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
                      sendAction(activeProfile.id, actionInput.trim(), settings, activeCharacter);
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
                  sendAction(activeProfile.id, actionInput.trim(), settings, activeCharacter);
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
              {activeCharacter.card.data.ui_layout ? (
                <LayoutRenderer layoutSchema={activeCharacter.card.data.ui_layout} />
              ) : (
                <div style={{ opacity: 0.6 }}>
                  <em>(Card does not define a UI Layout)</em>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div style={{ opacity: 0.5 }}>Waiting for session...</div>
        )}
      </div>
    </>
  );
}
