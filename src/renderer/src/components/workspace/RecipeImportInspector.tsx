// The RECIPE import inspection sheet (agent-packs plan WP5.3) — the trust moment for a whole world
// setup. The grown-up sibling of AgentPackImportInspector: instead of one pack, it inspects a BUNDLE
// (several packs with pinned versions + gate state, an optional narrator, memory templates) and — the
// novel piece — the install confirm carries a WORLD PICKER (WP5.2 friction: the token stores no world;
// the target is chosen at confirm time).
//
// The caller (Installed pane) runs importRecipeDialog first; a null result (canceled OS dialog) never
// mounts this. So this always receives a real report and renders one of these shapes:
//   · parse-error sheet — the file never parsed (pack codes + four recipe-specific ones). No token.
//   · inspection sheet — recipe identity, the PACK LIST as compact sub-cards (name + version + dedupe
//     chip + condensed capability chips + a per-pack blocker badge listing unknown node types), the
//     narrator line, template plans, warnings, and a recipe-level BLOCKED banner naming the offenders
//     when any member is broken (one broken member blocks the whole recipe — WP5.2). The footer holds
//     the world picker (required; current world preselected) + Install.
//   · partial-result panel — confirmRecipeImport can resolve 'partial' (some steps landed, one failed
//     midway). A dedicated panel says what landed, what failed, and that re-importing is safe (the
//     service dedupes → idempotent).
//
// TOKEN SEMANTICS (WP5.2): the report's `token` is single-use; confirmRecipeImport(token, world)
// consumes it. cancelRecipeImport(token) drops it. So dismiss WITHOUT installing → cancel the token.
// A 'blocked' confirm result (re-checked block) surfaces inline; 'expired' too.
//
// Renderer-only: consumes WP5.2's IPC as-is. Pure view-model + copy in ./recipeTransferDisplay.ts
// (Node-tested); this owns the DOM + localized copy. Styling reuses .rpt-transfer-* / .rpt-inspect-*
// plus .rpt-recipe-* additions; all colors via --rpt-* tokens, AA + keyboard + 180ms motion.

import React from 'react'
import { useT } from '../../i18n'
import { useToastStore } from '../../stores/toastStore'
import { useWcvSuppression } from '../useWcvSuppression'
import {
  recipeInspectionModel,
  recipeDedupeChipKey,
  recipeTemplateOutcomeKey,
  recipeParseErrorTitleKey,
  recipeParseErrorBodyKey,
  recipeParseErrorHasDetails,
  narratorLineKey,
  initialWorldPicker,
  selectWorld,
  partialResultModel,
  type RecipeInspectionReport,
  type RecipeInspectionModel,
  type RecipePackCard,
  type WorldPickerState,
  type RecipeApplied,
  type PartialResultModel
} from './recipeTransferDisplay'
import { isWriteCapability } from '../../../../shared/workflow/capabilities'

const api = (): any => (window as unknown as { api: any }).api

type ConfirmResult =
  | { ok: true; applied: RecipeApplied }
  | { ok: false; code: 'expired' }
  | { ok: false; code: 'blocked'; packs: unknown[]; narrator?: unknown }
  | { ok: false; code: 'partial'; applied: RecipeApplied; failedStep: string; error: string }

