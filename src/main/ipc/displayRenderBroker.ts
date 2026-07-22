// src/main/ipc/displayRenderBroker.ts
//
// Main-side half of the DisplayHost render broker (ADR 0023, docs/display-host-design.md §3.5).
//
// `renderFloors` cannot be answered in MAIN — the display transform (regex/settings/character stores +
// the quickjs EJS engine) is renderer-only. So a WCV card's `renderFloors` invoke is FORWARDED to the
// main window's renderer with a correlation id; the renderer's `displayBroker` renders the floors and
// replies. This module owns that correlation: it clamps the batch, sends the request, and resolves the
// card's promise when the matching response lands — or with `[]` on timeout, so a stuck / reloading
// renderer never hangs the card. It is deliberately electron-free (a `send` fn + injectable timers) so
// the correlation / clamp / timeout logic unit-tests without a BrowserWindow.
import type { RenderedFloorView } from '../../shared/thRuntime/displayView'

/** A card's request context, resolved main-side from its WCV sender, plus the requested floor window. */
export interface RenderBrokerRequest {
  profileId: string
  chatId: string
  from: number
  to: number
  /** The panel's chat scope, if any — forwarded so the renderer indexes floors exactly as the panel's
   *  `floors()` view does (chatScope-consistent). `undefined` ⇒ the real chat. */
  scope?: unknown
}

export interface RenderBrokerDeps {
  /** Send a payload to the main window renderer (`mainWindow.webContents.send`). */
  send: (channel: string, payload: unknown) => void
  /** Per-request timeout before resolving `[]` (default 10s). */
  timeoutMs?: number
  /** Max floors per call — `to` is clamped to `from + maxBatch - 1` (default 32; §3.6). */
  maxBatch?: number
  /** Injectable timer (tests). Defaults to setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

const REQUEST_CHANNEL = 'display-render-request'

/** Correlates `renderFloors` invokes with the renderer's `display-render-response` replies. */
export class DisplayRenderBroker {
  private seq = 0
  private readonly pending = new Map<
    number,
    { resolve: (v: RenderedFloorView[]) => void; timer: unknown }
  >()
  private readonly send: RenderBrokerDeps['send']
  private readonly timeoutMs: number
  private readonly maxBatch: number
  private readonly setTimer: NonNullable<RenderBrokerDeps['setTimer']>
  private readonly clearTimer: NonNullable<RenderBrokerDeps['clearTimer']>

  constructor(deps: RenderBrokerDeps) {
    this.send = deps.send
    this.timeoutMs = deps.timeoutMs ?? 10_000
    this.maxBatch = deps.maxBatch ?? 32
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  }

  /** Forward a render request to the renderer; resolve when it replies, or `[]` on timeout / bad range. */
  request(req: RenderBrokerRequest): Promise<RenderedFloorView[]> {
    const from = Math.max(0, Math.floor(Number(req.from)))
    const rawTo = Math.floor(Number(req.to))
    if (!Number.isFinite(from) || !Number.isFinite(rawTo) || rawTo < from) return Promise.resolve([])
    // Batch cap: never render more than `maxBatch` floors per call — the card pages larger windows.
    const to = Math.min(rawTo, from + this.maxBatch - 1)
    const reqId = ++this.seq
    return new Promise<RenderedFloorView[]>((resolve) => {
      const timer = this.setTimer(() => {
        if (this.pending.delete(reqId)) resolve([])
      }, this.timeoutMs)
      this.pending.set(reqId, { resolve, timer })
      this.send(REQUEST_CHANNEL, {
        reqId,
        profileId: req.profileId,
        chatId: req.chatId,
        from,
        to,
        scope: req.scope
      })
    })
  }

  /** The renderer replied — resolve the matching pending request (ignored if it already timed out). */
  resolve(reqId: unknown, views: unknown): void {
    const id = Number(reqId)
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    this.clearTimer(p.timer)
    p.resolve(Array.isArray(views) ? (views as RenderedFloorView[]) : [])
  }
}
