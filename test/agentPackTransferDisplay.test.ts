import { describe, it, expect } from 'vitest'
import {
  capabilityRows,
  exportReviewModel,
  formatBytes,
  exportErrorKey,
  parseErrorTitleKey,
  parseErrorBodyKey,
  parseErrorHasDetails,
  blockerCopy,
  inspectionModel,
  templateOutcomeKey,
  dedupeChipKey,
  type ExportPreview,
  type InspectionReport,
  type ImportBlocker,
  type ParseErrorCode
} from '../src/renderer/src/components/workspace/agentPackTransferDisplay'
import { CAPABILITY_IDS } from '../src/shared/workflow/capabilities'
import en from '../src/renderer/src/i18n/locales/en'
import zh from '../src/renderer/src/i18n/locales/zh'

// Pins the pure display derivations behind the export wizard + import inspection sheet (agent-packs
// plan WP4.3). vitest runs under Node with no jsdom renderer, so per WP convention the display LOGIC
// (view-model assembly + copy-key mapping) is extracted here and covered; the components add only
// labels + DOM.

const report = (over: {
  capabilities?: (typeof CAPABILITY_IDS)[number][]
  nodesByCapability?: Record<string, string[]>
}): ExportPreview['capabilityReport'] => ({
  capabilities: over.capabilities ?? [],
  unknownNodeTypes: [],
  nodesByCapability: (over.nodesByCapability ?? {}) as never
})

describe('capabilityRows', () => {
  it('orders by CAPABILITY_IDS, tags write caps, and carries per-cap node ids', () => {
    const rows = capabilityRows(
      report({
        // deliberately out of CAPABILITY_IDS order to prove the sort
        capabilities: ['writes-tables', 'reads-tables'],
        nodesByCapability: { 'writes-tables': ['n1'], 'reads-tables': ['n2', 'n3'] }
      })
    )
    expect(rows.map((r) => r.id)).toEqual(['reads-tables', 'writes-tables'])
    expect(rows.find((r) => r.id === 'writes-tables')!.write).toBe(true)
    expect(rows.find((r) => r.id === 'reads-tables')!.write).toBe(false)
    expect(rows.find((r) => r.id === 'reads-tables')!.nodeIds).toEqual(['n2', 'n3'])
  })

  it('gives structural caps (no conferring node) an empty nodeIds', () => {
    const rows = capabilityRows(report({ capabilities: ['injects-prompt', 'runs-headless'] }))
    expect(rows.every((r) => r.nodeIds.length === 0)).toBe(true)
  })
})

describe('exportReviewModel', () => {
  const preview: ExportPreview = {
    envelopeMeta: { name: 'Table Memory', version: 2, creator: 'me', sizeBytes: 2048 },
    attachments: { entries: 1, rejoins: 0, triggers: 2 },
    capabilityReport: report({ capabilities: ['writes-tables'], nodesByCapability: { 'writes-tables': ['a'] } }),
    bundledTemplateNames: [],
    noTemplatesBundled: true,
    warnings: ['node "x" references a local sub-graph']
  }

  it('flattens the preview into the render model', () => {
    const m = exportReviewModel(preview)
    expect(m.name).toBe('Table Memory')
    expect(m.version).toBe(2)
    expect(m.creator).toBe('me')
    expect(m.noAttachments).toBe(false)
    expect(m.templateNote).toBe('none')
    expect(m.capabilities.map((c) => c.id)).toEqual(['writes-tables'])
    expect(m.warnings).toHaveLength(1)
  })

  it('flags noAttachments when all counts are zero', () => {
    const m = exportReviewModel({ ...preview, attachments: { entries: 0, rejoins: 0, triggers: 0 } })
    expect(m.noAttachments).toBe(true)
  })

  it('reports templateNote=bundled with names when templates are bundled', () => {
    const m = exportReviewModel({
      ...preview,
      noTemplatesBundled: false,
      bundledTemplateNames: ['Journal']
    })
    expect(m.templateNote).toBe('bundled')
    expect(m.bundledTemplateNames).toEqual(['Journal'])
  })
})

