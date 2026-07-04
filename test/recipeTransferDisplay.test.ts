import { describe, it, expect } from 'vitest'
import {
  recipeExportReviewModel,
  narratorLineKey,
  initialRecipeForm,
  canSubmitRecipeForm,
  recipeExportOpts,
  recipeExportErrorKey,
  condensedCapabilities,
  recipeInspectionModel,
  recipeDedupeChipKey,
  recipeTemplateOutcomeKey,
  recipeParseErrorTitleKey,
  recipeParseErrorBodyKey,
  recipeParseErrorHasDetails,
  initialWorldPicker,
  selectWorld,
  appliedLines,
  classifyFailedStep,
  failedStepKey,
  partialResultModel,
  RECIPE_STEPS,
  type RecipeExportPreview,
  type RecipeInspectionReport,
  type RecipeApplied,
  type RecipeParseErrorCode,
  type RecipeCapabilityReport
} from '../src/renderer/src/components/workspace/recipeTransferDisplay'
import en from '../src/renderer/src/i18n/locales/en'
import zh from '../src/renderer/src/i18n/locales/zh'

// Pins the pure display derivations behind the RECIPE export wizard + import inspection sheet
// (agent-packs plan WP5.3). vitest runs under Node with no jsdom renderer, so per WP convention the
// display LOGIC (view-model assembly + copy-key mapping + world-picker + partial-result copy) is
// extracted here and covered; the components add only labels + DOM.

const capReport = (over?: Partial<RecipeCapabilityReport>): RecipeCapabilityReport => ({
  capabilities: [],
  unknownNodeTypes: [],
  nodesByCapability: {},
  ...over
})

const preview = (over?: Partial<RecipeExportPreview>): RecipeExportPreview => ({
  recipeMeta: { id: 'r1', name: 'My World', sizeBytes: 2048 },
  packs: [
    { id: 'p1', version: 2, name: 'Table Memory', enabled: true },
    { id: 'p2', version: 1, name: 'Async Memory', enabled: false }
  ],
  narratorKind: 'builtin',
  bundledTemplateNames: [],
  noTemplatesBundled: true,
  warnings: [],
  ...over
})

describe('recipeExportReviewModel', () => {
  it('flattens packs, counts enabled, and maps a builtin narrator', () => {
    const m = recipeExportReviewModel(preview())
    expect(m.packCount).toBe(2)
    expect(m.enabledCount).toBe(1)
    expect(m.packs.map((p) => p.version)).toEqual([2, 1])
    expect(m.narrator).toBe('builtin')
    expect(m.templateNote).toBe('none')
  })

  it('maps an embedded narrator to the custom line and lists bundled templates', () => {
    const m = recipeExportReviewModel(
      preview({
        narratorKind: 'embedded',
        noTemplatesBundled: false,
        bundledTemplateNames: ['World State']
      })
    )
    expect(m.narrator).toBe('custom')
    expect(m.templateNote).toBe('bundled')
    expect(m.bundledTemplateNames).toEqual(['World State'])
  })

  it('carries description/creator only when present', () => {
    const withMeta = recipeExportReviewModel(
      preview({ recipeMeta: { id: 'r', name: 'N', description: 'd', creator: 'c', sizeBytes: 1 } })
    )
    expect(withMeta.description).toBe('d')
    expect(withMeta.creator).toBe('c')
    const bare = recipeExportReviewModel(preview())
    expect(bare.description).toBeUndefined()
    expect(bare.creator).toBeUndefined()
  })
})

describe('export form', () => {
  it('prefills name from the world, falls back when unnamed, and starts optionals empty', () => {
    expect(initialRecipeForm('Neon City', 'Untitled')).toEqual({
      name: 'Neon City',
      description: '',
      creator: ''
    })
    expect(initialRecipeForm('   ', 'Untitled setup').name).toBe('Untitled setup')
  })

  it('requires a non-blank name to submit', () => {
    expect(canSubmitRecipeForm({ name: 'x', description: '', creator: '' })).toBe(true)
    expect(canSubmitRecipeForm({ name: '   ', description: 'd', creator: 'c' })).toBe(false)
  })

  it('normalizes opts — trims and drops empty optionals', () => {
    expect(recipeExportOpts({ name: '  N  ', description: '', creator: '  ' })).toEqual({ name: 'N' })
    expect(recipeExportOpts({ name: 'N', description: ' d ', creator: ' c ' })).toEqual({
      name: 'N',
      description: 'd',
      creator: 'c'
    })
  })
})

