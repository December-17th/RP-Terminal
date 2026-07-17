import { describe, it, expect } from 'vitest'
import {
  normalize,
  getDefaultSettings,
  resolveModeConfig,
  encryptSecret,
  decryptSecret,
  maskSecret,
  isMaskedKey
} from '../src/main/services/settingsService'

describe('api-key masking', () => {
  it('masks ≥ 2/3 of a key, keeping only a few first/last chars', () => {
    const key = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const m = maskSecret(key)
    expect(m).toContain('•')
    expect(m).not.toBe(key)
    const visible = m.replace(/•/g, '')
    expect(visible.length).toBeLessThanOrEqual(Math.ceil(key.length / 3)) // ≥ 2/3 hidden
    expect(key.startsWith(visible.slice(0, 2))).toBe(true) // keeps the real prefix
    expect(isMaskedKey(m)).toBe(true)
  })
  it('fully masks short inputs, leaves empty alone, and detects real keys', () => {
    expect(maskSecret('')).toBe('')
    expect(maskSecret('abc')).toBe('••••••••')
    expect(isMaskedKey('sk-real-key-no-bullets')).toBe(false)
    expect(isMaskedKey('')).toBe(false)
  })
})

describe('api-key encryption', () => {
  it('round-trips a secret through encrypt/decrypt', () => {
    const enc = encryptSecret('sk-secret-123')
    expect(enc).not.toBe('sk-secret-123')
    expect(enc.startsWith('enc:v1:')).toBe(true)
    expect(decryptSecret(enc)).toBe('sk-secret-123')
  })

  it('leaves empty strings untouched', () => {
    expect(encryptSecret('')).toBe('')
    expect(decryptSecret('')).toBe('')
  })

  it('does not double-encrypt an already-encrypted value', () => {
    const enc = encryptSecret('k')
    expect(encryptSecret(enc)).toBe(enc)
  })

  it('passes through legacy plaintext on decrypt (transparent migration)', () => {
    expect(decryptSecret('plain-legacy-key')).toBe('plain-legacy-key')
  })
})

describe('settings normalize', () => {
  it('seeds a single "Default" API preset from the live api block when none exist', () => {
    const s = normalize({
      api: {
        provider: 'anthropic',
        endpoint: 'https://x',
        api_key: 'k',
        model: 'm'
      }
    })
    expect(s.api_presets).toHaveLength(1)
    expect(s.api_presets[0]).toMatchObject({
      id: 'default',
      name: 'Default',
      provider: 'anthropic',
      endpoint: 'https://x',
      api_key: 'k',
      model: 'm'
    })
    expect(s.active_api_preset_id).toBe('default')
  })

  it('fills defaults for an empty input', () => {
    const s = normalize({})
    expect(s.persona).toEqual({ name: 'User', description: '', inject: true, depth: null })
    expect(s.generation.max_context_tokens).toBe(200000)
    expect(s.ui.font_size).toBe(16)
  })

  it('merges per-section so a partial section keeps the other defaults', () => {
    const s = normalize({ ui: { font_size: 22 } as any, persona: { name: 'Lyra' } as any })
    expect(s.ui.font_size).toBe(22)
    expect(s.ui.theme).toBe('dark') // default preserved
    expect(s.ui.show_fps).toBe(false)
    expect(s.persona.name).toBe('Lyra')
    expect(s.persona.inject).toBe(true) // default preserved
  })

  it('repairs an active_api_preset_id that points at no existing preset', () => {
    const s = normalize({
      api_presets: [
        { id: 'a', name: 'A', provider: 'openai', endpoint: '', api_key: '', model: '' }
      ],
      active_api_preset_id: 'gone'
    })
    expect(s.active_api_preset_id).toBe('a')
  })

  it('keeps an existing preset set instead of reseeding', () => {
    const presets = [
      { id: 'a', name: 'A', provider: 'openai', endpoint: '', api_key: '', model: '' },
      { id: 'b', name: 'B', provider: 'anthropic', endpoint: '', api_key: '', model: '' }
    ]
    const s = normalize({ api_presets: presets, active_api_preset_id: 'b' })
    expect(s.api_presets).toHaveLength(2)
    expect(s.active_api_preset_id).toBe('b')
  })

  it('getDefaultSettings has no presets (they are seeded by normalize)', () => {
    expect(getDefaultSettings().api_presets).toEqual([])
  })

  it('seeds the three FSM modes with their defaults', () => {
    const s = normalize({})
    expect(Object.keys(s.modes).sort()).toEqual(['combat', 'dialogue', 'explore'])
    expect(s.modes.combat.max_output_tokens).toBe(450)
    expect(s.modes.explore.scan_depth).toBe(4)
  })

  it('defaults agent mode to off (classic)', () => {
    expect(normalize({}).agent.mode).toBe('off')
  })

  it('preserves a valid stored agent mode', () => {
    expect(normalize({ agent: { mode: 'manual' } }).agent.mode).toBe('manual')
    expect(normalize({ agent: { mode: 'agentic' } }).agent.mode).toBe('agentic')
  })

  it('coerces an unknown agent mode to off', () => {
    expect(normalize({ agent: { mode: 'bogus' } as any }).agent.mode).toBe('off')
  })

  it('migrates the legacy boolean agent toggle (enabled → manual / off)', () => {
    expect(normalize({ agent: { enabled: true } as any }).agent.mode).toBe('manual')
    expect(normalize({ agent: { enabled: false } as any }).agent.mode).toBe('off')
  })

  it('merges a partial mode override while keeping the other tuning fields', () => {
    const s = normalize({ modes: { combat: { max_output_tokens: 800 } } as any })
    expect(s.modes.combat.max_output_tokens).toBe(800) // overridden
    expect(s.modes.combat.scan_depth).toBe(2) // default preserved
    expect(s.modes.combat.addendum).toContain('Combat mode') // default preserved
    expect(s.modes.explore.max_output_tokens).toBe(1200) // untouched mode intact
  })
})

