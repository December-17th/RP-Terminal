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
  /** WP4.7: the version this panel is configuring (the pinned active version, else the highest). Shown
   *  prominently in the header so "which version am I configuring" is never ambiguous. */
  activeVersion: number
  /** WP4.7: every installed version of this id, ascending. Drives the header switcher + the multi-
   *  version note + the version-aware uninstall copy. */
  versions: number[]
  worldId: string
  chatId: string | null
  onClose: () => void
  /** Fork this pack for the active world (WP4.5). The host owns the post-fork flow (toast + refresh +
   *  highlight + re-open the detail on the new fork). Undefined hides the Advanced-group Fork button
   *  (the host didn't wire it). Fork-a-fork is legitimate, so this is offered for non-builtins too. */
  onFork?: () => void
  /** WP4.7: re-pin which installed version runs in this world. The host owns the IPC + refresh + toast.
   *  Undefined (or a single-version pack) hides the header switcher. */
  onSwitchVersion?: (version: number) => void
  /** Called after the pack was uninstalled (WP4.3b) so the host can refresh the list + drop the detail
   *  panel. Undefined disables the Advanced-group uninstall action (the host didn't wire a refresh). */
  onUninstalled?: () => void
}> = ({
  profileId,
  packId,
  packName,
  builtin,
  activeVersion,
  versions,
  worldId,
  chatId,
  onClose,
  onFork,
  onSwitchVersion,
  onUninstalled
}) => {
  const t = useT()
  const locale = useI18nStore((s) => s.locale)
  const openWorkflowEditor = useUiStore((s) => s.openWorkflowEditor)
  // WP4.7: does this id have coexisting versions? Drives the header switcher, the multi-version note,
  // and the version-aware uninstall copy. The switcher list is newest-first (latest at top).
  const multiVersion = versions.length > 1
  const versionsDesc = React.useMemo(() => [...versions].sort((a, b) => b - a), [versions])
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
      // WP4.7: with coexisting versions, uninstall ONLY the version being configured (activeVersion);
      // the others stay installed. A single-version pack omits the version → the store removes it and
      // cascades the version-agnostic activation/override/trigger rows (the full-removal path).
      const res = (await api().uninstallAgentPack(
        profileId,
        packId,
        multiVersion ? activeVersion : undefined
      )) as { ok: true } | { ok: false; code: 'builtin' | 'not-found' }
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
  }, [profileId, packId, multiVersion, activeVersion, onUninstalled])

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
        <div className="rpt-agentdetail-identity">
          <h2 className="rpt-agentdetail-title">{packName}</h2>
          {/* WP4.7: the version being configured, prominent — "which version am I configuring" is never
              ambiguous. getAgentPackSettings resolves the PINNED version's settings, so the header names
              that same version. With coexisting versions, the switcher lets the user re-pin. */}
          <div className="rpt-agentdetail-versionrow">
            <span className="rpt-agentdetail-version">{t('agents.version', { v: activeVersion })}</span>
            {multiVersion && (
              <span className="rpt-agentdetail-versioncount">
                {t('agents.version.installedCount', { n: versions.length })}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          className="rpt-agentdetail-close"
          aria-label={t('agents.settings.close')}
          onClick={onClose}
        >
          ×
        </button>
      </header>

      {/* WP4.7: the version switcher — only with coexisting versions + a wired host callback. Re-pins
          which version RUNS in this world; the settings below apply across versions (see the note under
          the groups). Newest-first; the active one is disabled (already pinned). */}
      {multiVersion && onSwitchVersion && (
        <div
          className="rpt-agentdetail-versionswitch"
          role="radiogroup"
          aria-label={t('agents.version.popTitle')}
        >
          <span className="rpt-agentdetail-versionswitch-label">
            {t('agents.version.switchInlineLabel')}
          </span>
          {versionsDesc.map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={v === activeVersion}
              disabled={v === activeVersion}
              className={`rpt-agentdetail-versionchip${v === activeVersion ? ' active' : ''}`}
              onClick={() => onSwitchVersion(v)}
            >
              {t('agents.version', { v })}
            </button>
          ))}
        </div>
      )}

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

            {/* WP4.7: with coexisting versions, one honest line stating the TRUE override semantics —
                settings are version-AGNOSTIC (they apply to this pack in this world regardless of which
                version is pinned), so switching versions never loses them. Only shown when it can
                confuse (multiple versions installed). */}
            {multiVersion && (
              <p className="rpt-agentdetail-versionnote">{t('agents.version.settingsNote')}</p>
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
                  writes back to this pack. A builtin can't be edited in place (edit by forking): the
                  actionable Fork button below now makes that first step one click (WP4.5). */}
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

              {/* Fork this pack (WP4.5 — the missing button the owner couldn't find). Makes a private
                  copy for THIS world and repoints it; the host lands the fork's detail panel so the next
                  step (Edit fragment) is one click. Offered for BUILT-INS (the fork-first path the notes
                  above/below describe) AND non-builtins (fork-a-fork is legitimate — forkPack flattens
                  the fork base, WP3.6a). It's safe (never mutates the source), so neutral styling. */}
              {onFork && (
                <button
                  type="button"
                  className="rpt-agentdetail-studio"
                  onClick={onFork}
                  title={t('agents.fork.detailTitle')}
                >
                  {t('agents.fork.detail')}
                </button>
              )}

              {builtin ? (
                <p className="rpt-agentdetail-note">{t('agents.export.builtinHint')}</p>
              ) : (
                <>
                  <button
                    type="button"
                    className="rpt-agentdetail-studio"
                    onClick={() => setExporting(true)}
                  >
                    {t('agents.export.open')}
                  </button>
                  {/* WP4.7: export ships the HIGHEST installed version (the export IPC takes no version
                      — agentPackTransferService.buildExportEnvelope reads getPackRecord with no version,
                      ORDER BY version DESC). With coexisting versions, say so honestly so the user isn't
                      surprised the shown/pinned version may differ from what's exported. */}
                  {multiVersion && (
                    <p className="rpt-agentdetail-note">
                      {t('agents.export.versionNote', { v: versionsDesc[0] })}
                    </p>
                  )}
                </>
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
                      {/* WP4.7: with coexisting versions, the action NAMES the version being removed
                          (the others stay) — otherwise the version-less full-removal copy. */}
                      {multiVersion
                        ? t('agents.settings.uninstallVersion', {
                            v: activeVersion,
                            keep: versionsDesc.filter((v) => v !== activeVersion).join(', ')
                          })
                        : t('agents.settings.uninstall')}
                    </button>
                    {uninstallError && (
                      <p className="rpt-agentdetail-rowerror">{t('agents.settings.uninstallFailed')}</p>
                    )}
                  </>
                ) : (
                  <div className="rpt-agentdetail-uninstall-confirm">
                    <p className="rpt-agentdetail-note">
                      {multiVersion
                        ? t('agents.settings.uninstallVersionConfirm', {
                            name: packName,
                            v: activeVersion,
                            keep: versionsDesc.filter((v) => v !== activeVersion).join(', ')
                          })
                        : t('agents.settings.uninstallConfirm', { name: packName })}
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
