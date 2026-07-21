import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron'
import { log } from '../services/logService'

/**
 * Main-side sender gating for the "real-harm" IPC channels (card-trust-boundary issue 02).
 *
 * The full preload surface is exposed as `window.api`, so a same-origin card iframe (or any WCV
 * page that reaches these channels) could invoke handlers that destroy the storage layer, steal
 * credentials, or reach the host. Trust (a user consenting to run a card's scripts) covers profile
 * *content* — NOT the data directory, API keys, or the host. Main is the enforcement point: the
 * gated handlers below run ONLY for the app's own top frame.
 *
 * `GATED_CHANNELS` is the single greppable source of truth; `gate(channel, handler)` is applied
 * per-handler (not a global hook) so the gated surface stays explicit. The per-channel rationale
 * lives in `.scratch/card-trust-boundary/issues/02-destructive-ipc-sender-gating.md` (## Comments).
 *
 * NOT gated (accepted in-profile scope per PRD + owner decision log #1/#4): chat/lorebook/entry
 * read-write-DELETE, variables, generation, chatCardVars*, asset *reads*, geometry/overlay.
 */
export const GATED_CHANNELS = [
  // data-location pointer + app lifecycle (storageIpc) — storage-location + host reach
  'set-data-location-dialog',
  'open-data-location',
  'reset-data-location',
  'restart-app',
  // Packaged-build update notifier: network check + opening the main-validated GitHub release URL
  'check-for-update',
  'open-update-release',
  // profile-level destruction + credential-bearing settings write (profileIpc)
  'wipe-profile',
  'save-settings',
  // whole-entity deletion (conservative default) + native card import/export dialogs (characterIpc)
  'delete-character',
  'import-character-dialog',
  'confirm-character-import',
  'cancel-character-import',
  'export-character-dialog',
  // save (session) export/import native dialogs (saveTransferIpc) — host-path read/write
  'export-save-dialog',
  'import-save-dialog',
  // Asset-manager native dialogs + host folder reveal (worldAssetIpc)
  'asset-pick-images',
  'asset-import-zip-dialog',
  'asset-export-zip',
  'asset-open-folder',
  // table-template import/export native dialogs (tableMemoryIpc) — host-path read/write
  'table-template-import-dialog',
  'table-template-export-dialog',
  // import/export native dialogs (presetIpc / regexIpc / lorebookIpc / scriptIpc)
  'import-preset-dialog',
  'import-regex-dialog',
  'import-lorebook-dialog',
  'export-lorebook-dialog',
  'import-script-dialog',
  // preset high-trust opt-in (a card must not unlock its own remote-code preset scripts) (presetIpc)
  'preset-set-high-trust',
  // plugin/grant mutation (a card must not grant itself trust) + plugin install dialogs (pluginIpc)
  'plugin-set-grants',
  'plugins-set-grants',
  'plugins-set-enabled',
  'plugins-install-dialog',
  'plugins-install-zip-dialog',
  // Full Agent Run records contain prompts/evidence; cancellation controls active model work.
  'agent-runs-list',
  'agent-run-get',
  'agent-run-cancel',
  // Agent library management (agentCatalogIpc). Installing, disabling, deleting, and role-binding
  // Agents decide what model work the app runs — a trusted card must still never reach these.
  'agent-catalog-list',
  'agent-catalog-get',
  'agent-catalog-sync-folder',
  'agent-catalog-set-enabled',
  'agent-catalog-delete',
  'agent-catalog-bind-role',
  'agent-catalog-role-bindings',
  'agent-catalog-create',
  'agent-catalog-edit',
  'agent-catalog-restore',
  'agent-catalog-export',
  'agent-catalog-inspect-upgrade',
  'agent-catalog-upgrade',
  // Profile-local per-Agent invocation config (M5b) — the API preset the triggered dispatch runs an
  // Agent against decides what model work fires; a trusted card must still never reach these.
  'agent-catalog-get-invocation-config',
  'agent-catalog-set-invocation-config',
  // Manual Invocation from the Agent Workspace: starts real model work on the latest committed floor.
  'agent-catalog-run',
  // Dry-run Prompt Preview (Microscope-lite): reads floor/vars + preset to build the prompt an Agent
  // WOULD send. No model work, but it exposes prompt/preset detail a trusted card must not reach.
  'agent-catalog-preview-prompt',
  // Agent Lab (case fixtures). Replaying/live-running a case decides what model work runs (a live run
  // bills a provider call) and cases expose captured prompts/evidence — a trusted card must not reach.
  'agent-lab-list',
  'agent-lab-get',
  'agent-lab-capture-from-run',
  'agent-lab-create-from-input',
  'agent-lab-rename',
  'agent-lab-remove',
  'agent-lab-replay',
  'agent-lab-run-live',
  'agent-lab-get-run',
  // Inline card Agent transport. Main validates its explicit card scope against the authoritative chat.
  'card-agent-run',
  'card-agent-run-plan',
  'card-agent-cancel',
  'card-agent-tool-register',
  'card-agent-tool-unregister'
] as const

