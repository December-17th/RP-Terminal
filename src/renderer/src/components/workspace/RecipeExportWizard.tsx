// The RECIPE export wizard (agent-packs plan WP5.3) — "share this world's setup". The grown-up sibling
// of AgentPackExportWizard: it exports a WHOLE world configuration (its activated packs with pinned
// versions + gate state, its narrator, any bundled memory templates) as one `.rptrecipe`. A two-step
// modal + save, mirroring the pack wizard's rhythm:
//
//   1. FORM — name (required, prefilled from the world name) + optional description/creator. This is
//      the one thing the recipe export needs from the user (the rest is assembled from the world).
//   2. REVIEW — previewRecipeExport rendered as "this is what someone will install": the pack list
//      (name + version + on/off), the narrator line ("uses your default narrator" / "includes your
//      custom narrator"), the memory-template note, and warnings framed for the importer. The honest
//      empty-ish state: a world with nothing activated returns no-activated-packs → a designed panel
//      explaining why there's nothing to export.
//   3. SAVE — exportRecipeDialog (native save dialog). Success shows the path + a done state; a
//      canceled dialog returns to Review; the no-activated-packs refusal can also surface here.
//
// Renderer-only: consumes WP5.2's IPC as-is. Pure view-model + copy-key mapping live in
// ./recipeTransferDisplay.ts (Node-tested); this component owns the DOM + localized copy. Styling
// reuses the .rpt-transfer-* / .rpt-inspect-* shell (same visual language as the pack wizard) plus a
// few .rpt-recipe-* additions; all colors via --rpt-* tokens, AA + keyboard + 180ms motion.

import React from 'react'
import { useT } from '../../i18n'
import { useWcvSuppression } from '../useWcvSuppression'
import {
  recipeExportReviewModel,
  initialRecipeForm,
  canSubmitRecipeForm,
  recipeExportOpts,
  narratorLineKey,
  recipeExportErrorKey,
  type RecipeExportPreview,
  type RecipeExportReviewModel,
  type RecipeExportFormValues,
  type RecipeExportErrorCode
} from './recipeTransferDisplay'
import { formatBytes as formatBytesFrom } from './agentPackTransferDisplay'

const api = (): any => (window as unknown as { api: any }).api

type PreviewResult =
  | { ok: true; preview: RecipeExportPreview }
  | { ok: false; error: { code: RecipeExportErrorCode; message: string } }

type Phase =
  | { step: 'form' }
  | { step: 'review' }
  | { step: 'saving' }
  | { step: 'saved'; path: string }

