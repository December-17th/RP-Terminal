import { IpcMain, BrowserWindow, dialog } from 'electron'
import * as agentPackService from '../services/agentPackService'
import * as transfer from '../services/agentPackTransferService'
import * as recipeTransfer from '../services/recipeTransferService'
import * as moduleTransfer from '../services/moduleTransferService'
import type { WorkflowDoc } from '../../shared/workflow/types'
import type { TableTemplate } from '../types/tableTemplate'
import { OverrideScope } from '../services/agentPackStore'
import { listRuns } from '../services/runHistoryStore'
import { explainTriggers, explainDocTriggers, runManualDoc } from '../services/headlessRunService'
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
  // WP4.6: version-aware uninstall (omitted version = highest installed; last version cascades).
  ipcMain.handle('agent-pack-uninstall', (_, profileId: string, packId: string, version?: number) =>
    agentPackService.uninstall(profileId, packId, version)
  )
  // WP4.6: `version` pins which coexisting version this activation runs (written on open).
  ipcMain.handle(
    'agent-pack-set-gate',
    (
      _,
      packId: string,
      worldId: string,
      chatId: string | null,
      open: boolean,
      version?: number | null
    ) => agentPackService.setGate(packId, worldId, chatId, open, version ?? null)
  )
  // WP4.6: re-pin which installed version of a pack runs in a world (ADR 0008 — recipes pin versions).
  ipcMain.handle(
    'agent-pack-set-active-version',
    (_, profileId: string, packId: string, version: number, worldId: string) =>
      agentPackService.setActiveVersion(profileId, packId, version, worldId)
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
  // Live trigger badges for the one-canvas editor (one-canvas rebuild WP6.4a). Explains the ENABLED
  // trigger.* NODES of the chat's RESOLVED active doc read-only (met / current / required per node) —
  // the doc-path sibling of agent-pack-explain-triggers. READ-ONLY: never advances a baseline or fires,
  // so the editor can fetch it on open / after save without perturbing the trigger store.
  ipcMain.handle('workflow-explain-doc-triggers', (_, profileId: string, chatId: string) =>
    explainDocTriggers(profileId, chatId)
  )
  // Fire ONE trigger.manual node's chain on explicit user action (RF-01). All validity guards
  // (active doc, node kind, disabled) live in runManualDoc itself — they log + no-op, never throw.
  ipcMain.handle(
    'workflow-run-manual-trigger',
    (_, profileId: string, chatId: string, docId: string, triggerNodeId: string) =>
      runManualDoc(profileId, chatId, docId, triggerNodeId)
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
  // Is a pack's activation EXCLUSIVELY this world's? (agent-packs plan WP4.4; ADR 0006.) A read-only
  // check the Effective-mode edit router consults to decide write-through-vs-fork-again for a config
  // edit on a non-builtin fork, so config edits on your OWN fork persist across restarts (the old
  // session-map-only rule silently re-forked after a restart). No activation rows → not exclusive.
  ipcMain.handle(
    'agent-pack-activation-exclusive',
    (_, profileId: string, packId: string, worldId: string) =>
      agentPackService.isPackActivationExclusiveToWorld(profileId, packId, worldId)
  )
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
  ipcMain.handle('agent-pack-export-dialog', async (event, profileId: string, packId: string) => {
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
  })

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

  // ── Module SHARING: `.rptmodule` export / import (one-canvas rebuild WP6.5) ───────────────────────
  //
  // Export a GROUP of the doc being edited as a reusable module slab; import one into whatever doc is
  // open. The dialogs live HERE (the service stays dialog-free + testable), mirroring the `.rptagent`
  // channels above. Export is previewless (the module panel IS the review): the renderer passes the
  // (unsaved) doc + groupId + optional whole active template; the service builds + writes. Import is
  // TWO-PHASE (inspect → confirm): the renderer's compact sheet renders the report, then confirms to
  // install bundled templates main-side + receive the module payload for graph insertion (the doc is
  // unsaved in the editor store — main never writes it).

  // Preview a module's envelope WITHOUT writing (the sheet-less panel doesn't use this today, but the
  // channel is here for parity / a future review UI): returns { ok, meta } or a not-found error.
  ipcMain.handle(
    'module-preview-export',
    (
      _,
      _profileId: string,
      doc: WorkflowDoc,
      groupId: string,
      includeTemplate?: TableTemplate | null
    ) => {
      const built = moduleTransfer.buildModuleEnvelope(doc, groupId, {
        ...(includeTemplate ? { includeTemplate } : {})
      })
      if (!built) return { ok: false as const, error: { code: 'group-not-found' as const } }
      return {
        ok: true as const,
        meta: {
          name: built.module.name,
          nodeCount: built.module.nodes.length,
          bundledTemplate: built.bundledTemplates?.[0]?.name ?? null
        }
      }
    }
  )

  // Export behind a save dialog (default filename `<name>.rptmodule`). Canceled dialog → { canceled }.
  // group-not-found → { ok:false, error }. Success → { saved: path }.
  ipcMain.handle(
    'module-export-dialog',
    async (
      event,
      _profileId: string,
      doc: WorkflowDoc,
      groupId: string,
      includeTemplate?: TableTemplate | null
    ) => {
      const built = moduleTransfer.buildModuleEnvelope(doc, groupId, {
        ...(includeTemplate ? { includeTemplate } : {})
      })
      if (!built) return { ok: false as const, error: { code: 'group-not-found' as const } }
      const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, {
        defaultPath: moduleTransfer.moduleFileName(built.module.name),
        filters: [{ name: 'RPT Module', extensions: ['rptmodule'] }]
      })
      if (result.canceled || !result.filePath) return { canceled: true as const }
      moduleTransfer.writeModuleExport(built.module, result.filePath, built.bundledTemplates)
      return { saved: result.filePath }
    }
  )

  // Import phase one: open dialog (filter .rptmodule) → inspect → return the report the sheet renders.
  // Canceled dialog → null. The report carries a `token` (present iff the file parsed) for phase two.
  ipcMain.handle('module-import-dialog', async (event, profileId: string) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      properties: ['openFile'],
      filters: [{ name: 'RPT Module', extensions: ['rptmodule', 'json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return moduleTransfer.inspectModuleFile(profileId, result.filePaths[0])
  })

  // Import phase two: install bundled templates main-side + return the module payload to the renderer
  // (it inserts the graph into the edited doc). Re-checks blockers (defense-in-depth). `cancel-import`
  // drops a token the user dismissed without confirming.
  ipcMain.handle('module-confirm-import', (_, token: string) =>
    moduleTransfer.confirmModuleImport(token)
  )
  ipcMain.handle('module-cancel-import', (_, token: string) =>
    moduleTransfer.cancelModuleImport(token)
  )

  // ── Recipe SHARING: `.rptrecipe` export / import (agent-packs plan WP5.2; ADR 0008) ──────────────
  //
  // "Share this world's setup" — a set of embedded packs + an activation preset + the narrator choice.
  // Mirrors the `.rptagent` channels above: the service stays dialog-free + testable, the dialogs live
  // HERE. Export assembles from the CURRENT world; import is TWO-PHASE (inspect → confirm) with the
  // TARGET WORLD chosen at CONFIRM (the recipe file doesn't know it — passed as `targetWorldId`).

  // Dry-run export preview for WP5.3's wizard: what the file WOULD contain (recipe meta, pack list with
  // pinned versions + gate state, narrator kind, bundled template names, size estimate, warnings)
  // WITHOUT writing. { ok, preview } | { ok:false, error } (no-activated-packs). `opts` carries the
  // caller-supplied name/description/creator the wizard collects.
  ipcMain.handle(
    'recipe-preview-export',
    (_, profileId: string, worldId: string, opts: recipeTransfer.BuildRecipeOpts) =>
      recipeTransfer.previewRecipeExport(profileId, worldId, opts)
  )

  // Export behind a save dialog (default filename `<name>.rptrecipe`). Canceled dialog → { canceled }.
  // no-activated-packs → { ok:false, error }. Success → { saved: path }.
  ipcMain.handle(
    'recipe-export-dialog',
    async (event, profileId: string, worldId: string, opts: recipeTransfer.BuildRecipeOpts) => {
      // Assemble first so a no-activated-packs refusal happens BEFORE the dialog (no point prompting for
      // a file we can't write). previewRecipeExport is the cheap read of the same core.
      const preview = recipeTransfer.previewRecipeExport(profileId, worldId, opts)
      if (!preview.ok) return { ok: false as const, error: preview.error }
      const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, {
        defaultPath: recipeTransfer.recipeFileName(opts.name),
        filters: [{ name: 'RPT Recipe', extensions: ['rptrecipe'] }]
      })
      if (result.canceled || !result.filePath) return { canceled: true as const }
      const written = recipeTransfer.writeRecipeExport(profileId, worldId, opts, result.filePath)
      if (!written.ok) return { ok: false as const, error: written.error }
      return { saved: result.filePath }
    }
  )

  // Import phase one: open dialog (filter .rptrecipe) → inspect → return the inspection report the
  // wizard renders. Canceled dialog → null. The report carries per-pack sub-reports, a narrator report,
  // template plans, the recipe-level `blocked` verdict, and a `token` (present iff the file parsed) for
  // phase two.
  ipcMain.handle('recipe-import-dialog', async (event, profileId: string) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      properties: ['openFile'],
      filters: [{ name: 'RPT Recipe', extensions: ['rptrecipe', 'json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return recipeTransfer.inspectRecipeFile(profileId, result.filePaths[0])
  })

  // Import phase two: apply the inspected recipe into the TARGET world (chosen NOW — the file doesn't
  // know it). Installs templates + packs (alongside per WP4.6), applies the narrator to the world's
  // selection sidecar, and applies the activation preset (gates + pins + world-scope overrides).
  // Re-checks the recipe-level block (defense-in-depth). Returns ok / expired / blocked / partial.
  ipcMain.handle('recipe-confirm-import', (_, token: string, targetWorldId: string) =>
    recipeTransfer.confirmRecipeImport(token, targetWorldId)
  )
  ipcMain.handle('recipe-cancel-import', (_, token: string) =>
    recipeTransfer.cancelRecipeImport(token)
  )
}
