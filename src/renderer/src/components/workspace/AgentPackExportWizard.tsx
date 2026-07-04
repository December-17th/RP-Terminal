// The agent-pack EXPORT wizard (agent-packs plan WP4.3) — creator onboarding: it teaches what a pack
// IS (attachments + derived capabilities) at the moment a creator shares one. A two-step modal:
//
//   1. REVIEW — previewAgentPackExport rendered as the honest "this is what another user will see
//      before installing": pack identity, attachment badges, capability chips WITH a nodes-per-
//      capability expandable, the template note (bundled names or the "binds at runtime" copy), and
//      the warnings verbatim (framed as "importers will see these"). This IS the teaching moment.
//   2. SAVE — exportAgentPackDialog (native save dialog). Success shows the path + a subtle done
//      state; a canceled dialog returns to Review; errors render inline.
//
// Renderer-only: consumes WP4.2's IPC as-is. The pure view-model + copy-key mapping live in
// ./agentPackTransferDisplay.ts (Node-tested); this component owns the DOM + localized copy. Styling:
// .rpt-export-* / .rpt-inspect-* in assets/index.css, all colors via --rpt-* tokens, AA + keyboard +
// 180ms motion like the rest of the control center. The capability chips REUSE the .rpt-agents-chip
// look (same visual language builds trust).

import React from 'react'
import { useT } from '../../i18n'
import { useWcvSuppression } from '../useWcvSuppression'
import {
  exportReviewModel,
  formatBytes,
  exportErrorKey,
  type ExportPreview,
  type ExportReviewModel,
  type CapabilityRow,
  type ExportErrorCode
} from './agentPackTransferDisplay'

const api = (): any => (window as unknown as { api: any }).api

type ExportPreviewResult =
  | { ok: true; preview: ExportPreview }
  | { ok: false; error: { code: ExportErrorCode; message: string } }

type SaveState =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'saved'; path: string }
  | { phase: 'error'; code: ExportErrorCode }

