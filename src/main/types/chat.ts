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
  /** State events extracted from this floor's response (rpt-event tags). */
  events: Array<{ type: string; path: string; value: unknown; action: string }>
  /** Cumulative game state after applying this floor's events. */
  variables: Record<string, unknown>
}
