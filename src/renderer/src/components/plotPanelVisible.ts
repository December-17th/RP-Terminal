/**
 * Pure gate for the plot-recall plot panel — kept dependency-free (no React/DOM) so the
 * show/hide matrix is unit-testable under the node test harness.
 */

/** Read the `display.plotBlock` setting: ON by default (a profile predating the flag has no
 *  `display` block, so unset ⇒ shown). Only an explicit `false` hides the panel. */
export const plotPanelSettingEnabled = (display?: { plotBlock?: boolean }): boolean =>
  display?.plotBlock !== false

/** The panel renders only when the setting is ON *and* the floor actually carries a non-empty
 *  plot_block. Whitespace-only blocks count as absent. */
export const plotPanelVisible = (
  plotBlock: string | undefined,
  settingEnabled: boolean
): boolean => settingEnabled && !!plotBlock && plotBlock.trim() !== ''
