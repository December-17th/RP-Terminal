// The agent-pack IMPORT inspection sheet (agent-packs plan WP4.3) — the TRUST moment: where a
// stranger's `.rptagent` file earns the right to run. The caller (Installed pane) runs
// importAgentPackDialog first; a null result (canceled dialog) never mounts this. So this component
// always receives a real InspectionReport and renders one of two shapes:
//
//   · parse-error sheet — the file never parsed (too-large / invalid-json / unsupported-version /
//     invalid-envelope / not-a-fragment / invalid-fragment). No token, nothing to confirm; a designed
//     error sheet localizes each code. Dismiss just closes (no token to cancel).
//   · inspection sheet — identity + dedupe chip, REUSED capability chips with the nodes-per-capability
//     expand, bundled-template outcomes in plain language, warnings verbatim, blocker reason-cards
//     (unknown-node-types lists the types INSIDE the card, not as chips), and a footer with Cancel
//     (cancelAgentPackImport) / Install (disabled while blockers exist).
//
// TOKEN SEMANTICS (grounded in WP4.2's agentPackTransferService):
//   · The report's `token` is single-use: confirmAgentPackImport(token) consumes it on BOTH success
//     AND blocked-refusal. cancelAgentPackImport(token) drops it.
//   · So dismiss WITHOUT installing → cancel the token (Escape / backdrop / Cancel).
//   · Install → confirm(token). On the ok result: toast + refresh the Installed list.
//   · VERSION-CONFLICT: the store PK can't hold two versions of one id (WP1.4 debt), so a same-id-
//     different-version file is refused with a version-conflict blocker. WP4.3b exposed the uninstall
//     IPC (uninstallAgentPack), so the recovery is now WIRED (not just explained): the conflict card
//     carries a destructive "Uninstall installed vX, then install" action with an explicit confirm
//     sub-step. GROUNDED sequence — because confirmAgentPackImport(token) re-checks blockers and
//     consumes the token only when CALLED, the token is STILL LIVE while Install is disabled. So the
//     recovery is: uninstall the installed pack → confirm(SAME token) DIRECTLY (no re-inspect) — the
//     version-conflict blocker vanishes on the confirm-time re-check and the install proceeds. Uninstall
//     failure (a builtin conflict — the incoming id collides with a built-in pack, which is
//     uninstallable) surfaces inline on the card; the token stays alive and Cancel still works.

import React from 'react'
import { useT } from '../../i18n'
import { useToastStore } from '../../stores/toastStore'
import { useWcvSuppression } from '../useWcvSuppression'
import {
  inspectionModel,
  blockerCopy,
  parseErrorTitleKey,
  parseErrorBodyKey,
  parseErrorHasDetails,
  templateOutcomeKey,
  dedupeChipKey,
  type InspectionReport,
  type InspectionModel,
  type CapabilityRow,
  type ImportBlocker
} from './agentPackTransferDisplay'

const api = (): any => (window as unknown as { api: any }).api

type ConfirmResult =
  | { ok: true; installed: 'installed' | 'already-installed'; pack: { id: string; name: string } }
  | { ok: false; code: 'expired' }
  | { ok: false; code: 'blocked'; blockers: ImportBlocker[] }

