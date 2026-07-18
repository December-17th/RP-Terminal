import { IpcMain, BrowserWindow, dialog } from 'electron'
import * as scriptService from '../services/scriptService'
import * as characterService from '../services/characterService'
import { getActivePresetId } from '../services/presetService'
import { gate } from './ipcGuards'

export const registerScriptIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('list-scripts', (_, profileId) => scriptService.listScripts(profileId))
  ipcMain.handle('get-script', (_, profileId, file) => scriptService.getScript(profileId, file))
  ipcMain.handle('save-script', (_, profileId, script, scope, owner) =>
    scriptService.saveScript(profileId, script, scope, owner)
  )
  ipcMain.handle('update-script', (_, profileId, file, patch) =>
    scriptService.updateScript(profileId, file, patch)
  )
  ipcMain.handle('script-set-scope', (_, profileId, file, scope, owner) =>
    scriptService.setScriptScope(profileId, file, scope, owner)
  )
  ipcMain.handle('script-set-disabled', (_, profileId, file, disabled) =>
    scriptService.setScriptDisabled(profileId, file, disabled)
  )
  ipcMain.handle('delete-script', (_, profileId, file) =>
    scriptService.deleteScript(profileId, file)
  )
  // GATED: native file picker (import from an arbitrary host path).
  ipcMain.handle('import-script-dialog', gate('import-script-dialog', async (event, profileId, scope, owner) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Tavern Helper / RPT Scripts', extensions: ['json'] }]
    })
    if (result.canceled) return 0
    let count = 0
    for (const fp of result.filePaths) {
      count += scriptService.importScriptsFromFile(profileId, fp, scope || 'global', owner)
    }
    return count
  }))

  // The merged runtime script set for a chat: card-embedded (World) + active-scope store
  // scripts (raw — remote `import`s load natively in the sandbox under the remoteScripts
  // grant, 1B). Also reports the remote hosts those scripts import from (grant + CSP).
  // `isolatedRealm` = the caller is the WCV transport (the isolated card realm). Only then do high-trust
  // remote-code scripts (ADR 0017) resolve; the inline transport (app renderer) omits it, so they stay out.
  ipcMain.handle('get-runtime-scripts', (_, profileId, cardId, chatId, isolatedRealm) => {
    const presetId = getActivePresetId(profileId)
    const card = cardId ? characterService.getCharacter(profileId, cardId) : null
    const cardScripts = (card?.data.extensions?.rp_terminal?.scripts || [])
      .filter((s) => s && s.enabled !== false)
      .map((s) => ({ name: s.name || 'script', code: s.code || '' }))
    const scripts = [
      ...cardScripts,
      ...scriptService.getActiveScripts(profileId, {
        cardId,
        chatId,
        presetId,
        isolatedRealm: isolatedRealm === true
      })
    ]
    // The subset of `scripts` authorized by the ACTIVE preset's per-preset high-trust grant (ADR 0017).
    // These run under the PRESET's trust — not the card's — so the card-trust consent gate must never
    // block them (issue 19). High-trust scripts only resolve in the isolated realm (so this is empty
    // otherwise), which keeps this a strict subset of `scripts` above (the remainder is card-trust-gated).
    const presetHighTrustScripts =
      isolatedRealm === true && presetId
        ? scriptService
            .listScripts(profileId)
            .filter((s) => s.highTrust && s.scope === 'preset' && s.owner === presetId && !s.disabled)
            .map((s) => ({ name: s.name, code: s.code, ...(s.id ? { id: s.id } : {}) }))
        : []
    return { scripts, remoteHosts: scriptService.runtimeImportHosts(scripts), presetHighTrustScripts }
  })
}
