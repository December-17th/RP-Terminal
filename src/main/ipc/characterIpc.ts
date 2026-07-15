import { IpcMain, BrowserWindow, dialog } from 'electron'
import fs from 'fs'
import * as characterService from '../services/characterService'
import { gate } from './ipcGuards'

/** Optionally prompt for a World Card's asset zip (character/ + location/ images). Only offered for World
 *  Cards — plain cards can use the Asset Manager later. Returns the chosen path, or undefined if skipped.
 *  Shared by the fresh-import and update-in-place paths (Feature 1). */
const maybePickAssets = async (
  win: BrowserWindow,
  isWorldCard: boolean
): Promise<string | undefined> => {
  if (!isWorldCard) return undefined
  const addAssets = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Choose zip…', 'Skip'],
    defaultId: 1,
    cancelId: 1,
    message: 'Import assets?',
    detail:
      'Optionally pick a .zip of images (character/ and location/ folders) to import with this world.'
  })
  if (addAssets.response !== 0) return undefined
  const pick = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Asset Zip', extensions: ['zip'] }]
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
      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: 'World Cards', extensions: ['png', 'json'] }]
      })
      if (result.canceled || result.filePaths.length === 0) return null
      const filePath = result.filePaths[0]

      const parsed = characterService.parseCardFile(filePath)
      if (!parsed) return null
      const summary = characterService.summarizeCardBundle(parsed)

      // Feature 1 — a world with this card's identity (name+creator) is already installed: offer the
      // 3-way choice before touching anything. Default is the SAFE, non-destructive "Import as new".
      const matches = characterService.findMatchingCharacter(profileId, parsed.card)
      if (matches.length > 0) {
        const target = matches[0] // most recent
        const inCreator = parsed.card.data.creator ? ` by ${parsed.card.data.creator}` : ''
        const inVer = parsed.card.data.character_version
          ? ` (v${parsed.card.data.character_version})`
          : ''
        const exCreator = target.creator ? ` by ${target.creator}` : ''
        const exVer = target.version ? ` (v${target.version})` : ''
        const dupNote =
          matches.length > 1
            ? `\n\n${matches.length} copies are already installed — Update/Replace act on the most recent.`
            : ''
        const { response } = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: ['Update & keep saves', 'Import as new', 'Replace (delete saves)', 'Cancel'],
          defaultId: 1,
          cancelId: 3,
          message: `"${summary.name}" is already installed`,
          detail:
            `Installed: ${target.name}${exCreator}${exVer}\n` +
            `Importing: ${summary.name}${inCreator}${inVer}\n\n` +
            `• Update & keep saves — refresh this world's card, scripts and lore; keep all sessions.\n` +
            `• Import as new — install a separate copy.\n` +
            `• Replace — DELETE the installed world and its saved sessions, then import fresh.` +
            dupNote
        })
        if (response === 3) return null // Cancel
        if (response === 0) {
          // Update in place (keeps saves). Still offer the optional asset zip for World Cards.
          const assetZipPath = await maybePickAssets(win, summary.isWorldCard)
          return characterService.updateCharacterInPlace(
            profileId,
            target.id,
            filePath,
            assetZipPath
          )
        }
        if (response === 2) {
          // Replace: delete the existing world (+ its saves) then fall through to a fresh import.
          characterService.deleteCharacter(profileId, target.id)
        }
        // response === 1 (Import as new) or 2 (after delete) → continue to the fresh-import path below.
      }

      // One-click install: if the card bundles artifacts (regex/scripts/UI), show a transparent confirm
      // listing exactly what installs before committing anything.
      if (characterService.hasBundle(summary)) {
        const items = [
          summary.loreEntries && `${summary.loreEntries} lore entries`,
          summary.lorebooks && `${summary.lorebooks} extra lorebooks`,
          summary.regexScripts && `${summary.regexScripts} regex scripts`,
          summary.presets && `${summary.presets} presets`,
          summary.scripts && `${summary.scripts} card scripts`,
          summary.uiWidgets && `${summary.uiWidgets} UI widgets`,
          summary.pluginsSkipped &&
            `${summary.pluginsSkipped} plugins (skipped — not yet supported)`
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
      const assetZipPath = await maybePickAssets(win, summary.isWorldCard)
      return characterService.importCharacterFromFile(profileId, filePath, assetZipPath)
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