export const AgentPackExportWizard: React.FC<{
  profileId: string
  packId: string
  onClose: () => void
}> = ({ profileId, packId, onClose }) => {
  const t = useT()
  useWcvSuppression()

  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState(false)
  const [model, setModel] = React.useState<ExportReviewModel | null>(null)
  const [refuse, setRefuse] = React.useState<ExportErrorCode | null>(null)
  const [save, setSave] = React.useState<SaveState>({ phase: 'idle' })

  const load = React.useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    setRefuse(null)
    try {
      const res = (await api().previewAgentPackExport(profileId, packId)) as ExportPreviewResult
      if (res.ok) setModel(exportReviewModel(res.preview))
      else setRefuse(res.error.code)
    } catch {
      setLoadError(true)
      setModel(null)
    } finally {
      setLoading(false)
    }
  }, [profileId, packId])

  React.useEffect(() => {
    void load()
  }, [load])

  const doSave = React.useCallback(async () => {
    setSave({ phase: 'saving' })
    try {
      const res = (await api().exportAgentPackDialog(profileId, packId)) as
        | { saved: string }
        | { canceled: true }
        | { ok: false; error: { code: ExportErrorCode } }
      if ('saved' in res) setSave({ phase: 'saved', path: res.saved })
      else if ('canceled' in res) setSave({ phase: 'idle' }) // returns to Review
      else setSave({ phase: 'error', code: res.error.code })
    } catch {
      setSave({ phase: 'error', code: 'not-installed' })
    }
  }, [profileId, packId])

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div
        className="rpt-transfer-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('agents.export.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="rpt-transfer-head">
          <h2 className="rpt-transfer-title">{t('agents.export.title')}</h2>
          <button
            type="button"
            className="rpt-transfer-close"
            aria-label={t('agents.export.close')}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="rpt-transfer-body">
          {loading ? (
            <div className="rpt-transfer-skel" aria-hidden>
              <div className="rpt-agents-skel-line" />
              <div className="rpt-agents-skel-line short" />
              <div className="rpt-agents-skel-line" />
            </div>
          ) : loadError ? (
            <div className="rpt-transfer-state">
              <p>{t('agents.export.loadError')}</p>
              <button className="btn-accent" onClick={() => void load()}>
                {t('agents.retry')}
              </button>
            </div>
          ) : refuse ? (
            <div className="rpt-transfer-state">
              <div className="rpt-transfer-state-icon" aria-hidden>
                ⓘ
              </div>
              <h3 className="rpt-transfer-state-title">{t(exportErrorKey(refuse))}</h3>
              {refuse === 'builtin-not-exportable' && (
                <p className="rpt-transfer-state-body">{t('agents.export.builtinHint')}</p>
              )}
            </div>
          ) : model && save.phase === 'saved' ? (
            <SaveDone path={save.path} onClose={onClose} />
          ) : model ? (
            <ReviewStep
              model={model}
              save={save}
              onSave={() => void doSave()}
              onCancel={onClose}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}

// ── Review step — the teaching moment ────────────────────────────────────────────────────────────────
const ReviewStep: React.FC<{
  model: ExportReviewModel
  save: SaveState
  onSave: () => void
  onCancel: () => void
}> = ({ model, save, onSave, onCancel }) => {
  const t = useT()
  const { entries, rejoins, triggers } = model.attachments

  return (
    <>
      {/* The framing sentence — this IS what an importer will see before installing. */}
      <p className="rpt-transfer-lede">{t('agents.export.reviewLede')}</p>

      {/* Identity block. */}
      <section className="rpt-inspect-section">
        <div className="rpt-inspect-identity">
          <span className="rpt-inspect-name">{model.name}</span>
          <span className="rpt-inspect-meta">
            {model.creator ? `${model.creator} · ` : ''}
            {t('agents.version', { v: model.version })}
          </span>
        </div>
        <p className="rpt-inspect-size">
          {t('agents.export.fileSize', { size: formatBytes(model.sizeBytes) })}
        </p>
      </section>

      {/* Attachments — reuse the plain-language badge vocabulary. */}
      <section className="rpt-inspect-section">
        <h3 className="rpt-inspect-sectiontitle">{t('agents.export.attachTitle')}</h3>
        {model.noAttachments ? (
          <p className="rpt-inspect-empty">{t('agents.export.attachNone')}</p>
        ) : (
          <div className="rpt-agents-badges">
            {entries > 0 && (
              <span className="rpt-agents-badge">
                {t('agents.export.attachEntries', { n: entries })}
              </span>
            )}
            {rejoins > 0 && (
              <span className="rpt-agents-badge">
                {t('agents.export.attachRejoins', { n: rejoins })}
              </span>
            )}
            {triggers > 0 && (
              <span className="rpt-agents-badge headless">
                {t('agents.export.attachTriggers', { n: triggers })}
              </span>
            )}
          </div>
        )}
      </section>

      {/* Derived capabilities — REUSED chip look, with the nodes-per-capability expand. */}
      <section className="rpt-inspect-section">
        <h3 className="rpt-inspect-sectiontitle">{t('agents.export.capTitle')}</h3>
        {model.capabilities.length === 0 ? (
          <p className="rpt-inspect-empty">{t('agents.export.capNone')}</p>
        ) : (
          <ul className="rpt-inspect-caplist">
            {model.capabilities.map((cap) => (
              <CapabilityItem key={cap.id} cap={cap} />
            ))}
          </ul>
        )}
      </section>

      {/* Template note. */}
      <section className="rpt-inspect-section">
        <h3 className="rpt-inspect-sectiontitle">{t('agents.export.templateTitle')}</h3>
        {model.templateNote === 'none' ? (
          <p className="rpt-inspect-note">{t('agents.export.templateNone')}</p>
        ) : (
          <ul className="rpt-inspect-templates">
            {model.bundledTemplateNames.map((name) => (
              <li key={name} className="rpt-inspect-template">
                {name}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Warnings — verbatim, framed as "importers will see these". */}
      {model.warnings.length > 0 && (
        <section className="rpt-inspect-section">
          <h3 className="rpt-inspect-sectiontitle">{t('agents.export.warnTitle')}</h3>
          <p className="rpt-inspect-note">{t('agents.export.warnLede')}</p>
          <ul className="rpt-inspect-warnings">
            {model.warnings.map((w, i) => (
              <li key={i} className="rpt-inspect-warning">
                {w}
              </li>
            ))}
          </ul>
        </section>
      )}

      {save.phase === 'error' && (
        <p className="rpt-transfer-inline-error">{t(exportErrorKey(save.code))}</p>
      )}

      <footer className="rpt-transfer-footer">
        <button type="button" className="rpt-duel-secondary" onClick={onCancel}>
          {t('agents.export.cancel')}
        </button>
        <button
          type="button"
          className="btn-accent"
          onClick={onSave}
          disabled={save.phase === 'saving'}
        >
          {save.phase === 'saving' ? t('agents.export.saving') : t('agents.export.save')}
        </button>
      </footer>
    </>
  )
}

// One capability row: the REUSED chip + node count, expandable to the conferring node ids. Structural
// caps (no conferring node) show "from structure" instead of a count and are not expandable.
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
          {cap.nodeIds.map((id) => (
            <li key={id} className="rpt-inspect-capnode">
              {id}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

// The subtle done state after a successful save.
const SaveDone: React.FC<{ path: string; onClose: () => void }> = ({ path, onClose }) => {
  const t = useT()
  const closeRef = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    closeRef.current?.focus()
  }, [])
  return (
    <div className="rpt-transfer-done">
      <div className="rpt-transfer-done-icon" aria-hidden>
        ✓
      </div>
      <h3 className="rpt-transfer-done-title">{t('agents.export.savedTitle')}</h3>
      <p className="rpt-transfer-done-path" title={path}>
        {path}
      </p>
      <button ref={closeRef} type="button" className="btn-accent" onClick={onClose}>
        {t('agents.export.done')}
      </button>
    </div>
  )
}
