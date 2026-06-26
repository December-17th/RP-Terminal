import { getSettings } from './settingsService'

/**
 * Embeddings for vector / hybrid recall (docs/episodic-memory-design.md §6, T4 = brute-force JS).
 * Vectors come from the user-configured embedding connection (`memory.embedding_api_preset_id`,
 * OpenAI-compatible `/embeddings`); cosine similarity is computed in JS over a chat's memories. With
 * no embedding preset configured, `utilityEmbed` returns null and recall stays keyword-only.
 */

export interface EmbedResult {
  /** The embedding model id (stored per row to invalidate on a model/dim change). */
  model: string
  vectors: number[][]
}

/** Embed `texts` via the configured embedding connection, or null if none is set. */
export const utilityEmbed = async (
  profileId: string,
  texts: string[]
): Promise<EmbedResult | null> => {
  const settings = getSettings(profileId)
  const id = settings.memory?.embedding_api_preset_id
  const conn = id ? settings.api_presets.find((p) => p.id === id) : undefined
  if (!conn) return null // vector recall is disabled without an embedding connection
  if (!texts.length) return { model: conn.model, vectors: [] }

  const endpoint = conn.endpoint.replace(/\/+$/, '')
  const res = await fetch(`${endpoint}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(conn.api_key ? { Authorization: `Bearer ${conn.api_key}` } : {})
    },
    body: JSON.stringify({ model: conn.model, input: texts })
  })
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`)
  const json = (await res.json()) as { data?: { embedding: number[] }[] }
  return { model: conn.model, vectors: (json.data ?? []).map((d) => d.embedding) }
}

/** Cosine similarity of two equal-length vectors (0 if empty or mismatched length). Pure. */
export const cosine = (a: number[], b: number[]): number => {
  if (!a.length || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}
