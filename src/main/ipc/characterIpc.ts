import { IpcMain, BrowserWindow, dialog } from 'electron'
import fs from 'fs'
import * as characterService from '../services/characterService'
import * as settingsService from '../services/settingsService'
import { CharacterImportText, getCharacterImportText } from './characterImportText'
import { gate } from './ipcGuards'

/** Optionally prompt for a World Card's asset zip (character/ + location/ images). Only offered for World
 *  Cards — plain cards can use the Asset Manager later. Returns the chosen path, or undefined if skipped.
 *  Shared by the fresh-import and update-in-place paths (Feature 1). */
const maybePickAssets = async (
  win: BrowserWindow,
  isWorldCard: boolean,
  text: CharacterImportText
): Promise<string | undefined> => {
  if (!isWorldCard) return undefined
  const addAssets = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: [text.chooseZip, text.skip],
    defaultId: 1,
    cancelId: 1,
    message: text.importAssets,
    detail: text.importAssetsDetail
  })
  if (addAssets.response !== 0) return undefined
  const pick = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: text.assetZip, extensions: ['zip'] }]
  })
  return !pick.canceled && pick.filePaths[0] ? pick.filePaths[0] : undefined
}

export const registerCharacterIpc = (ipcMain: IpcMain): void => {
  ipcMain.handle('get-characters', (_, profileId) => characterService.getCharacters(profileId))
  ipcMain.handle('get-character-avatar', (_, characterId) =>
    characterService.getAvatarDataUrl(characterId)
  )
  ipcMain.handle('save-character', (_, profileId, charId, card) =>
    characterService.saveCharacter(profileId, charId, card)
  )
  // GATED: whole-character deletion (conservative default — owner ruled on chats/lorebooks, not worlds).
  ipcMain.handle(
    'delete-character',
    gate('delete-character', (_, profileId, charId) =>
      characterService.deleteCharacter(profileId, charId)
    )
  )

  // GATED: native file-picker dialog (import from an arbitrary host path).
  ipcMain.handle(
    'import-character-dialog',
    gate('import-character-dialog', async (event, profileId) => {
      const win = BrowserWindow.fromWebContents(event.sender)!
      const text = getCharacterImportText(settingsService.getSettings(profileId).ui.locale)
      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: text.worldCards, extensions: ['png', 'json'] }]
      })
      if (result.canceled || result.filePaths.length === 0) return null
      const filePath = result.filePaths[0]

      const parsed = characterService.parseCardFile(filePath)
      if (!parsed) return null
      const summary = characterService.summarizeCardBundle(parsed)
      let replaceTargetId: string | null = null

      // Feature 1 — a world with this card's identity (name+creator) is already installed: offer the
      // 3-way choice before touching anything. Default is the SAFE, non-destructive "Import as new".
      const matches = characterService.findMatchingCharacter(profileId, parsed.card)
      if (matches.length > 0) {
        const target = matches[0] // most recent
        const { response } = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: text.duplicateButtons,
          defaultId: 1,
          cancelId: 3,
          message: text.duplicateMessage(summary.name),
          detail: text.duplicateDetail({
            installedName: target.name,
            installedCreator: target.creator,
            installedVersion: target.version,
            incomingName: summary.name,
            incomingCreator: parsed.card.data.creator ?? '',
            incomingVersion: parsed.card.data.character_version ?? '',
            matchCount: matches.length
          })
        })
        if (response === 3) return null // Cancel
        if (response === 0) {
          // Update in place (keeps saves). Still offer the optional asset zip for World Cards.
          const assetZipPath = await maybePickAssets(win, summary.isWorldCard, text)
          return characterService.updateCharacterInPlace(
            profileId,
            target.id,
            filePath,
            assetZipPath
          )
        }
        if (response === 2) {
          // Defer deletion until the replacement has been fully imported and validated.
          replaceTargetId = target.id
        }
        // response === 1 (Import as new) or 2 (after delete) → continue to the fresh-import path below.
      }

      // One-click install: if the card bundles artifacts (regex/scripts/UI), show a transparent confirm
      // listing exactly what installs before committing anything.
      if (characterService.hasBundle(summary)) {
        const items = [
          summary.loreEntries && text.bundleItem(summary.loreEntries, 'loreEntries'),
          summary.lorebooks && text.bundleItem(summary.lorebooks, 'lorebooks'),
          summary.regexScripts && text.bundleItem(summary.regexScripts, 'regexScripts'),
          summary.presets && text.bundleItem(summary.presets, 'presets'),
          summary.scripts && text.bundleItem(summary.scripts, 'scripts'),
          summary.uiWidgets && text.bundleItem(summary.uiWidgets, 'uiWidgets'),
          summary.workflows && text.bundleItem(summary.workflows, 'workflows'),
          summary.tableTemplates && text.bundleItem(summary.tableTemplates, 'tableTemplates'),
          summary.pluginsSkipped && text.bundleItem(summary.pluginsSkipped, 'pluginsSkipped')
        ].filter(Boolean)
        const { response } = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: [text.install, text.cancel],
          defaultId: 0,
          cancelId: 1,
          message: text.importMessage(summary.name),
          detail:
            text.bundleIntro(summary.isWorldCard) + items.map((item) => `  • ${item}`).join('\n')
        })
        if (response !== 0) return null
      }
      const assetZipPath = await maybePickAssets(win, summary.isWorldCard, text)
      return replaceTargetId
        ? characterService.replaceCharacterFromFile(
            profileId,
            replaceTargetId,
            filePath,
            assetZipPath
          )
        : characterService.importCharacterFromFile(profileId, filePath, assetZipPath)
    })
  )

  // GATED: native save dialog writing a card JSON to an arbitrary host path.
  ipcMain.handle(
    'export-character-dialog',
    gate('export-character-dialog', async (event, profileId, characterId) => {
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
  )
}
