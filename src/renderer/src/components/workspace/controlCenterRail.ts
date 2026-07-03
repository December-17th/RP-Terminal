// The control-center rail model (agent-packs plan WP3.7 — the full-window Agents & Workflows
// overlay). Pure so it can be unit-tested under Node (no jsdom harness in this repo) and so the
// rail order / labels live in ONE place both the overlay and any deep-link caller agree on.
//
// The i18n label key is derived (`controlCenter.rail.<id>`), so a new entry only needs its two
// locale strings — no other wiring. Reading order: "packs → their workflows → the memory they build
// → what ran → what's next", so 'memory' sits between 'workflows' and 'runs'.

import type { ControlCenterRail } from '../../stores/uiStore'

/** The rail panes, in display order. Extend here to grow the rail. */
export const RAIL_ITEMS: readonly ControlCenterRail[] = [
  'overview',
  'installed',
  'workflows',
  'memory',
  'runs',
  'preview'
] as const

/** The i18n key for a rail item's label. Derived so a new pane needs only its locale strings. */
export const railLabelKey = (item: ControlCenterRail): string => `controlCenter.rail.${item}`

/**
 * Resolve the rail the overlay should open on from a (possibly stale / null) deep-link request.
 * A caller may request a pane; if it isn't a known rail id we fall back to Overview so a bad
 * hand-off can never leave the overlay on a blank pane.
 */
export function resolveInitialRail(requested: ControlCenterRail | null | undefined): ControlCenterRail {
  return requested && RAIL_ITEMS.includes(requested) ? requested : 'overview'
}
