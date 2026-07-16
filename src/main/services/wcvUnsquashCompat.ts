import type { WebContents, WebFrameMain } from 'electron'
import { UNSQUASH_COMPAT_SOURCE } from '../../shared/unsquashCompat'

type CompatFrame = Pick<WebFrameMain, 'isDestroyed' | 'executeJavaScript'>
type FrameResolver = (processId: number, routingId: number) => CompatFrame | undefined
const reportInjectionFailure = (error: unknown): void =>
  console.error('wcv: unsquash compatibility injection failed', error)

/** Install the card-layout pass after every main-frame or child-frame navigation. */
export function attachWcvUnsquashCompat(
  contents: WebContents,
  resolveFrame: FrameResolver,
  onError: (error: unknown) => void = reportInjectionFailure
): void {
  contents.on('did-frame-finish-load', (_event, _isMainFrame, processId, routingId) => {
    const frame = resolveFrame(processId, routingId)
    if (!frame || frame.isDestroyed()) return
    void frame.executeJavaScript(UNSQUASH_COMPAT_SOURCE).catch(onError)
  })
}
