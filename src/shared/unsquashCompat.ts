/**
 * Install the fixed-height flex-column compatibility pass in one browser frame.
 *
 * Some SillyTavern cards are authored inside an auto-height iframe. In RPT's fixed-height
 * WebContentsView, flex children with `min-height:0` can shrink below their content and clip or overlap.
 * A content-height floor keeps those children readable while leaving actual scroll containers alone.
 *
 * Keep this function self-contained: main serializes it and evaluates it in every WebContentsView frame.
 */
export function installUnsquashCompat(win: Window): void {
  const stateKey = '__rptUnsquashCompatInstalled'
  const state = win as unknown as Record<string, unknown>
  if (state[stateKey]) return
  state[stateKey] = true

  const floored = new WeakSet<Element>()
  const pass = (): void => {
    const body = win.document?.body
    if (!body) return
    for (const el of Array.from(body.querySelectorAll('*'))) {
      if (floored.has(el)) continue
      const parent = el.parentElement
      if (!parent) continue
      const parentStyle = win.getComputedStyle(parent)
      if (!parentStyle.display.includes('flex')) continue
      if (!parentStyle.flexDirection.startsWith('column')) continue
      const overflowY = win.getComputedStyle(el).overflowY
      if (overflowY === 'auto' || overflowY === 'scroll') continue
      if (el.scrollHeight <= el.clientHeight + 2) continue
      ;(el as HTMLElement).style.setProperty('min-height', 'fit-content', 'important')
      floored.add(el)
    }
  }

  let timer: number | null = null
  const schedule = (): void => {
    if (timer !== null) return
    timer = win.setTimeout(() => {
      timer = null
      try {
        pass()
      } catch {
        // A frame may navigate while a queued pass is reading its document.
      }
    }, 50)
  }
  const start = (): void => {
    schedule()
    try {
      const MutationObserverCtor = (win as any).MutationObserver as typeof MutationObserver
      const ResizeObserverCtor = (win as any).ResizeObserver as typeof ResizeObserver
      new MutationObserverCtor(schedule).observe(win.document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      })
      new ResizeObserverCtor(schedule).observe(win.document.documentElement)
      win.document.fonts?.ready.then(schedule, () => {})
    } catch {
      // The initial pass still runs when an observer API is unavailable.
    }
  }

  if (win.document?.readyState === 'loading')
    win.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
}

/** JavaScript evaluated by Electron's WebFrameMain API in both main and child frames. */
export const UNSQUASH_COMPAT_SOURCE = `;(${installUnsquashCompat.toString()})(window)`
