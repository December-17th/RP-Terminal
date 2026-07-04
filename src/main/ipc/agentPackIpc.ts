import { IpcMain, BrowserWindow, dialog } from 'electron'
import * as agentPackService from '../services/agentPackService'
import * as transfer from '../services/agentPackTransferService'
import { OverrideScope } from '../services/agentPackStore'
import { listRuns } from '../services/runHistoryStore'
import { explainTriggers } from '../services/headlessRunService'
import { previewNextPrompt } from '../services/generation/previewService'
import { getChat } from '../services/chatService'

/**
 * IPC for the agent-pack library (agent-packs plan WP1.4). Exposes the read side the future
 * Agents-workspace settings UI needs (listPacks, resolveOverrides) plus the write side for the gate
 * toggle and exposed-setting overrides. INSTALL stays main-internal (packs are seeded and imported —
 * import runs through the two-phase confirm-import flow below, never a bare install); UNINSTALL is now
 * exposed (WP4.3b) so the renderer can (a) recover from a version-conflict import — uninstall the
 * installed pack, then re-confirm the SAME import token — and (b) remove a pack from its detail panel.
 *
 * Importing this module also triggers agentPackService's module-init side effect: it registers the
 * enabled-fragments provider on the WP1.3 composition seam (agentPackService.ts bottom). So the app
 * gains agent-pack composition simply by registering this IPC group once after app-ready.
 */
