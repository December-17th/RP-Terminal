import fs from 'fs'
import path from 'path'
import { nativeImage } from 'electron'
import { getAppDir, ensureDir } from './storageService'
import { getDb } from './db'
import { log } from './logService'
import { RPTerminalCard, RPTerminalCardSchema, Lorebook, getRpExt } from '../types/character'
import {
  saveCharacterLorebook,
  deleteCharacterLorebook,
  normalizeLorebookData,
  saveLorebookById,
  getCharacterLorebook
} from './lorebookService'
import * as regexService from './regexService'
import * as scriptService from './scriptService'
import * as tableTemplateService from './tableTemplateService'
import { installBundledPreset } from './presetService'
import { parseStPng, extractAppendedZip } from '../parsers/stPngParser'
import { importAssetsZip } from './worldAssetService'
import { installCartridgeCode, deleteCardCode } from './cardCodeService'
import { deleteChatFully, chatIdsForCharacter } from './chatDeleteService'

const getAvatarsDir = (): string => path.join(getAppDir(), 'avatars')
export const getAvatarPath = (characterId: string): string =>
  path.join(getAvatarsDir(), `${characterId}.png`)

/** The bounded launcher thumbnail path for a character (sibling of the original avatar PNG). */
export const getAvatarThumbPath = (characterId: string): string =>
  path.join(getAvatarsDir(), `${characterId}.thumb.png`)

/** Longest-edge cap for the generated launcher thumbnail. The original stays untouched on disk. */
const AVATAR_THUMB_MAX = 256

/**
 * Upper bound (bytes) on the ORIGINAL avatar we're willing to serve as a FALLBACK when thumbnail
 * generation fails. The launcher contract is a bounded 256px thumb; if we can't produce one, a small
 * original is a tolerable stand-in but a multi-MB original is not — so above this we 404 and let the
 * renderer's letter-placeholder show instead of streaming an unbounded image on the hot path.
 */
export const AVATAR_FALLBACK_MAX_BYTES = 512 * 1024

/** Pure decision seam: may the ORIGINAL avatar be served as a fallback given its size in bytes? */
export const isAvatarFallbackAllowed = (origSizeBytes: number): boolean =>
  origSizeBytes <= AVATAR_FALLBACK_MAX_BYTES

/**
 * Resolve the ORIGINAL + THUMB absolute paths for a character id inside the avatars dir, with the
 * same root-escape guard the world-asset protocol uses (a traversing id → null). Pure path logic —
 * no fs, no nativeImage — so both the thumb generator and the protocol serve-path share one guard.
 */
const avatarPaths = (characterId: string): { orig: string; thumb: string } | null => {
  let decoded: string
  try {
    decoded = decodeURIComponent(characterId)
  } catch {
    return null
  }
  const dir = path.resolve(getAvatarsDir())
  const orig = path.resolve(dir, `${decoded}.png`)
  const thumb = path.resolve(dir, `${decoded}.thumb.png`)
  const base = dir + path.sep
  if (!orig.startsWith(base) || !thumb.startsWith(base)) return null // escaped the avatars root
  return { orig, thumb }
}

/**
 * Ensure a bounded launcher thumbnail exists for a character and return the best path to SERVE:
 * the thumb if present/generated, else the original as a fallback, else null. Downscales the
 * original PNG to {@link AVATAR_THUMB_MAX}px (longest edge) via Electron's `nativeImage` — no new
 * deps, main-process only. Any failure (missing/undecodable image, resize/write error) falls back
 * to the original so the launcher still shows something. Idempotent: a hit returns immediately.
 */
export const ensureAvatarThumb = (characterId: string): string | null => {
  const p = avatarPaths(characterId)
  if (!p) return null
  try {
    if (fs.existsSync(p.thumb)) return p.thumb
    if (!fs.existsSync(p.orig)) return null
    const img = nativeImage.createFromPath(p.orig)
    if (img.isEmpty()) return p.orig
    const { width, height } = img.getSize()
    const longest = Math.max(width, height)
    // Only downscale; a small avatar is served as-is (still written as the thumb so the protocol
    // has a stable target and we don't re-run nativeImage on every launcher open).
    const out =
      longest > AVATAR_THUMB_MAX
        ? img.resize(width >= height ? { width: AVATAR_THUMB_MAX } : { height: AVATAR_THUMB_MAX })
        : img
    ensureDir(getAvatarsDir())
    fs.writeFileSync(p.thumb, out.toPNG())
    return p.thumb
  } catch (e) {
    log('error', 'Avatar thumbnail generation failed:', e)
    return fs.existsSync(p.orig) ? p.orig : null
  }
}