describe('settings tables section (memory-table reminder)', () => {
  it('defaults tables with the new-session reminder on', () => {
    const t = getDefaultSettings().tables
    expect(t.default_update_frequency).toBe(3)
    expect(t.injection_max_rows).toBe(20)
    expect(t.remind_set_template).toBe(true)
  })

  it('preserves a stored remind_set_template=false and keeps the other tables defaults', () => {
    const s = normalize({ tables: { remind_set_template: false } } as any)
    expect(s.tables.remind_set_template).toBe(false)
    expect(s.tables.default_update_frequency).toBe(3) // default preserved
    expect(s.tables.injection_max_rows).toBe(20) // default preserved
  })
})

describe('resolveModeConfig', () => {
  it('returns the requested mode config', () => {
    const s = normalize({})
    expect(resolveModeConfig(s, 'combat')).toBe(s.modes.combat)
  })

  it('falls back to explore for an unknown mode', () => {
    const s = normalize({})
    expect(resolveModeConfig(s, 'nonsense')).toBe(s.modes.explore)
  })
})

describe('settings cache section', () => {
  // The cache system is STASHED (WS-2): default + pinned to `baseline` (no optimization, not even provider
  // caching); `level` is derived from `mode` (frozen → 1, else 0).
  it('defaults to baseline mode / level 0', () => {
    const c = getDefaultSettings().cache
    expect(c.mode).toBe('baseline')
    expect(c.level).toBe(0)
    expect(c.l1_mode).toBe('partition')
    expect(c.ttl).toBe('5m')
    expect(c.prewarm).toBe(false)
    expect(c.breakpoint_optimizer).toBe(false)
  })

  it('coerces a legacy stored cache (level 1, no mode) to the stashed baseline', () => {
    const s = normalize({ cache: { level: 1, l1_mode: 'diff' } } as any)
    // No explicit mode → pinned to baseline; level derived to 0 (the system is parked).
    expect(s.cache.mode).toBe('baseline')
    expect(s.cache.level).toBe(0)
    // other unset fields still fall back to defaults; l1_mode is preserved (the dormant Frozen-Core knob)
    expect(s.cache.l1_mode).toBe('diff')
    expect(s.cache.ttl).toBe('5m')
    expect(s.cache.prewarm).toBe(false)
  })

  it('preserves an explicit frozen mode and derives level 1', () => {
    const s = normalize({ cache: { mode: 'frozen' } } as any)
    expect(s.cache.mode).toBe('frozen')
    expect(s.cache.level).toBe(1)
  })

  it('supplies the cache section (baseline) when stored settings omit it entirely', () => {
    const s = normalize({})
    expect(s.cache.mode).toBe('baseline')
    expect(s.cache.level).toBe(0)
  })
})

describe('settings usage-meter + pricing', () => {
  it('defaults: overlay off, empty fields/columns, empty pricing', () => {
    const s = getDefaultSettings()
    expect(s.ui.usage_meter.enabled).toBe(false)
    expect(s.ui.usage_meter.x).toBeNull()
    expect(s.ui.usage_meter.y).toBeNull()
    expect(s.ui.usage_meter.collapsed).toBe(false)
    expect(Array.isArray(s.ui.usage_meter.fields)).toBe(true)
    expect(s.ui.usage_view.columns.length).toBeGreaterThan(0)
    expect(s.pricing).toEqual({})
  })

  it('merges a stored usage_meter without wiping unset sub-fields', () => {
    const s = normalize({ ui: { usage_meter: { enabled: true, x: 12 } } } as any)
    expect(s.ui.usage_meter.enabled).toBe(true)
    expect(s.ui.usage_meter.x).toBe(12)
    expect(s.ui.usage_meter.collapsed).toBe(false) // default preserved
    expect(s.ui.usage_meter.fields).toEqual([
      'proxyPct',
      'cacheHitPct',
      'promptTokens',
      'avgCacheHitPct'
    ])
  })

  it('keeps stored pricing rows', () => {
    const s = normalize({
      pricing: { m1: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } }
    } as any)
    expect(s.pricing.m1.output).toBe(2)
  })

  // Project Yuzu WP-S1 follow-up: the VN-mode output ceiling (settings.yuzu.max_tokens).
  it('yuzu.max_tokens defaults to 30000 and round-trips a stored value', () => {
    expect(getDefaultSettings().yuzu?.max_tokens).toBe(30000)
    expect(normalize({}).yuzu?.max_tokens).toBe(30000) // legacy settings file: absent section
    expect(normalize({ yuzu: { max_tokens: 8000 } } as any).yuzu?.max_tokens).toBe(8000)
  })

  it('yuzu.max_tokens coerces an invalid stored value back to the default', () => {
    expect(normalize({ yuzu: { max_tokens: 0 } } as any).yuzu?.max_tokens).toBe(30000)
    expect(normalize({ yuzu: { max_tokens: NaN } } as any).yuzu?.max_tokens).toBe(30000)
    expect(normalize({ yuzu: { max_tokens: 'lots' } } as any).yuzu?.max_tokens).toBe(30000)
  })
})
