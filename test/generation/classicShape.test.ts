// Classic Narrator first execution plan — Milestone 3: THE PREDICATE.
//
// `isClassicDirectShape` decides which of the two Classic paths a turn takes. It must be right in BOTH
// directions: too strict and the milestone is inert in production (everyone silently back on
// runWorkflow); too loose and an edited graph loses the nodes the user wired. Both failure modes are
// SILENT, so each is pinned below.
import { describe, it, expect } from 'vitest'
import { WorkflowDoc, NodeInstance } from '../../src/shared/workflow/types'
import { composeEffectiveGraph } from '../../src/shared/workflow/compose'
import {
  isClassicDirectShape,
  classicTurnPhaseIds
} from '../../src/main/services/generation/classicShape'
import {
  buildDefaultMemoryDocV2,
  DEFAULT_MEMORY_SEED_MARKER_V2
} from '../../src/main/services/nodes/builtin/defaultMemoryTemplate'

/** A fresh copy of the doc `workflowService.seedDefaultMemoryWorkflow` writes into a profile. */
const seeded = (): WorkflowDoc => buildDefaultMemoryDocV2()

/** The invisible read-only fallback a FRESH profile resolves (workflowStore.BUILTIN_DEFAULT_DOC's
 *  construction: the same template, normalized to id 'default' with the seed marker stripped). */
const builtin = (): WorkflowDoc => ({ ...buildDefaultMemoryDocV2(), id: 'default', meta: {} })

const nodeOf = (doc: WorkflowDoc, id: string): NodeInstance => doc.nodes.find((n) => n.id === id)!

describe('the direct-path predicate — docs that TAKE the direct path', () => {
  it('accepts the unedited seeded doc', () => {
    expect(isClassicDirectShape(seeded())).toBe(true)
  })

  it('accepts a fresh profile resolving the builtin fallback', () => {
    expect(isClassicDirectShape(builtin())).toBe(true)
  })

  it('ignores the doc identity a save assigns — a seeded copy is still the seeded shape', () => {
    // `createWorkflowFromDoc` stamps a fresh id; the user may rename the doc. Neither changes what a
    // turn executes, so neither may demote the turn onto the workflow path.
    const doc = seeded()
    doc.id = 'wf_7f3a91'
    doc.name = 'My narrator'
    doc.description = 'tweaked description'
    expect(isClassicDirectShape(doc)).toBe(true)
  })

  it('ignores node POSITION — dragging a node on the canvas is not an edit to the turn', () => {
    const doc = seeded()
    nodeOf(doc, 'llm').position = { x: -999, y: 12 }
    expect(isClassicDirectShape(doc)).toBe(true)
  })

  it('accepts a changed memory MODE — control.mode is trigger-rooted, outside the turn phase', () => {
    // The single most common real edit. `selected` cannot reach a turn (classicTurnInventory.test.ts
    // pins turn behavior as mode-independent), so demoting these users would be pure loss.
    for (const selected of ['every_turn', 'async', 'off']) {
      const doc = seeded()
      const mode = nodeOf(doc, 'mode')
      mode.config = { ...(mode.config as Record<string, unknown>), selected }
      expect(isClassicDirectShape(doc)).toBe(true)
    }
  })

  it('accepts changed trigger cadence / backlog threshold / memory settings', () => {
    const doc = seeded()
    nodeOf(doc, 'trigger-cadence').config = { everyNFloors: 12 }
    const state = nodeOf(doc, 'trigger-state')
    state.config = { ...(state.config as Record<string, unknown>), value: 20 }
    const maintain = nodeOf(doc, 'maintain')
    maintain.config = { ...(maintain.config as Record<string, unknown>), api_preset_id: 'cheap' }
    expect(isClassicDirectShape(doc)).toBe(true)
  })

  it('accepts the zero-packs compose result — composition is identity with no gate open', () => {
    const { doc } = composeEffectiveGraph(seeded(), [
      {
        packId: 'p1',
        doc: {
          id: 'f',
          name: 'f',
          version: 1,
          schemaVersion: 1,
          kind: 'fragment',
          nodes: [],
          edges: []
        },
        gateOpen: false
      }
    ])
    expect(isClassicDirectShape(doc)).toBe(true)
  })
})