export const registerAgentPackIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle(
    'agent-packs-list',
    (_, profileId: string, worldId?: string | null, chatId?: string | null) =>
      agentPackService.list(profileId, worldId, chatId)
  )
  // Uninstall an installed pack (agent-packs plan WP4.3b). Returns the service's structured result:
  // { ok:true } on removal (library row + activation + override + trigger-state rows all pruned), or
  // { ok:false, code:'builtin' | 'not-found' } — builtins are uninstallable, so the version-conflict
  // recovery renders that refusal honestly. Install is NOT exposed (import is the two-phase confirm).
  ipcMain.handle('agent-pack-uninstall', (_, profileId: string, packId: string) =>
    agentPackService.uninstall(profileId, packId)
  )
  ipcMain.handle(
    'agent-pack-set-gate',
    (_, packId: string, worldId: string, chatId: string | null, open: boolean) =>
      agentPackService.setGate(packId, worldId, chatId, open)
  )
  ipcMain.handle(
    'agent-pack-set-override',
    (_, packId: string, scope: OverrideScope, settingId: string, value: unknown) =>
      agentPackService.setOverride(packId, scope, settingId, value)
  )
  ipcMain.handle(
    'agent-pack-clear-override',
    (_, packId: string, scope: OverrideScope, settingId: string) =>
      agentPackService.clearOverride(packId, scope, settingId)
  )
  ipcMain.handle(
    'agent-pack-resolve-overrides',
    (_, packId: string, worldId: string | null, chatId: string | null) =>
      agentPackService.resolveOverrides(packId, worldId, chatId)
  )
  // The detail panel's settings model (agent-packs plan WP3.2): creator-exposed + auto-derived System
  // trigger params, each with its resolved value + provenance (the chip). Assembled main-side so the
  // renderer never re-derives from the fragment blob. Null when the pack is not installed.
  ipcMain.handle(
    'agent-pack-settings',
    (_, profileId: string, packId: string, worldId: string | null, chatId: string | null) =>
      agentPackService.getPackSettings(profileId, packId, worldId, chatId)
  )
  // Persisted run history for the phase-3 Runs timeline (agent-packs plan WP2.3). Newest-first,
  // cursor-paged via `beforeSeq` (pass the smallest seq of the previous page for the next page).
  ipcMain.handle(
    'agent-pack-list-runs',
    (_, profileId: string, chatId: string, beforeSeq?: number, limit?: number) =>
      listRuns(profileId, chatId, { beforeSeq, limit })
  )
  // Read-only "why isn't this pack running?" trigger explanation for the Agents "Why?" popover
  // (agent-packs plan WP3.5). Evaluates the pack's MATERIALIZED trigger attachments against COMMITTED
  // state WITHOUT advancing any baseline or firing (calling it never mutates the trigger store). Returns
  // [] when the pack is not gate-open (the popover answers from gate state then). The controller
  // decision (WP3.3 friction) routes explain-why through live state, not a stored skip-reason.
  ipcMain.handle(
    'agent-pack-explain-triggers',
    (_, profileId: string, chatId: string, packId: string) =>
      explainTriggers(profileId, chatId, packId)
  )
  // Effective-graph projection for the Workflow view's Effective mode (agent-packs plan WP3.6a;
  // ADR 0010). Returns the composed doc + warnings + per-pack grouping (name / node ids / triggerOnly)
  // — a live projection, never a persisted artifact (ADR 0001). Re-fetched after a gate flip or a
  // narrator write-through to recompose.
  ipcMain.handle('agent-pack-effective-graph', (_, profileId: string, chatId: string) =>
    agentPackService.getEffectiveGraph(profileId, chatId)
  )
  // Copy-on-edit fork (ADR 0006; phase-4 machinery pulled forward for ADR 0010). WP3.6a exposes the
  // operation; WP3.6b routes pack-node edits through it. Repoints only the given world's activation.
  ipcMain.handle(
    'agent-pack-fork',
    (_, profileId: string, packId: string, worldId: string, editedFragment?: unknown) =>
      agentPackService.forkPack(profileId, packId, worldId, editedFragment as never)
  )
  // Fork write-through (ADR 0006; agent-packs plan WP3.6b): replace a NON-builtin pack's fragment doc
  // (builtin → refused; the fork is the writable target). Validates before writing; returns a
  // structured { ok, code, error } the renderer toasts on failure.
  ipcMain.handle(
    'agent-pack-update-fragment',
    (_, profileId: string, packId: string, fragment: unknown) =>
      agentPackService.updatePackFragment(profileId, packId, fragment as never)
  )
  // Read a pack's SOURCE fragment doc (agent-packs plan WP3.6b): the renderer needs it to apply an
  // edit to a COPY before forking / writing through. Scoped read — only the fragment being edited.
  ipcMain.handle('agent-pack-fragment', (_, profileId: string, packId: string) => {
    const pack = agentPackService.getPackFragment(profileId, packId)
    return pack
  })
  // Next-prompt injection preview for the Agents workspace Preview pane (agent-packs plan WP3.4). Runs
  // the effective doc's pre-assemble closure in a dry run (ZERO state writes, ZERO LLM calls) and shapes
  // the assembled prompt into per-source sections + an omitted list. Resolves the installed-pack
  // summaries here (world = the chat's card) so previewService stays independent of the pack store.
  ipcMain.handle(
    'agent-pack-preview-prompt',
    async (_, profileId: string, chatId: string, userAction?: string) => {
      const worldId = getChat(profileId, chatId)?.character_id ?? null
      const packSummaries = agentPackService.list(profileId, worldId, chatId)
      return previewNextPrompt({ profileId, chatId, userAction, packSummaries })
    }
  )

  // ── Agent-pack SHARING: `.rptagent` export / import (agent-packs plan WP4.2) ─────────────────────
  //
  // Export refuses builtins (`builtin-not-exportable`); a fork of a builtin IS exportable. The dialog
  // lives HERE (the service stays dialog-free + testable), mirroring the table-template + workflow
  // export-dialog precedents (tableMemoryIpc `table-template-export-dialog`, workflowIpc
  // `export-workflow-dialog`). Import is TWO-PHASE for WP4.3's inspection screen: `import` opens the
  // dialog + inspects (returns the report, incl. a `token`); the renderer decides to `confirm-import`
  // or `cancel-import`. `app.getVersion()` (via the service's appVersion accessor) grounds the
  // minRptVersion gate — read main-side, passed into the pure core.

  // Dry-run export preview for the wizard (WP4.3): what the file WOULD contain — envelope meta,
  // attachments summary, LOCALLY-derived capability report, bundled template names, warnings — WITHOUT
  // writing. Returns { ok, preview } | { ok:false, error } (builtin / not-installed).
  ipcMain.handle('agent-pack-preview-export', (_, profileId: string, packId: string) =>
    transfer.previewAgentPackExport(profileId, packId)
  )

  // Export behind a save dialog (default filename `<id>-v<version>.rptagent`). Canceled dialog →
  // { canceled: true }. Builtin / not-installed → { ok:false, error }. Success → { saved: path }.
  ipcMain.handle(
    'agent-pack-export-dialog',
    async (event, profileId: string, packId: string) => {
      // Resolve the pack meta first so a builtin/not-installed refusal happens BEFORE the dialog (no
      // point prompting for a file we can't write). previewAgentPackExport is the cheap read.
      const preview = transfer.previewAgentPackExport(profileId, packId)
      if (!preview.ok) return { ok: false as const, error: preview.error }
      const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, {
        defaultPath: transfer.exportFileName(packId, preview.preview.envelopeMeta.version),
        filters: [{ name: 'RPT Agent Pack', extensions: ['rptagent'] }]
      })
      if (result.canceled || !result.filePath) return { canceled: true as const }
      const written = transfer.writeAgentPackExport(profileId, packId, result.filePath)
      if (!written.ok) return { ok: false as const, error: written.error }
      return { saved: result.filePath }
    }
  )

  // Import phase one: open dialog (filter .rptagent) → inspect → return the inspection report the
  // renderer's screen renders. Canceled dialog → null. The report carries a `token` (present iff the
  // file parsed) for phase two. app.getVersion() grounds the minRptVersion gate.
  ipcMain.handle('agent-pack-import-dialog', async (event, profileId: string) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      properties: ['openFile'],
      filters: [{ name: 'RPT Agent Pack', extensions: ['rptagent', 'json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return transfer.inspectAgentPackFile(profileId, result.filePaths[0], transfer.appVersion())
  })

  // Import phase two: install the inspected pack (+ bundled templates) for a token. Gate stays CLOSED
  // (ADR 0005 — activation is separate). Re-checks blockers (defense-in-depth). Returns the confirm
  // result the renderer toasts. `cancel-import` drops a token the user dismissed without confirming.
  ipcMain.handle('agent-pack-confirm-import', (_, token: string) =>
    transfer.confirmAgentPackImport(token, transfer.appVersion())
  )
  ipcMain.handle('agent-pack-cancel-import', (_, token: string) =>
    transfer.cancelAgentPackImport(token)
  )
}
