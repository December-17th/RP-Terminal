import { Settings } from '../types/models'
import { PresetParameters } from '../types/preset'
import { ChatMessage } from './promptBuilder'
import { log } from './logService'

export type DeltaCallback = (delta: string) => void

/** Receives the provider's RAW usage object (shape differs per provider) once known. */
export type UsageCallback = (raw: unknown) => void

/**
 * Stream a completion from the configured provider. Each text chunk is handed to
 * `onDelta` as it arrives; the full concatenated text is returned when done.
 * Generation parameters come from the active preset (preset wins over defaults).
 */
export const streamProvider = async (
  settings: Settings,
  messages: ChatMessage[],
  params: PresetParameters,
  onDelta: DeltaCallback,
  signal?: AbortSignal,
  onUsage?: UsageCallback
): Promise<string> => {
  if (settings.api.provider === 'anthropic') {
    return streamAnthropic(settings, messages, params, onDelta, signal, onUsage)
  }
  if (settings.api.provider === 'google' || settings.api.provider === 'gemini') {
    return streamGemini(settings, messages, params, onDelta, signal, onUsage)
  }
  return streamOpenAICompatible(settings, messages, params, onDelta, signal, onUsage)
}

/**
 * End the conversation on a user message for strict OpenAI-compatible backends that reject a trailing
 * assistant "prefill" — EXCEPT when the preset intends one (the last message is `assistant`), which the
 * model must CONTINUE (e.g. a CoT `[START THINKING]` block). Moving a user turn past such a prefill makes
 * the model ignore it and reason on its own (the English-vs-prompt-directed-thinking bug). Non-OpenAI
 * providers keep their own ordering. Applied in generationService BEFORE the request is logged, so the
 * logged/stored prompt matches exactly what's sent.
 */
export const orderForProvider = (messages: ChatMessage[], provider?: string): ChatMessage[] => {
  if (provider === 'anthropic' || provider === 'google' || provider === 'gemini') return messages
  if (messages[messages.length - 1]?.role === 'assistant') return messages // keep the trailing prefill last
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user')
  if (lastUserIdx === -1 || lastUserIdx === messages.length - 1) return messages
  return [
    ...messages.slice(0, lastUserIdx),
    ...messages.slice(lastUserIdx + 1),
    messages[lastUserIdx]
  ]
}

/**
 * List the models available at the configured provider (GET /models), mirroring the auth each
 * provider uses for generation: OpenAI-compatible (openai/openrouter/custom) → `data[].id` with a
 * Bearer key; Anthropic → `data[].id` with x-api-key; Google → `models[].name` (sans the "models/"
 * prefix) with x-goog-api-key. Used by the API settings tab's "Fetch models" button. Throws on a
 * non-OK response so the renderer can surface the error.
 */