/**
 * The absolute path to serve for a character avatar WITHOUT generating anything: thumb if it
 * exists, else the original, else null (with the same root-escape guard as {@link ensureAvatarThumb}).
 * Pure fs + path — the protocol handler calls {@link ensureAvatarThumb} first (which generates lazily),
 * then this is the testable seam for the thumb-preferred selection + traversal guard.
 */
export const resolveAvatarServePath = (characterId: string): string | null => {
  const p = avatarPaths(characterId)
  if (!p) return null
  if (fs.existsSync(p.thumb)) return p.thumb
  if (fs.existsSync(p.orig)) return p.orig
  return null
}

const pathExists = async (p: string): Promise<boolean> => {
  try {
    await fs.promises.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Run the CPU-bound `nativeImage` decode/resize/encode OFF the protocol callback tick. `setImmediate`
 * yields once so a burst of concurrent requests doesn't serialize a wall of synchronous IO inside the
 * protocol handler. Resolves the written thumb path, or `null` if the original is undecodable (caller
 * then applies the bounded fallback). Rejects on an unexpected resize/write error.
 */
const generateThumbDeferred = (p: { orig: string; thumb: string }): Promise<string | null> =>
  new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        const img = nativeImage.createFromPath(p.orig)
        if (img.isEmpty()) return resolve(null) // undecodable original
        const { width, height } = img.getSize()
        const longest = Math.max(width, height)
        const out =
          longest > AVATAR_THUMB_MAX
            ? img.resize(width >= height ? { width: AVATAR_THUMB_MAX } : { height: AVATAR_THUMB_MAX })
            : img
        ensureDir(getAvatarsDir())
        fs.writeFileSync(p.thumb, out.toPNG())
        resolve(p.thumb)
      } catch (e) {
        reject(e)
      }
    })
  })

const generateThumbServePath = async (p: {
  orig: string
  thumb: string
}): Promise<string | null> => {
  if (await pathExists(p.thumb)) return p.thumb
  let origSize: number
  try {
    origSize = (await fs.promises.stat(p.orig)).size
  } catch {
    return null // no original → 404 (letter placeholder)
  }
  try {
    const thumb = await generateThumbDeferred(p)
    if (thumb) return thumb
  } catch (e) {
    log('error', 'Avatar thumbnail generation failed:', e)
  }
  // Generation failed or the original was undecodable: serve the original ONLY if it's small enough
  // to honour the bounded contract; otherwise 404 so the renderer's onError placeholder shows.
  return isAvatarFallbackAllowed(origSize) ? p.orig : null
}

/** In-flight thumb generations, keyed by the absolute thumb path, so N concurrent requests for the
 * same avatar decode/encode ONCE (single-flight) and share the resolved serve path. */
const inFlightThumbs = new Map<string, Promise<string | null>>()

/**
 * Async, request-path counterpart to {@link ensureAvatarThumb}: resolve the bounded path to SERVE for a
 * character avatar, generating the launcher thumbnail lazily and OFF the hot path. Existence/stat reads
 * use `fs.promises`; the synchronous `nativeImage` work is deferred via {@link generateThumbDeferred};
 * concurrent requests for the same id are de-duplicated so generation runs once. On failure the bounded
 * fallback rule ({@link isAvatarFallbackAllowed}) decides between the original and a `null` (→ 404).
 */
export const ensureAvatarThumbAsync = (characterId: string): Promise<string | null> => {
  const p = avatarPaths(characterId)
  if (!p) return Promise.resolve(null)
  const existing = inFlightThumbs.get(p.thumb)
  if (existing) return existing
  const job = generateThumbServePath(p).finally(() => {
    inFlightThumbs.delete(p.thumb)
  })
  inFlightThumbs.set(p.thumb, job)
  return job
}

/** The card's avatar PNG as a `data:` URL (for the renderer launcher/img), or null if none. */
export const getAvatarDataUrl = (characterId: string): string | null => {
  try {
    const p = getAvatarPath(characterId)
    if (!fs.existsSync(p)) return null
    return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64')
  } catch {
    return null
  }
}

