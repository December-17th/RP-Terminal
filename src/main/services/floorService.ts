import { getDb } from './db'
import { FloorFile } from '../types/chat'
import { normalizeSwipes, selectSwipe, appendSwipe } from './swipeHelpers'
import { withLock } from './asyncLock'

/** Per-chat floor-variable write lock key (agent-packs WP1.5; ADR 0003). Floors are keyed by
 *  `chat_id` in SQLite (PRIMARY KEY (chat_id, floor)), so a chat is the write-serialization scope —
 *  the same granularity every floor-var writer (vars.save floor scope, the MVU write-back bridge, the
 *  Variables-view editor, swipe/regenerate) shares. */
const varsLockKey = (chatId: string): string => `vars:${chatId}`

interface FloorRow {
  floor: number
  chat_id: string
  timestamp: string
  user_content: string
  user_timestamp: string | null
  response_content: string
  response_model: string | null
  response_provider: string | null
  swipes: string | null
  swipe_id: number | null
  events: string
  variables: string
  request: string | null
  metrics: string | null
  plot_block: string | null
}

const rowToFloor = (r: FloorRow): FloorFile => {
  const stored = r.swipes ? safeJson<string[] | null>(r.swipes, null) : null
  const swipe = normalizeSwipes(stored, r.response_content, r.swipe_id)
  return {
    floor: r.floor,
    chat_id: r.chat_id,
    timestamp: r.timestamp,
    user_message: { content: r.user_content, timestamp: r.user_timestamp || r.timestamp },
    response: {
      content: r.response_content,
      model: r.response_model || '',
      provider: r.response_provider || ''
    },
    swipes: swipe.swipes,
    swipe_id: swipe.swipe_id,
    events: safeJson(r.events, []),
    variables: safeJson(r.variables, {}),
    request: r.request ? safeJson(r.request, undefined) : undefined,
    metrics: r.metrics ? safeJson(r.metrics, undefined) : undefined,
    // Display-only plot-recall directive; a plain string column (present only when recall emitted one).
    ...(r.plot_block ? { plot_block: r.plot_block } : {})
  }
}

export const getFloor = (
  _profileId: string,
  chatId: string,
  floorIndex: number
): FloorFile | null => {
  const row = getDb()
    .prepare('SELECT * FROM floors WHERE chat_id = ? AND floor = ?')
    .get(chatId, floorIndex) as FloorRow | undefined
  return row ? rowToFloor(row) : null
}

export const getAllFloors = (_profileId: string, chatId: string, _count?: number): FloorFile[] => {
  const rows = getDb()
    .prepare('SELECT * FROM floors WHERE chat_id = ? ORDER BY floor')
    .all(chatId) as FloorRow[]
  return rows.map(rowToFloor)
}

/** The actual floor INSERT/UPSERT (synchronous). Wrapped by `saveFloor` under the per-chat vars
 *  lock so concurrent engine runs can't lose a floor-variable write (ADR 0003). */
const saveFloorRow = (chatId: string, floor: FloorFile): void => {
  getDb()
    .prepare(
      `INSERT INTO floors
        (chat_id, floor, timestamp, user_content, user_timestamp, response_content,
         response_model, response_provider, swipes, swipe_id, events, variables, request, metrics,
         plot_block)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, floor) DO UPDATE SET
         timestamp = excluded.timestamp,
         user_content = excluded.user_content,
         user_timestamp = excluded.user_timestamp,
         response_content = excluded.response_content,
         response_model = excluded.response_model,
         response_provider = excluded.response_provider,
         swipes = excluded.swipes,
         swipe_id = excluded.swipe_id,
         events = excluded.events,
         variables = excluded.variables,
         request = excluded.request,
         metrics = excluded.metrics,
         plot_block = excluded.plot_block`
    )
    .run(
      chatId,
      floor.floor,
      floor.timestamp || new Date().toISOString(),
      floor.user_message?.content ?? '',
      floor.user_message?.timestamp ?? null,
      floor.response?.content ?? '',
      floor.response?.model ?? null,
      floor.response?.provider ?? null,
      // Only persist swipes once there's more than one; single-swipe floors stay null
      // (legacy-compatible) and normalize back to [response] on read.
      floor.swipes && floor.swipes.length > 1 ? JSON.stringify(floor.swipes) : null,
      floor.swipe_id ?? null,
      JSON.stringify(floor.events ?? []),
      JSON.stringify(floor.variables ?? {}),
      floor.request ? JSON.stringify(floor.request) : null,
      floor.metrics ? JSON.stringify(floor.metrics) : null,
      floor.plot_block ?? null
    )
}

