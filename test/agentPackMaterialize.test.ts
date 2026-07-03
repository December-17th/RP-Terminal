import { describe, it, expect, vi } from 'vitest'
import {
  materializeFragment,
  deriveSystemSettings,
  sysTriggerKey,
  readNodeConfigPath
} from '../src/main/services/agentPackMaterialize'
import type { ExposedSetting } from '../src/main/services/agentPackStore'
import { WorkflowDoc } from '../src/shared/workflow/types'
import {
  ASYNC_MEMORY_FRAGMENT,
  ASYNC_MEMORY_BACKLOG_N,
  ASYNC_MEMORY_WATCH_TABLE,
  buildAsyncMemoryPack
} from '../src/main/services/nodes/builtin/asyncMemoryPack'
import {
  TABLE_MEMORY_FRAGMENT,
  buildTableMemoryPack
} from '../src/main/services/nodes/builtin/tableMemoryPack'
import { StateTrigger, CadenceTrigger } from '../src/shared/workflow/attachments'

// Silence the module's skip-with-log so test output is clean (behavior asserted, not the log line).
vi.mock('../src/main/services/logService', () => ({ log: () => {} }))

// agentPackMaterialize (agent-packs plan WP3.2) — the keystone that applies resolved overrides to a
// pack's fragment BEFORE composition/headless run. These pin: (1) the zero-change guarantee (no
// overrides → deep-equal the raw fragment), (2) creator-exposed settings landing in target node config
// with clamping + type-checks, (3) auto-derived System trigger params landing in the attachments copy,
// (4) unknown targets skipped safely, (5) the two builtin packs' real settings.

// ── A tiny fragment with a settable node config + a table state trigger + a cadence trigger ──────────
const makeFragment = (): WorkflowDoc => ({
  id: 'test.frag',
  name: 'test',
  version: 1,
  schemaVersion: 1,
  kind: 'fragment',
  nodes: [{ id: 'gate', type: 'table.gate', config: { every: 3 } }],
  edges: [],
  attachments: [
    // index 0 — an entry (NOT a trigger; the auto-derive must skip it but keep the index).
    { kind: 'entry', checkpoint: 'context-ready', mode: 'branch', entryPort: { node: 'gate', port: 'gen' } },
    // index 1 — a table-scoped state trigger (auto-exposes .value + .table).
    {
      kind: 'trigger',
      trigger: 'state',
      source: { scope: 'table', table: 'summary', stat: 'unprocessed' },
      op: 'gte',
      value: 6
    } as StateTrigger,
    // index 2 — a cadence trigger (auto-exposes .value = everyNFloors).
    { kind: 'trigger', trigger: 'cadence', everyNFloors: 5 } as CadenceTrigger
  ]
})

const packWith = (fragment: WorkflowDoc, exposedSettings: ExposedSetting[] = []) => ({
  id: 'test.pack',
  manifest: { exposedSettings },
  fragment
})

describe('materializeFragment — zero-change guarantee', () => {
  it('with no overrides deep-equals the raw fragment (both builtin packs)', () => {
    for (const build of [buildTableMemoryPack, buildAsyncMemoryPack]) {
      const pack = build()
      const out = materializeFragment(pack, {})
      expect(out).toEqual(pack.fragment)
      // And it is a COPY (never the stored reference — mutation-safety).
      expect(out).not.toBe(pack.fragment)
    }
  })

  it('an override that matches NO setting/trigger leaves the fragment unchanged', () => {
    const pack = packWith(makeFragment())
    const out = materializeFragment(pack, { 'not.a.real.id': 999 })
    expect(out).toEqual(pack.fragment)
  })
})

describe('materializeFragment — creator-exposed settings', () => {
  const exposed: ExposedSetting[] = [
    {
      id: 'maintenance.every',
      label: 'every',
      type: 'number',
      default: 3,
      min: 1,
      max: 20,
      target: { nodeId: 'gate', path: 'every' }
    }
  ]

  it('writes the resolved override into the target node config', () => {
    const pack = packWith(makeFragment(), exposed)
    const out = materializeFragment(pack, { 'maintenance.every': 8 })
    expect(readNodeConfigPath(out, 'gate', 'every')).toBe(8)
  })

  it('clamps a number to [min, max]', () => {
    const pack = packWith(makeFragment(), exposed)
    expect(readNodeConfigPath(materializeFragment(pack, { 'maintenance.every': 999 }), 'gate', 'every')).toBe(20)
    expect(readNodeConfigPath(materializeFragment(pack, { 'maintenance.every': -4 }), 'gate', 'every')).toBe(1)
  })

  it('skips a wrong-typed value (string on a number setting) — keeps the default', () => {
    const pack = packWith(makeFragment(), exposed)
    const out = materializeFragment(pack, { 'maintenance.every': 'nope' })
    expect(readNodeConfigPath(out, 'gate', 'every')).toBe(3) // untouched
  })

  it('skips a setting whose target node is absent (unknown nodeId) without throwing', () => {
    const bad: ExposedSetting[] = [
      { id: 's', label: 's', type: 'number', default: 1, target: { nodeId: 'ghost', path: 'x' } }
    ]
    const pack = packWith(makeFragment(), bad)
    expect(() => materializeFragment(pack, { s: 5 })).not.toThrow()
    // The fragment is otherwise unchanged.
    expect(materializeFragment(pack, { s: 5 })).toEqual(pack.fragment)
  })

  it('enforces enum options — an out-of-set value is skipped', () => {
    const enumSetting: ExposedSetting[] = [
      { id: 'e', label: 'e', type: 'enum', default: 'a', options: ['a', 'b'], target: { nodeId: 'gate', path: 'mode' } }
    ]
    const pack = packWith(makeFragment(), enumSetting)
    expect(readNodeConfigPath(materializeFragment(pack, { e: 'b' }), 'gate', 'mode')).toBe('b')
    expect(readNodeConfigPath(materializeFragment(pack, { e: 'z' }), 'gate', 'mode')).toBeUndefined()
  })
})

