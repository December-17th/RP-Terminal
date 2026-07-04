// The Agents pack DETAIL panel (agent-packs plan WP3.2 — tiered settings with provenance).
//
// Opens when a pack card is clicked (AgentsView). Three groups (UX brief §Settings):
//   · SYSTEM — auto-derived trigger params (backlog N, watched table, cadence) + an honest
//     "more controls coming" note. Shown ONLY for packs that have triggers (hasTriggers).
//   · PACK SETTINGS — creator-exposed settings (hidden when the pack exposes none).
//   · ADVANCED — an "Open in Workflow Studio" hand-off (opens the editor in Effective mode via
//     uiStore) + one sentence that editing a pack = forking it (ADR 0006).
//
// Each control carries a PROVENANCE chip (default / this world / this chat — from getAgentPackSettings'
// resolved.provenance, computed main-side, never re-derived here) and a reset-to-default that clears the
// NEAREST override scope (clearing chat reveals world). Writes go to WORLD scope by default; a subtle
// scope switcher toggles world/chat. Skeleton loading, inline error, keyboard-accessible, all strings
// via t(), tokens/AA like WP3.1 (styles in assets/index.css .rpt-agentdetail-*).
//
// Grounding: the pure display derivations in ./agentPackSettingsDisplay.ts (label / provenance / reset),
// the IPC surface (getAgentPackSettings + setAgentPackOverride + clearAgentPackOverride), ADR 0005 scopes.

import React from 'react'
import { useT, useI18nStore } from '../../i18n'
import { useUiStore } from '../../stores/uiStore'
import { AgentPackExportWizard } from './AgentPackExportWizard'
import {
  resolveSettingLabel,
  systemLabelKey,
  provenanceChipKey,
  canReset,
  nearestOverrideScope,
  type PackSettingView,
  type WriteScope
} from './agentPackSettingsDisplay'

const api = (): any => (window as unknown as { api: any }).api

interface PackSettingsPayload {
  packId: string
  hasTriggers: boolean
  packSettings: PackSettingView[]
  systemSettings: PackSettingView[]
}

/** Encode a WriteScope + world/chat ids into the OverrideScope IPC shape (agentPackStore). */
const encodeWriteScope = (
  scope: WriteScope,
  worldId: string,
  chatId: string | null
): { world: string } | { chat: string } | null =>
  scope === 'chat' ? (chatId ? { chat: chatId } : null) : { world: worldId }