/**
 * Persist ONE floor (insert or upsert). Serialized per chat through the async vars lock (WP1.5 /
 * ADR 0003): a single writer runs SYNCHRONOUSLY (the lock's fast path — same behavior as before),
 * so every existing synchronous caller (`setFloorStatData`, `reevaluateVariables`, swipe/regenerate,
 * the MVU write-back bridge, the Variables-view editor) is unaffected; only genuinely concurrent
 * writers (a headless run vs. a turn, once WP2.2 lands) are queued in submission order so neither
 * loses its write. `withLock`'s returned promise is intentionally not awaited here — the row is
 * written on the synchronous fast path, and this keeps `saveFloor`'s `void` (synchronous) contract
 * that ~20 call sites rely on. A caller that must serialize a read-modify-write ACROSS an `await`
 * (the headless runner) wraps its own critical section in `withLock(varsLockKey(chatId), …)`.
 */
export const saveFloor = (_profileId: string, chatId: string, floor: FloorFile): void => {
  void withLock(varsLockKey(chatId), () => saveFloorRow(chatId, floor))
}

/** The per-chat floor-variable write-lock key, exported so the headless runner (WP2.2) and any other
 *  async read-modify-write of floor variables can wrap its whole critical section on the SAME key
 *  `saveFloor` serializes on. */
export { varsLockKey }

/** Switch a floor's active swipe; keeps response.content in sync. Returns the updated floor. */
export const setActiveSwipe = (
  profileId: string,
  chatId: string,
  floorIndex: number,
  swipeId: number
): FloorFile | null => {
  const floor = getFloor(profileId, chatId, floorIndex)
  if (!floor) return null
  const state = normalizeSwipes(floor.swipes, floor.response.content, floor.swipe_id)
  const { swipe_id, content } = selectSwipe(state, swipeId)
  floor.swipes = state.swipes
  floor.swipe_id = swipe_id
  floor.response.content = content
  saveFloor(profileId, chatId, floor)
  return floor
}

/** Append a new alternate response to a floor, making it the active swipe. */
export const addSwipe = (
  profileId: string,
  chatId: string,
  floorIndex: number,
  content: string
): FloorFile | null => {
  const floor = getFloor(profileId, chatId, floorIndex)
  if (!floor) return null
  const state = appendSwipe(
    normalizeSwipes(floor.swipes, floor.response.content, floor.swipe_id),
    content
  )
  floor.swipes = state.swipes
  floor.swipe_id = state.swipe_id
  floor.response.content = content
  saveFloor(profileId, chatId, floor)
  return floor
}

/** Edit a stored floor's text in place (user message and/or AI response). */
export const updateFloorFields = (
  _profileId: string,
  chatId: string,
  floorIndex: number,
  userContent: string | null,
  responseContent: string | null
): void => {
  const db = getDb()
  if (userContent !== null) {
    db.prepare('UPDATE floors SET user_content = ? WHERE chat_id = ? AND floor = ?').run(
      userContent,
      chatId,
      floorIndex
    )
  }
  if (responseContent !== null) {
    db.prepare('UPDATE floors SET response_content = ? WHERE chat_id = ? AND floor = ?').run(
      responseContent,
      chatId,
      floorIndex
    )
  }
}

export const deleteFloorAndSubsequent = (
  _profileId: string,
  chatId: string,
  fromFloorIndex: number
): void => {
  getDb().prepare('DELETE FROM floors WHERE chat_id = ? AND floor >= ?').run(chatId, fromFloorIndex)
}

const safeJson = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}