describe('condensedCapabilities', () => {
  it('orders by CAPABILITY_IDS and tags writes, without node expand', () => {
    const rows = condensedCapabilities(
      capReport({ capabilities: ['writes-tables', 'reads-tables'] })
    )
    expect(rows.map((r) => r.id)).toEqual(['reads-tables', 'writes-tables'])
    expect(rows.find((r) => r.id === 'writes-tables')!.write).toBe(true)
    expect(rows.find((r) => r.id === 'reads-tables')!.write).toBe(false)
    // No nodeIds leaked into the condensed shape.
    expect(Object.keys(rows[0])).toEqual(['id', 'write'])
  })
})

const inspection = (over?: Partial<RecipeInspectionReport>): RecipeInspectionReport => ({
  recipeMeta: { id: 'r1', name: 'My World', creator: 'me' },
  packs: [
    {
      id: 'p1',
      version: 2,
      name: 'Table Memory',
      dedupe: 'new',
      capabilityReport: capReport({ capabilities: ['writes-tables'] }),
      unknownNodeTypes: [],
      warnings: []
    }
  ],
  narrator: { kind: 'builtin', unknownNodeTypes: [], warnings: [] },
  templatePlans: [],
  blocked: false,
  warnings: [],
  token: 'tok-1',
  ...over
})

describe('recipeInspectionModel', () => {
  it('assembles a clean report — installable, no offenders', () => {
    const m = recipeInspectionModel(inspection())
    expect(m.kind).toBe('report')
    expect(m.canInstall).toBe(true)
    expect(m.token).toBe('tok-1')
    expect(m.blocked).toBe(false)
    expect(m.offenderNames).toEqual([])
    expect(m.packs[0].capabilities.map((c) => c.id)).toEqual(['writes-tables'])
    expect(m.narrator?.line).toBe('builtin')
  })

  it('flags a broken pack — blocks the recipe, names the offender, disables install', () => {
    const m = recipeInspectionModel(
      inspection({
        blocked: true,
        packs: [
          {
            id: 'p1',
            version: 1,
            name: 'Weird Pack',
            dedupe: 'new',
            capabilityReport: capReport(),
            unknownNodeTypes: ['x.mystery'],
            warnings: []
          }
        ]
      })
    )
    expect(m.packs[0].blocks).toBe(true)
    expect(m.blocked).toBe(true)
    expect(m.offenderNames).toEqual(['Weird Pack'])
    expect(m.canInstall).toBe(false)
  })

  it('short-circuits a parse error — no token, not installable', () => {
    const m = recipeInspectionModel(
      inspection({ parseError: { code: 'invalid-narrator' }, token: undefined })
    )
    expect(m.kind).toBe('parse-error')
    expect(m.canInstall).toBe(false)
    expect(m.token).toBeUndefined()
  })

  it('maps an embedded narrator to the custom line and surfaces its node count', () => {
    const m = recipeInspectionModel(
      inspection({ narrator: { kind: 'embedded', nodeCount: 4, unknownNodeTypes: [], warnings: [] } })
    )
    expect(m.narrator?.line).toBe('custom')
    expect(m.narrator?.nodeCount).toBe(4)
    expect(m.narrator?.blocks).toBe(false)
  })

  it('a token with no block is required for install — no token means not installable', () => {
    expect(recipeInspectionModel(inspection({ token: undefined })).canInstall).toBe(false)
  })
})

describe('world picker', () => {
  const worlds = [
    { id: 'w1', name: 'Alpha' },
    { id: 'w2', name: 'Beta' }
  ]

  it('preselects the current world and marks it', () => {
    const s = initialWorldPicker(worlds, 'w2')
    expect(s.selectedId).toBe('w2')
    expect(s.hasSelection).toBe(true)
    expect(s.options.find((o) => o.id === 'w2')!.current).toBe(true)
    expect(s.options.find((o) => o.id === 'w1')!.current).toBe(false)
  })

  it('selects nothing when there is no current world (user must choose)', () => {
    const s = initialWorldPicker(worlds, null)
    expect(s.selectedId).toBeNull()
    expect(s.hasSelection).toBe(false)
  })

  it('selects nothing when the current world is not in the list', () => {
    expect(initialWorldPicker(worlds, 'ghost').selectedId).toBeNull()
  })

  it('applies a valid selection and ignores an unknown id', () => {
    const s0 = initialWorldPicker(worlds, null)
    const s1 = selectWorld(s0, 'w1')
    expect(s1.selectedId).toBe('w1')
    expect(s1.hasSelection).toBe(true)
    expect(selectWorld(s1, 'nope').selectedId).toBe('w1')
  })
})

