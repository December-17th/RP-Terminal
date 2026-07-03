import { describe, it, expect } from 'vitest'
import {
  RAIL_ITEMS,
  railLabelKey,
  resolveInitialRail
} from '../src/renderer/src/components/workspace/controlCenterRail'

// Pins the pure control-center rail model (agent-packs plan WP3.7 — the full-window Agents &
// Workflows overlay). Node-env like the other renderer pure-helper tests (no jsdom harness).

describe('RAIL_ITEMS', () => {
  it('lists the six panes in reading order, with Memory between Workflows and Runs', () => {
    expect(RAIL_ITEMS).toEqual([
      'overview',
      'installed',
      'workflows',
      'memory',
      'runs',
      'preview'
    ])
  })
})

describe('railLabelKey', () => {
  it('derives the i18n key from the rail id', () => {
    expect(railLabelKey('overview')).toBe('controlCenter.rail.overview')
    expect(railLabelKey('workflows')).toBe('controlCenter.rail.workflows')
    expect(railLabelKey('preview')).toBe('controlCenter.rail.preview')
  })
})

describe('resolveInitialRail', () => {
  it('passes through a known rail id', () => {
    expect(resolveInitialRail('workflows')).toBe('workflows')
    expect(resolveInitialRail('memory')).toBe('memory')
    expect(resolveInitialRail('runs')).toBe('runs')
  })

  it('falls back to overview for null / undefined (the default open)', () => {
    expect(resolveInitialRail(null)).toBe('overview')
    expect(resolveInitialRail(undefined)).toBe('overview')
  })

  it('falls back to overview for an unknown rail id (a stale hand-off can never land on a blank pane)', () => {
    // @ts-expect-error — deliberately passing an off-contract value
    expect(resolveInitialRail('bogus')).toBe('overview')
    // @ts-expect-error
    expect(resolveInitialRail('garbage')).toBe('overview')
  })
})