export const AgentPackDetail: React.FC<{
  profileId: string
  packId: string
  packName: string
  /** Whether this pack is a built-in (built-ins can't be exported — fork first). */
  builtin: boolean
  worldId: string
  chatId: string | null
  onClose: () => void
  /** Called after the pack was uninstalled (WP4.3b) so the host can refresh the list + drop the detail
   *  panel. Undefined disables the Advanced-group uninstall action (the host didn't wire a refresh). */
  onUninstalled?: () => void
}> = ({ profileId, packId, packName, builtin, worldId, chatId, onClose, onUninstalled }) => {
  const t = useT()
  const locale = useI18nStore((s) => s.locale)
  const openWorkflowEditor = useUiStore((s) => s.openWorkflowEditor)
  // The export wizard mounts over the whole control center (its own modal overlay) when opened here.
  const [exporting, setExporting] = React.useState(false)
  // Uninstall (WP4.3b): a destructive Advanced action with an explicit confirm sub-step. Built-ins are
  // uninstallable (a note replaces the button). `confirmingUninstall` reveals the confirm row.
  const [confirmingUninstall, setConfirmingUninstall] = React.useState(false)
  const [uninstalling, setUninstalling] = React.useState(false)
  const [uninstallError, setUninstallError] = React.useState(false)

  const doUninstall = React.useCallback(async () => {
    setUninstalling(true)
    setUninstallError(false)
    try {
      const res = (await api().uninstallAgentPack(profileId, packId)) as
        | { ok: true }
        | { ok: false; code: 'builtin' | 'not-found' }
      if (res.ok || res.code === 'not-found') {
        // Success — or the pack was already gone (treat as done). Refresh the list + close the panel.
        onUninstalled?.()
      } else {
        // 'builtin' — shouldn't reach here (the button is builtin-disabled), but surface honestly.
        setUninstallError(true)
        setUninstalling(false)
        setConfirmingUninstall(false)
      }
    } catch {
      setUninstallError(true)
      setUninstalling(false)
      setConfirmingUninstall(false)
    }
  }, [profileId, packId, onUninstalled])

  const [data, setData] = React.useState<PackSettingsPayload | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(false)
  const [scope, setScope] = React.useState<WriteScope>('world')
  // Per-setting inline error (a rejected write) keyed by setting id.
  const [writeError, setWriteError] = React.useState<Record<string, boolean>>({})

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const res = (await api().getAgentPackSettings(
        profileId,
        packId,
        worldId,
        chatId
      )) as PackSettingsPayload | null
      setData(res)
    } catch {
      setError(true)
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [profileId, packId, worldId, chatId])

  React.useEffect(() => {
    void load()
  }, [load])

  // A chat-scope write is only possible with an active chat; fall back to world if none.
  const effectiveScope: WriteScope = scope === 'chat' && !chatId ? 'world' : scope

  const writeOverride = React.useCallback(
    async (setting: PackSettingView, value: unknown) => {
      const enc = encodeWriteScope(effectiveScope, worldId, chatId)
      if (!enc) return
      setWriteError((e) => ({ ...e, [setting.id]: false }))
      try {
        await api().setAgentPackOverride(packId, enc, setting.id, value)
        await load()
      } catch {
        setWriteError((e) => ({ ...e, [setting.id]: true }))
      }
    },
    [effectiveScope, worldId, chatId, packId, load]
  )

  const resetSetting = React.useCallback(
    async (setting: PackSettingView) => {
      const near = nearestOverrideScope(setting)
      if (!near) return
      // Reset clears the NEAREST scope that holds an override (clearing chat reveals world). `global`
      // is a valid clear target too (ADR 0005) even though writes only target world/chat here.
      const enc =
        near === 'global'
          ? ('global' as const)
          : near === 'chat'
            ? chatId
              ? ({ chat: chatId } as const)
              : null
            : ({ world: worldId } as const)
      if (!enc) return
      try {
        await api().clearAgentPackOverride(packId, enc, setting.id)
        await load()
      } catch {
        setWriteError((e) => ({ ...e, [setting.id]: true }))
      }
    },
    [packId, worldId, chatId, load]
  )

  return (
    <aside className="rpt-agentdetail" role="dialog" aria-modal="false" aria-label={packName}>
      <header className="rpt-agentdetail-head">
        <h2 className="rpt-agentdetail-title">{packName}</h2>
        <button
          type="button"
          className="rpt-agentdetail-close"
          aria-label={t('agents.settings.close')}
          onClick={onClose}
        >
          ×
        </button>
      </header>

      {/* Scope switcher — subtle; writes target this scope. Chat disabled without an active chat. */}
      <div className="rpt-agentdetail-scope" role="radiogroup" aria-label={t('agents.settings.scopeLabel')}>
        {(['world', 'chat'] as WriteScope[]).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={effectiveScope === s}
            disabled={s === 'chat' && !chatId}
            className={`rpt-agentdetail-scopebtn${effectiveScope === s ? ' active' : ''}`}
            onClick={() => setScope(s)}
            title={s === 'chat' && !chatId ? t('agents.settings.scopeChatDisabled') : undefined}
          >
            {t(s === 'world' ? 'agents.settings.scopeWorld' : 'agents.settings.scopeChat')}
          </button>
        ))}
      </div>

      <div className="rpt-agentdetail-body">
        {loading ? (
          <div className="rpt-agentdetail-skel" aria-hidden>
            <div className="rpt-agents-skel-line" />
            <div className="rpt-agents-skel-line short" />
            <div className="rpt-agents-skel-line" />
          </div>
        ) : error ? (
          <div className="rpt-agentdetail-error">
            <p>{t('agents.settings.loadError')}</p>
            <button className="btn-accent" onClick={() => void load()}>
              {t('agents.retry')}
            </button>
          </div>
        ) : !data ? (
          <p className="rpt-agentdetail-empty">{t('agents.settings.notInstalled')}</p>
        ) : (
          <>
            {/* SYSTEM group — only for packs with triggers. */}
            {data.hasTriggers && (
              <section className="rpt-agentdetail-group">
                <h3 className="rpt-agentdetail-grouptitle">{t('agents.settings.systemGroup')}</h3>
                {data.systemSettings.map((s) => (
                  <SettingRow
                    key={s.id}
                    setting={s}
                    locale={locale}
                    writeError={!!writeError[s.id]}
                    onWrite={(v) => void writeOverride(s, v)}
                    onReset={() => void resetSetting(s)}
                  />
                ))}
                {/* Honest "more controls coming" note — the system-tier settings from the spec (token
                    budget / retry policy / API-preset override) have NO engine machinery yet. */}
                <p className="rpt-agentdetail-note">{t('agents.settings.systemMoreComing')}</p>
              </section>
            )}

            {/* PACK SETTINGS group — hidden if the pack exposes none. */}
            {data.packSettings.length > 0 && (
              <section className="rpt-agentdetail-group">
                <h3 className="rpt-agentdetail-grouptitle">{t('agents.settings.packGroup')}</h3>
                {data.packSettings.map((s) => (
                  <SettingRow
                    key={s.id}
                    setting={s}
                    locale={locale}
                    writeError={!!writeError[s.id]}
                    onWrite={(v) => void writeOverride(s, v)}
                    onReset={() => void resetSetting(s)}
                  />
                ))}
              </section>
            )}

            {/* ADVANCED group — the Workflow Studio hand-off, the fork sentence, and the Export
                affordance (sharing loop close — WP4.3). Built-ins can't export (fork first); the
                affordance says so instead of offering a dead button. */}
            <section className="rpt-agentdetail-group">
              <h3 className="rpt-agentdetail-grouptitle">{t('agents.settings.advancedGroup')}</h3>
              <button
                type="button"
                className="rpt-agentdetail-studio"
                onClick={() => {
                  onClose()
                  openWorkflowEditor({ initialMode: 'effective' })
                }}
              >
                {t('agents.settings.openStudio')}
              </button>
              {/* Direct fragment editing (WP4.4). A NON-builtin pack (a fork, or an imported install)
                  opens as an EDITABLE fragment session in Studio — full drag / rewire / add-node, save
                  writes back to this pack. A builtin can't be edited in place (edit by forking): it
                  keeps only the Effective-mode hand-off above (where the first edit forks). */}
              {builtin ? (
                <p className="rpt-agentdetail-note">{t('agents.settings.editFragmentBuiltinHint')}</p>
              ) : (
                <button
                  type="button"
                  className="rpt-agentdetail-studio"
                  onClick={() => {
                    onClose()
                    openWorkflowEditor({ fragmentPackId: packId })
                  }}
                >
                  {t('agents.settings.editFragment')}
                </button>
              )}
              <p className="rpt-agentdetail-note">{t('agents.settings.forkNote')}</p>

              {builtin ? (
                <p className="rpt-agentdetail-note">{t('agents.export.builtinHint')}</p>
              ) : (
                <button
                  type="button"
                  className="rpt-agentdetail-studio"
                  onClick={() => setExporting(true)}
                >
                  {t('agents.export.open')}
                </button>
              )}

              {/* Uninstall — the destructive library-removal action (WP4.3b). Built-ins are
                  uninstallable, so a note replaces the button. Only offered when the host wired a
                  refresh (onUninstalled); a confirm sub-step gates the actual removal. */}
              {onUninstalled &&
                (builtin ? (
                  <p className="rpt-agentdetail-note">{t('agents.settings.uninstallBuiltinHint')}</p>
                ) : !confirmingUninstall ? (
                  <>
                    <button
                      type="button"
                      className="rpt-agentdetail-uninstall danger"
                      onClick={() => {
                        setUninstallError(false)
                        setConfirmingUninstall(true)
                      }}
                    >
                      {t('agents.settings.uninstall')}
                    </button>
                    {uninstallError && (
                      <p className="rpt-agentdetail-rowerror">{t('agents.settings.uninstallFailed')}</p>
                    )}
                  </>
                ) : (
                  <div className="rpt-agentdetail-uninstall-confirm">
                    <p className="rpt-agentdetail-note">
                      {t('agents.settings.uninstallConfirm', { name: packName })}
                    </p>
                    <div className="rpt-agentdetail-uninstall-actions">
                      <button
                        type="button"
                        className="rpt-duel-secondary"
                        onClick={() => setConfirmingUninstall(false)}
                        disabled={uninstalling}
                      >
                        {t('agents.settings.uninstallKeep')}
                      </button>
                      <button
                        type="button"
                        className="rpt-agentdetail-uninstall danger"
                        onClick={() => void doUninstall()}
                        disabled={uninstalling}
                      >
                        {uninstalling
                          ? t('agents.settings.uninstallWorking')
                          : t('agents.settings.uninstallConfirmBtn')}
                      </button>
                    </div>
                  </div>
                ))}
            </section>
          </>
        )}
      </div>

      {exporting && (
        <AgentPackExportWizard
          profileId={profileId}
          packId={packId}
          onClose={() => setExporting(false)}
        />
      )}
    </aside>
  )
}