describe('the direct-path predicate — docs that FALL BACK to runWorkflow', () => {
  it('falls back when an agent pack gate is OPEN (composition spliced)', () => {
    // Milestone 2's second caveat: an open gate changes the graph the turn executes. The real
    // composer stamps `meta.composition` exactly when it splices, which is what this reads.
    const { doc } = composeEffectiveGraph(seeded(), [
      {
        packId: 'p1',
        doc: {
          id: 'f',
          name: 'f',
          version: 1,
          schemaVersion: 1,
          kind: 'fragment',
          nodes: [],
          edges: []
        },
        gateOpen: true
      }
    ])
    expect(doc.meta?.composition).toBeDefined()
    expect(isClassicDirectShape(doc)).toBe(false)
  })

  it('falls back on a CONFIG edit to a turn-phase node', () => {
    for (const [id, config] of [
      ['llm', { retries: 3 }],
      ['trim', { table: 'summary' }],
      ['export', { max_rows: 10 }]
    ] as const) {
      const doc = seeded()
      nodeOf(doc, id).config = config as Record<string, unknown>
      expect(isClassicDirectShape(doc)).toBe(false)
    }
  })

  it('falls back when a PANEL is added to a spine node', () => {
    // A user who opted a spine node into an output panel must not silently lose it: the direct path
    // emits no panels.
    const doc = seeded()
    nodeOf(doc, 'assemble').panel = { show: true, label: 'Prompt' }
    expect(isClassicDirectShape(doc)).toBe(false)
  })

  it('falls back when a node is wired DOWNSTREAM of the main output', () => {
    // THE capability Milestone 2 flagged: this node lands in the detached post phase and genuinely
    // RUNS there under runWorkflow. The direct path has no post phase, so this doc must not take it.
    const doc = seeded()
    doc.nodes.push({
      id: 'after-write',
      type: 'util.log',
      config: { label: 'post' },
      position: { x: 0, y: 0 }
    })
    doc.edges.push({
      from: { node: 'write', port: 'floor' },
      to: { node: 'after-write', port: 'value' }
    })
    expect(isClassicDirectShape(doc)).toBe(false)
  })

  it('falls back when a spine node is DISABLED', () => {
    const doc = seeded()
    nodeOf(doc, 'export').disabled = true
    expect(isClassicDirectShape(doc)).toBe(false)
  })

  it('falls back when a spine node is RETYPED or RENAMED', () => {
    const retyped = seeded()
    nodeOf(retyped, 'trim').type = 'context.refresh'
    expect(isClassicDirectShape(retyped)).toBe(false)

    const renamed = seeded()
    const node = nodeOf(renamed, 'export')
    node.id = 'export2'
    for (const e of renamed.edges) {
      if (e.from.node === 'export') e.from.node = 'export2'
      if (e.to.node === 'export') e.to.node = 'export2'
    }
    expect(isClassicDirectShape(renamed)).toBe(false)
  })

  it('falls back when the WIRING changes without any node changing', () => {
    const doc = seeded()
    // Drop the table projection into assembly — same nodes, different prompt.
    doc.edges = doc.edges.filter((e) => !(e.from.node === 'export' && e.to.node === 'assemble'))
    expect(isClassicDirectShape(doc)).toBe(false)
  })

  it('falls back when the memory group is deleted (conservative, and safe)', () => {
    // Strictly this doc would behave identically on the direct path; the predicate is deliberately
    // fail-CLOSED, so an unrecognised shape goes to the unchanged engine rather than being guessed at.
    const doc = seeded()
    const keep = new Set(classicTurnPhaseIds())
    doc.nodes = doc.nodes.filter((n) => keep.has(n.id))
    doc.edges = doc.edges.filter((e) => keep.has(e.from.node) && keep.has(e.to.node))
    expect(isClassicDirectShape(doc)).toBe(false)
  })

  it('refuses non-turn docs outright', () => {
    const doc = seeded()
    doc.kind = 'subgraph'
    expect(isClassicDirectShape(doc)).toBe(false)
  })
})