export const getCharacters = (profileId: string): Array<{ id: string; card: RPTerminalCard }> => {
  const rows = getDb()
    .prepare('SELECT id, card FROM characters WHERE profile_id = ? ORDER BY created_at')
    .all(profileId) as Array<{ id: string; card: string }>

  const out: Array<{ id: string; card: RPTerminalCard }> = []
  for (const row of rows) {
    const parsed = RPTerminalCardSchema.safeParse(safeJson(row.card))
    if (parsed.success) out.push({ id: row.id, card: parsed.data })
    else log('info', `Skipping invalid card ${row.id}:`, parsed.error.issues?.[0]?.message)
  }
  return out
}

export const getCharacter = (profileId: string, characterId: string): RPTerminalCard | null => {
  const row = getDb()
    .prepare('SELECT card FROM characters WHERE id = ? AND profile_id = ?')
    .get(characterId, profileId) as { card: string } | undefined
  if (!row) return null
  const parsed = RPTerminalCardSchema.safeParse(safeJson(row.card))
  return parsed.success ? parsed.data : null
}

export const saveCharacter = (
  profileId: string,
  characterId: string,
  card: RPTerminalCard
): void => {
  const parsed = RPTerminalCardSchema.parse(card)
  getDb()
    .prepare(
      `INSERT INTO characters (id, profile_id, card, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET card = excluded.card`
    )
    .run(characterId, profileId, JSON.stringify(parsed), new Date().toISOString())
}

export const deleteCharacter = (profileId: string, characterId: string): void => {
  const db = getDb()
  db.prepare('DELETE FROM characters WHERE id = ? AND profile_id = ?').run(characterId, profileId)
  // Cascade the character's sessions (chats) through the SAME centralized per-chat teardown as
  // chatService.deleteChat (the leaf chatDeleteService — no characterService ↔ chatService cycle),
  // so each chat's non-cascading central rows (workflow_run_history / workflow_trigger_state /
  // agent_pack_trigger_state / per-chat pack activation + chat-scope overrides) AND its whole
  // per-session store folder are removed — not just the chat row. character_id is a plain column
  // (not an FK), so nothing cascades from the character delete above; enumerating + tearing down
  // each chat is what prevents the orphans.
  for (const chatId of chatIdsForCharacter(profileId, characterId)) {
    deleteChatFully(profileId, chatId)
  }
  deleteCharacterLorebook(profileId, characterId)
  // Remove the world-scoped regex/scripts this card brought in on import (scope='world',
  // owner=characterId) so a deleted World Card doesn't leave orphans in the managers —
  // mirrors deletePreset's cleanup of its preset-scoped artifacts.
  regexService.deleteScriptsByOwner(profileId, 'world', characterId)
  scriptService.deleteScriptsByOwner(profileId, 'world', characterId)
  // Remove the world-bound workflows this card brought in on import (tagged meta.world_owner);
  // deleteWorkflowsByOwner also clears the world-default selection ref. Bundled table templates are
  // library artifacts (never world-bound, like presets/lorebooks) and are deliberately left in place.
  cardWorkflowHooks?.deleteWorkflowsByOwner(profileId, characterId)
  const avatar = getAvatarPath(characterId)
  if (fs.existsSync(avatar)) fs.unlinkSync(avatar)
  const thumb = getAvatarThumbPath(characterId)
  if (fs.existsSync(thumb)) fs.unlinkSync(thumb)
  // Remove any card-code cartridge subtree extracted for this world on import (A1).
  deleteCardCode(profileId, characterId)
}

/** A card file parsed (losslessly) but not yet persisted. */
export interface ParsedCard {
  card: RPTerminalCard
  /** The normalized embedded lorebook (character_book), routed to the lore store on install. */
  lorebook: Lorebook | null
}

/** What a card bundles — drives the one-click install confirm + summary toast. */
export interface ImportSummary {
  name: string
  isWorldCard: boolean
  regexScripts: number
  loreEntries: number
  scripts: number
  uiWidgets: number
  presets: number
  lorebooks: number
  /** Bundled workflow docs imported + bound as this world's default (Track S / card-import). */
  workflows: number
  /** Bundled memory-table templates dropped into the profile's template library. */
  tableTemplates: number
  /** Bundled plugins detected but NOT installed yet (package format/grant flow TBD). */
  pluginsSkipped: number
  /** Images extracted from an optional asset zip supplied at import time. */
  assetsImported: number
}