export const listModels = async (api: Settings['api']): Promise<string[]> => {
  const key = api.api_key || ''
  const collect = (rows: unknown, field: 'id' | 'name'): string[] =>
    (Array.isArray(rows) ? rows : [])
      .map((m) => (m as Record<string, unknown>)?.[field])
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
  const fail = async (r: Response): Promise<never> => {
    throw new Error(`models ${r.status}: ${(await r.text()).slice(0, 200)}`)
  }

  if (api.provider === 'anthropic') {
    const base = (api.endpoint || 'https://api.anthropic.com/v1').replace(/\/$/, '')
    const r = await fetch(`${base}/models?limit=1000`, {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    })
    if (!r.ok) return fail(r)
    return collect(((await r.json()) as { data?: unknown }).data, 'id')
  }
  if (api.provider === 'google' || api.provider === 'gemini') {
    const base = (api.endpoint || 'https://generativelanguage.googleapis.com/v1beta').replace(
      /\/$/,
      ''
    )
    const r = await fetch(`${base}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key } })
    if (!r.ok) return fail(r)
    return collect(((await r.json()) as { models?: unknown }).models, 'name').map((n) =>
      n.replace(/^models\//, '')
    )
  }
  const base = (api.endpoint || 'https://api.openai.com/v1').replace(/\/$/, '')
  const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } })
  if (!r.ok) return fail(r)
  return collect(((await r.json()) as { data?: unknown }).data, 'id')
}

// Drop undefined params so we don't send nulls to providers that reject them.
const cleanParams = (params: PresetParameters): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

/**
 * Read an SSE body line by line, handing each `data:` payload (minus the prefix)
 * to `handle`. Buffers partial lines across chunks. `[DONE]` is filtered out.
 */
const readSse = async (response: Response, handle: (data: string) => void): Promise<void> => {
  if (!response.body) throw new Error('No response body to stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? '' // keep the trailing partial line
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data && data !== '[DONE]') handle(data)
    }
  }
}

/**
 * Reasoning models stream their chain-of-thought on a SEPARATE channel (OpenAI-compatible
 * `delta.reasoning_content` / `delta.reasoning`, Anthropic `thinking` blocks, Gemini `thought` parts)
 * rather than inside the message content. This assembler inlines that reasoning as a single leading
 * `<think>…</think>` block so it lands in the lossless store + the reasoning view exactly like models
 * that emit `<think>` in the content directly. It also feeds `onDelta` so the live view streams it.
 */
type ThinkAssembler = {
  reasoning: (c: string) => void
  content: (c: string) => void
  done: () => string
}
export const thinkAssembler = (onDelta: DeltaCallback): ThinkAssembler => {
  let full = ''
  let open = false
  const push = (s: string): void => {
    full += s
    onDelta(s)
  }
  return {
    reasoning: (c) => {
      if (!c) return
      if (!open) {
        push('<think>')
        open = true
      }
      push(c)
    },
    content: (c) => {
      if (!c) return
      if (open) {
        push('</think>\n\n')
        open = false
      }
      push(c)
    },
    done: () => {
      if (open) {
        push('</think>')
        open = false
      }
      return full
    }
  }
}

const streamOpenAICompatible = async (
  settings: Settings,
  messages: ChatMessage[],
  params: PresetParameters,
  onDelta: DeltaCallback,
  signal?: AbortSignal,
  onUsage?: UsageCallback
): Promise<string> => {
  const { endpoint, api_key, model } = settings.api
  const base = endpoint || 'https://api.openai.com/v1'
  const url = base.endsWith('/chat/completions')
    ? base
    : `${base.replace(/\/$/, '')}/chat/completions`

  // Message ordering (end-on-user vs preserving a trailing assistant prefill) is decided upstream in
  // generationService via orderForProvider, BEFORE the request is logged — so the log matches what's sent.
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${api_key}`
    },
    body: JSON.stringify({
      model,
      messages,
      ...cleanParams(params),
      stream: true,
      stream_options: { include_usage: true }
    }),
    signal
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`API Error: ${response.status} ${response.statusText} - ${errorText}`)
  }

  // Some OpenAI-compatible proxies ignore stream:true and return a normal JSON
  // completion. Fall back to parsing that instead of silently yielding nothing.
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('text/event-stream')) {
    const text = await response.text()
    let content = ''
    let reasoning = ''
    try {
      const json = JSON.parse(text)
      const msg = json.choices?.[0]?.message
      content = msg?.content ?? json.choices?.[0]?.text ?? ''
      reasoning = msg?.reasoning_content ?? msg?.reasoning ?? ''
    } catch {
      throw new Error(`Non-streaming response was not valid JSON: ${text.slice(0, 800)}`)
    }
    if (!content && !reasoning)
      throw new Error(`Provider returned an empty completion: ${text.slice(0, 800)}`)
    const out = reasoning ? `<think>${reasoning}</think>\n\n${content}` : content
    onDelta(out)
    return out
  }

  const asm = thinkAssembler(onDelta)
  let usage: any = null
  const rawFrames: string[] = []
  try {
    await readSse(response, (data) => {
      rawFrames.push(data)
      try {
        const json = JSON.parse(data)
        if (json.usage) usage = json.usage
        const d = json.choices?.[0]?.delta
        const rc = d?.reasoning_content ?? d?.reasoning // DeepSeek / OpenRouter side channel
        if (typeof rc === 'string') asm.reasoning(rc)
        if (typeof d?.content === 'string') asm.content(d.content)
      } catch {
        // ignore keep-alive / non-JSON lines
      }
    })
  } catch (e) {
    if (signal?.aborted) return asm.done() // user stopped — keep whatever streamed
    throw e
  }
  const full = asm.done()
  if (!full && !signal?.aborted) {
    throw new Error(
      `Stream produced no text. Raw frames:\n${rawFrames.slice(0, 8).join('\n').slice(0, 800) || '(none)'}`
    )
  }
  if (usage) onUsage?.(usage)
  return full
}

