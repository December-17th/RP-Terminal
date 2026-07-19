import type {
  ProviderAdapterEvent,
  ScriptedProviderStep
} from '../../../src/main/services/agentRuntime/provider'

const events = (...items: ProviderAdapterEvent[]): ScriptedProviderStep => ({ events: items })

export const SCRIPTED_TEXT = events(
  { type: 'text-delta', delta: 'Done.' },
  { type: 'finish', reason: 'stop' }
)

export const SCRIPTED_REASONING = events(
  { type: 'reasoning-delta', delta: 'private chain' },
  { type: 'text-delta', delta: 'Visible.' },
  { type: 'finish', reason: 'stop' }
)

export const SCRIPTED_FRAGMENTED_TOOL_CALL = events(
  { type: 'reasoning-delta', delta: 'private chain' },
  {
    type: 'tool-call-delta',
    index: 0,
    id: 'call_weather',
    name: 'weather',
    argumentsDelta: '{"city":"Tor'
  },
  {
    type: 'tool-call-delta',
    index: 1,
    id: 'call_time',
    name: 'time',
    argumentsDelta: '{"zone":"UTC"}'
  },
  { type: 'tool-call-delta', index: 0, argumentsDelta: 'onto"}' },
  { type: 'finish', reason: 'tool-calls' }
)

export const SCRIPTED_USAGE = events(
  {
    type: 'usage',
    usage: { inputTokens: 20, outputTokens: 5 },
    cache: { readTokens: 12, writeTokens: 3 },
    raw: { provider: 'shape' }
  },
  { type: 'finish', reason: 'stop' }
)

export const SCRIPTED_RATE_LIMIT = events(
  {
    type: 'rate-limit',
    rateLimit: {
      requestsLimit: 100,
      requestsRemaining: 42,
      resetAfterMs: 1500,
      retryAfterMs: 2500
    }
  },
  { type: 'finish', reason: 'stop' }
)

export const SCRIPTED_MALFORMED_ARGUMENTS = events(
  {
    type: 'tool-call-delta',
    index: 0,
    id: 'call_broken',
    name: 'lookup',
    argumentsDelta: '{"id":'
  },
  { type: 'finish', reason: 'tool-calls' }
)

export const SCRIPTED_TRUNCATION = events(
  { type: 'text-delta', delta: '{"summary":"unfinished' },
  { type: 'finish', reason: 'length' }
)