export interface ImportResult {
  id: string
  summary: ImportSummary
}

/**
 * Collect bundled ST regex scripts from both the standard `extensions.regex_scripts`
 * (which SillyTavern also applies) and our `rp_terminal.regex` slot. Each element is
 * one ST regex-script object. Canonical source is `regex_scripts` (§3 of the design).
 */
export const collectBundledRegex = (card: RPTerminalCard): any[] => {
  const rpt = getRpExt(card)
  // `regex_scripts` is the ST-standard key (extensions level, untyped via catchall).
  const fromSt = card.data.extensions?.regex_scripts
  const fromRpt = rpt?.regex
  return [
    ...(Array.isArray(fromSt) ? fromSt : []),
    ...(Array.isArray(fromRpt) ? fromRpt : [])
  ].filter((r) => r && typeof r === 'object')
}

/** Bundled chat-completion presets from `rp_terminal.presets[]` (Track S §3). */
export const collectBundledPresets = (card: RPTerminalCard): any[] => {
  const p = getRpExt(card)?.presets
  return Array.isArray(p) ? p.filter((x) => x && typeof x === 'object') : []
}

/** Extra bundled lorebooks from `rp_terminal.lorebooks[]` (beyond `character_book`). */
export const collectBundledLorebooks = (card: RPTerminalCard): any[] => {
  const b = getRpExt(card)?.lorebooks
  return Array.isArray(b) ? b.filter((x) => x && typeof x === 'object') : []
}

/** Bundled generation/memory workflow docs from `rp_terminal.workflows[]` (world-bound on import). */
export const collectBundledWorkflows = (card: RPTerminalCard): any[] => {
  const w = getRpExt(card)?.workflows
  return Array.isArray(w) ? w.filter((x) => x && typeof x === 'object') : []
}

/** Bundled memory-table templates from `rp_terminal.table_templates[]` (library-drop on import). */
export const collectBundledTableTemplates = (card: RPTerminalCard): any[] => {
  const t = getRpExt(card)?.table_templates
  return Array.isArray(t) ? t.filter((x) => x && typeof x === 'object') : []
}

/**
 * Bundled Tavern Helper scripts from the card's standard `extensions.tavern_helper.scripts[]`
 * (the same slot presets use). These are routed into the script store on import. NOTE: the
 * card's *native* `rp_terminal.scripts` are NOT here — those ride on the card and load at
 * runtime (`get-runtime-scripts`); only the ST/TH-format scripts need importing.
 */
export const collectBundledScripts = (card: RPTerminalCard): any[] => {
  const arr = (card.data.extensions as any)?.tavern_helper?.scripts
  return Array.isArray(arr) ? arr.filter((s) => s && typeof s === 'object') : []
}

/** Count what a parsed card bundles, for the import confirm + summary toast. */
export const summarizeCardBundle = (parsed: ParsedCard): ImportSummary => {
  const rpt = getRpExt(parsed.card)
  return {
    name: parsed.card.data.name,
    isWorldCard: !!rpt?.world_card,
    regexScripts: collectBundledRegex(parsed.card).length,
    loreEntries: parsed.lorebook?.entries.length || 0,
    // Native (rp_terminal.scripts, ride on the card) + bundled TH scripts (imported to store).
    scripts:
      (Array.isArray(rpt?.scripts) ? rpt.scripts.length : 0) +
      collectBundledScripts(parsed.card).length,
    uiWidgets: Array.isArray(rpt?.ui_layout) ? rpt.ui_layout.length : 0,
    presets: collectBundledPresets(parsed.card).length,
    lorebooks: collectBundledLorebooks(parsed.card).length,
    workflows: collectBundledWorkflows(parsed.card).length,
    tableTemplates: collectBundledTableTemplates(parsed.card).length,
    pluginsSkipped: Array.isArray(rpt?.plugins) ? rpt.plugins.length : 0,
    assetsImported: 0
  }
}

/** True when a card carries enough of a bundle to warrant the install confirm. */
export const hasBundle = (s: ImportSummary): boolean =>
  s.isWorldCard ||
  s.regexScripts > 0 ||
  s.scripts > 0 ||
  s.uiWidgets > 0 ||
  s.presets > 0 ||
  s.lorebooks > 0 ||
  s.workflows > 0 ||
  s.tableTemplates > 0

