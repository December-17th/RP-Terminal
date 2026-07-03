import { describe, it, expect } from 'vitest'
import {
  resolveSettingLabel,
  systemLabelKey,
  provenanceChipKey,
  canReset,
  nearestOverrideScope,
  valueAfterReset,
  type PackSettingView
} from '../src/renderer/src/components/workspace/agentPackSettingsDisplay'

// Pure display-derivation for the Agents detail panel's settings (agent-packs plan WP3.2). Node-env,
// React-free (the codebase's node-env display-logic convention — cf. agentPackDisplay.test.ts).

const mk = (over: Partial<PackSettingView>): PackSettingView => ({
  id: 's',
  kind: 'pack',
  type: 'number',
  default: 3,
  resolved: { value: 3, provenance: 'default' },
  ...over
})

describe('resolveSettingLabel', () => {
  it('picks the active locale from a per-locale map, falling back to en then any', () => {
    const label = { en: 'Every', zh: '每次' }
    expect(resolveSettingLabel(label, 'zh', 'id')).toBe('每次')
    expect(resolveSettingLabel(label, 'en', 'id')).toBe('Every')
    expect(resolveSettingLabel(label, 'fr', 'id')).toBe('Every') // fall back to en
    expect(resolveSettingLabel({ zh: '仅中文' }, 'en', 'id')).toBe('仅中文') // no en → any
  })

  it('uses a plain string as-is, and falls back to the id when absent', () => {
    expect(resolveSettingLabel('Plain', 'zh', 'id')).toBe('Plain')
    expect(resolveSettingLabel(undefined, 'en', 'my.id')).toBe('my.id')
  })
})

describe('systemLabelKey', () => {
  it('maps a labelKind token to its i18n key', () => {
    expect(systemLabelKey('trigger-cadence')).toBe('agents.settings.sys.cadence')
    expect(systemLabelKey('trigger-table')).toBe('agents.settings.sys.watchedTable')
    expect(systemLabelKey('trigger-value')).toBe('agents.settings.sys.triggerValue')
    expect(systemLabelKey(undefined)).toBe('agents.settings.sys.triggerValue')
  })
})

describe('provenanceChipKey', () => {
  it('maps each provenance to its chip key', () => {
    expect(provenanceChipKey('default')).toBe('agents.settings.prov.default')
    expect(provenanceChipKey('global')).toBe('agents.settings.prov.global')
    expect(provenanceChipKey('world')).toBe('agents.settings.prov.world')
    expect(provenanceChipKey('chat')).toBe('agents.settings.prov.chat')
  })
})

describe('canReset / nearestOverrideScope', () => {
  it('a defaulted setting cannot be reset (nothing to clear)', () => {
    const s = mk({ resolved: { value: 3, provenance: 'default' } })
    expect(canReset(s)).toBe(false)
    expect(nearestOverrideScope(s)).toBeNull()
  })

  it('an overridden setting resets its nearest scope', () => {
    expect(nearestOverrideScope(mk({ resolved: { value: 'c', provenance: 'chat' } }))).toBe('chat')
    expect(nearestOverrideScope(mk({ resolved: { value: 'w', provenance: 'world' } }))).toBe('world')
    expect(canReset(mk({ resolved: { value: 'w', provenance: 'world' } }))).toBe(true)
  })
})

describe('valueAfterReset (clearing chat reveals world, then default)', () => {
  it('chat override with a world value beneath → reveals world', () => {
    const s = mk({
      default: 3,
      resolved: { value: 9, provenance: 'chat', chatValue: 9, worldValue: 5, globalValue: 2 }
    })
    expect(valueAfterReset(s)).toEqual({ value: 5, provenance: 'world' })
  })

  it('chat override with only a global beneath → reveals global', () => {
    const s = mk({
      default: 3,
      resolved: { value: 9, provenance: 'chat', chatValue: 9, globalValue: 2 }
    })
    expect(valueAfterReset(s)).toEqual({ value: 2, provenance: 'global' })
  })

  it('world override with nothing beneath → falls to the schema default', () => {
    const s = mk({ default: 3, resolved: { value: 5, provenance: 'world', worldValue: 5 } })
    expect(valueAfterReset(s)).toEqual({ value: 3, provenance: 'default' })
  })
})
