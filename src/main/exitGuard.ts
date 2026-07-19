/**
 * Active-work exit warning (Classic Narrator plan, Milestone 4).
 *
 * The app previously had NO close handler: Cmd-Q, the dock's Quit, and the window close button all
 * went straight to `will-quit`, which is too late to stop (only `before-quit` and a window's `close`
 * can preventDefault). This guard is the first interception point, and it does exactly one thing —
 * it GATES reaching the existing shutdown path when background work would be discarded. It does not
 * cancel anything itself: `will-quit` -> shutdownInvocationRuntime() already aborts every invocation
 * with APP_SHUTDOWN and finalizes live run controllers, idempotently. No recovery, no resumption, no
 * negotiation, no lifecycle framework — those are explicitly out of scope for this milestone.
 *
 * The decision logic lives here, free of electron, so it is testable: `src/main/index.ts` only wires
 * the real `hasActiveBackgroundWork`, `dialog.showMessageBox`, and `app.quit` into it.
 */

/** The subset of an Electron Event this guard needs. */
export interface ExitGuardEvent {
  preventDefault(): void
}

export interface ExitGuardDeps {
  /** The one signal. Must be synchronous — the decision happens before any await. */
  hasActiveBackgroundWork(): boolean
  /** Ask the user whether the active work may be discarded. Resolves true to quit. */
  confirmDiscard(): Promise<boolean>
  /** Re-issue the quit once the user has confirmed (app.quit). */
  quit(): void
  /** Swallowed-failure sink; a dialog failure must never wedge the app closed. */
  onError?(err: unknown): void
}

export interface ExitGuard {
  /** Wire this to BOTH `app.on('before-quit')` and `mainWindow.on('close')`. */
  handleExitRequest(event: ExitGuardEvent): void
  /**
   * The same decision for an exit path that CAN await — `restart-app` calls `app.relaunch()` +
   * `app.exit(0)`, which by design emits neither `before-quit` nor `will-quit`, so it would sail
   * past `handleExitRequest` entirely. Resolves true when the caller may proceed to terminate.
   * Shares the `confirmed` latch and the `prompting` flag with `handleExitRequest`, so a restart
   * asked while a quit dialog is open does not stack a second dialog.
   */
  confirmExit(): Promise<boolean>
  /**
   * Disarm the `confirmed` latch. For a caller that got a yes but then FAILED to terminate: without
   * this the app stays alive with the latch armed and the next quit skips its confirmation entirely.
   * Only meaningful on an error path — a successful terminate never returns to call it.
   */
  releaseConfirmation(): void
  /** Test/inspection only: is a confirmation dialog currently open? */
  readonly isPrompting: boolean
}

export const createExitGuard = (deps: ExitGuardDeps): ExitGuard => {
  // Latched once the user says "discard": every later exit event (the re-issued app.quit, and the
  // window `close` that a quit cascades into) passes straight through, so one confirmation is asked
  // once and the app really exits.
  let confirmed = false
  // True while a dialog is open. A SECOND close action in that window must neither open a stacked
  // dialog nor start a second quit — it is prevented and dropped; the open dialog still decides.
  let prompting = false

  // The single ask. Sets `prompting` for its duration and latches `confirmed` on a yes, so every
  // entry point below shares one dialog and one decision.
  const ask = (): Promise<boolean> => {
    prompting = true
    return deps.confirmDiscard().then(
      (discard) => {
        prompting = false
        if (discard) confirmed = true
        return discard
      },
      (err) => {
        // Failing closed (staying open) is the safe direction: the user can always retry the exit.
        prompting = false
        deps.onError?.(err)
        return false
      }
    )
  }

  const guard: ExitGuard = {
    get isPrompting() {
      return prompting
    },
    handleExitRequest(event) {
      if (confirmed) return
      // The no-active-work path is fully unchanged behavior: one synchronous boolean, no dialog, no
      // preventDefault, no added latency on the way to `will-quit`.
      if (!deps.hasActiveBackgroundWork()) return

      // showMessageBox is async and preventDefault cannot await, so we always stop this exit and
      // re-issue the quit ourselves after the answer arrives.
      event.preventDefault()
      if (prompting) return

      void ask().then((discard) => {
        if (discard) deps.quit()
      })
    },
    async confirmExit() {
      if (confirmed) return true
      // Same idle short-circuit: with nothing running, restart proceeds exactly as it did before.
      if (!deps.hasActiveBackgroundWork()) return true
      // A dialog is already up for some other exit path — let that one decide rather than stacking.
      if (prompting) return false
      return ask()
    },
    releaseConfirmation() {
      confirmed = false
    }
  }
  return guard
}