/**
 * Parse a card file (PNG/JSON) into a normalized, **lossless** RPTerminalCard
 * without persisting anything. Unlike the old whitelist import, this preserves the
 * *entire* `extensions` object (ST keys like `regex_scripts` + future `rp_terminal`
 * bundle slots) so a World Card round-trips instead of being stripped on import.
 */
export const parseCardFile = (filePath: string): ParsedCard | null => {
  let stData: any = null
  try {
    const ext = path.extname(filePath).toLowerCase()
    if (ext === '.png') stData = parseStPng(filePath)
    else if (ext === '.json') stData = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
  if (!stData) return null

  const isWrapped = stData.spec === 'chara_card_v2' || stData.spec === 'chara_card_v3'
  const src = isWrapped ? stData.data : stData

  const result = RPTerminalCardSchema.safeParse({
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: src.name || 'Unknown',
      description: src.description || '',
      personality: src.personality || '',
      scenario: src.scenario || '',
      first_mes: src.first_mes || '',
      mes_example: src.mes_example || '',
      creator_notes: src.creator_notes || '',
      system_prompt: src.system_prompt || '',
      post_history_instructions: src.post_history_instructions || '',
      alternate_greetings: src.alternate_greetings || [],
      tags: src.tags || [],
      creator: src.creator || '',
      character_version: src.character_version || '',
      // Lossless: keep ALL extensions, not just rp_terminal. The schema's catchalls
      // (CardData.extensions + RPTerminalExt) preserve unknown keys.
      extensions: src.extensions || {}
    }
  })
  if (!result.success) return null

  const lorebook = normalizeLorebookData(
    src.character_book || stData.character_book,
    src.name || 'Unknown'
  )
  return { card: result.data, lorebook }
}

/**
 * Workflow operations are injected to keep characterService out of workflowService's dependency cycle.
 */
export interface CardWorkflowHooks {
  importWorkflow: (profileId: string, doc: unknown, owner: string) => string | null
  setWorldWorkflow: (profileId: string, characterId: string, workflowId: string) => void
  deleteWorkflowsByOwner: (profileId: string, owner: string) => void
}

let cardWorkflowHooks: CardWorkflowHooks | null = null

export const setCardWorkflowHooks = (hooks: CardWorkflowHooks | null): void => {
  cardWorkflowHooks = hooks
}

interface BundleCounts {
  regexScripts: number
  scripts: number
  presets: number
  lorebooks: number
  workflows: number
  tableTemplates: number
  assetsImported: number
}

/**
 * Install a card's BUNDLED artifacts (regex, Tavern Helper scripts, presets, optional extra lorebooks,
 * avatar + cartridge code, asset zip) against an EXISTING character id — the shared tail of both a fresh
 * import and an in-place update (Feature 1). World-scoped artifacts key on `characterId`, so re-running
 * this against the same id re-installs the bundle for that world. `installExtraLorebooks` is false on
 * UPDATE (plan review C8b): extra lorebooks install under fresh UUIDs each time, so re-installing them on
 * every update would silently duplicate them. Returns the per-kind counts for the import summary.
 */
