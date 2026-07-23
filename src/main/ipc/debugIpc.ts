import { IpcMain } from 'electron'
import { openDebugWindow } from '../services/debugWindowService'
import { buildGenContext } from '../services/generation/genContext'
import { buildScanText, buildPinBlock } from '../services/promptBuilder'
import { matchAcrossTraced } from '../services/lorebookService'
import { getRpExt } from '../types/character'
import type { RetrievalPreviewResponse } from '../../shared/retrievalTrace'

/** IPC for the separate Debug window: open/focus (WP-D1) + lorebook retrieval dry-run (WP-D2). */
export const registerDebugIpc = (ipcMain: IpcMain): void => {
  // The TopStrip button asks main to open/focus the window.
  ipcMain.handle('open-debug-window', () => openDebugWindow())

  /**
   * WP-D2: a side-effect-free dry-run of lorebook retrieval for one chat. It gathers the exact scan
   * inputs a real turn would (`buildGenContext` — reads floors/lorebooks/card/settings/vars, NO model
   * call, NO writes), then runs the matcher twice: RPT retrieval scans `base + [PINS]`, the ST-keyword
   * baseline scans `base` alone. Returns both traces so the viewer can diff them per entry. Read-only:
   * no journaling, no epoch bumps.
   */
  ipcMain.handle(
    'retrieval-preview',
    (
      _event,
      profileId: string,
      chatId: string,
      userAction?: string
    ): RetrievalPreviewResponse => {
      const action = userAction ?? ''
      let ctx
      try {
        // buildGenContext THROWS on a missing chat/card — treat either as not-found.
        ctx = buildGenContext(profileId, chatId, action, 'normal')
      } catch {
        return { ok: false, code: 'not-found' }
      }
      const base = buildScanText(ctx.floors, action, ctx.scanDepth)
      const pinBlock = buildPinBlock(ctx.workingVars, getRpExt(ctx.card)?.pin_paths)
      const books = ctx.lorebooks.map((lorebook) => ({ name: lorebook.name, lorebook }))
      // rng: () => 0 → the probability roll always passes (0*100 < probability for any probability > 0),
      // so the viewer shows what WOULD qualify and the two runs are stably comparable.
      const rpt = matchAcrossTraced(books, base + pinBlock, () => 0, ctx.maxRecursion)
      const baseline = matchAcrossTraced(books, base, () => 0, ctx.maxRecursion)
      return {
        ok: true,
        baseScanText: base,
        pinBlock,
        scanDepth: ctx.scanDepth,
        maxRecursion: ctx.maxRecursion,
        rpt: rpt.trace,
        baseline: baseline.trace,
        lorebookNames: ctx.lorebooks.map((lb) => lb.name)
      }
    }
  )
}