/**
 * Build the Anthropic `system` + `messages` payload with (or without) prompt-cache breakpoints.
 *
 * Prompt caching (Phase G): cache_control breakpoints mark the end of a stable prefix (max 4/request,
 * ephemeral = 5-min TTL). Two breakpoints — the system block (static per session) and the last message
 * before the new user turn (caches the history prefix); the volatile final user turn stays past the last
 * breakpoint so it never invalidates the cached head. Prefixes below the model's min-cacheable size are
 * skipped by the provider, silently.
 *
 * `cacheOn=false` (the stashed `baseline` mode) omits cache_control entirely — NO provider-side prompt
 * caching, a clean reference control. Pure + exported for testing. See docs/prompt-cache-optimization-design.md.
 */
export const buildAnthropicCacheLayout = (
  merged: ChatMessage[],
  systemPrompt: string,
  cacheOn: boolean
): { system: unknown; outMessages: unknown[] } => {
  const EPHEMERAL = { type: 'ephemeral' as const }
  const sys = systemPrompt.trim()
  const system = sys
    ? cacheOn
      ? [{ type: 'text', text: sys, cache_control: EPHEMERAL }]
      : sys
    : undefined
  if (!cacheOn) return { system, outMessages: merged }
  const cacheIdx = merged.length - 2 // message just before the final user turn
  const outMessages = merged.map((m, i) =>
    i === cacheIdx
      ? { role: m.role, content: [{ type: 'text', text: m.content, cache_control: EPHEMERAL }] }
      : m
  )
  return { system, outMessages }
}