// ── One setting row: label + provenance chip + typed control + reset ──────────────────────────────────
const SettingRow: React.FC<{
  setting: PackSettingView
  locale: string
  writeError: boolean
  onWrite: (value: unknown) => void
  onReset: () => void
}> = ({ setting, locale, writeError, onWrite, onReset }) => {
  const t = useT()
  const label =
    setting.kind === 'system'
      ? t(systemLabelKey(setting.labelKind))
      : resolveSettingLabel(setting.label, locale, setting.id)
  const value = setting.resolved.value

  return (
    <div className="rpt-agentdetail-row">
      <div className="rpt-agentdetail-rowhead">
        <label className="rpt-agentdetail-rowlabel" htmlFor={`setting-${setting.id}`}>
          {label}
        </label>
        <span
          className={`rpt-agentdetail-prov ${setting.resolved.provenance}`}
          title={t('agents.settings.provTitle')}
        >
          {t(provenanceChipKey(setting.resolved.provenance))}
        </span>
      </div>

      <div className="rpt-agentdetail-control">
        <Control id={`setting-${setting.id}`} setting={setting} value={value} onWrite={onWrite} />
        {canReset(setting) && (
          <button
            type="button"
            className="rpt-agentdetail-reset"
            onClick={onReset}
            title={t('agents.settings.resetTitle')}
          >
            {t('agents.settings.reset')}
          </button>
        )}
      </div>

      {writeError && <p className="rpt-agentdetail-rowerror">{t('agents.settings.writeError')}</p>}
    </div>
  )
}

// ── The typed input for one setting ───────────────────────────────────────────────────────────────────
const Control: React.FC<{
  id: string
  setting: PackSettingView
  value: unknown
  onWrite: (value: unknown) => void
}> = ({ id, setting, value, onWrite }) => {
  if (setting.type === 'boolean') {
    return (
      <input
        id={id}
        type="checkbox"
        checked={value === true}
        onChange={(e) => onWrite(e.target.checked)}
      />
    )
  }
  if (setting.type === 'enum') {
    return (
      <select
        id={id}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onWrite(e.target.value)}
      >
        {(setting.options ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    )
  }
  if (setting.type === 'number') {
    return (
      <input
        id={id}
        type="number"
        value={typeof value === 'number' ? value : ''}
        min={setting.min}
        max={setting.max}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (!Number.isNaN(n)) onWrite(n)
        }}
      />
    )
  }
  // string
  return (
    <input
      id={id}
      type="text"
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onWrite(e.target.value)}
    />
  )
}
