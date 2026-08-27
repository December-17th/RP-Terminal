import type { WebContents } from 'electron'

type OpenExternal = (url: string) => Promise<unknown>

const parsedUrl = (value: string): URL | null => {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/** True only for the renderer document this BrowserWindow was created to host. */
export const isAllowedMainWindowUrl = (url: string, appUrl: string): boolean => {
  const candidate = parsedUrl(url)
  const app = parsedUrl(appUrl)
  if (!candidate || !app) return false

  // The development renderer legitimately navigates within its local Vite origin. A packaged
  // renderer is a file URL, where `origin` is always "null", so it must match the exact file.
  if (app.protocol === 'http:' || app.protocol === 'https:') return candidate.origin === app.origin
  if (app.protocol === 'file:') {
    return candidate.protocol === 'file:' && candidate.pathname === app.pathname
  }
  return candidate.href === app.href
}

const isAllowedExternalUrl = (url: string): boolean => {
  const parsed = parsedUrl(url)
  return parsed?.protocol === 'https:' || parsed?.protocol === 'mailto:'
}

const openAllowedExternal = (url: string, openExternal: OpenExternal): void => {
  if (!isAllowedExternalUrl(url)) return
  void openExternal(url).catch(() => undefined)
}

/** Default-deny navigation for the privileged BrowserWindow. */
export const installMainWindowNavigationPolicy = (
  webContents: Pick<WebContents, 'on' | 'setWindowOpenHandler'>,
  appUrl: string,
  openExternal: OpenExternal
): void => {
  webContents.on('will-navigate', (event) => {
    if (isAllowedMainWindowUrl(event.url, appUrl)) return
    event.preventDefault()
    openAllowedExternal(event.url, openExternal)
  })

  webContents.setWindowOpenHandler(({ url }) => {
    openAllowedExternal(url, openExternal)
    return { action: 'deny' }
  })
}
