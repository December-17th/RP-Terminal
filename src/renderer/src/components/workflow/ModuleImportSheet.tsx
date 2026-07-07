// The `.rptmodule` import review sheet (one-canvas rebuild WP6.5). Flow: the palette's "Import module…"
// button opens the file dialog + inspects (importModuleDialog), then renders THIS compact centered sheet
// with the inspection report — name, node count, capability chips (reusing the Agents chip look + the
// agents.cap.* labels), the unknown-type blocker list, template plans, and warnings. Install →
// confirmModuleImport (templates install main-side; the module payload comes back) → insertModule
// (remint + remap + collapsed group at viewport-center, marks the doc dirty — the user saves it
// themselves). Cancel / dismiss → cancelModuleImport (drops the pending token).
//
// The sheet is view-model-driven from the report the store handed it; it holds no derivation logic of
// its own beyond the capability read/write split (isWriteCapability, the shared authority).
import React from 'react'
import { useT } from '../../i18n'
import { isWriteCapability, type CapabilityId } from '../../../../shared/workflow/capabilities'
import './workflowEditor.css'

/** The inspection report the import IPC returns (moduleTransferService.ModuleInspectionReport mirror). */
export interface ModuleInspectReport {
  meta?: { name: string; nodeCount: number; description?: string; creator?: string }
  capabilityReport?: {
    capabilities: CapabilityId[]
    unknownNodeTypes: string[]
    nodesByCapability: Partial<Record<CapabilityId, string[]>>
  }
  templatePlans: { name: string; outcome: 'will-install' | 'will-duplicate' }[]
  blockers: { code: 'unknown-node-types'; nodeTypes: string[] }[]
  warnings: string[]
  parseError?: { code: string; errors?: string[]; foundVersion?: unknown }
  token?: string
}

export default function ModuleImportSheet({
  report,
  onInstall,
  onCancel
}: {
  report: ModuleInspectReport
  /** Called with the token when the user confirms; the caller runs confirmModuleImport + insertModule. */
  onInstall: (token: string) => void
  /** Called when the user dismisses / cancels; the caller runs cancelModuleImport for the token. */
  onCancel: () => void
}): React.JSX.Element {
  const t = useT()
  const blocked = report.blockers.length > 0
  const unknownTypes = report.blockers.flatMap((b) => b.nodeTypes)

  return (
    <div
      className="rpt-module-import-overlay rpt-wfe-sheet-overlay"
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
    >
      <div onClick={(e) => e.stopPropagation()} className="rpt-wfe-sheet">
        {report.parseError ? (
          <>
            <div className="rpt-wfe-sheet-parse-fail">
              {t('workflowEditor.moduleImport.parseFailed')}
            </div>
            <div className="rpt-wfe-sheet-parse-detail">
              {t(`workflowEditor.moduleImport.err.${report.parseError.code}`)}
            </div>
            <div className="rpt-wfe-sheet-actions-end">
              <button type="button" onClick={onCancel} className="rpt-wfe-btn-xs">
                {t('workflowEditor.moduleImport.close')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="rpt-wfe-sheet-title">
              {report.meta?.name ?? t('workflowEditor.moduleImport.title')}
            </div>
            <div className="rpt-wfe-sheet-subtitle">
              {t('workflowEditor.moduleImport.nodeCount', { n: report.meta?.nodeCount ?? 0 })}
              {report.meta?.creator ? ` · ${report.meta.creator}` : ''}
            </div>
            {report.meta?.description && (
              <div className="rpt-wfe-sheet-desc">{report.meta.description}</div>
            )}

            {report.capabilityReport && report.capabilityReport.capabilities.length > 0 && (
              <div className="rpt-agents-chips rpt-wfe-sheet-chips">
                {report.capabilityReport.capabilities.map((cap) => (
                  <span
                    key={cap}
                    className={`rpt-agents-chip${isWriteCapability(cap) ? ' write' : ''}`}
                  >
                    {t(`agents.cap.${cap}`)}
                  </span>
                ))}
              </div>
            )}

            {blocked && (
              <div className="rpt-wfe-sheet-blocked">
                <div className="rpt-wfe-sheet-blocked-head">
                  {t('workflowEditor.moduleImport.blockedUnknown')}
                </div>
                <ul className="rpt-wfe-sheet-blocked-list">
                  {unknownTypes.map((tp) => (
                    <li key={tp} className="rpt-wfe-sheet-blocked-item">
                      {tp}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {report.templatePlans.length > 0 && (
              <div className="rpt-wfe-sheet-templates">
                <div className="rpt-wfe-sheet-templates-head">
                  {t('workflowEditor.moduleImport.templates')}
                </div>
                {report.templatePlans.map((p) => (
                  <div key={p.name} className="rpt-wfe-sheet-template-row">
                    {p.name} —{' '}
                    {p.outcome === 'will-duplicate'
                      ? t('workflowEditor.moduleImport.willDuplicate')
                      : t('workflowEditor.moduleImport.willInstall')}
                  </div>
                ))}
              </div>
            )}

            {report.warnings.length > 0 && (
              <ul className="rpt-wfe-sheet-warnings">
                {report.warnings.map((w, i) => (
                  <li key={i} className="rpt-wfe-sheet-warning-item">
                    {w}
                  </li>
                ))}
              </ul>
            )}

            <div className="rpt-wfe-sheet-lands">
              {t('workflowEditor.moduleImport.landsUnwired')}
            </div>

            <div className="rpt-wfe-sheet-actions">
              <button type="button" onClick={onCancel} className="rpt-wfe-btn-xs">
                {t('workflowEditor.moduleImport.cancel')}
              </button>
              <button
                type="button"
                disabled={blocked || !report.token}
                onClick={() => report.token && onInstall(report.token)}
                className="rpt-wfe-btn-xs"
              >
                {t('workflowEditor.moduleImport.install')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
