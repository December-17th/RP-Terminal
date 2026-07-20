import { useEffect } from 'react'

/**
 * Duck all native card WCVs (regex 状态栏 panels etc.) while a full-viewport DOM overlay is
 * open. Native WebContentsViews always paint ABOVE the renderer DOM, so a Modal or a full-window
 * popup (e.g. the Agent Workspace) can't cover them — the host must hide them instead.
 *
 * REFCOUNTED: overlays nest (the Regex/Scripts editor Modal opens inside the Settings Modal),
 * so the views are hidden on the first acquisition and restored only when the LAST overlay
 * releases — an inner modal closing must not bring the card views back over the outer one.
 */
let depth = 0

export function useWcvSuppression(active: boolean = true): void {
  useEffect(() => {
    if (!active) return
    depth += 1
    if (depth === 1) window.api.wcvSetAllVisible(false)
    return () => {
      depth -= 1
      if (depth === 0) window.api.wcvSetAllVisible(true)
    }
  }, [active])
}
