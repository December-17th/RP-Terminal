export interface ChatSession {
  id: string;
  character_id: string;
  created_at: string;
  updated_at: string;
  floor_count: number;
  floor_index: Array<{
    floor: number;
    timestamp: string;
    user_preview: string;
    response_preview: string;
  }>;
}

export interface FloorFile {
  floor: number;
  chat_id: string;
  timestamp: string;
  user_message: {
    content: string;
    timestamp: string;
  };
  response: {
    content: string;
    model: string;
    provider: string;
    tokens: {
      prompt: number;
      completion: number;
    };
    generation_settings: Record<string, unknown>;
    swipes?: string[];
    active_swipe: number;
  };
  prompt_context: {
    messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string;
    }>;
    lorebook_injections: string[];
  };
  variables: Record<string, any>;
}
