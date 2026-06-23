import { IpcMain, BrowserWindow, dialog } from 'electron'
import fs from 'fs'
import * as characterService from '../services/characterService'

export const registerCharacterIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('get-characters', (_, profileId) => characterService.getCharacters(profileId))
  ipcMain.handle('save-character', (_, profileId, charId, card) =>
    characterService.saveCharacter(profileId, charId, card)
  )
  ipcMain.handle('delete-character', (_, profileId, charId) =>
    characterService.deleteCharacter(profileId, charId)
  )

  ipcMain.handle('import-character-dialog', async (event, profileId) => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'World Cards', extensions: ['png', 'json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]

    // One-click install: if the card bundles artifacts (regex/scripts/UI), show a
    // transparent confirm listing exactly what installs before committing anything.
    const summary = characterService.inspectCardFile(filePath)
    if (summary && characterService.hasBundle(summary)) {
      const items = [
        summary.loreEntries && `${summary.loreEntries} lore entries`,
        summary.lorebooks && `${summary.lorebooks} extra lorebooks`,
        summary.regexScripts && `${summary.regexScripts} regex scripts`,
        summary.presets && `${summary.presets} presets`,
        summary.scripts && `${summary.scripts} card scripts`,
        summary.uiWidgets && `${summary.uiWidgets} UI widgets`,
        summary.pluginsSkipped && `${summary.pluginsSkipped} plugins (skipped — not yet supported)`
      ].filter(Boolean)
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Install', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: `Import "${summary.name}"`,
        detail:
          (summary.isWorldCard ? 'This World Card bundles:\n' : 'This card bundles:\n') +
          items.map((i) => `  • ${i}`).join('\n')
      })
      if (response !== 0) return null
    }
    return characterService.importCharacterFromFile(profileId, filePath)
  })

  ipcMain.handle('export-character-dialog', async (event, profileId, characterId) => {
    const exported = characterService.exportWorldCard(profileId, characterId)
    if (!exported) return null
    const safeName = exported.name.replace(/[^a-z0-9_-]+/gi, '_') || 'world-card'
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, {
      defaultPath: `${safeName}.json`,
      filters: [{ name: 'World Card', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return null
    fs.writeFileSync(result.filePath, JSON.stringify(exported.json, null, 2), 'utf-8')
    return exported.name
  })
}