const installBundleArtifacts = (
  profileId: string,
  characterId: string,
  card: RPTerminalCard,
  filePath: string,
  assetZipPath: string | undefined,
  opts: { installExtraLorebooks: boolean; installTableTemplates: boolean }
): BundleCounts => {
  // Route each bundled ST regex script into the profile regex store (one file each), scoped to this world
  // so it only fires when this card is loaded (Track S §6). A card's UI regexes (status/home/…) import as
  // normal INLINE display regexes by default — the user can later promote one to a docked WCV panel.
  let regexScripts = 0
  for (const script of collectBundledRegex(card)) {
    if (regexService.saveRegexScript(profileId, script, 'world', characterId)) regexScripts++
  }

  // Route bundled Tavern Helper scripts (extensions.tavern_helper.scripts — the standard ST slot) into the
  // script store, scoped to this world so they run when the card is loaded and show in the Scripts manager.
  // (Native rp_terminal.scripts ride on the card instead.)
  let scripts = 0
  for (const s of scriptService.normalizeImportedScripts(collectBundledScripts(card))) {
    const file = scriptService.saveScript(
      profileId,
      { name: s.name, code: s.code },
      'world',
      characterId
    )
    if (!s.enabled) scriptService.setScriptDisabled(profileId, file, true)
    scripts++
  }

  // Route bundled chat-completion presets into the preset store (never made active). Preset install
  // name-dedupes (presetService), so re-running on update is safe — no skip flag needed here.
  let presets = 0
  for (const p of collectBundledPresets(card)) {
    if (installBundledPreset(profileId, p)) presets++
  }

  // Route extra bundled lorebooks (beyond character_book) into the lorebook library — SKIPPED on update
  // (C8b) because each install mints a fresh UUID and would duplicate them.
  let lorebooks = 0
  if (opts.installExtraLorebooks) {
    for (const lb of collectBundledLorebooks(card)) {
      const normalized = normalizeLorebookData(lb, lb?.name || 'Bundled Lorebook')
      if (normalized) {
        saveLorebookById(profileId, crypto.randomUUID(), normalized)
        lorebooks++
      }
    }
  }

  let workflows = 0
  let worldWorkflowId: string | null = null
  for (const doc of collectBundledWorkflows(card)) {
    const id = cardWorkflowHooks?.importWorkflow(profileId, doc, characterId) ?? null
    if (id) {
      workflows++
      worldWorkflowId ??= id
    } else {
      log('info', 'Bundled workflow not imported (invalid, unsupported, or bridge unwired)')
    }
  }
  if (worldWorkflowId) {
    cardWorkflowHooks?.setWorldWorkflow(profileId, characterId, worldWorkflowId)
  }

  // Templates are library artifacts without world ownership. Install them only on a fresh import so a
  // card update cannot silently duplicate templates under new ids.
  let tableTemplates = 0
  if (opts.installTableTemplates) {
    for (const raw of collectBundledTableTemplates(card)) {
      const result = tableTemplateService.importTableTemplateFromObject(profileId, raw)
      if (result.summary) tableTemplates++
      else if (result.error) log('info', `Bundled table template not imported: ${result.error}`)
    }
  }

  if (path.extname(filePath).toLowerCase() === '.png') {
    ensureDir(getAvatarsDir())
    fs.copyFileSync(filePath, getAvatarPath(characterId))
    // Pre-generate the bounded launcher thumbnail so the launcher never sync-reads the multi-MB
    // original (perf P1-6). Best-effort: a failure falls back to the original at serve time.
    // Drop any existing thumb first — ensureAvatarThumb is idempotent-on-hit, and an update-in-place
    // just overwrote the original, so a stale thumb would otherwise survive the new artwork.
    try {
      fs.unlinkSync(getAvatarThumbPath(characterId))
    } catch {
      /* no existing thumb */
    }
    ensureAvatarThumb(characterId)
    // S5 cartridge: if the PNG carries a ZIP appended after IEND, extract its code/ subtree to the
    // card-code dir (WP0/A1). A rejected/absent cartridge never blocks the card import.
    try {
      const zipBytes = extractAppendedZip(filePath)
      if (zipBytes) {
        const res = installCartridgeCode(profileId, characterId, zipBytes)
        if (res.error) log('info', `Cartridge code not imported: ${res.error}`)
      }
    } catch (e) {
      log('error', 'Cartridge code import failed (card import continues):', e)
    }
  }

  let assetsImported = 0
  if (assetZipPath) {
    try {
      assetsImported = importAssetsZip(profileId, characterId, assetZipPath).imported
    } catch (e) {
      log('error', 'Asset zip import failed (card import continues):', e)
    }
  }

  return {
    regexScripts,
    scripts,
    presets,
    lorebooks,
    workflows,
    tableTemplates,
    assetsImported
  }
}

/** Overlay the actually-installed bundle counts onto the base summary (shared by import + update). */
const buildImportSummary = (parsed: ParsedCard, counts: BundleCounts): ImportSummary => {
  const summary = summarizeCardBundle(parsed)
  summary.regexScripts = counts.regexScripts
  // Native scripts ride on the card; add the count actually imported into the store.
  summary.scripts =
    (Array.isArray(getRpExt(parsed.card)?.scripts) ? getRpExt(parsed.card)!.scripts!.length : 0) +
    counts.scripts
  summary.presets = counts.presets
  summary.lorebooks = counts.lorebooks
  summary.workflows = counts.workflows
  summary.tableTemplates = counts.tableTemplates
  summary.assetsImported = counts.assetsImported
  return summary
}

