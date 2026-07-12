import { useMemo, type ReactNode } from 'react'
import { MessageContent } from './MessageContent'
import { plotPanelSettingEnabled, plotPanelVisible } from './plotPanelVisible'
import { useRegexStore } from '../stores/regexStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useCharacterStore } from '../stores/characterStore'
import { useT } from '../i18n'

/**
 * The plot-recall PLOT PANEL: renders `FloorFile.plot_block` (recall's planner output, a display-only
 * directive block) as a collapsible `<details>` on the assistant floor, mirroring the reasoning panel.
 *
 * The block is USER-INPUT text (wrapped `<用户本轮输入>…`), so the beautifier that dresses it is a
 * placement-1 display regex — one the normal chat path (placement 2) never runs. We apply the store's
 * plot-block rules (placement 1 ⊕ 2) ONCE here, then hand the transformed string to `MessageContent`,
 * which SPLITS + routes fenced ```html / full-document card payloads (no second regex pass happens
 * there). A beautification card emits a ```html document with a `<script>`; under a TRUSTED active card
 * that routes to `InlineCardFrame` and the script runs. An untrusted card falls back to a script-free
 * frame (dashboard inert) — acceptable, never a crash.
 *
 * Gated by the `display.plotBlock` setting (default ON). Renders nothing when off or when empty.
 */
export function PlotPanel({ plotBlock, cardCss }: { plotBlock: string; cardCss?: string }): ReactNode {
  const t = useT()
  const enabled = useSettingsStore((s) => plotPanelSettingEnabled(s.settings?.display))
  const plotRules = useRegexStore((s) => s.plotRules)
  const personaName = useSettingsStore((s) => s.settings?.persona?.name) || 'User'
  const charName = useCharacterStore((s) => s.activeCharacter?.card.data.name) || 'Character'

  // Apply the plot-block display regex once. Recompute only when the block, the resolved rules, or the
  // macro names change — NOT on every parent re-render (the regex can paste a large HTML payload).
  const html = useMemo(
    () =>
      useRegexStore.getState().applyPlot(plotBlock, { user: personaName, char: charName }),
    [plotBlock, plotRules, personaName, charName]
  )

  if (!plotPanelVisible(plotBlock, enabled)) return null
  return (
    <details className="plot-block">
      <summary className="plot-summary">{t('chat.plotBlock')}</summary>
      <div className="plot-content">
        <MessageContent content={html} css={cardCss} />
      </div>
    </details>
  )
}