describe('applied lines + partial result', () => {
  const applied: RecipeApplied = {
    templates: [{ name: 'T', id: 't1' }],
    packs: [
      { id: 'p1', version: 1, installed: true },
      { id: 'p2', version: 2, installed: false }
    ],
    narrator: { kind: 'embedded', workflowId: 'wf1' },
    activation: [
      { packId: 'p1', version: 1, enabled: true },
      { packId: 'p2', version: 2, enabled: false }
    ]
  }

  it('emits one line per non-empty step in apply order', () => {
    const lines = appliedLines(applied)
    expect(lines.map((l) => l.key)).toEqual([
      'recipe.applied.templates',
      'recipe.applied.packs',
      'recipe.applied.narrator',
      'recipe.applied.activation'
    ])
    expect(lines[1].vars).toEqual({ n: 2, installed: 1 })
    expect(lines[3].vars).toEqual({ n: 2, enabled: 1 })
  })

  it('drops empty steps', () => {
    const lines = appliedLines({ templates: [], packs: [], activation: [] })
    expect(lines).toEqual([])
  })

  it('classifies failed steps (including qualified names) and falls back to unknown', () => {
    expect(classifyFailedStep('narrator')).toBe('narrator')
    expect(classifyFailedStep('narrator.install')).toBe('narrator')
    expect(classifyFailedStep('ACTIVATION')).toBe('activation')
    expect(classifyFailedStep('mystery')).toBe('unknown')
  })

  it('builds the partial-result model with landed lines + failed-step key', () => {
    const m = partialResultModel(applied, 'narrator', 'boom')
    expect(m.applied.map((l) => l.key)).toContain('recipe.applied.packs')
    expect(m.failedStepKey).toBe('recipe.partial.failed.narrator')
    expect(m.error).toBe('boom')
  })

  it('failedStepKey maps every step + unknown', () => {
    for (const step of RECIPE_STEPS) expect(failedStepKey(step)).toBe(`recipe.partial.failed.${step}`)
    expect(failedStepKey('what')).toBe('recipe.partial.failed.unknown')
  })
})

// ── Copy-key coverage: every derived key resolves in BOTH locales ──────────────────────────────────
describe('i18n key coverage', () => {
  const keys: string[] = []

  keys.push(narratorLineKey('builtin'), narratorLineKey('custom'))
  keys.push(recipeExportErrorKey('no-activated-packs'))
  keys.push(
    recipeDedupeChipKey('new'),
    recipeDedupeChipKey('new-version'),
    recipeDedupeChipKey('already-installed')
  )
  keys.push(
    recipeTemplateOutcomeKey('will-install'),
    recipeTemplateOutcomeKey('will-duplicate')
  )
  const parseCodes: RecipeParseErrorCode[] = [
    'too-large',
    'invalid-json',
    'unsupported-version',
    'invalid-envelope',
    'not-a-fragment',
    'invalid-fragment',
    'invalid-narrator',
    'duplicate-pack',
    'activation-refers-unknown-pack',
    'activation-duplicate-pack'
  ]
  for (const c of parseCodes) {
    keys.push(recipeParseErrorTitleKey(c), recipeParseErrorBodyKey(c))
  }
  for (const step of [...RECIPE_STEPS, 'unknown']) keys.push(`recipe.partial.failed.${step}`)
  keys.push(
    'recipe.applied.templates',
    'recipe.applied.packs',
    'recipe.applied.narrator',
    'recipe.applied.activation'
  )

  it('resolves every derived copy key in en', () => {
    for (const k of keys) expect(en, `missing en key: ${k}`).toHaveProperty([k])
  })
  it('resolves every derived copy key in zh', () => {
    for (const k of keys) expect(zh, `missing zh key: ${k}`).toHaveProperty([k])
  })
})

describe('recipeParseErrorHasDetails', () => {
  it('true only when a field-error list is present', () => {
    expect(recipeParseErrorHasDetails({ code: 'invalid-narrator', errors: ['bad'] })).toBe(true)
    expect(recipeParseErrorHasDetails({ code: 'too-large' })).toBe(false)
  })
})