export type GatedChannel = (typeof GATED_CHANNELS)[number]

/**
 * Typed rejection handed back (as a rejected invoke) to a non-top-frame caller. It is returned via
 * `Promise.reject`, never thrown uncaught — the renderer's `invoke` rejects and the caller fails
 * soft; main does not crash.
 */
export class IpcSenderRejectedError extends Error {
  readonly code = 'IPC_SENDER_REJECTED' as const
  constructor(readonly channel: string) {
    super(`ipc '${channel}': rejected — sender is not the app's top frame`)
    this.name = 'IpcSenderRejectedError'
  }
}

let mainWebContents: WebContents | null = null

/**
 * Wire the app's main BrowserWindow so the guard can compare senders against it. Mirrors
 * `wcvManager.init(win)` — called once from `createWindow`. Cleared when that window closes so a
 * stale, destroyed webContents can never be mistaken for the top frame.
 */
export const setGuardMainWindow = (win: BrowserWindow): void => {
  mainWebContents = win.webContents
  win.on('closed', () => {
    if (mainWebContents === win.webContents) mainWebContents = null
  })
}

/** Test/introspection seam: the WebContents the guard currently treats as the app top frame. */
export const guardMainWebContents = (): WebContents | null => mainWebContents

/**
 * Pure predicate — is this invoke from the app's OWN top frame? True only when the sender IS the
 * main window's webContents AND the calling frame is that webContents' `mainFrame`. A card iframe
 * (a sub-frame of the same webContents) fails the frame check; a WCV (a different webContents)
 * fails the sender check; a destroyed frame (`senderFrame === null`, an Electron caveat) fails.
 * Exported so the guard can be table-driven in tests with fake events.
 */
export const isAppTopFrame = (
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  mainWc: WebContents | null
): boolean => {
  if (!mainWc) return false
  const sender = event?.sender
  if (!sender || sender !== mainWc) return false
  const frame = event?.senderFrame
  if (!frame) return false // destroyed frame → reject
  return frame === sender.mainFrame
}

type Handler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown

/**
 * Wrap an `ipcMain.handle` handler so it runs only for the app top frame. Any other sender (card
 * iframe, WCV page, destroyed frame) gets a logged, typed rejection: the invoke rejects (renderer
 * fails soft) and main never throws uncaught. `channel` is typed to `GatedChannel`, so every gated
 * handler is compile-time proven to appear in `GATED_CHANNELS`.
 */
export const gate = <T extends Handler>(channel: GatedChannel, handler: T): T =>
  ((event: IpcMainInvokeEvent, ...args: any[]) => {
    if (!isAppTopFrame(event, mainWebContents)) {
      log(
        'error',
        `ipc-guard: rejected '${channel}'`,
        'sender is not the app top frame (card iframe / WCV / destroyed frame)'
      )
      return Promise.reject(new IpcSenderRejectedError(channel))
    }
    return handler(event, ...args)
  }) as T