/**
 * One-click World Card import: persist the (lossless) card + its embedded lorebook, and extract bundled
 * regex, Tavern Helper scripts, presets, and extra lorebooks into their profile stores (scoped to this
 * world) — the slots the old importer silently dropped. Always mints a NEW id (a separate copy); the
 * update-in-place path (Feature 1) is the way to refresh an existing world. Returns the new id + summary.
 */
export const importCharacterFromFile = (
  profileId: string,
  filePath: string,
  assetZipPath?: string
): ImportResult | null => {
  let newId: string | null = null
  try {
    const parsed = parseCardFile(filePath)
    if (!parsed) return null
    const { card, lorebook } = parsed

    newId = crypto.randomUUID()
    saveCharacter(profileId, newId, card)
    if (lorebook) saveCharacterLorebook(profileId, newId, lorebook)

    const counts = installBundleArtifacts(profileId, newId, card, filePath, assetZipPath, {
      installExtraLorebooks: true,
      installTableTemplates: true
    })
    return { id: newId, summary: buildImportSummary(parsed, counts) }
  } catch (error) {
    log('error', 'Failed to import character:', error)
    if (newId) {
      try {
        deleteCharacter(profileId, newId)
      } catch (cleanupError) {
        log('error', `Failed to roll back partial character import ${newId}:`, cleanupError)
      }
    }
    return null
  }
}

/**
 * UPDATE an existing world in place from a re-imported card, KEEPING its chats/saves (plan §B7 / Feature
 * 1). Overwrites the card blob + avatar + (when the new card carries one) the character lorebook, CLEARS
 * the old world-scoped regex/scripts/cartridge, then re-installs the bundle against the SAME id. Chats,
 * floors and memory are untouched — they key on `characterId`, which is preserved. Details:
 *  - A new card with NO character_book leaves the existing lorebook in place (non-destructive).
 *  - Overwriting the lorebook stales cached L2 world-info on this world's chats → that cache is cleared
 *    so the next turn re-matches (review C8a).
 *  - Extra bundled lorebooks are NOT re-installed (review C8b — they'd duplicate under fresh UUIDs).
 * Returns the same {id, summary} shape as import (id unchanged).
 */
export const updateCharacterInPlace = (
  profileId: string,
  characterId: string,
  filePath: string,
  assetZipPath?: string
): ImportResult | null => {
  try {
    const parsed = parseCardFile(filePath)
    if (!parsed) return null
    const { card, lorebook } = parsed

    saveCharacter(profileId, characterId, card) // upsert overwrites the stored blob
    if (lorebook) saveCharacterLorebook(profileId, characterId, lorebook)

    // C8a: overwriting the lorebook stales cached world-info on this world's chats — drop it so the next
    // turn re-matches. Scoped to this character (characterService already writes the chats table, cf.
    // deleteCharacter), avoiding a chatService import cycle.
    getDb()
      .prepare(
        'UPDATE chats SET cached_world_info = NULL WHERE profile_id = ? AND character_id = ?'
      )
      .run(profileId, characterId)

    // Clear the OLD world-scoped artifacts before re-installing (mirrors deleteCharacter's cleanup), so a
    // script/regex removed or renamed in the new card version doesn't linger as an orphan.
    regexService.deleteScriptsByOwner(profileId, 'world', characterId)
    scriptService.deleteScriptsByOwner(profileId, 'world', characterId)
    cardWorkflowHooks?.deleteWorkflowsByOwner(profileId, characterId)
    deleteCardCode(profileId, characterId)

    const counts = installBundleArtifacts(profileId, characterId, card, filePath, assetZipPath, {
      installExtraLorebooks: false,
      installTableTemplates: false
    })
    return { id: characterId, summary: buildImportSummary(parsed, counts) }
  } catch (error) {
    log('error', 'Failed to update character in place:', error)
    return null
  }
}

/**
 * Replace an installed world without risking its saves when the incoming card cannot be installed.
 * The new world is fully imported first; only then is the existing world deleted.
 */
export const replaceCharacterFromFile = (
  profileId: string,
  characterId: string,
  filePath: string,
  assetZipPath?: string
): ImportResult | null => {
  const imported = importCharacterFromFile(profileId, filePath, assetZipPath)
  if (!imported) return null
  try {
    deleteCharacter(profileId, characterId)
  } catch (error) {
    log(
      'error',
      `Imported replacement ${imported.id}, but could not delete existing character ${characterId}:`,
      error
    )
  }
  return imported
}