export const RecipeExportWizard: React.FC<{
  profileId: string
  worldId: string
  /** The current world's display name — seeds the form's name field. */
  worldName: string
  onClose: () => void
}> = ({ profileId, worldId, worldName, onClose }) => {
  const t = useT()
  useWcvSuppression()

  const [form, setForm] = React.useState<RecipeExportFormValues>(() =>
    initialRecipeForm(worldName, t('recipe.export.fallbackName'))
  )
  const [phase, setPhase] = React.useState<Phase>({ step: 'form' })
  // Review-step data: loaded lazily when the user advances from the form (the preview depends on the
  // name/id the form supplies). null while loading; a refuse code on the empty-ish no-activated-packs.
  const [loading, setLoading] = React.useState(false)
  const [loadError, setLoadError] = React.useState(false)
  const [refuse, setRefuse] = React.useState<RecipeExportErrorCode | null>(null)
  const [model, setModel] = React.useState<RecipeExportReviewModel | null>(null)
  const [saveError, setSaveError] = React.useState<RecipeExportErrorCode | null>(null)

  const opts = React.useMemo(() => recipeExportOpts(form), [form])

  const loadPreview = React.useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    setRefuse(null)
    try {
      const res = (await api().previewRecipeExport(profileId, worldId, opts)) as PreviewResult
      if (res.ok) setModel(recipeExportReviewModel(res.preview))
      else setRefuse(res.error.code)
    } catch {
      setLoadError(true)
      setModel(null)
    } finally {
      setLoading(false)
    }
  }, [profileId, worldId, opts])

  const goReview = React.useCallback(() => {
    if (!canSubmitRecipeForm(form)) return
    setPhase({ step: 'review' })
    void loadPreview()
  }, [form, loadPreview])

  const doSave = React.useCallback(async () => {
    setPhase({ step: 'saving' })
    setSaveError(null)
    try {
      const res = (await api().exportRecipeDialog(profileId, worldId, opts)) as
        | { saved: string }
        | { canceled: true }
        | { ok: false; error: { code: RecipeExportErrorCode } }
      if ('saved' in res) setPhase({ step: 'saved', path: res.saved })
      else if ('canceled' in res) setPhase({ step: 'review' }) // returns to Review
      else {
        setSaveError(res.error.code)
        setPhase({ step: 'review' })
      }
    } catch {
      setSaveError('no-activated-packs')
      setPhase({ step: 'review' })
    }
  }, [profileId, worldId, opts])

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
        aria-label={t('recipe.export.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="rpt-transfer-head">
          <h2 className="rpt-transfer-title">{t('recipe.export.title')}</h2>
          <button
            type="button"
            className="rpt-transfer-close"
            aria-label={t('recipe.export.close')}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="rpt-transfer-body">
          {phase.step === 'form' ? (
            <FormStep form={form} onChange={setForm} />
          ) : phase.step === 'saved' ? (
            <SaveDone path={phase.path} onClose={onClose} />
          ) : loading ? (
            <div className="rpt-transfer-skel" aria-hidden>
              <div className="rpt-agents-skel-line" />
              <div className="rpt-agents-skel-line short" />
              <div className="rpt-agents-skel-line" />
            </div>
          ) : loadError ? (
            <div className="rpt-transfer-state">
              <p>{t('recipe.export.loadError')}</p>
              <button className="btn-accent" onClick={() => void loadPreview()}>
                {t('agents.retry')}
              </button>
            </div>
          ) : refuse ? (
            <div className="rpt-transfer-state">
              <div className="rpt-transfer-state-icon" aria-hidden>
                ⓘ
              </div>
              <h3 className="rpt-transfer-state-title">{t(recipeExportErrorKey(refuse))}</h3>
            </div>
          ) : model ? (
            <ReviewStep model={model} saveError={saveError} />
          ) : null}
        </div>

        <footer className="rpt-transfer-footer">
          {phase.step === 'form' && (
            <>
              <button type="button" className="rpt-duel-secondary" onClick={onClose}>
                {t('recipe.export.cancel')}
              </button>
              <button
                type="button"
                className="btn-accent"
                onClick={goReview}
                disabled={!canSubmitRecipeForm(form)}
              >
                {t('recipe.export.next')}
              </button>
            </>
          )}
          {(phase.step === 'review' || phase.step === 'saving') && !refuse && !loadError && (
            <>
              <button
                type="button"
                className="rpt-duel-secondary"
                onClick={() => setPhase({ step: 'form' })}
                disabled={phase.step === 'saving'}
              >
                {t('recipe.export.back')}
              </button>
              <button
                type="button"
                className="btn-accent"
                onClick={() => void doSave()}
                disabled={phase.step === 'saving' || loading || !model}
              >
                {phase.step === 'saving' ? t('recipe.export.saving') : t('recipe.export.save')}
              </button>
            </>
          )}
          {(refuse || loadError) && phase.step !== 'saved' && (
            <button type="button" className="rpt-duel-secondary" onClick={() => setPhase({ step: 'form' })}>
              {t('recipe.export.back')}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

// ── Step 1: the small form (name required, description/creator optional) ──────────────────────────
const FormStep: React.FC<{
  form: RecipeExportFormValues
  onChange: (v: RecipeExportFormValues) => void
}> = ({ form, onChange }) => {
  const t = useT()
  const nameRef = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [])
  const blankName = form.name.trim().length === 0
  return (
    <>
      <p className="rpt-transfer-lede">{t('recipe.export.formLede')}</p>
      <div className="rpt-recipe-form">
        <label className="rpt-recipe-field">
          <span className="rpt-recipe-fieldlabel">{t('recipe.export.nameLabel')}</span>
          <input
            ref={nameRef}
            type="text"
            className="rpt-recipe-input"
            value={form.name}
            placeholder={t('recipe.export.namePlaceholder')}
            aria-invalid={blankName}
            onChange={(e) => onChange({ ...form, name: e.target.value })}
          />
          {blankName && <span className="rpt-recipe-fielderror">{t('recipe.export.nameRequired')}</span>}
        </label>
        <label className="rpt-recipe-field">
          <span className="rpt-recipe-fieldlabel">{t('recipe.export.descriptionLabel')}</span>
          <textarea
            className="rpt-recipe-input rpt-recipe-textarea"
            value={form.description}
            placeholder={t('recipe.export.descriptionPlaceholder')}
            rows={2}
            onChange={(e) => onChange({ ...form, description: e.target.value })}
          />
        </label>
        <label className="rpt-recipe-field">
          <span className="rpt-recipe-fieldlabel">{t('recipe.export.creatorLabel')}</span>
          <input
            type="text"
            className="rpt-recipe-input"
            value={form.creator}
            placeholder={t('recipe.export.creatorPlaceholder')}
            onChange={(e) => onChange({ ...form, creator: e.target.value })}
          />
        </label>
      </div>
    </>
  )
}

// ── Step 2: the Review — "this is what someone will install" ──────────────────────────────────────
const ReviewStep: React.FC<{
  model: RecipeExportReviewModel
  saveError: RecipeExportErrorCode | null
}> = ({ model, saveError }) => {
  const t = useT()
  const empty = model.packCount === 0

  return (
    <>
      <p className="rpt-transfer-lede">{t('recipe.export.reviewLede')}</p>

      {/* Identity + size. */}
      <section className="rpt-inspect-section">
        <div className="rpt-inspect-identity">
          <span className="rpt-inspect-name">{model.name}</span>
          {model.creator && <span className="rpt-inspect-meta">{model.creator}</span>}
        </div>
        {model.description && <p className="rpt-inspect-note">{model.description}</p>}
        <p className="rpt-inspect-size">
          {t('recipe.export.fileSize', { size: formatBytesFrom(model.sizeBytes) })}
        </p>
      </section>

      {/* Packs — the core of a recipe. */}
      <section className="rpt-inspect-section">
        <h3 className="rpt-inspect-sectiontitle">{t('recipe.export.packsTitle')}</h3>
        {empty ? (
          <p className="rpt-inspect-empty">{t('recipe.export.packsEmpty')}</p>
        ) : (
          <>
            <p className="rpt-inspect-note">
              {t('recipe.export.packsSummary', { n: model.packCount, enabled: model.enabledCount })}
            </p>
            <ul className="rpt-recipe-packlist">
              {model.packs.map((p) => (
                <li key={p.id} className="rpt-recipe-packrow">
                  <span className="rpt-recipe-packname">{p.name}</span>
                  <span className="rpt-recipe-packver">
                    {t('recipe.export.packVersion', { v: p.version })}
                  </span>
                  <span className={`rpt-recipe-packstate${p.enabled ? ' on' : ''}`}>
                    {p.enabled ? t('recipe.export.packOn') : t('recipe.export.packOff')}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* Narrator line. */}
      {!empty && (
        <section className="rpt-inspect-section">
          <h3 className="rpt-inspect-sectiontitle">{t('recipe.export.narratorTitle')}</h3>
          <p className="rpt-inspect-note">{t(narratorLineKey(model.narrator))}</p>
        </section>
      )}

      {/* Memory templates. */}
      {!empty && (
        <section className="rpt-inspect-section">
          <h3 className="rpt-inspect-sectiontitle">{t('recipe.export.templateTitle')}</h3>
          {model.templateNote === 'none' ? (
            <p className="rpt-inspect-note">{t('recipe.export.templateNone')}</p>
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
      )}

      {/* Warnings — framed for the importer. */}
      {model.warnings.length > 0 && (
        <section className="rpt-inspect-section">
          <h3 className="rpt-inspect-sectiontitle">{t('recipe.export.warnTitle')}</h3>
          <p className="rpt-inspect-note">{t('recipe.export.warnLede')}</p>
          <ul className="rpt-inspect-warnings">
            {model.warnings.map((w, i) => (
              <li key={i} className="rpt-inspect-warning">
                {w}
              </li>
            ))}
          </ul>
        </section>
      )}

      {saveError && (
        <p className="rpt-transfer-inline-error">{t(recipeExportErrorKey(saveError))}</p>
      )}
    </>
  )
}

// The done state after a successful save.
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
      <h3 className="rpt-transfer-done-title">{t('recipe.export.savedTitle')}</h3>
      <p className="rpt-transfer-done-path" title={path}>
        {path}
      </p>
      <button ref={closeRef} type="button" className="btn-accent" onClick={onClose}>
        {t('recipe.export.done')}
      </button>
    </div>
  )
}
