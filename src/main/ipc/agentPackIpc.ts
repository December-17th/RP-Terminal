import { IpcMain } from 'electron'
import * as agentPackService from '../services/agentPackService'
import { OverrideScope } from '../services/agentPackStore'
import { listRuns } from '../services/runHistoryStore'
import { previewNextPrompt } from '../services/generation/previewService'
import { getChat } from '../services/chatService'

/**
 * IPC for the agent-pack library (agent-packs plan WP1.4). Exposes the read side the future
 * Agents-workspace settings UI needs (listPacks, resolveOverrides) plus the write side for the gate
 * toggle and exposed-setting overrides. Install/uninstall are intentionally NOT exposed yet — packs
 * are seeded/imported by later WPs; this WP wires only the activation + override surface.
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
}