export const RecipeImportInspector: React.FC<{
  report: RecipeInspectionReport
  /** The worlds the recipe can install into ({id,name}), grounded from the renderer's world/character
   *  data. The picker lists these; the current one is marked + preselected. */
  worlds: { id: string; name: string }[]
  /** The currently-open world (active chat's character_id) or null — preselected in the picker. */
  currentWorldId: string | null
  /** Called after the sheet is dealt with. `installedWorldId` + `installedPackIds` drive the host's
   *  jump-to-Installed + just-installed highlights on the landed packs; both undefined when nothing
   *  installed (canceled / dismissed / still-open on a partial the user hasn't dismissed). */
  onClose: (result?: { worldId: string; packIds: string[] }) => void
}> = ({ report, worlds, currentWorldId, onClose }) => {
  const t = useT()
  const pushToast = useToastStore((s) => s.push)
  useWcvSuppression()

  const model = React.useMemo(() => recipeInspectionModel(report), [report])
  const [picker, setPicker] = React.useState<WorldPickerState>(() =>
    initialWorldPicker(worlds, currentWorldId)
  )
  const [installing, setInstalling] = React.useState(false)
  const [confirmError, setConfirmError] = React.useState<'expired' | 'blocked' | null>(null)
  // A 'partial' confirm result — a dedicated panel replaces the sheet body until dismissed.
  const [partial, setPartial] = React.useState<PartialResultModel | null>(null)

  const sheetRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    sheetRef.current?.focus()
  }, [])

  // Dismiss WITHOUT installing = cancel the token (idempotent main-side; a no-op for a parse-error
  // report with no token). Then close with no result.
  const dismiss = React.useCallback(() => {
    if (model.token) void api().cancelRecipeImport(model.token)
    onClose()
  }, [model.token, onClose])

  // Confirm the stashed token against the chosen world. On ok → toast + close with the landed packs
  // (for the jump + highlights). On 'partial' → swap the body to the partial panel (token consumed;
  // re-import is the safe recovery). On 'blocked'/'expired' → inline error.
  const doInstall = React.useCallback(async () => {
    if (!model.token || !picker.selectedId || !model.canInstall) return
    setInstalling(true)
    setConfirmError(null)
    try {
      const res = (await api().confirmRecipeImport(model.token, picker.selectedId)) as ConfirmResult
      if (res.ok) {
        const name = model.identity?.name ?? ''
        pushToast(t('recipe.import.installedToast', { name }))
        onClose({
          worldId: picker.selectedId,
          packIds: res.applied.packs.map((p) => p.id)
        })
        return
      }
      if (res.code === 'partial') {
        setPartial(partialResultModel(res.applied, res.failedStep, res.error))
        setInstalling(false)
        return
      }
      setConfirmError(res.code)
      setInstalling(false)
    } catch {
      setConfirmError('expired')
      setInstalling(false)
    }
  }, [model.token, model.canInstall, model.identity, picker.selectedId, onClose, pushToast, t])

  const noWorlds = picker.options.length === 0

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
        aria-label={t('recipe.import.title')}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="rpt-transfer-head">
          <h2 className="rpt-transfer-title">
            {partial ? t('recipe.partial.title') : t('recipe.import.title')}
          </h2>
          <button
            type="button"
            className="rpt-transfer-close"
            aria-label={t('recipe.import.close')}
            onClick={partial ? () => onClose() : dismiss}
          >
            ×
          </button>
        </header>

        <div className="rpt-transfer-body">
          {partial ? (
            <PartialPanel model={partial} />
          ) : model.kind === 'parse-error' ? (
            <ParseErrorSheet model={model} />
          ) : (
            <ReportSheet model={model} confirmError={confirmError} />
          )}
        </div>

        <footer className="rpt-transfer-footer">
          {partial ? (
            <button type="button" className="btn-accent" onClick={() => onClose()}>
              {t('recipe.partial.dismiss')}
            </button>
          ) : model.kind === 'parse-error' ? (
            <button type="button" className="rpt-duel-secondary" onClick={dismiss}>
              {t('recipe.import.dismiss')}
            </button>
          ) : (
            <>
              {/* The novel confirm row: a world PICKER (required) + Install. */}
              <div className="rpt-recipe-target">
                <label className="rpt-recipe-targetlabel" htmlFor="rpt-recipe-target-select">
                  {t('recipe.import.targetLabel')}
                </label>
                {noWorlds ? (
                  <span className="rpt-recipe-target-none">{t('recipe.import.targetNoWorlds')}</span>
                ) : (
                  <select
                    id="rpt-recipe-target-select"
                    className="rpt-recipe-targetselect"
                    value={picker.selectedId ?? ''}
                    onChange={(e) => setPicker((s) => selectWorld(s, e.target.value))}
                  >
                    <option value="" disabled>
                      {t('recipe.import.targetPlaceholder')}
                    </option>
                    {picker.options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.current ? t('recipe.import.targetCurrent', { name: o.name }) : o.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <button type="button" className="rpt-duel-secondary" onClick={dismiss}>
                {t('recipe.import.cancel')}
              </button>
              <button
                type="button"
                className="btn-accent"
                onClick={() => void doInstall()}
                disabled={!model.canInstall || !picker.hasSelection || noWorlds || installing}
                title={
                  !model.canInstall
                    ? t('recipe.import.installBlocked')
                    : !picker.hasSelection
                      ? t('recipe.import.targetRequired')
                      : undefined
                }
              >
                {installing ? t('recipe.import.installing') : t('recipe.import.install')}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}

// ── Parse-error sheet ─────────────────────────────────────────────────────────────────────────────
const ParseErrorSheet: React.FC<{ model: RecipeInspectionModel }> = ({ model }) => {
  const t = useT()
  const err = model.parseError!
  return (
    <div className="rpt-transfer-state">
      <div className="rpt-transfer-state-icon danger" aria-hidden>
        ⚠
      </div>
      <h3 className="rpt-transfer-state-title">{t(recipeParseErrorTitleKey(err.code))}</h3>
      <p className="rpt-transfer-state-body">
        {t(recipeParseErrorBodyKey(err.code), {
          found: err.foundVersion === undefined ? '' : String(err.foundVersion)
        })}
      </p>
      {recipeParseErrorHasDetails(err) && (
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

// ── Inspection report sheet — the trust screen ────────────────────────────────────────────────────
const ReportSheet: React.FC<{
  model: RecipeInspectionModel
  confirmError: 'expired' | 'blocked' | null
}> = ({ model, confirmError }) => {
  const t = useT()
  const id = model.identity

  return (
    <>
      <p className="rpt-transfer-lede">{t('recipe.import.lede')}</p>

      {/* Recipe-level blocked banner — names the offenders (WP5.2: one broken member blocks all). */}
      {model.blocked && (
        <div className="rpt-recipe-blocked" role="alert">
          <div className="rpt-recipe-blocked-head">
            <span className="rpt-recipe-blocked-icon" aria-hidden>
              ⛔
            </span>
            <span className="rpt-recipe-blocked-title">{t('recipe.import.blockedTitle')}</span>
          </div>
          {model.offenderNames.length > 0 && (
            <p className="rpt-recipe-blocked-body">
              {t('recipe.import.blockedBody', { names: model.offenderNames.join(', ') })}
            </p>
          )}
          {model.narrator?.blocks && (
            <p className="rpt-recipe-blocked-body">{t('recipe.import.blockedNarrator')}</p>
          )}
        </div>
      )}

      {/* Identity. */}
      {id && (
        <section className="rpt-inspect-section">
          <div className="rpt-inspect-identity">
            <span className="rpt-inspect-name">{id.name}</span>
            {id.creator && (
              <span className="rpt-inspect-meta">
                {t('recipe.import.identityMeta', { creator: id.creator })}
              </span>
            )}
          </div>
          {id.description && <p className="rpt-inspect-note">{id.description}</p>}
        </section>
      )}

      {/* Packs as compact sub-cards. */}
      <section className="rpt-inspect-section">
        <h3 className="rpt-inspect-sectiontitle">
          {t('recipe.import.packsTitle')}{' '}
          <span className="rpt-recipe-packcount">
            {t('recipe.import.packsCount', { n: model.packs.length })}
          </span>
        </h3>
        <ul className="rpt-recipe-packcards">
          {model.packs.map((p) => (
            <PackSubCard key={`${p.id}-${p.version}`} pack={p} />
          ))}
        </ul>
      </section>

      {/* Narrator line. */}
      {model.narrator && (
        <section className="rpt-inspect-section">
          <h3 className="rpt-inspect-sectiontitle">{t('recipe.import.narratorTitle')}</h3>
          <p className="rpt-inspect-note">
            {model.narrator.line === 'custom' && model.narrator.nodeCount !== undefined
              ? t('recipe.narrator.customNodes', { n: model.narrator.nodeCount })
              : t(narratorLineKey(model.narrator.line))}
          </p>
        </section>
      )}

      {/* Bundled templates + outcome. */}
      {model.templatePlans.length > 0 && (
        <section className="rpt-inspect-section">
          <h3 className="rpt-inspect-sectiontitle">{t('recipe.import.templateTitle')}</h3>
          <ul className="rpt-inspect-templates">
            {model.templatePlans.map((tp) => (
              <li key={tp.name} className="rpt-inspect-template">
                <span className="rpt-inspect-template-name">{tp.name}</span>
                <span className={`rpt-inspect-template-outcome ${tp.outcome}`}>
                  {t(recipeTemplateOutcomeKey(tp.outcome))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Warnings — verbatim. */}
      {model.warnings.length > 0 && (
        <section className="rpt-inspect-section">
          <h3 className="rpt-inspect-sectiontitle">{t('recipe.import.warnTitle')}</h3>
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
            ? t('recipe.import.confirmExpired')
            : t('recipe.import.confirmBlocked')}
        </p>
      )}
    </>
  )
}

// One compact pack sub-card: name + version + dedupe chip, condensed capability chips, and a per-pack
// blocker badge (listing the unknown node types) when the pack is broken.
const PackSubCard: React.FC<{ pack: RecipePackCard }> = ({ pack }) => {
  const t = useT()
  return (
    <li className={`rpt-recipe-packcard${pack.blocks ? ' blocked' : ''}`}>
      <div className="rpt-recipe-packcard-head">
        <span className="rpt-recipe-packcard-name">{pack.name}</span>
        <span className="rpt-recipe-packcard-ver">
          {t('recipe.import.packVersion', { v: pack.version })}
        </span>
        <span className={`rpt-inspect-dedupe ${pack.dedupe}`}>
          {t(recipeDedupeChipKey(pack.dedupe))}
        </span>
        {pack.blocks && (
          <span className="rpt-recipe-packcard-blocked">{t('recipe.import.packBlocked')}</span>
        )}
      </div>

      {pack.capabilities.length > 0 && (
        <div className="rpt-agents-chips rpt-recipe-packcard-chips">
          {pack.capabilities.map((c) => (
            <span key={c.id} className={`rpt-agents-chip${isWriteCapability(c.id) ? ' write' : ''}`}>
              {t(`agents.cap.${c.id}`)}
            </span>
          ))}
        </div>
      )}

      {pack.blocks && (
        <div className="rpt-recipe-packcard-nodes">
          <span className="rpt-recipe-packcard-nodeslede">
            {t('recipe.import.packUnknownNodes', { n: pack.unknownNodeTypes.length })}
          </span>
          <ul className="rpt-inspect-blocker-nodes">
            {pack.unknownNodeTypes.map((nt) => (
              <li key={nt} className="rpt-inspect-blocker-node">
                {nt}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  )
}

// ── Partial-result panel — "these landed, this failed" (the honest recipe-only shape) ─────────────
const PartialPanel: React.FC<{ model: PartialResultModel }> = ({ model }) => {
  const t = useT()
  return (
    <div className="rpt-recipe-partial">
      <div className="rpt-recipe-partial-icon" aria-hidden>
        ◑
      </div>
      <section className="rpt-inspect-section">
        <h3 className="rpt-inspect-sectiontitle">{t('recipe.partial.landedTitle')}</h3>
        {model.applied.length === 0 ? (
          <p className="rpt-inspect-empty">—</p>
        ) : (
          <ul className="rpt-recipe-partial-landed">
            {model.applied.map((l, i) => (
              <li key={i} className="rpt-recipe-partial-landeditem">
                <span className="rpt-recipe-partial-check" aria-hidden>
                  ✓
                </span>
                {t(l.key, l.vars)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rpt-inspect-section">
        <h3 className="rpt-inspect-sectiontitle danger">{t('recipe.partial.failedTitle')}</h3>
        <p className="rpt-recipe-partial-failed">{t(model.failedStepKey)}</p>
        {model.error && <p className="rpt-recipe-partial-error">{model.error}</p>}
      </section>

      <p className="rpt-recipe-partial-safe">{t('recipe.partial.safeToRetry')}</p>
    </div>
  )
}
