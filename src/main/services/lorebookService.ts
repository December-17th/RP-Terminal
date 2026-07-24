import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  getAppDir,
  ensureDir,
  readJsonSync,
  writeJsonSyncAtomic,
  listFilesSync
} from './storageService'
import { Lorebook, LorebookEntry, LorebookSchema } from '../types/character'
import { bumpAssemblyEpochForLorebook } from './assemblyEpochService'
import { RetrievalReason, RetrievalTraceRow } from '../../shared/retrievalTrace'

/**
 * Lorebooks are file-based, id-keyed artifacts: `lorebooks/<id>.json`. A card's
 * embedded lorebook is stored under id == characterId, so a character always has
 * an associated lorebook (and existing per-character files keep working); extra
 * standalone lorebooks get a uuid id. A chat selects which lorebook ids are active.
 */

const lorebooksDir = (profileId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'lorebooks')
const lorebookPath = (profileId: string, id: string): string =>
  path.join(lorebooksDir(profileId), `${id}.json`)
// Pre-Phase-F location (embedded lorebook lived under the character dir).
const legacyLorebookPath = (profileId: string, characterId: string): string =>
  path.join(getAppDir(), 'profiles', profileId, 'characters', characterId, 'lorebook.json')

export interface LorebookSummary {
  id: string
  name: string
}

