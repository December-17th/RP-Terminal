import type {
  AgentDefinition,
  AgentPromptOrigin,
  EffectiveInvocationOptions,
  JsonValue,
  PromptMessage
} from '../../../../shared/agentRuntime'
import type { ProviderMessage } from '../provider'
import type { HarnessExecuteRequest, HarnessFailure } from './types'

export type BuildAttemptLogResult =
  | {
      ok: true
      immutablePrefix: ProviderMessage[]
      attemptLog: ProviderMessage[]
      /** Coarse origin per message, aligned to the concatenated `[...immutablePrefix, ...attemptLog]`
       *  order — NOT push order (D3). Length equals prefix.length + log.length. */
      origins: AgentPromptOrigin[]
    }
  | { ok: false; failure: HarnessFailure }

/**
 * Apply the injected prompt renderer, guarding the Harness against a renderer that throws or returns
 * a non-string. Prompt rendering must never take down an invocation (ADR 0021), so every failure
 * degrades to the authored text.
 */
const renderText = (text: string, render: ((text: string) => string) | undefined): string => {
  if (!render) return text
  try {
    const rendered = render(text)
    return typeof rendered === 'string' ? rendered : text
  } catch {
    return text
  }
}

const resolvePromptMessage = (
  message: PromptMessage,
  request: HarnessExecuteRequest,
  render: ((text: string) => string) | undefined
): { ok: true; content: string } | { ok: false; binding: string } => {
  const chunks: string[] = []
  for (const segment of message.content) {
    if (segment.type === 'text') {
      // ADR 0021: the AUTHORED text evaluates through the injected renderer (ST-Prompt-Template EJS
      // + macros). Bound values below deliberately do NOT — upstream data must never become
      // executable template code. Fail-open: a renderer that throws yields the raw text.
      chunks.push(renderText(segment.text, render))
      continue
    }
    const source = segment.source
    let value: JsonValue | undefined
    let key: string = source.type
    if (source.type === 'input') value = request.input
    else if (source.type === 'history') value = request.history
    else {
      key = source.path
      value = request.promptValues?.[source.path]
    }
    if (value === undefined) value = segment.default
    if (value === undefined) return { ok: false, binding: key }
    chunks.push(typeof value === 'string' ? value : JSON.stringify(value))
  }
  return { ok: true, content: chunks.join('') }
}

export const buildAttemptLog = (
  definition: AgentDefinition,
  request: HarnessExecuteRequest,
  options: EffectiveInvocationOptions,
  policy: string
): BuildAttemptLogResult => {
  const immutablePrefix: ProviderMessage[] = [{ role: 'system', content: policy }]
  const attemptLog: ProviderMessage[] = []
  // Origins tracked separately per array so the concatenated result aligns to `[...prefix, ...log]`,
  // not push order (D3). The policy line is the first — and, on the assembled path, only — prefix entry.
  const prefixOrigins: AgentPromptOrigin[] = ['harness-policy']
  const logOrigins: AgentPromptOrigin[] = []
  let volatile = false
  // ADR 0021: an upstream-assembled prompt SUBSTITUTES for the definition's own messages. It already
  // ends with those messages (the preset assembles context, `prompt` is the task instruction), so
  // nothing is lost by not reading `definition.prompt` here.
  //
  // An assembled prompt is also never re-rendered: the assembler already ran the engine over it, and
  // a second pass would treat card/lore/history CONTENT as template code. Enforced structurally here
  // rather than left to the caller to remember.
  const fromAssembledPrompt = request.prompt !== undefined
  const render = fromAssembledPrompt ? undefined : request.render
  for (const prompt of request.prompt ?? definition.prompt) {
    const rendered = resolvePromptMessage(prompt, request, render)
    if (!rendered.ok) {
      return {
        ok: false,
        failure: {
          code: 'PROMPT_BINDING_MISSING',
          message: `Prompt Binding "${rendered.binding}" is unavailable`,
          retryable: false
        }
      }
    }
    // VOLATILITY BOUNDARY (ADR 0021 + Microscope-lite D1). A message is volatile — excluded from the
    // reuse-safe immutable prefix — when ANY of:
    //   (a) it has a `binding` segment (bound values read mutable state);
    //   (b) `render` is active AND an authored text segment contains template syntax (`<%`/`{{`), since
    //       templated text evaluates `getvar`/macros against mutable state at render time. `render`
    //       absent ⇒ text is used verbatim, so it is stable and stays in the prefix;
    //   (c) it was SUBSTITUTED from `request.prompt` — the assembled stack embeds per-floor state
    //       (history, lorebook activation), so every substituted message is volatile and only the
    //       harness policy line remains reusable.
    // The flag is sticky, so the split stays a single clean cut: dispatch concatenates
    // `[...immutablePrefix, ...attemptLog]`, so the wire bytes are identical to before — only the split
    // point moves. Cross-call prefix reuse (agent-runtime-design.md §229-236) is still UNIMPLEMENTED;
    // this boundary is now truthful so that reuse, and today's visualization, no longer misclassify
    // templated or assembled messages as immutable.
    const templated =
      render !== undefined &&
      prompt.content.some(
        (segment) =>
          segment.type === 'text' &&
          (segment.text.includes('<%') || segment.text.includes('{{'))
      )
    volatile ||=
      fromAssembledPrompt ||
      templated ||
      prompt.content.some((segment) => segment.type === 'binding')
    const origin: AgentPromptOrigin = fromAssembledPrompt ? 'assembled-preset' : 'agent-prompt'
    if (volatile) {
      attemptLog.push({ role: prompt.role, content: rendered.content })
      logOrigins.push(origin)
    } else {
      immutablePrefix.push({ role: prompt.role, content: rendered.content })
      prefixOrigins.push(origin)
    }
  }
  attemptLog.push({ role: 'user', content: JSON.stringify(request.input) })
  logOrigins.push('input')
  if (options.addendum) {
    attemptLog.push({ role: 'user', content: options.addendum })
    logOrigins.push('addendum')
  }
  return { ok: true, immutablePrefix, attemptLog, origins: [...prefixOrigins, ...logOrigins] }
}
