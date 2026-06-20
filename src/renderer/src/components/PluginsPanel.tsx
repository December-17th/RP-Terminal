import React, { useEffect } from 'react'
import { usePluginsStore, InstalledPlugin } from '../stores/pluginsStore'

/** Permissions that require explicit approval (mirrors the host's set). */
const SENSITIVE = ['generate', 'chat:write', 'net', 'slash']

/**
 * Plugins tab (P2). Lists installed standalone plugins; install (folder),
 * enable/disable (with a permission-approval prompt), and uninstall. The
 * runtime itself is <PluginHost/> at the app root.
 */
export const PluginsPanel: React.FC<{ profileId: string }> = ({ profileId }) => {
  const { plugins, load, install, uninstall, setEnabled, scaffoldExample } = usePluginsStore()

  useEffect(() => {
    load(profileId)
  }, [profileId])

  const toggle = async (p: InstalledPlugin): Promise<void> => {
    if (p.enabled) {
      await setEnabled(profileId, p.id, false)
      return
    }
    const perms = p.manifest.permissions
    const sensitive = perms.filter((x) => SENSITIVE.includes(x))
    const lines = perms.length
      ? 'It requests:\n' + perms.map((x) => '  • ' + x).join('\n')
      : 'It requests no special permissions.'
    const warn = sensitive.length ? `\n\n⚠ Sensitive: ${sensitive.join(', ')}` : ''
    if (!window.confirm(`Enable "${p.manifest.name}"?\n\n${lines}${warn}`)) return
    // Approving grants exactly the requested permissions.
    await setEnabled(profileId, p.id, true, perms)
  }

  const remove = async (p: InstalledPlugin): Promise<void> => {
    if (window.confirm(`Uninstall "${p.manifest.name}"? This deletes its files.`)) {
      await uninstall(profileId, p.id)
    }
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>Plugins</h3>
        <div className="panel-header-actions">
          <button onClick={() => install(profileId)}>Install…</button>
          <button className="btn-ghost" onClick={() => scaffoldExample(profileId)}>
            + Example
          </button>
        </div>
      </div>
      <div className="panel-body">
        <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginBottom: 10 }}>
          Standalone plugins run app-wide in a sandbox (no network). Install a folder containing a{' '}
          <code>manifest.json</code>, or add the bundled example. See{' '}
          <code>docs/plugin-api.md</code>.
        </div>

        {plugins.length === 0 ? (
          <div style={{ opacity: 0.6, fontStyle: 'italic', padding: '20px 0' }}>
            No plugins installed. Use “Install…” or “+ Example”.
          </div>
        ) : (
          plugins.map((p) => (
            <PluginRow
              key={p.id}
              plugin={p}
              onToggle={() => toggle(p)}
              onRemove={() => remove(p)}
            />
          ))
        )}
      </div>
    </div>
  )
}

const PluginRow: React.FC<{
  plugin: InstalledPlugin
  onToggle: () => void
  onRemove: () => void
}> = ({ plugin, onToggle, onRemove }) => {
  const m = plugin.manifest
  return (
    <div className={`entry-card ${plugin.enabled ? '' : 'disabled'}`}>
      <div className="entry-head">
        <div className="entry-head-main">
          <span className="entry-title">{m.name}</span>
          <span className="entry-keys-preview">
            v{m.version} · {m.type}
            {m.author ? ` · ${m.author}` : ''}
          </span>
        </div>
        <button
          className={`rpt-script-toggle ${plugin.enabled ? 'on' : ''}`}
          disabled={!!plugin.error}
          onClick={onToggle}
        >
          {plugin.enabled ? 'On' : 'Off'}
        </button>
        <button className="btn-ghost danger" onClick={onRemove} title="Uninstall">
          🗑
        </button>
      </div>
      <div className="entry-body" style={{ display: 'block' }}>
        {m.description && (
          <div style={{ fontSize: '0.85em', marginBottom: 8 }}>{m.description}</div>
        )}
        {plugin.error ? (
          <div style={{ color: '#e74c3c', fontSize: '0.82em' }}>⚠ {plugin.error}</div>
        ) : (
          <div className="plugin-perms">
            {m.permissions.length === 0 ? (
              <span className="perm-chip">no permissions</span>
            ) : (
              m.permissions.map((perm) => (
                <span
                  key={perm}
                  className={`perm-chip ${SENSITIVE.includes(perm) ? 'sensitive' : ''}`}
                >
                  {perm}
                </span>
              ))
            )}
          </div>
        )}
        <div style={{ fontSize: '0.72em', opacity: 0.5, marginTop: 6 }}>{plugin.id}</div>
      </div>
    </div>
  )
}