describe('formatBytes', () => {
  it('formats bytes / KB / MB', () => {
    expect(formatBytes(840)).toBe('840 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(20 * 1024)).toBe('20 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})

describe('blockerCopy', () => {
  it('maps unknown-node-types with the type list + count var', () => {
    const c = blockerCopy({ code: 'unknown-node-types', nodeTypes: ['x.y', 'z.w'] })
    expect(c.vars.count).toBe(2)
    expect(c.nodeTypes).toEqual(['x.y', 'z.w'])
    expect(c.recoverable).toBe(false)
  })

  it('maps version-too-old with required/app vars', () => {
    const c = blockerCopy({ code: 'version-too-old', minRptVersion: '9.9.9', appVersion: '1.0.0' })
    expect(c.vars).toEqual({ required: '9.9.9', app: '1.0.0' })
  })

  it('marks version-conflict recoverable and carries the installed version', () => {
    const c = blockerCopy({ code: 'version-conflict', installedVersion: 3 })
    expect(c.recoverable).toBe(true)
    expect(c.vars.installed).toBe(3)
  })
})

describe('inspectionModel', () => {
  it('short-circuits a parse failure to the error sheet (no token, no install)', () => {
    const m = inspectionModel({
      bundledTemplatePlans: [],
      blockers: [],
      warnings: [],
      parseError: { code: 'invalid-json' }
    })
    expect(m.kind).toBe('parse-error')
    expect(m.canInstall).toBe(false)
    expect(m.token).toBeUndefined()
  })

  it('allows install for a clean report with a token', () => {
    const m = inspectionModel({
      envelopeMeta: { id: 'p', name: 'Pack', version: 1 },
      capabilityReport: report({ capabilities: ['reads-tables'], nodesByCapability: { 'reads-tables': ['n'] } }),
      bundledTemplatePlans: [{ name: 'T', outcome: 'will-install' }],
      dedupe: 'new',
      blockers: [],
      warnings: [],
      token: 'tok'
    })
    expect(m.kind).toBe('report')
    expect(m.canInstall).toBe(true)
    expect(m.dedupe).toBe('new')
    expect(m.capabilities).toHaveLength(1)
    expect(m.templatePlans).toHaveLength(1)
  })

  it('blocks install when blockers exist even with a token, and surfaces the conflict version', () => {
    const blockers: ImportBlocker[] = [{ code: 'version-conflict', installedVersion: 4 }]
    const m = inspectionModel({
      envelopeMeta: { id: 'p', name: 'Pack', version: 5 },
      bundledTemplatePlans: [],
      dedupe: 'new',
      blockers,
      warnings: [],
      token: 'tok'
    })
    expect(m.canInstall).toBe(false)
    expect(m.conflictInstalledVersion).toBe(4)
  })

  it('blocks install when the token is absent (parsed but no confirm path)', () => {
    const m = inspectionModel({
      envelopeMeta: { id: 'p', name: 'Pack', version: 1 },
      bundledTemplatePlans: [],
      dedupe: 'new',
      blockers: [],
      warnings: []
    })
    expect(m.canInstall).toBe(false)
  })
})

describe('parseErrorHasDetails', () => {
  it('is true only when a field-error list is present', () => {
    expect(parseErrorHasDetails({ code: 'invalid-json' })).toBe(false)
    expect(parseErrorHasDetails({ code: 'invalid-envelope', errors: ['bad.field'] })).toBe(true)
    expect(parseErrorHasDetails({ code: 'invalid-envelope', errors: [] })).toBe(false)
  })
})

// ── i18n parity: every derived key present in BOTH locales (CLAUDE.md rule; mirrors WP3.4's test).
// Check the raw maps (not translate(), which falls back to en and would hide a zh gap).
describe('i18n coverage — every WP4.3 derived key present in en + zh', () => {
  const parseCodes: ParseErrorCode[] = [
    'too-large',
    'invalid-json',
    'unsupported-version',
    'invalid-envelope',
    'not-a-fragment',
    'invalid-fragment'
  ]
  const blockers: ImportBlocker[] = [
    { code: 'unknown-node-types', nodeTypes: ['a'] },
    { code: 'version-too-old', minRptVersion: '1', appVersion: '0' },
    { code: 'version-conflict', installedVersion: 1 }
  ]

  const derivedKeys: string[] = [
    // capability chip labels (reused mapping)
    ...CAPABILITY_IDS.map((id) => `agents.cap.${id}`),
    // export errors
    exportErrorKey('builtin-not-exportable'),
    exportErrorKey('not-installed'),
    // parse-error title + body per code
    ...parseCodes.flatMap((c) => [parseErrorTitleKey(c), parseErrorBodyKey(c)]),
    // blocker title + body per code
    ...blockers.flatMap((b) => {
      const c = blockerCopy(b)
      return [c.titleKey, c.bodyKey]
    }),
    // template outcomes + dedupe chips
    templateOutcomeKey('will-install'),
    templateOutcomeKey('will-duplicate'),
    dedupeChipKey('new'),
    dedupeChipKey('already-installed')
  ]

  // Static keys the components also render.
  const staticKeys: string[] = [
    'agents.transfer.nodeCount',
    'agents.transfer.fromStructure',
    'agents.export.open',
    'agents.export.title',
    'agents.export.close',
    'agents.export.loadError',
    'agents.export.reviewLede',
    'agents.export.fileSize',
    'agents.export.attachTitle',
    'agents.export.attachNone',
    'agents.export.attachEntries',
    'agents.export.attachRejoins',
    'agents.export.attachTriggers',
    'agents.export.capTitle',
    'agents.export.capNone',
    'agents.export.templateTitle',
    'agents.export.templateNone',
    'agents.export.warnTitle',
    'agents.export.warnLede',
    'agents.export.save',
    'agents.export.saving',
    'agents.export.cancel',
    'agents.export.savedTitle',
    'agents.export.done',
    'agents.export.builtinHint',
    'agents.import.open',
    'agents.import.opening',
    'agents.import.title',
    'agents.import.close',
    'agents.import.lede',
    'agents.import.forkLineage',
    'agents.import.capTitle',
    'agents.import.capNone',
    'agents.import.templateTitle',
    'agents.import.warnTitle',
    'agents.import.blockersTitle',
    'agents.import.blockersLede',
    'agents.import.cancel',
    'agents.import.dismiss',
    'agents.import.install',
    'agents.import.installing',
    'agents.import.installBlocked',
    'agents.import.installedToast',
    'agents.import.alreadyToast',
    'agents.import.confirmExpired',
    'agents.import.confirmBlocked',
    'agents.import.versionConflictRecovery',
    // WP4.3b — the wired version-conflict recovery + Task C uninstall.
    'agents.import.conflictUninstall',
    'agents.import.conflictConfirm',
    'agents.import.conflictConfirmBtn',
    'agents.import.conflictKeep',
    'agents.import.conflictWorking',
    'agents.import.conflictBuiltin',
    'agents.import.conflictUninstallFailed',
    'agents.settings.uninstall',
    'agents.settings.uninstallConfirm',
    'agents.settings.uninstallConfirmBtn',
    'agents.settings.uninstallKeep',
    'agents.settings.uninstallWorking',
    'agents.settings.uninstallBuiltinHint',
    'agents.settings.uninstallFailed'
  ]

  const keys = [...derivedKeys, ...staticKeys]

  for (const [name, dict] of [
    ['en', en],
    ['zh', zh]
  ] as const) {
    it(`every WP4.3 key present in ${name}`, () => {
      const missing = keys.filter((k) => !(k in dict))
      expect(missing).toEqual([])
    })
  }
})