const streamAnthropic = async (
  settings: Settings,
  messages: ChatMessage[],
  params: PresetParameters,
  onDelta: DeltaCallback,
  signal?: AbortSignal,
  onUsage?: UsageCallback
): Promise<string> => {
  const { endpoint, api_key, model } = settings.api
  const base = endpoint || 'https://api.anthropic.com/v1'
  const url = base.endsWith('/messages') ? base : `${base.replace(/\/$/, '')}/messages`

  // Anthropic takes the system prompt at the top level and requires alternating
  // user/assistant roles. Hoist only the LEADING system run (the static system
  // prefix) into the top-level system param; a system message that appears AFTER
  // the conversation has begun is a positional injection (e.g. a depth-placed
  // lorebook/persona block) — Anthropic has no inline system role, so keep it
  // where it sits by demoting it to a user turn (same-role merge folds it in).
  let systemPrompt = ''
  let convoStarted = false
  const convo: ChatMessage[] = []
  for (const m of messages) {
    if (m.role === 'system' && !convoStarted) {
      systemPrompt += m.content + '\n'
      continue
    }
    convoStarted = true
    convo.push(m.role === 'system' ? { role: 'user', content: m.content } : m)
  }

  const merged: ChatMessage[] = []
  for (const msg of convo) {
    const last = merged[merged.length - 1]
    if (last && last.role === msg.role) {
      last.content += '\n\n' + msg.content
    } else {
      merged.push({ ...msg })
    }
  }

  // `baseline` mode (the stashed default) omits provider prompt caching entirely. Otherwise apply the
  // Anthropic cache_control breakpoints. Extracted to a pure helper so the baseline behavior is testable.
  const { system, outMessages } = buildAnthropicCacheLayout(
    merged,
    systemPrompt,
    settings.cache?.mode !== 'baseline'
  )

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': api_key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model || 'claude-opus-4-8',
      system,
      messages: outMessages,
      max_tokens: params.max_tokens ?? 4000,
      temperature: params.temperature ?? 0.9,
      ...(params.top_p !== undefined ? { top_p: params.top_p } : {}),
      ...(params.top_k !== undefined ? { top_k: params.top_k } : {}),
      stream: true
    }),
    signal
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Anthropic API Error: ${response.status} ${response.statusText} - ${errorText}`)
  }

  const asm = thinkAssembler(onDelta)
  let usage: any = null
  try {
    await readSse(response, (data) => {
      try {
        const json = JSON.parse(data)
        if (json.type === 'message_start' && json.message?.usage) usage = json.message.usage
        // content_block_delta carries incremental thinking_delta (extended thinking) + text_delta chunks.
        if (json.type === 'content_block_delta') {
          if (typeof json.delta?.thinking === 'string') asm.reasoning(json.delta.thinking)
          else if (typeof json.delta?.text === 'string') asm.content(json.delta.text)
        }
      } catch {
        // ignore non-JSON lines
      }
    })
  } catch (e) {
    if (signal?.aborted) return asm.done() // user stopped — keep whatever streamed
    throw e
  }
  const full = asm.done()
  if (usage) {
    log(
      'info',
      `cache — read ${usage.cache_read_input_tokens ?? 0} · write ${usage.cache_creation_input_tokens ?? 0} · fresh ${usage.input_tokens ?? 0} tok`
    )
  }
  if (usage) onUsage?.(usage)
  return full
}

/**
 * Build a Gemini request body from our provider-neutral messages + params. Gemini
 * differs from OpenAI/Anthropic: the system prompt is a top-level `systemInstruction`,
 * the assistant role is `model`, turns carry `parts: [{ text }]`, and sampler knobs
 * live under camelCase `generationConfig`. The LEADING system run is hoisted into
 * `systemInstruction`; a system message that appears AFTER the conversation begins is
 * a positional injection (depth-placed lore/persona) — Gemini has no inline system
 * role, so it is demoted to a user turn. Consecutive same-role turns are merged
 * (Gemini requires alternation). Exported pure for unit testing.
 */
export const buildGeminiBody = (
  messages: ChatMessage[],
  params: PresetParameters
): Record<string, unknown> => {
  let systemText = ''
  let convoStarted = false
  const convo: Array<{ role: 'user' | 'model'; text: string }> = []
  for (const m of messages) {
    if (m.role === 'system' && !convoStarted) {
      systemText += m.content + '\n'
      continue
    }
    convoStarted = true
    convo.push({ role: m.role === 'assistant' ? 'model' : 'user', text: m.content })
  }

  const merged: Array<{ role: 'user' | 'model'; text: string }> = []
  for (const c of convo) {
    const last = merged[merged.length - 1]
    if (last && last.role === c.role) last.text += '\n\n' + c.text
    else merged.push({ ...c })
  }
  const contents = merged.map((c) => ({ role: c.role, parts: [{ text: c.text }] }))

  // Map our sampler params onto Gemini's camelCase generationConfig (it ignores the rest).
  const generationConfig: Record<string, unknown> = {}
  if (params.temperature !== undefined) generationConfig.temperature = params.temperature
  if (params.max_tokens !== undefined) generationConfig.maxOutputTokens = params.max_tokens
  if (params.top_p !== undefined) generationConfig.topP = params.top_p
  if (params.top_k !== undefined) generationConfig.topK = params.top_k
  if (params.frequency_penalty !== undefined)
    generationConfig.frequencyPenalty = params.frequency_penalty
  if (params.presence_penalty !== undefined)
    generationConfig.presencePenalty = params.presence_penalty

  const body: Record<string, unknown> = { contents, generationConfig }
  if (systemText.trim()) body.systemInstruction = { parts: [{ text: systemText.trim() }] }
  return body
}

/**
 * Stream from Google's Gemini (Generative Language) API. The model name goes in the
 * URL path; `?alt=sse` yields a `data:`-framed event stream that `readSse` can read.
 */
const streamGemini = async (
  settings: Settings,
  messages: ChatMessage[],
  params: PresetParameters,
  onDelta: DeltaCallback,
  signal?: AbortSignal,
  onUsage?: UsageCallback
): Promise<string> => {
  const { endpoint, api_key, model } = settings.api
  const base = (endpoint || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '')
  const modelName = model || 'gemini-2.5-flash'
  const url = `${base}/models/${encodeURIComponent(modelName)}:streamGenerateContent?alt=sse`

  const body = buildGeminiBody(messages, params)

  const response = await fetch(url, {
    method: 'POST',
    // Key via header (not the ?key= query param) so it never lands in a logged URL.
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': api_key },
    body: JSON.stringify(body),
    signal
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Gemini API Error: ${response.status} ${response.statusText} - ${errorText}`)
  }

  const asm = thinkAssembler(onDelta)
  let usage: any = null
  try {
    await readSse(response, (data) => {
      try {
        const json = JSON.parse(data)
        const parts = json.candidates?.[0]?.content?.parts
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (typeof p?.text === 'string' && p.text) {
              // Gemini "thinking" models flag reasoning parts with thought === true.
              if (p.thought === true) asm.reasoning(p.text)
              else asm.content(p.text)
            }
          }
        }
        if (json.usageMetadata) usage = json.usageMetadata
      } catch {
        // ignore keep-alive / non-JSON lines
      }
    })
  } catch (e) {
    if (signal?.aborted) return asm.done() // user stopped — keep whatever streamed
    throw e
  }
  const full = asm.done()
  if (usage) {
    log(
      'info',
      `gemini — prompt ${usage.promptTokenCount ?? 0} · output ${usage.candidatesTokenCount ?? 0} · cached ${usage.cachedContentTokenCount ?? 0} tok`
    )
  }
  if (usage) onUsage?.(usage)
  if (!full && !signal?.aborted) {
    throw new Error('Gemini stream produced no text')
  }
  return full
}