/** Every lorebook in this profile's library (id = filename stem; name from content). */
export const listLorebooks = (profileId: string): LorebookSummary[] => {
  const dir = lorebooksDir(profileId)
  const out: LorebookSummary[] = []
  for (const file of listFilesSync(dir)) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue
    const id = file.replace(/\.json$/, '')
    const data = readJsonSync<Lorebook>(path.join(dir, file))
    if (data) out.push({ id, name: data.name || 'Untitled Lorebook' })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Read a lorebook by id (falls back to the legacy per-character path on miss). */
export const getLorebookById = (profileId: string, id: string): Lorebook | null => {
  let data = readJsonSync(lorebookPath(profileId, id))
  if (!data) data = readJsonSync(legacyLorebookPath(profileId, id)) // migrate-on-read
  if (!data) return null
  const parsed = LorebookSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

export const saveLorebookById = (profileId: string, id: string, lorebook: Lorebook): void => {
  ensureDir(lorebooksDir(profileId))
  // Single minting authority: any entry without a stable id gets one here (idempotent —
  // re-saving an already-id'd book is a no-op). The renderer editor creates id-less entries
  // and must not mint its own.
  const withIds = {
    ...lorebook,
    entries: (lorebook.entries || []).map((e) => (e.id ? e : { ...e, id: randomUUID() }))
  }
  writeJsonSyncAtomic(lorebookPath(profileId, id), LorebookSchema.parse(withIds))
  // ADR 0023: the book's content just changed, so every chat that references it (by explicit selection,
  // or on the default selection when this is the character's embedded book) has stale stored prompts.
  bumpAssemblyEpochForLorebook(profileId, id)
}

export const deleteLorebookById = (profileId: string, id: string): void => {
  const p = lorebookPath(profileId, id)
  if (fs.existsSync(p)) fs.unlinkSync(p)
}

/** Create a new, empty standalone lorebook. Returns its id. */
export const createLorebook = (profileId: string, name = 'New Lorebook'): LorebookSummary => {
  const id = randomUUID()
  saveLorebookById(profileId, id, LorebookSchema.parse({ name, entries: [] }))
  return { id, name }
}

// --- Character-bound helpers (id == characterId) — kept for import/delete flows ---
export const getCharacterLorebook = (profileId: string, characterId: string): Lorebook | null =>
  getLorebookById(profileId, characterId)

export const saveCharacterLorebook = (
  profileId: string,
  characterId: string,
  lorebook: Lorebook
): void => saveLorebookById(profileId, characterId, lorebook)

export const deleteCharacterLorebook = (profileId: string, characterId: string): void =>
  deleteLorebookById(profileId, characterId)

/**
 * Select which lorebook entries to inject given the recent conversation text.
 * Constant entries always fire; the rest fire on a keyword match. An entry with
 * probability < 100 then rolls (per turn) to decide whether it actually fires.
 * Returns entries sorted by insertion_order (lower = earlier). Pure aside from the
 * injectable `rng` (defaults to Math.random) — pass a fixed rng to test the roll.
 */
/**
 * ST-style regex key support. A key is a regex when it is slash-delimited
 * `/pattern/flags`: it starts with `/`, has a closing unescaped `/`, and everything
 * after the final `/` is flags drawn from JS RegExp's `g i m s u y`. Internal `/` in
 * the pattern must be escaped (`\/`). A key that looks slash-delimited but fails to
 * compile falls back to plaintext matching of the whole key string. Regex keys test
 * the untransformed scan text — their own `i` flag governs case, so `case_sensitive`
 * does not apply to them.
 */
const parseRegexKey = (key: string): RegExp | null => {
  // Body: escaped chars (\.) or any char that is not an unescaped `/` or `\`.
  const m = /^\/((?:\\.|[^/\\])*)\/([a-z]*)$/.exec(key)
  if (!m) return null
  const [, pattern, flags] = m
  if (flags && !/^[gimsuy]*$/.test(flags)) return null
  try {
    return new RegExp(pattern, flags)
  } catch {
    return null // invalid pattern → caller falls back to literal
  }
}

// A per-match-call compiled-regex cache: parse each unique key string once WITHIN a single
// matchEntries/matchAcross call, then discard. Kept out of module scope by design (no module state —
// V8 lore-runtime spec): the cache is created at the call entry point and threaded through
// entryQualifies. Value `null` = "not a valid regex key, use literal". Cached RegExps may carry `g`/`y`
// state, so lastIndex is reset before every `.test()`.
export type RegexKeyCache = Map<string, RegExp | null>
const getRegexKey = (key: string, cache: RegexKeyCache): RegExp | null => {
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const re = parseRegexKey(key)
  cache.set(key, re)
  return re
}

/**
 * The single key-vs-text matcher. A slash-delimited `/pattern/flags` key tests the UNTRANSFORMED text
 * (its own `i` flag governs case; `caseSensitive` does not apply); a literal key does a case-folded
 * substring test unless `caseSensitive`. An invalid regex key falls back to literal. `cache` is an
 * optional per-call compiled-regex cache (regexes may carry `g`/`y` lastIndex state, reset before every
 * `.test`). Extracted so `qualifyDetail` (the matcher) and the debug-only lore scorer share ONE code
 * path — matcher behavior is unchanged.
 */
export const keyMatchesText = (
  key: string,
  text: string,
  caseSensitive: boolean,
  cache?: RegexKeyCache
): boolean => {
  if (!key) return false
  const re = cache ? getRegexKey(key, cache) : parseRegexKey(key)
  if (re) {
    re.lastIndex = 0 // guard against g/y-flag lastIndex state across calls
    return re.test(text) // untransformed: the regex's own flags govern case
  }
  const needle = caseSensitive ? key : key.toLowerCase()
  const haystack = caseSensitive ? text : text.toLowerCase()
  return haystack.includes(needle)
}

/** The outcome of qualifying one entry against scan text, with the detail the trace viewer needs.
 *  `qualified` is exactly what the old boolean `entryQualifies` returned; the extra fields are pure
 *  observation and never change matcher behavior. */
interface QualifyDetail {
  qualified: boolean
  reason: RetrievalReason
  /** The first primary key that hit (its source string; regex keys report their slash-delimited text). */
  matchedKey?: string
  /** For a selective entry: whether a secondary key also matched. */
  secondaryMatched?: boolean
}

/** Does an entry qualify for this scan text (constant, or keyword + optional secondary), and by which
 *  key? The `cache` is the caller's per-call compiled-regex cache (see RegexKeyCache). This is the
 *  single source of truth for qualification — `entryQualifies` is its boolean projection, so the traced
 *  and untraced matchers can never diverge. */
const qualifyDetail = (
  entry: LorebookEntry,
  scanText: string,
  cache: RegexKeyCache
): QualifyDetail => {
  if (entry.constant) return { qualified: true, reason: 'constant' }
  // First key that hits (mirrors the old `.some` short-circuit), returning its source string. Routes
  // through the shared `keyMatchesText` so the matcher and the debug scorer can never diverge.
  const firstHit = (keys: string[]): string | undefined => {
    for (const k of keys) {
      if (keyMatchesText(k, scanText, entry.case_sensitive, cache)) return k
    }
    return undefined
  }
  const primary = firstHit(entry.keys)
  if (primary === undefined) return { qualified: false, reason: 'none' }
  if (entry.selective && entry.secondary_keys.length > 0) {
    const secondary = firstHit(entry.secondary_keys)
    if (secondary === undefined)
      return { qualified: false, reason: 'none', matchedKey: primary, secondaryMatched: false }
    return { qualified: true, reason: 'key', matchedKey: primary, secondaryMatched: true }
  }
  return { qualified: true, reason: 'key', matchedKey: primary }
}

/** Does an entry qualify for this scan text? Boolean projection of `qualifyDetail` (unchanged behavior). */
const entryQualifies = (entry: LorebookEntry, scanText: string, cache: RegexKeyCache): boolean =>
  qualifyDetail(entry, scanText, cache).qualified

/** Probability gate — entries with probability < 100 roll once when they qualify. */
const rollPasses = (entry: LorebookEntry, rng: () => number): boolean =>
  entry.probability >= 100 || rng() * 100 < entry.probability

export const matchEntries = (
  lorebook: Lorebook | null,
  scanText: string,
  rng: () => number = Math.random
): LorebookEntry[] => {
  if (!lorebook || lorebook.entries.length === 0) return []
  const cache: RegexKeyCache = new Map() // per-call; discarded when this match returns
  return lorebook.entries
    .filter((e) => e.enabled && entryQualifies(e, scanText, cache) && rollPasses(e, rng))
    .sort((a, b) => a.insertion_order - b.insertion_order)
}

/**
 * Match across all active lorebooks, merged and ordered together. With
 * `maxRecursion > 0`, matched entries' content is fed back as scan text for further
 * passes (ST-style recursion): `exclude_recursion` entries can't be triggered by a
 * recursive pass, and `prevent_recursion` entries' content doesn't feed the next
 * pass. Each entry is decided (and probability-rolled) at most once.
 */
/** One considered entry paired with its source lorebook name (for the trace). */
interface MatchCandidate {
  entry: LorebookEntry
  bookName: string
}

/** Per-entry trace accumulator, keyed by the entry object. Only allocated on the traced path. */
type TraceOutcome = {
  bookName: string
  entryId?: string
  comment: string
  fired: boolean
  reason: RetrievalReason
  matchedKey?: string
  secondaryMatched?: boolean
  recursionPass: number
  probability: number
  excludedByRecursionFlag?: boolean
}

const entryLabel = (entry: LorebookEntry): string =>
  entry.comment?.trim() || entry.content.slice(0, 40).trim()

/**
 * The single matcher core. Operates on book-name-tagged candidates and, when `trace` is provided,
 * records one outcome per considered entry WITHOUT changing which entries fire or their order. Both the
 * public `matchAcross` (trace off) and `matchAcrossTraced` (trace on) delegate here, so the trace can
 * never drift from real matching.
 */
const runMatchCore = (
  candidates: MatchCandidate[],
  scanText: string,
  rng: () => number,
  maxRecursion: number,
  trace: Map<LorebookEntry, TraceOutcome> | null
): LorebookEntry[] => {
  let pool = candidates
  const fired: LorebookEntry[] = []
  const cache: RegexKeyCache = new Map() // per-call; shared across this match's recursion passes only

  if (trace) {
    for (const c of candidates) {
      trace.set(c.entry, {
        bookName: c.bookName,
        ...(c.entry.id ? { entryId: c.entry.id } : {}),
        comment: entryLabel(c.entry),
        fired: false,
        reason: 'none',
        recursionPass: 0,
        probability: c.entry.probability
      })
    }
  }

  // One pass: qualify each pool entry against `text`, roll, and drop it from the
  // pool whether it fired or not (so it can't double-roll on a later pass).
  const runPass = (text: string, recursive: boolean, passIndex: number): LorebookEntry[] => {
    const passFired: LorebookEntry[] = []
    const remaining: MatchCandidate[] = []
    for (const c of pool) {
      const e = c.entry
      if (recursive && e.exclude_recursion) {
        remaining.push(c)
        if (trace) trace.get(e)!.excludedByRecursionFlag = true
        continue
      }
      const detail = trace ? qualifyDetail(e, text, cache) : null
      const qualifies = detail ? detail.qualified : entryQualifies(e, text, cache)
      if (qualifies) {
        const rolled = rollPasses(e, rng)
        if (trace) {
          const o = trace.get(e)!
          o.reason = detail!.reason
          if (detail!.matchedKey !== undefined) o.matchedKey = detail!.matchedKey
          if (detail!.secondaryMatched !== undefined) o.secondaryMatched = detail!.secondaryMatched
          o.recursionPass = passIndex
          o.fired = rolled
        }
        if (rolled) passFired.push(e)
      } else {
        // Record the (partial) reason for a considered-but-unqualified entry — it may still qualify on a
        // later pass, which will overwrite these fields. Left as-is if it never qualifies.
        if (trace && detail) {
          const o = trace.get(e)!
          if (detail.matchedKey !== undefined) o.matchedKey = detail.matchedKey
          if (detail.secondaryMatched !== undefined) o.secondaryMatched = detail.secondaryMatched
        }
        remaining.push(c)
      }
    }
    pool = remaining
    return passFired
  }

  const feed = (entries: LorebookEntry[]): string =>
    entries
      .filter((e) => !e.prevent_recursion)
      .map((e) => e.content)
      .join('\n')

  fired.push(...runPass(scanText, false, 0))

  let recursionText = feed(fired)
  let steps = 0
  while (maxRecursion > 0 && steps < maxRecursion && pool.length && recursionText.trim()) {
    const passFired = runPass(recursionText, true, steps + 1)
    if (passFired.length === 0) break
    fired.push(...passFired)
    recursionText = feed(passFired)
    steps++
  }

  return fired.sort((a, b) => a.insertion_order - b.insertion_order)
}

export const matchAcross = (
  lorebooks: Lorebook[],
  scanText: string,
  rng: () => number = Math.random,
  maxRecursion = 0
): LorebookEntry[] => {
  const candidates = lorebooks.flatMap((lb) =>
    lb.entries.filter((e) => e.enabled).map((entry) => ({ entry, bookName: lb.name }))
  )
  return runMatchCore(candidates, scanText, rng, maxRecursion, null)
}

/**
 * Side-effect-free diagnostic sibling of `matchAcross` (WP-D2). Same matcher, plus a per-considered-entry
 * trace. `books` carries each lorebook's name so a trace row can name its source. `fired` is byte-identical
 * to `matchAcross` given the same enabled entries, scan text, rng, and recursion depth.
 */
export const matchAcrossTraced = (
  books: Array<{ name: string; lorebook: Lorebook }>,
  scanText: string,
  rng: () => number = Math.random,
  maxRecursion = 0
): { fired: LorebookEntry[]; trace: RetrievalTraceRow[] } => {
  const candidates: MatchCandidate[] = books.flatMap(({ name, lorebook }) =>
    lorebook.entries.filter((e) => e.enabled).map((entry) => ({ entry, bookName: name }))
  )
  const traceMap = new Map<LorebookEntry, TraceOutcome>()
  const fired = runMatchCore(candidates, scanText, rng, maxRecursion, traceMap)
  // Emit rows in candidate (book, then entry) order for a stable, readable viewer.
  const trace: RetrievalTraceRow[] = candidates.map((c) => {
    const o = traceMap.get(c.entry)!
    return {
      bookName: o.bookName,
      ...(o.entryId ? { entryId: o.entryId } : {}),
      comment: o.comment,
      fired: o.fired,
      reason: o.reason,
      ...(o.matchedKey !== undefined ? { matchedKey: o.matchedKey } : {}),
      ...(o.secondaryMatched !== undefined ? { secondaryMatched: o.secondaryMatched } : {}),
      recursionPass: o.recursionPass,
      probability: o.probability,
      ...(o.excludedByRecursionFlag ? { excludedByRecursionFlag: true } : {})
    }
  })
  return { fired, trace }
}

/**
 * Normalize a raw ST world-info / character_book object into our Lorebook shape.
 * Accepts array-style and object-keyed `entries`, mapping ST field aliases. Returns
 * null if there are no usable entries.
 */
export const normalizeLorebookData = (raw: any, fallbackName: string): Lorebook | null => {
  if (!raw) return null
  const rawEntries = Array.isArray(raw.entries) ? raw.entries : Object.values(raw.entries || {})
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) return null

  const entries = rawEntries.map((e: any) => {
    const entry: any = {
      keys: e.keys || e.key || [],
      secondary_keys: e.secondary_keys || e.keysecondary || [],
      content: e.content || '',
      enabled: e.enabled !== false && e.disable !== true,
      insertion_order: e.insertion_order ?? e.order ?? 100,
      // ST world-info position 4 = "at depth"; otherwise our default top placement.
      insertion_depth:
        e.position === 4
          ? typeof e.depth === 'number'
            ? e.depth
            : 4
          : (e.insertion_depth ?? null),
      case_sensitive: e.case_sensitive === true || e.caseSensitive === true,
      constant: e.constant === true,
      selective: e.selective === true,
      probability: typeof e.probability === 'number' ? e.probability : 100,
      exclude_recursion: e.exclude_recursion === true || e.excludeRecursion === true,
      prevent_recursion: e.prevent_recursion === true || e.preventRecursion === true,
      comment: e.comment || e.name || ''
    }

    // Preserve source identity: ST `uid` (or `id`), stringified. Absent → minted on save.
    const srcId = e.uid ?? e.id
    if (srcId !== undefined && srcId !== null && srcId !== '') entry.id = String(srcId)

    // Preserve source metadata the normalizer does not consume, so a future timed/groups WP
    // and lorebook re-export can read it without a re-import.
    const extra: Record<string, any> = {}
    if (e.extensions && typeof e.extensions === 'object' && !Array.isArray(e.extensions)) {
      Object.assign(extra, e.extensions)
    }
    const st: Record<string, any> = {}
    const copyIf = (key: string, ...srcKeys: string[]): void => {
      for (const k of srcKeys) {
        if (e[k] !== undefined) {
          st[key] = e[k]
          return
        }
      }
    }
    copyIf('sticky', 'sticky')
    copyIf('cooldown', 'cooldown')
    copyIf('delay', 'delay')
    copyIf('group', 'group')
    copyIf('groupOverride', 'groupOverride')
    copyIf('groupWeight', 'groupWeight')
    copyIf('useGroupScoring', 'useGroupScoring')
    copyIf('selectiveLogic', 'selectiveLogic')
    copyIf('matchWholeWords', 'matchWholeWords', 'match_whole_words')
    copyIf('scanDepth', 'scanDepth', 'scan_depth')
    copyIf('position', 'position')
    copyIf('depth', 'depth')
    copyIf('role', 'role')
    copyIf('vectorized', 'vectorized')
    copyIf('automationId', 'automationId')
    if (Object.keys(st).length > 0) extra.st_source = st
    if (Object.keys(extra).length > 0) entry.extra = extra

    return entry
  })

  return LorebookSchema.parse({ name: raw.name || fallbackName, entries })
}

/** Import an ST world-info / lorebook JSON file as a new standalone lorebook. */
export const importLorebookFromFile = (
  profileId: string,
  filePath: string
): LorebookSummary | null => {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    const lb = normalizeLorebookData(raw, path.basename(filePath, '.json'))
    if (!lb) return null
    const id = randomUUID()
    saveLorebookById(profileId, id, lb)
    return { id, name: lb.name }
  } catch {
    return null
  }
}

/** Write a lorebook to a JSON file (our native {name, entries} format). */
export const exportLorebookToFile = (profileId: string, id: string, filePath: string): boolean => {
  const lb = getLorebookById(profileId, id)
  if (!lb) return false
  fs.writeFileSync(filePath, JSON.stringify(lb, null, 2), 'utf-8')
  return true
}
