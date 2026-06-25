import React, { useEffect } from 'react'
import { usePluginsStore, InstalledPlugin } from '../stores/pluginsStore'
import { useT } from '../i18n'

/** Permissions that require explicit approval (mirrors the host's set). */
const SENSITIVE = ['generate', 'chat:write', 'net', 'slash']

/**
 * Plugins tab (P2). Lists installed standalone plugins; install (folder),
 * enable/disable (with a permission-approval prompt), and uninstall. The
 * runtime itself is <PluginHost/> at the app root.
 */
export const PluginsPanel: React.FC<{ profileId: string }> = ({ profileId }) => {
  const { plugins, load, install, installZip, uninstall, setEnabled, scaffoldExample } =
    usePluginsStore()
  const t = useT()

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
      ? t('plugins.itRequests') + perms.map((x) => '  • ' + x).join('\n')
      : t('plugins.noSpecialPerms')
    const warn = sensitive.length
      ? '\n\n' + t('plugins.sensitive', { perms: sensitive.join(', ') })
      : ''
    if (
      !window.confirm(t('plugins.confirmEnable', { name: p.manifest.name }) + `\n\n${lines}${warn}`)
    )
      return
    // Approving grants exactly the requested permissions.
    await setEnabled(profileId, p.id, true, perms)
  }

  const remove = async (p: InstalledPlugin): Promise<void> => {
    if (window.confirm(t('plugins.confirmUninstall', { name: p.manifest.name }))) {
      await uninstall(profileId, p.id)
    }
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>{t('plugins.heading')}</h3>
        <div className="panel-header-actions">
          <button onClick={() => install(profileId)} title={t('plugins.installFolderTitle')}>
            {t('plugins.folder')}
          </button>
          <button onClick={() => installZip(profileId)} title={t('plugins.installZipTitle')}>
            {t('plugins.zip')}
          </button>
          <button className="btn-ghost" onClick={() => scaffoldExample(profileId)}>
            {t('plugins.addExample')}
          </button>
        </div>
      </div>
      <div className="panel-body">
        <div style={{ fontSize: '0.78em', color: 'var(--rpt-text-secondary)', marginBottom: 10 }}>
          {t('plugins.help')}
        </div>

        {plugins.length === 0 ? (
          <div style={{ opacity: 0.6, fontStyle: 'italic', padding: '20px 0' }}>
            {t('plugins.empty')}
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
  const t = useT()
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
          {plugin.enabled ? t('plugins.on') : t('plugins.off')}
        </button>
        <button className="btn-ghost danger" onClick={onRemove} title={t('common.uninstall')}>
          🗑
        </button>
      </div>
      <div className="entry-body" style={{ display: 'block' }}>
        {m.description && (
          <div style={{ fontSize: '0.85em', marginBottom: 8 }}>{m.description}</div>
        )}
        {plugin.error ? (
          <div style={{ color: 'var(--rpt-danger)', fontSize: '0.82em' }}>⚠ {plugin.error}</div>
        ) : (
          <div className="plugin-perms">
            {m.permissions.length === 0 ? (
              <span className="perm-chip">{t('plugins.noPerms')}</span>
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