export const AgentPackImportInspector: React.FC<{
  /** The profile the file was inspected for — the uninstall recovery targets this profile's library. */
  profileId: string
  report: InspectionReport
  /** Called after the sheet has been dealt with (installed, canceled, or dismissed) so the host can
   *  close it. `installedId` is the id of a freshly-installed pack (for the 'just installed' highlight
   *  + list refresh); undefined when nothing installed. */
  onClose: (installedId?: string) => void
}> = ({ profileId, report, onClose }) => {
  const t = useT()
  const pushToast = useToastStore((s) => s.push)
  useWcvSuppression()

  const model = React.useMemo(() => inspectionModel(report), [report])
  const [installing, setInstalling] = React.useState(false)
  // A confirm that came back 'expired' (TTL-swept / consumed) or 'blocked' — surfaced inline so the
  // user knows to re-import rather than silently failing.
  const [confirmError, setConfirmError] = React.useState<'expired' | 'blocked' | null>(null)

  // Focus the sheet on mount so Escape + Tab are captured.
  const sheetRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    sheetRef.current?.focus()
  }, [])

  // Dismiss WITHOUT installing = cancel the token (idempotent main-side; a no-op for a parse-error
  // report with no token). Then close with no installedId.
  const dismiss = React.useCallback(() => {
    if (model.token) void api().cancelAgentPackImport(model.token)
    onClose()
  }, [model.token, onClose])

  // Confirm the stashed import token → the normal success path (toast + close with the just-installed
  // id for the highlight/refresh). Shared by the footer Install button AND the version-conflict
  // recovery (which calls this with the SAME token right after uninstalling the installed pack — the
  // conflict blocker is gone on confirm's re-check, so this proceeds). Returns whether it succeeded so
  // the recovery can leave its own error state alone when confirm itself refuses.
  const confirmToken = React.useCallback(async (): Promise<boolean> => {
    if (!model.token) return false
    setConfirmError(null)
    try {
      const res = (await api().confirmAgentPackImport(model.token)) as ConfirmResult
      if (res.ok) {
        const name = res.pack.name
        pushToast(
          res.installed === 'installed'
            ? t('agents.import.installedToast', { name })
            : t('agents.import.alreadyToast', { name })
        )
        onClose(res.pack.id)
        return true
      }
      setConfirmError(res.code)
      return false
    } catch {
      setConfirmError('expired')
      return false
    }
  }, [model.token, onClose, pushToast, t])

  const doInstall = React.useCallback(async () => {
    if (!model.canInstall) return
    setInstalling(true)
    const ok = await confirmToken()
    if (!ok) setInstalling(false)
  }, [model.canInstall, confirmToken])

  // Version-conflict recovery (WP4.3b): uninstall the installed conflicting pack, then confirm the
  // SAME token directly (no re-inspect — the token is still live; the conflict blocker vanishes on the
  // confirm-time re-check). On uninstall failure (a builtin conflict) the error is rendered on the card
  // and the token stays alive; Cancel still works.
  const recoverFromConflict = React.useCallback(async (): Promise<
    { ok: true } | { ok: false; code: 'builtin' | 'not-found' | 'error' }
  > => {
    if (!model.token || model.conflictInstalledVersion === undefined)
      return { ok: false, code: 'error' }
    let uninstalled: { ok: true } | { ok: false; code: 'builtin' | 'not-found' }
    try {
      uninstalled = (await api().uninstallAgentPack(profileId, report.envelopeMeta!.id)) as typeof uninstalled
    } catch {
      return { ok: false, code: 'error' }
    }
    if (!uninstalled.ok) return uninstalled
    // Uninstall succeeded — confirm the same token. A confirmToken failure (expired etc.) surfaces via
    // its own inline confirmError; we report ok:true here because the destructive step itself worked.
    await confirmToken()
    return { ok: true }
  }, [model.token, model.conflictInstalledVersion, profileId, report.envelopeMeta, confirmToken])

  return (
    <div
      className="modal-overlay"
      onClick={dismiss}
      onKeyDown={(e) => {
        if (e.key === 'Escape') dismiss()
      }}
    >
      <div
        ref={sheetRef}
        className="rpt-transfer-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('agents.import.title')}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="rpt-transfer-head">
          <h2 className="rpt-transfer-title">{t('agents.import.title')}</h2>
          <button
            type="button"
            className="rpt-transfer-close"
            aria-label={t('agents.import.close')}
            onClick={dismiss}
          >
            ×
          </button>
        </header>

        <div className="rpt-transfer-body">
          {model.kind === 'parse-error' ? (
            <ParseErrorSheet model={model} />
          ) : (
            <ReportSheet
              model={model}
              confirmError={confirmError}
              onRecoverConflict={recoverFromConflict}
            />
          )}
        </div>

        <footer className="rpt-transfer-footer">
          <button type="button" className="rpt-duel-secondary" onClick={dismiss}>
            {model.kind === 'parse-error'
              ? t('agents.import.dismiss')
              : t('agents.import.cancel')}
          </button>
          {model.kind === 'report' && (
            <button
              type="button"
              className="btn-accent"
              onClick={() => void doInstall()}
              disabled={!model.canInstall || installing}
              title={model.canInstall ? undefined : t('agents.import.installBlocked')}
            >
              {installing ? t('agents.import.installing') : t('agents.import.install')}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

// ── Parse-error sheet — the designed error state for an unreadable file ───────────────────────────────
const ParseErrorSheet: React.FC<{ model: InspectionModel }> = ({ model }) => {
  const t = useT()
  const err = model.parseError!
  return (
    <div className="rpt-transfer-state">
      <div className="rpt-transfer-state-icon danger" aria-hidden>
        ⚠
      </div>
      <h3 className="rpt-transfer-state-title">{t(parseErrorTitleKey(err.code))}</h3>
      <p className="rpt-transfer-state-body">
        {t(parseErrorBodyKey(err.code), {
          // unsupported-version's body interpolates the found version (best-effort stringify).
          found: err.foundVersion === undefined ? '' : String(err.foundVersion)
        })}
      </p>
      {parseErrorHasDetails(err) && (
        <ul className="rpt-transfer-errlist">
          {err.errors!.slice(0, 6).map((e, i) => (
            <li key={i} className="rpt-transfer-errline">
              {e}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── Inspection report sheet — the trust screen ────────────────────────────────────────────────────────
const ReportSheet: React.FC<{
  model: InspectionModel
  confirmError: 'expired' | 'blocked' | null
  /** Run the version-conflict recovery (uninstall the installed pack, then confirm the same token).
   *  Only the version-conflict blocker card invokes it. */
  onRecoverConflict: () => Promise<{ ok: true } | { ok: false; code: 'builtin' | 'not-found' | 'error' }>
}> = ({ model, confirmError, onRecoverConflict }) => {
  const t = useT()
  const id = model.identity

  return (
    <>
      <p className="rpt-transfer-lede">{t('agents.import.lede')}</p>

      {/* Identity + dedupe chip. */}
      {id && (
        <section className="rpt-inspect-section">
          <div className="rpt-inspect-identity">
            <span className="rpt-inspect-name">{id.name}</span>
            {model.dedupe && (
              <span className={`rpt-inspect-dedupe ${model.dedupe}`}>
                {t(dedupeChipKey(model.dedupe))}
              </span>
            )}
          </div>
          <span className="rpt-inspect-meta">
            {id.creator ? `${id.creator} · ` : ''}
            {t('agents.version', { v: id.version })}
          </span>
          {id.fork && (
            <p className="rpt-inspect-fork">
              {t('agents.import.forkLineage', { base: id.fork.base, n: id.fork.n })}
            </p>
          )}
          {/* WP4.6/4.7: 'new-version' = the same pack id, a DIFFERENT version already installed. It
              installs ALONGSIDE the existing version(s) — nothing is overwritten; you pick which runs
              per world afterward. One honest line so the chip isn't cryptic. */}
          {model.dedupe === 'new-version' && (
            <p className="rpt-inspect-dedupe-note">
              {t('agents.import.newVersionNote', { v: id.version })}
            </p>
          )}
        </section>
      )}

      {/* Derived capabilities — REUSED chips with the nodes-per-capability expand. */}
      <section className="rpt-inspect-section">
        <h3 className="rpt-inspect-sectiontitle">{t('agents.import.capTitle')}</h3>
        {model.capabilities.length === 0 ? (
          <p className="rpt-inspect-empty">{t('agents.import.capNone')}</p>
        ) : (
          <ul className="rpt-inspect-caplist">
            {model.capabilities.map((cap) => (
              <CapabilityItem key={cap.id} cap={cap} />
            ))}
          </ul>
        )}
      </section>

      {/* Bundled templates + per-item outcome in plain language. */}
      {model.templatePlans.length > 0 && (
        <section className="rpt-inspect-section">
          <h3 className="rpt-inspect-sectiontitle">{t('agents.import.templateTitle')}</h3>
          <ul className="rpt-inspect-templates">
            {model.templatePlans.map((tp) => (
              <li key={tp.name} className="rpt-inspect-template">
                <span className="rpt-inspect-template-name">{tp.name}</span>
                <span className={`rpt-inspect-template-outcome ${tp.outcome}`}>
                  {t(templateOutcomeKey(tp.outcome))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Blockers — each a clear reason card; Install is disabled while any exist. */}
      {model.blockers.length > 0 && (
        <section className="rpt-inspect-section">
          <h3 className="rpt-inspect-sectiontitle danger">{t('agents.import.blockersTitle')}</h3>
          <p className="rpt-inspect-note">{t('agents.import.blockersLede')}</p>
          <ul className="rpt-inspect-blockers">
            {model.blockers.map((b, i) => (
              <BlockerCard key={i} blocker={b} onRecoverConflict={onRecoverConflict} />
            ))}
          </ul>
        </section>
      )}

      {/* Warnings — muted but visible, verbatim from the report. */}
      {model.warnings.length > 0 && (
        <section className="rpt-inspect-section">
          <h3 className="rpt-inspect-sectiontitle">{t('agents.import.warnTitle')}</h3>
          <ul className="rpt-inspect-warnings">
            {model.warnings.map((w, i) => (
              <li key={i} className="rpt-inspect-warning">
                {w}
              </li>
            ))}
          </ul>
        </section>
      )}

      {confirmError && (
        <p className="rpt-transfer-inline-error">
          {confirmError === 'expired'
            ? t('agents.import.confirmExpired')
            : t('agents.import.confirmBlocked')}
        </p>
      )}
    </>
  )
}

// One blocker reason-card. unknown-node-types lists the types inside; version-conflict carries the
// WIRED destructive recovery (WP4.3b): "Uninstall installed vX, then install" → explicit confirm
// sub-step (names the pack + version being removed) → uninstall + confirm the same token.
const BlockerCard: React.FC<{
  blocker: ImportBlocker
  onRecoverConflict: () => Promise<{ ok: true } | { ok: false; code: 'builtin' | 'not-found' | 'error' }>
}> = ({ blocker, onRecoverConflict }) => {
  const t = useT()
  const copy = blockerCopy(blocker)
  return (
    <li className="rpt-inspect-blocker">
      <div className="rpt-inspect-blocker-head">
        <span className="rpt-inspect-blocker-icon" aria-hidden>
          ⛔
        </span>
        <span className="rpt-inspect-blocker-title">{t(copy.titleKey)}</span>
      </div>
      <p className="rpt-inspect-blocker-body">{t(copy.bodyKey, copy.vars)}</p>
      {copy.nodeTypes.length > 0 && (
        <ul className="rpt-inspect-blocker-nodes">
          {copy.nodeTypes.map((nt) => (
            <li key={nt} className="rpt-inspect-blocker-node">
              {nt}
            </li>
          ))}
        </ul>
      )}
      {blocker.code === 'version-conflict' && (
        <ConflictRecovery
          installedVersion={blocker.installedVersion}
          onRecover={onRecoverConflict}
        />
      )}
    </li>
  )
}

// The version-conflict recovery affordance: a destructive-styled button that reveals an explicit
// confirm sub-step (naming the installed version being removed) before running uninstall + re-confirm.
// A builtin conflict (the installed pack is a built-in, uninstallable) surfaces its refusal inline; the
// import token stays alive and Cancel still closes the sheet.
const ConflictRecovery: React.FC<{
  installedVersion: number
  onRecover: () => Promise<{ ok: true } | { ok: false; code: 'builtin' | 'not-found' | 'error' }>
}> = ({ installedVersion, onRecover }) => {
  const t = useT()
  const [confirming, setConfirming] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<'builtin' | 'not-found' | 'error' | null>(null)

  const run = React.useCallback(async () => {
    setBusy(true)
    setError(null)
    const res = await onRecover()
    // On ok the whole sheet closes (success path); we only land here on failure.
    if (!res.ok) {
      setError(res.code)
      setBusy(false)
      setConfirming(false)
    }
  }, [onRecover])

  if (!confirming) {
    return (
      <div className="rpt-inspect-blocker-recovery">
        <button
          type="button"
          className="rpt-inspect-blocker-uninstall danger"
          onClick={() => setConfirming(true)}
        >
          {t('agents.import.conflictUninstall', { installed: installedVersion })}
        </button>
        {error && (
          <p className="rpt-inspect-blocker-uninstall-error">
            {t(
              error === 'builtin'
                ? 'agents.import.conflictBuiltin'
                : 'agents.import.conflictUninstallFailed'
            )}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="rpt-inspect-blocker-recovery">
      <p className="rpt-inspect-blocker-confirm">
        {t('agents.import.conflictConfirm', { installed: installedVersion })}
      </p>
      <div className="rpt-inspect-blocker-confirm-actions">
        <button
          type="button"
          className="rpt-duel-secondary"
          onClick={() => setConfirming(false)}
          disabled={busy}
        >
          {t('agents.import.conflictKeep')}
        </button>
        <button
          type="button"
          className="rpt-inspect-blocker-uninstall danger"
          onClick={() => void run()}
          disabled={busy}
        >
          {busy
            ? t('agents.import.conflictWorking')
            : t('agents.import.conflictConfirmBtn')}
        </button>
      </div>
    </div>
  )
}

// One capability row (shared with the export wizard's shape): REUSED chip + node count, expandable to
// the conferring node ids. Kept local (tiny) rather than a shared export to avoid a cross-component
// import chain — both components render the same view-model.
const CapabilityItem: React.FC<{ cap: CapabilityRow }> = ({ cap }) => {
  const t = useT()
  const [open, setOpen] = React.useState(false)
  const hasNodes = cap.nodeIds.length > 0
  return (
    <li className="rpt-inspect-capitem">
      <button
        type="button"
        className="rpt-inspect-caprow"
        aria-expanded={hasNodes ? open : undefined}
        disabled={!hasNodes}
        onClick={() => hasNodes && setOpen((v) => !v)}
      >
        <span className={`rpt-agents-chip${cap.write ? ' write' : ''}`}>
          {t(`agents.cap.${cap.id}`)}
        </span>
        <span className="rpt-inspect-capcount">
          {hasNodes
            ? t('agents.transfer.nodeCount', { n: cap.nodeIds.length })
            : t('agents.transfer.fromStructure')}
        </span>
        {hasNodes && (
          <span className="rpt-inspect-capcaret" aria-hidden>
            {open ? '▾' : '▸'}
          </span>
        )}
      </button>
      {open && hasNodes && (
        <ul className="rpt-inspect-capnodes">
          {cap.nodeIds.map((nid) => (
            <li key={nid} className="rpt-inspect-capnode">
              {nid}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
