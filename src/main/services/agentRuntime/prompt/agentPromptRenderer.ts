// The template surface is a dynamically typed variable bag (Record<string, any>), matching
// TemplateContext.vars/globals — `any` here mirrors the engine's own typing, not a shortcut.
import { expandMacros } from '../../../../shared/macros'
import { getCharacter } from '../../characterService'
import { getChat } from '../../chatService'
import { log } from '../../logService'
import { getSessionDbByChat } from '../../sessionDbService'
import { getSettings } from '../../settingsService'
import {
  buildTemplateContext,
  evalTemplateDetailed,
  hasTags,
  isEngineReady,
  type TemplateContext
} from '../../templateService'
import { loadGlobals } from '../../templateService'

/**
 * Agent prompt rendering (ADR 0021, slice 2).
 *
 * An `AgentDefinition`'s `prompt` messages are ST-Prompt-Template EJS — the two shipped Agents in
 * `test-agents/` carry 14 and 8 `<%` tags — so sending them verbatim ships the literal tag text to
 * the provider. This module turns a chat scope into a plain `(text) => string` renderer that runs
 * the SAME macro + EJS engines Classic assembly runs, and the Invocation Runtime injects it into the
 * Harness.
 *
 * Why a `(text) => string` seam rather than the Harness calling the engine: ADR 0021 places assembly
 * strictly BEFORE the Harness, so the Harness never becomes the owner of prompt policy. It receives a
 * function and knows nothing about templates, chats, or floors.
 *
 * FAIL-OPEN, ALWAYS. Prompt rendering must never take down a turn, so every failure mode — no engine
 * loaded, a throwing/erroring template, an unreadable floor — returns the caller's RAW text and logs
 * a warning. A degraded prompt is recoverable; a crashed invocation is not.
 *
 * SCOPE: this renders the Agent's OWN prompt messages only. Preset bundles, lorebook selection, and
 * full `assemblePrompt` integration are later slices of the same ADR.
 */

export interface AgentPromptScope {
  profileId: string
  chatId: string
  floor: number
}

/** Renders one authored prompt string. Never throws. */
export type AgentPromptRenderer = (text: string) => string

/** The injected seam the Invocation Runtime consumes; undefined = render nothing for this scope. */
export type AgentPromptRendererPort = (scope: AgentPromptScope) => AgentPromptRenderer | undefined

export interface AgentPromptRendererDeps {
  /** The floor's persisted variable bag. A COPY — build-time `setvar` must not persist here. */
  readFloorVariables(chatId: string, floor: number): Record<string, any>
  readGlobals(profileId: string): Record<string, any>
  /** `{{user}}` / `{{char}}` macro identities for this chat. */
  readNames(profileId: string, chatId: string): { user: string; char: string }
  /** The EJS engine on/off settings toggle. */
  templatesEnabled(profileId: string): boolean
  engineReady(): boolean
  evaluate(text: string, ctx: TemplateContext): { output: string; error: string | null }
  warn(message: string, detail?: unknown): void
}

export const defaultAgentPromptRendererDeps: AgentPromptRendererDeps = {
  readFloorVariables(chatId, floor) {
    const row = getSessionDbByChat(chatId)
      ?.prepare('SELECT variables FROM floors WHERE chat_id = ? AND floor = ?')
      .get(chatId, floor) as { variables: string } | undefined
    if (!row) return {}
    const parsed = JSON.parse(row.variables) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, any>)
      : {}
  },
  readGlobals: loadGlobals,
  readNames(profileId, chatId) {
    const user = getSettings(profileId).persona?.name || 'User'
    const chat = getChat(profileId, chatId)
    const card = chat ? getCharacter(profileId, chat.character_id) : null
    return { user, char: card?.data.name || 'Character' }
  },
  templatesEnabled: (profileId) => getSettings(profileId).templates?.enabled !== false,
  engineReady: isEngineReady,
  evaluate: evalTemplateDetailed,
  // LogLevel has no 'warn' tier; a degraded prompt IS a problem the developer must see in the Logs
  // panel, so it is logged at 'error' while the invocation itself continues.
  warn: (message, detail) => log('error', message, detail)
}

interface ScopeState {
  vars: Record<string, any>
  globals: Record<string, any>
  names: { user: string; char: string }
  enabled: boolean
}

/**
 * Build the Invocation Runtime's prompt-renderer port. Scope state (floor variables, globals, the
 * macro identities) is read ONCE per invocation and lazily — an Agent whose prompt is plain prose
 * touches neither the session DB nor the settings store.
 */
export const createAgentPromptRenderer = (
  deps: AgentPromptRendererDeps = defaultAgentPromptRendererDeps
): AgentPromptRendererPort => {
  return (scope) => {
    let state: ScopeState | null = null
    let stateFailed = false

    const loadState = (): ScopeState | null => {
      if (state || stateFailed) return state
      try {
        state = {
          // Deep-copied: an Agent prompt's `<% setvar %>` is a build-time scratchpad, and letting it
          // write through to the floor's persisted bag would make rendering a state mutation.
          vars: structuredClone(deps.readFloorVariables(scope.chatId, scope.floor)),
          globals: deps.readGlobals(scope.profileId),
          names: deps.readNames(scope.profileId, scope.chatId),
          enabled: deps.templatesEnabled(scope.profileId)
        }
      } catch (cause) {
        stateFailed = true
        deps.warn(
          'Agent prompt context could not be read — prompt sent unrendered',
          cause instanceof Error ? cause.message : String(cause)
        )
      }
      return state
    }

    return (text) => {
      // Fast path: nothing to expand and nothing to evaluate → byte-identical passthrough, and no
      // scope state is loaded at all.
      if (!text || (!text.includes('{{') && !hasTags(text))) return text
      const scopeState = loadState()
      if (!scopeState) return text

      let out = text
      if (out.includes('{{')) {
        try {
          out = expandMacros(out, {
            user: scopeState.names.user,
            char: scopeState.names.char,
            vars: scopeState.vars,
            globals: scopeState.globals
          })
        } catch (cause) {
          deps.warn(
            'Agent prompt macro expansion failed — macros left unexpanded',
            cause instanceof Error ? cause.message : String(cause)
          )
          out = text
        }
      }
      if (!hasTags(out)) return out
      // No engine in this process: the engine's own policy would STRIP the tags, which silently
      // deletes prompt content. Raw text is the honest fallback here.
      if (!deps.engineReady()) {
        deps.warn('Template engine unavailable — Agent prompt sent unrendered')
        return out
      }
      try {
        const result = deps.evaluate(
          out,
          buildTemplateContext(scopeState.vars, {
            globals: scopeState.globals,
            enabled: scopeState.enabled,
            constants: {
              userName: scopeState.names.user,
              charName: scopeState.names.char,
              assistantName: scopeState.names.char,
              chatId: scope.chatId,
              runType: 'agent'
            }
          })
        )
        if (result.error) {
          deps.warn('Agent prompt template failed — prompt sent unrendered', result.error)
          return out
        }
        return result.output
      } catch (cause) {
        deps.warn(
          'Agent prompt template threw — prompt sent unrendered',
          cause instanceof Error ? cause.message : String(cause)
        )
        return out
      }
    }
  }
}
