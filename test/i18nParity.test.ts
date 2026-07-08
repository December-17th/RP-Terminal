import { describe, it, expect } from 'vitest'
import en from '../src/renderer/src/i18n/locales/en'
import zh from '../src/renderer/src/i18n/locales/zh'
import { VIEW_LABEL_KEY, BUILTIN_VIEW_IDS } from '../src/renderer/src/components/workspace/viewLabels'

/** The `{{var}}` interpolation names referenced by a locale string, as a sorted, de-duped set. */
function vars(value: string): string[] {
  const names = new Set<string>()
  for (const m of value.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) names.add(m[1])
  return [...names].sort()
}

describe('locale parity (en ↔ zh)', () => {
  it('has identical key sets in both directions', () => {
    const enKeys = new Set(Object.keys(en))
    const zhKeys = new Set(Object.keys(zh))
    const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k)).sort()
    const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k)).sort()
    expect(missingInZh, `keys in en.ts missing from zh.ts: ${missingInZh.join(', ')}`).toEqual([])
    expect(missingInEn, `keys in zh.ts missing from en.ts: ${missingInEn.join(', ')}`).toEqual([])
  })

  it('has no empty-string values in either locale', () => {
    const emptyEn = Object.keys(en).filter((k) => en[k].trim() === '').sort()
    const emptyZh = Object.keys(zh).filter((k) => zh[k].trim() === '').sort()
    expect(emptyEn, `empty values in en.ts: ${emptyEn.join(', ')}`).toEqual([])
    expect(emptyZh, `empty values in zh.ts: ${emptyZh.join(', ')}`).toEqual([])
  })

  it('has matching {{var}} interpolation sets per key', () => {
    const mismatches: string[] = []
    for (const key of Object.keys(en)) {
      if (!(key in zh)) continue // key-set gap is covered by the first test
      const enVars = vars(en[key])
      const zhVars = vars(zh[key])
      if (enVars.join(',') !== zhVars.join(',')) {
        mismatches.push(`${key}: en={${enVars.join(',')}} zh={${zhVars.join(',')}}`)
      }
    }
    expect(mismatches, `interpolation-var mismatches:\n${mismatches.join('\n')}`).toEqual([])
  })
})

describe('VIEW_LABEL_KEY coverage', () => {
  it('maps every built-in view id, and every mapped key exists in both locales', () => {
    const unmapped = BUILTIN_VIEW_IDS.filter((id) => !VIEW_LABEL_KEY[id]).sort()
    expect(unmapped, `built-in view ids with no VIEW_LABEL_KEY entry: ${unmapped.join(', ')}`).toEqual([])

    const missing = Object.values(VIEW_LABEL_KEY)
      .filter((key) => !(key in en) || !(key in zh))
      .sort()
    expect(missing, `VIEW_LABEL_KEY i18n keys absent from a locale: ${missing.join(', ')}`).toEqual([])
  })
})
