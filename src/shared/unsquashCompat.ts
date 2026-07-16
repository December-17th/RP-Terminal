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

  const floored = new WeakMap<Element, { value: string; priority: string }>()
  const pass = (): void => {
    const body = win.document?.body
    if (!body) return
    for (const el of Array.from(body.querySelectorAll('*'))) {
      const originalMinHeight = floored.get(el)
      const parent = el.parentElement
      const parentStyle = parent ? win.getComputedStyle(parent) : null
      const overflowY = win.getComputedStyle(el).overflowY
      const eligible =
        !!parentStyle &&
        parentStyle.display.includes('flex') &&
        parentStyle.flexDirection.startsWith('column') &&
        overflowY !== 'auto' &&
        overflowY !== 'scroll' &&
        el.scrollHeight > el.clientHeight + 2
      const style = (el as HTMLElement).style
      const currentMinHeight = {
        value: style.getPropertyValue('min-height'),
        priority: style.getPropertyPriority('min-height')
      }
      const hasCompatOverride =
        currentMinHeight.value === 'fit-content' && currentMinHeight.priority === 'important'
      if (eligible) {
        if (!originalMinHeight || !hasCompatOverride) floored.set(el, currentMinHeight)
        if (!hasCompatOverride) style.setProperty('min-height', 'fit-content', 'important')
        continue
      }
      if (!originalMinHeight) continue
      if (hasCompatOverride) {
        if (originalMinHeight.value)
          style.setProperty('min-height', originalMinHeight.value, originalMinHeight.priority)
        else style.removeProperty('min-height')
      }
      floored.delete(el)
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