// ── COMPARATOR ROT ────────────────────────────────────────────────────────────────────────────────

describe('comparator rot — the reference template is pinned', () => {
  it('pins the seeded default’s turn phase, its inert remainder, and its wiring', () => {
    // WHY THIS EXISTS. The predicate compares against `buildDefaultMemoryDocV2()`. If that template
    // changes — a node added to the spine, a default config value tweaked, an edge rewired — the
    // comparator silently stops matching any real profile's doc and EVERY user falls back to
    // runWorkflow. That failure is invisible: nothing breaks, the milestone just quietly stops
    // applying. This snapshot fails first, forcing whoever moves the template to re-check
    // classicShape.ts and the direct orchestration's stage list in classicTurn.ts.
    //
    // What it deliberately does NOT pin: the DEFAULT VALUES of the memory group's config (cadence,
    // backlog threshold, mode, the memory node's settings). The comparator ignores post-phase config
    // by design, so changing those defaults cannot rot it — pinning them here would only produce a
    // false alarm on every routine tuning of the template.
    const doc = seeded()
    const turnPhase = classicTurnPhaseIds()

    expect(doc.meta?.seeded).toBe(DEFAULT_MEMORY_SEED_MARKER_V2)

    // 1. The turn phase: exactly these ids, these types, and NO config (the direct path hardcodes the
    //    empty config of every stage it runs).
    expect(
      doc.nodes
        .filter((n) => turnPhase.has(n.id))
        .map((n) => `${n.id}:${n.type}:${JSON.stringify(n.config ?? {})}`)
        .sort()
    ).toEqual(
      [
        'apply:apply.state:{}',
        'assemble:prompt.assemble:{}',
        'ctx:input.context:{}',
        'export:table.export:{}',
        'llm:llm.sample:{}',
        'parse:parse.response:{}',
        'trim:context.trimProcessed:{}',
        'write:output.writeFloor:{}'
      ].sort()
    )

    // 2. The remainder: the trigger-rooted memory group the direct path never runs. Config is
    //    deliberately NOT pinned here — those are the user-facing knobs the predicate ignores.
    expect(
      doc.nodes
        .filter((n) => !turnPhase.has(n.id))
        .map((n) => `${n.id}:${n.type}`)
        .sort()
    ).toEqual(
      [
        'trigger-cadence:trigger.cadence',
        'trigger-state:trigger.state',
        'mode:control.mode',
        'maintain:memory.maintain',
        'log-apply:util.log'
      ].sort()
    )

    // 3. The whole wiring, verbatim.
    expect(
      doc.edges.map((e) => `${e.from.node}.${e.from.port}->${e.to.node}.${e.to.port}`).sort()
    ).toEqual(
      [
        'ctx.gen->trim.gen',
        'trim.gen->export.gen',
        'trim.gen->assemble.gen',
        'export.entries->assemble.entries',
        'trim.gen->llm.gen',
        'assemble.sendMessages->llm.sendMessages',
        'assemble.params->llm.params',
        'trim.gen->parse.gen',
        'llm.raw->parse.raw',
        'assemble.sendMessages->parse.sendMessages',
        'llm.rawUsage->parse.rawUsage',
        'trim.gen->apply.gen',
        'parse.parsed->apply.parsed',
        'parse.mvu->apply.mvu',
        'llm.raw->apply.raw',
        'trim.gen->write.gen',
        'llm.raw->write.raw',
        'assemble.sendMessages->write.sendMessages',
        'apply.variables->write.variables',
        'parse.parsed->write.parsed',
        'parse.metrics->write.metrics',
        'trigger-cadence.fired->mode.when1',
        'trigger-state.fired->mode.when2',
        'mode.fired->maintain.when',
        'maintain.error->log-apply.value'
      ].sort()
    )

    // 4. The main output the phase split hangs off.
    expect(doc.nodes.filter((n) => n.isMainOutput).map((n) => n.id)).toEqual(['write'])
    // 5. No node ships a panel — the direct path emits none.
    expect(doc.nodes.some((n) => n.panel)).toBe(false)
  })
})
