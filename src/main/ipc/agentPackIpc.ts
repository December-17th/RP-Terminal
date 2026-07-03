import { IpcMain } from 'electron'
import * as agentPackService from '../services/agentPackService'
import { OverrideScope } from '../services/agentPackStore'
import { listRuns } from '../services/runHistoryStore'

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
  ipcMain.handle('agent-packs-list', (_, profileId: string) => agentPackService.list(profileId))
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
  // Persisted run history for the phase-3 Runs timeline (agent-packs plan WP2.3). Newest-first,
  // cursor-paged via `beforeSeq` (pass the smallest seq of the previous page for the next page).
  ipcMain.handle(
    'agent-pack-list-runs',
    (_, profileId: string, chatId: string, beforeSeq?: number, limit?: number) =>
      listRuns(profileId, chatId, { beforeSeq, limit })
  )
}
