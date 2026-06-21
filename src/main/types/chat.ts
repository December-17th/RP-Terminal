/** Manual FSM mode for a session (Phase H). Each mode tunes generation + retrieval. */
export type ChatMode = 'explore' | 'dialogue' | 'combat'
export const CHAT_MODES: ChatMode[] = ['explore', 'dialogue', 'combat']

export interface FloorIndexEntry {
  floor: number
  timestamp: string
  user_preview: string
  response_preview: string
}

export interface ChatSession {
  id: string
  character_id: string
  created_at: string
  updated_at: string
  floor_count: number
  floor_index: FloorIndexEntry[]
  /** Active lorebook ids for this session; null = default to the character's own lorebook. */
  lorebook_ids: string[] | null
}

export interface FloorFile {
  floor: number
  chat_id: string
  timestamp: string
  user_message: {
    content: string
    timestamp: string
  }
  response: {
    content: string
    model: string
    provider: string
  }
  /** Alternate responses for this floor (TH swipes). swipes[swipe_id] === response.content;
   * absent/empty ⇒ a single-swipe floor (legacy). */
  swipes?: string[]
  /** Index of the active swipe within `swipes`. */
  swipe_id?: number
  /** State events extracted from this floor's response (rpt-event tags). */
  events: Array<{ type: string; path: string; value: unknown; action: string }>
  /** Cumulative game state after applying this floor's events. */
  variables: Record<string, unknown>
}
