import { describe, it, expect } from 'vitest'
import { groupPalette, PALETTE_ORDER } from '../../src/renderer/src/components/workflow/paletteModel'
import type { NodeTypeInfo } from '../../src/renderer/src/stores/workflowEditorStore'

const nt = (type: string, title = type): NodeTypeInfo => ({
  type,
  title,
  inputs: [],
  outputs: []
})

// The identity localizer: return the catalog title verbatim (cases 1/2/4/5 don't need localization).
const rawTitle = (n: NodeTypeInfo): string => n.title

describe('groupPalette', () => {
  it('groups by prefix with PALETTE_ORDER first, unknowns alphabetical', () => {
    // 'zeta.x' + 'alpha.y' are not in PALETTE_ORDER → they sort alphabetically AFTER all ordered ones.
    const types = [nt('table.read'), nt('zeta.x'), nt('trigger.state'), nt('alpha.y')]
    const groups = groupPalette(types, '', rawTitle)
    expect(groups.map((g) => g.prefix)).toEqual(['trigger', 'table', 'alpha', 'zeta'])
    // sanity: the ordered prefixes came from PALETTE_ORDER, and trigger precedes table there.
    expect(PALETTE_ORDER.indexOf('trigger')).toBeLessThan(PALETTE_ORDER.indexOf('table'))
  })

  it('filters by type-id substring, case-insensitively', () => {
    const types = [nt('table.read'), nt('vars.get'), nt('trigger.state')]
    const groups = groupPalette(types, 'VAR', rawTitle)
    expect(groups.map((g) => g.prefix)).toEqual(['vars'])
    expect(groups[0].items.map((i) => i.type)).toEqual(['vars.get'])
  })

  it('filters by the LOCALIZED title via titleOf', () => {
    const types = [nt('table.read', 'Read table'), nt('vars.get', 'Get variable')]
    // Query matches only the localized title of vars.get, not its type id.
    const groups = groupPalette(types, '变量', (n) =>
      n.type === 'vars.get' ? '获取变量' : n.title
    )
    expect(groups.map((g) => g.prefix)).toEqual(['vars'])
    expect(groups[0].items.map((i) => i.type)).toEqual(['vars.get'])
  })

  it('drops empty groups; an empty query returns everything', () => {
    const types = [nt('table.read'), nt('vars.get')]
    // Non-matching query → no groups at all (every group would be empty).
    expect(groupPalette(types, 'zzz-nomatch', rawTitle)).toEqual([])
    // Empty query → every type present (order follows PALETTE_ORDER: vars before table).
    const all = groupPalette(types, '', rawTitle)
    expect(all.flatMap((g) => g.items.map((i) => i.type)).sort()).toEqual([
      'table.read',
      'vars.get'
    ])
    // Whitespace-only query is treated as empty too.
    expect(groupPalette(types, '   ', rawTitle).flatMap((g) => g.items)).toHaveLength(2)
  })

  it('a type without a dot lands in the "other" group', () => {
    const types = [nt('table.read'), nt('bare')]
    const groups = groupPalette(types, '', rawTitle)
    const other = groups.find((g) => g.prefix === 'other')
    expect(other).toBeDefined()
    expect(other!.items.map((i) => i.type)).toEqual(['bare'])
  })
})
