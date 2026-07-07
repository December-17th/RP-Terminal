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
  /** Called with the token when the user confirms; the caller runs confirmModuleImport + insertModule.
   *  WP-G: `saveToLibrary` = the sheet's "save to my library" checkbox (spec §2 — reuse without the file). */
  onInstall: (token: string, saveToLibrary: boolean) => void
  /** Called when the user dismisses / cancels; the caller runs cancelModuleImport for the token. */
  onCancel: () => void
}): React.JSX.Element {
  const t = useT()
  const blocked = report.blockers.length > 0
  const unknownTypes = report.blockers.flatMap((b) => b.nodeTypes)
  // WP-G: opt-in save of the imported module into the user library (unchecked by default).
  const [saveToLibrary, setSaveToLibrary] = React.useState(false)

  return (
    <div
      className="rpt-module-import-overlay"
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--rpt-scrim, rgba(0,0,0,0.45))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 20
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 360,
          maxHeight: '80%',
          overflowY: 'auto',
          background: 'var(--rpt-bg-elevated)',
          border: '1px solid var(--rpt-border)',
          borderRadius: 10,
          padding: 16,
          boxShadow: '0 8px 30px rgba(0,0,0,0.35)'
        }}
      >
        {report.parseError ? (
          <>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--rpt-danger)' }}>
              {t('workflowEditor.moduleImport.parseFailed')}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--rpt-text-secondary)', margin: '6px 0 12px' }}>
              {t(`workflowEditor.moduleImport.err.${report.parseError.code}`)}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" onClick={onCancel} style={{ fontSize: 12 }}>
                {t('workflowEditor.moduleImport.close')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--rpt-text-primary)' }}>
              {report.meta?.name ?? t('workflowEditor.moduleImport.title')}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--rpt-text-secondary)', marginTop: 2 }}>
              {t('workflowEditor.moduleImport.nodeCount', { n: report.meta?.nodeCount ?? 0 })}
              {report.meta?.creator ? ` · ${report.meta.creator}` : ''}
            </div>
            {report.meta?.description && (
              <div style={{ fontSize: 11.5, color: 'var(--rpt-text-secondary)', margin: '6px 0' }}>
                {report.meta.description}
              </div>
            )}

            {report.capabilityReport && report.capabilityReport.capabilities.length > 0 && (
              <div className="rpt-agents-chips" style={{ margin: '10px 0' }}>
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
              <div
                style={{
                  border: '1px solid var(--rpt-danger)',
                  borderRadius: 6,
                  padding: '6px 8px',
                  margin: '8px 0'
                }}
              >
                <div style={{ fontSize: 11.5, color: 'var(--rpt-danger)', fontWeight: 600 }}>
                  {t('workflowEditor.moduleImport.blockedUnknown')}
                </div>
                <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 11 }}>
                  {unknownTypes.map((tp) => (
                    <li key={tp} style={{ color: 'var(--rpt-text-secondary)' }}>
                      {tp}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {report.templatePlans.length > 0 && (
              <div style={{ margin: '8px 0' }}>
                <div style={{ fontSize: 10.5, color: 'var(--rpt-text-tertiary)' }}>
                  {t('workflowEditor.moduleImport.templates')}
                </div>
                {report.templatePlans.map((p) => (
                  <div key={p.name} style={{ fontSize: 11, color: 'var(--rpt-text-secondary)' }}>
                    {p.name} —{' '}
                    {p.outcome === 'will-duplicate'
                      ? t('workflowEditor.moduleImport.willDuplicate')
                      : t('workflowEditor.moduleImport.willInstall')}
                  </div>
                ))}
              </div>
            )}

            {report.warnings.length > 0 && (
              <ul style={{ margin: '8px 0 0', paddingLeft: 16, fontSize: 10.5 }}>
                {report.warnings.map((w, i) => (
                  <li key={i} style={{ color: 'var(--rpt-warning)' }}>
                    {w}
                  </li>
                ))}
              </ul>
            )}

            <div style={{ fontSize: 10.5, color: 'var(--rpt-text-tertiary)', margin: '10px 0 8px' }}>
              {t('workflowEditor.moduleImport.landsUnwired')}
            </div>

            {/* WP-G (spec §2): also save the imported module into the palette's user library. */}
            {!blocked && (
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: 11,
                  color: 'var(--rpt-text-secondary)',
                  marginBottom: 8
                }}
              >
                <input
                  type="checkbox"
                  checked={saveToLibrary}
                  onChange={(e) => setSaveToLibrary(e.target.checked)}
                />
                {t('workflowEditor.moduleImport.saveToLibrary')}
              </label>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" onClick={onCancel} style={{ fontSize: 12 }}>
                {t('workflowEditor.moduleImport.cancel')}
              </button>
              <button
                type="button"
                disabled={blocked || !report.token}
                onClick={() => report.token && onInstall(report.token, saveToLibrary)}
                style={{ fontSize: 12 }}
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