describe('materializeFragment — auto-derived System trigger params', () => {
  it('writes a state trigger comparison value override into the attachments copy', () => {
    const pack = packWith(makeFragment())
    const out = materializeFragment(pack, { [sysTriggerKey(1, 'value')]: 12 })
    const trig = (out.attachments ?? [])[1] as StateTrigger
    expect(trig.value).toBe(12)
    // The original fragment is untouched (copy semantics).
    expect(((pack.fragment.attachments ?? [])[1] as StateTrigger).value).toBe(6)
  })

  it('writes a table-scoped trigger watched-table override', () => {
    const pack = packWith(makeFragment())
    const out = materializeFragment(pack, { [sysTriggerKey(1, 'table')]: 'chronicle' })
    const trig = (out.attachments ?? [])[1] as StateTrigger
    expect(trig.source).toEqual({ scope: 'table', table: 'chronicle', stat: 'unprocessed' })
  })

  it('writes a cadence everyNFloors override via the .value key', () => {
    const pack = packWith(makeFragment())
    const out = materializeFragment(pack, { [sysTriggerKey(2, 'value')]: 9 })
    const trig = (out.attachments ?? [])[2] as CadenceTrigger
    expect(trig.everyNFloors).toBe(9)
  })

  it('skips a wrong-typed trigger override (string on a numeric comparison value)', () => {
    const pack = packWith(makeFragment())
    const out = materializeFragment(pack, { [sysTriggerKey(1, 'value')]: 'x' })
    expect(((out.attachments ?? [])[1] as StateTrigger).value).toBe(6) // untouched
  })
})

describe('deriveSystemSettings', () => {
  it('derives .value + .table for a table state trigger and .value for a cadence, skipping entries', () => {
    const settings = deriveSystemSettings(makeFragment())
    const ids = settings.map((s) => s.id)
    expect(ids).toEqual([
      sysTriggerKey(1, 'value'),
      sysTriggerKey(1, 'table'),
      sysTriggerKey(2, 'value')
    ])
    // Defaults reflect the fragment's own values.
    const byId = Object.fromEntries(settings.map((s) => [s.id, s]))
    expect(byId[sysTriggerKey(1, 'value')].defaultValue).toBe(6)
    expect(byId[sysTriggerKey(1, 'table')].defaultValue).toBe('summary')
    expect(byId[sysTriggerKey(2, 'value')].defaultValue).toBe(5)
    expect(byId[sysTriggerKey(2, 'value')].labelKind).toBe('trigger-cadence')
  })

  it('a manual trigger exposes no settings', () => {
    const doc: WorkflowDoc = {
      id: 'm', name: 'm', version: 1, schemaVersion: 1, kind: 'fragment', nodes: [], edges: [],
      attachments: [{ kind: 'trigger', trigger: 'manual' }]
    }
    expect(deriveSystemSettings(doc)).toEqual([])
  })
})

describe('the two builtin packs expose their real settings', () => {
  it('async-memory auto-exposes backlog N + watched table at the trigger index (3)', () => {
    const pack = buildAsyncMemoryPack()
    const settings = deriveSystemSettings(pack.fragment)
    const byId = Object.fromEntries(settings.map((s) => [s.id, s]))
    expect(byId[sysTriggerKey(3, 'value')]?.defaultValue).toBe(ASYNC_MEMORY_BACKLOG_N)
    expect(byId[sysTriggerKey(3, 'table')]?.defaultValue).toBe(ASYNC_MEMORY_WATCH_TABLE)
    // And a backlog-N override materializes onto the trigger.
    const out = materializeFragment(pack, { [sysTriggerKey(3, 'value')]: 10 })
    const trig = (out.attachments ?? [])[3] as StateTrigger
    expect(trig.value).toBe(10)
  })

  it('async-memory exposes the trimmer table scope (creator setting) → trim.config.table', () => {
    const pack = buildAsyncMemoryPack()
    expect(pack.manifest.exposedSettings?.some((s) => s.id === 'trim.tableScope')).toBe(true)
    const out = materializeFragment(pack, { 'trim.tableScope': 'chronicle' })
    expect(readNodeConfigPath(out, 'trim', 'table')).toBe('chronicle')
  })

  it('table-memory exposes the maintenance cadence (creator setting) → gate.config.every', () => {
    const pack = buildTableMemoryPack()
    const setting = pack.manifest.exposedSettings?.find((s) => s.id === 'maintenance.every')
    expect(setting?.default).toBe(3)
    expect(setting?.target).toEqual({ nodeId: 'gate', path: 'every' })
    const out = materializeFragment(pack, { 'maintenance.every': 7 })
    expect(readNodeConfigPath(out, 'gate', 'every')).toBe(7)
  })

  it('table-memory has no triggers → no auto-derived System settings', () => {
    expect(deriveSystemSettings(TABLE_MEMORY_FRAGMENT)).toEqual([])
  })

  it('async-memory fragment default constant unchanged (sanity — the fragment still hard-codes N=6)', () => {
    const trig = (ASYNC_MEMORY_FRAGMENT.attachments ?? []).find((a) => a.kind === 'trigger') as StateTrigger
    expect(trig.value).toBe(ASYNC_MEMORY_BACKLOG_N)
  })
})
