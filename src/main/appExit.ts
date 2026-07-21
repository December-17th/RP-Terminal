/**
 * The app's single exit gate and its shutdown cleanup (Classic Narrator plan, Milestone 4).
 *
 * Lives apart from `index.ts` because there are TWO terminating surfaces that must share one guard
 * instance — and therefore one `confirmed` latch and one `prompting` flag:
 *
 *   - `index.ts`      — `before-quit` (macOS Cmd-Q, dock Quit, any programmatic app.quit) and, off
 *     macOS, the window's `close` (which cascades into window-all-closed -> app.quit).
 *   - `storageIpc.ts` — the `restart-app` channel, which calls `app.relaunch()` + `app.exit(0)`.
 *     `app.exit` emits NEITHER `before-quit` NOR `will-quit` by design, so this path both skipped
 *     the warning and skipped the cleanup below. It now awaits the same confirmation and runs the
 *     same cleanup explicitly.
 *
 * `exitGuard.ts` stays free of electron (that is where the decision logic is tested); this module is
 * only the wiring: real signal, real dialog, real quit.
 */

import { app, BrowserWindow, dialog } from 'electron'

import {
  EXIT_WARNING_KEYS,
  translateExitWarning,
  type ExitWarningKey
} from '../shared/appExitI18n'
import { createExitGuard } from './exitGuard'
import * as logService from './services/logService'
import * as sessionDbService from './services/sessionDbService'
import { hasActiveBackgroundWork } from './services/activeWork'
import { shutdownInvocationRuntime } from './services/agentRuntime/InvocationRuntimeService'

// The window the exit-confirmation dialog is parented to. Set once the main window exists; the
// app-level `before-quit` handler has no window in scope of its own.
let guardedWindow: BrowserWindow | null = null
let exitDialogLocale = 'en'

export const setExitDialogWindow = (win: BrowserWindow | null): void => {
  guardedWindow = win
}

export const setExitDialogLocale = (locale: string): void => {
  exitDialogLocale = locale
}

export const appExitGuard = createExitGuard({
  hasActiveBackgroundWork,
  confirmDiscard: async () => {
    const t = (key: ExitWarningKey): string => translateExitWarning(exitDialogLocale, key)
    const options = {
      type: 'question' as const,
      buttons: [t(EXIT_WARNING_KEYS.quitAnyway), t(EXIT_WARNING_KEYS.keepWorking)],
      defaultId: 1,
      cancelId: 1,
      message: t(EXIT_WARNING_KEYS.message),
      detail: t(EXIT_WARNING_KEYS.detail)
    }
    const { response } = guardedWindow
      ? await dialog.showMessageBox(guardedWindow, options)
      : await dialog.showMessageBox(options)
    return response === 0
  },
  quit: () => app.quit(),
  onError: (err: any) =>
    logService.log('error', 'Exit confirmation failed', err?.message || String(err))
})

/**
 * Cancel in-flight Agent work and close every open per-chat session DB handle, so Windows file locks
 * don't linger and a clean shutdown checkpoints each WAL (plan §B4 / review C3). Run from `will-quit`
 * and, because `app.exit(0)` never fires it, explicitly from the restart path. Both halves are
 * individually try/caught and `shutdownInvocationRuntime()` is itself idempotent, so running this
 * twice (restart, then a `will-quit` that still manages to fire) is harmless.
 */
export const runShutdownCleanup = (): void => {
  try {
    shutdownInvocationRuntime()
  } catch (err: any) {
    logService.log(
      'error',
      'Failed to cancel Agent invocations on quit',
      err?.message || String(err)
    )
  }
  try {
    sessionDbService.closeAll()
  } catch (err: any) {
    logService.log(
      'error',
      'Failed to close session DB handles on quit',
      err?.message || String(err)
    )
  }
}