/** A normalized card identity for dedupe / update matching (plan review C7): name + creator, trimmed and
 *  lowercased. VERSION is deliberately EXCLUDED — it is the comparator, not part of identity, so a NEW
 *  version of the same card still matches its installed copy (which is the whole point of the feature). */
export const cardIdentity = (card: RPTerminalCard): { name: string; creator: string } => ({
  name: (card.data.name ?? '').trim().toLowerCase(),
  creator: (card.data.creator ?? '').trim().toLowerCase()
})

/** Whether two card identities match: name AND creator equal. An empty creator matches an empty creator
 *  (a name-only match for cards lacking a creator — review C7). Pure/testable. */
export const identityMatches = (
  a: { name: string; creator: string },
  b: { name: string; creator: string }
): boolean => a.name === b.name && a.creator === b.creator

/** An installed character that matches a card being imported — enough detail for the dedupe dialog. */
export interface CharacterMatch {
  id: string
  name: string
  creator: string
  version: string
  createdAt: string | null
}

/**
 * Every installed character whose identity (name+creator) matches `card` (plan §B7 / Feature 1), newest
 * first. Returns ALL matches, not 0/1: the library already holds UUID-duplicates from the pre-Feature-1
 * importer (which always minted a new id on every import), so callers must handle N matches.
 */
/** Find installed worlds matching a bare {name, creator} identity — the save-import world resolver
 *  (Feature 2: a save REFERENCES its world, so import requires a matching world installed). Same
 *  identity rule as card re-import (C7): name+creator, version-agnostic. */
export const findMatchingByIdentity = (
  profileId: string,
  name: string,
  creator: string
): CharacterMatch[] =>
  findMatchingCharacter(profileId, { data: { name, creator } } as unknown as RPTerminalCard)

export const findMatchingCharacter = (
  profileId: string,
  card: RPTerminalCard
): CharacterMatch[] => {
  const target = cardIdentity(card)
  const rows = getDb()
    .prepare(
      'SELECT id, card, created_at FROM characters WHERE profile_id = ? ORDER BY created_at DESC'
    )
    .all(profileId) as Array<{ id: string; card: string; created_at: string | null }>
  const out: CharacterMatch[] = []
  for (const row of rows) {
    const parsed = RPTerminalCardSchema.safeParse(safeJson(row.card))
    if (!parsed.success) continue
    if (identityMatches(cardIdentity(parsed.data), target)) {
      out.push({
        id: row.id,
        name: parsed.data.data.name,
        creator: parsed.data.data.creator ?? '',
        version: parsed.data.data.character_version ?? '',
        createdAt: row.created_at
      })
    }
  }
  return out
}

/**
 * Build a World Card export object (chara_card_v3) — the inverse of import (§7). Folds
 * the card's own lorebook back into `character_book`, this world's regex back into the
 * canonical `extensions.regex_scripts`, and stamps the `world_card` marker. The card's
 * existing `rp_terminal` payload (scripts/ui/data_schema/state_schema/agent/css/…) rides
 * along untouched. Pure + deep-cloned so export never mutates the live card. Re-importing
 * the result reproduces the same world (round-trip invariant).
 *
 * NOTE: presets/extra-lorebooks/plugins aren't exported yet — they have no world-scope
 * binding (S2 scoped regex only), so we can't reliably attribute them to this card.
 */
export const buildWorldCardExport = (
  card: RPTerminalCard,
  characterBook: Lorebook | null,
  worldRegex: any[]
): any => {
  const data: any = JSON.parse(JSON.stringify(card.data))
  data.extensions = data.extensions || {}
  data.extensions.rp_terminal = {
    ...(data.extensions.rp_terminal || {}),
    world_card: data.extensions.rp_terminal?.world_card || '1.0'
  }
  if (worldRegex.length > 0) data.extensions.regex_scripts = worldRegex
  if (characterBook && characterBook.entries.length > 0) data.character_book = characterBook
  return { spec: 'chara_card_v3', spec_version: '3.0', data }
}

/** Gather a character + its world-scoped artifacts into a World Card JSON for export. */
export const exportWorldCard = (
  profileId: string,
  characterId: string
): { name: string; json: any } | null => {
  const card = getCharacter(profileId, characterId)
  if (!card) return null
  const book = getCharacterLorebook(profileId, characterId)
  const worldRegex = regexService.getRawScriptsForExport(profileId, characterId)
  return { name: card.data.name, json: buildWorldCardExport(card, book, worldRegex) }
}

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
