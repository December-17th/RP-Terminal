import { RPTerminalCard } from '../types/character'
import { Preset } from '../types/preset'
import { FloorFile } from '../types/chat'
import { Lorebook } from '../types/character'
import { matchEntries } from './lorebookService'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface BuildPromptArgs {
  card: RPTerminalCard
  preset: Preset
  lorebook: Lorebook | null
  floors: FloorFile[]
  userAction: string
  userName?: string
}

/**
 * Expand the handful of macros we support and strip ST-Prompt-Template control
 * blocks (`<% ... %>`). A real EJS-style template engine is a planned follow-up;
 * until then we strip the syntax so it never leaks into the prompt.
 */
const expandMacros = (text: string, charName: string, userName: string): string => {
  if (!text) return ''
  return text
    .replace(/\{\{char\}\}/gi, charName)
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/<%[\s\S]*?%>/g, '')
    .trim()
}

const buildCharDescription = (card: RPTerminalCard, charName: string, userName: string): string => {
  const d = card.data
  const parts: string[] = [`Name: ${charName}`]
  if (d.description) parts.push(`Description: ${expandMacros(d.description, charName, userName)}`)
  if (d.personality) parts.push(`Personality: ${expandMacros(d.personality, charName, userName)}`)
  if (d.scenario) parts.push(`Scenario: ${expandMacros(d.scenario, charName, userName)}`)
  return parts.join('\n')
}

/** Expand the running history into alternating messages, ending with the new action. */
const buildHistory = (
  floors: FloorFile[],
  userAction: string,
  charName: string,
  userName: string
): ChatMessage[] => {
  const msgs: ChatMessage[] = []
  for (const f of floors) {
    if (f.user_message.content) {
      msgs.push({ role: 'user', content: expandMacros(f.user_message.content, charName, userName) })
    }
    if (f.response.content) {
      msgs.push({ role: 'assistant', content: expandMacros(f.response.content, charName, userName) })
    }
  }
  if (userAction) {
    msgs.push({ role: 'user', content: expandMacros(userAction, charName, userName) })
  }
  return msgs
}

/**
 * Assemble the final provider message array from the card, preset ordering,
 * matched lorebook entries and chat history. The preset's prompt blocks drive
 * the order; dynamic markers expand to live content.
 */
export const buildPrompt = (args: BuildPromptArgs): ChatMessage[] => {
  const { card, preset, lorebook, floors, userAction } = args
  const charName = card.data.name || 'Character'
  const userName = args.userName || 'User'

  // Lorebook scan over the last few turns plus the pending action.
  const scanText = [...floors.slice(-3).flatMap((f) => [f.user_message.content, f.response.content]), userAction]
    .filter(Boolean)
    .join('\n')
  const worldInfo = matchEntries(lorebook, scanText)
    .map((e) => expandMacros(e.content, charName, userName))
    .filter(Boolean)
    .join('\n\n')

  const messages: ChatMessage[] = []
  let historyEmitted = false

  for (const block of preset.prompts) {
    if (block.enabled === false) continue

    switch (block.marker) {
      case 'char_description': {
        messages.push({ role: block.role, content: buildCharDescription(card, charName, userName) })
        break
      }
      case 'mes_example': {
        const ex = expandMacros(card.data.mes_example, charName, userName)
        if (ex) messages.push({ role: block.role, content: `Example dialogue:\n${ex}` })
        break
      }
      case 'world_info': {
        if (worldInfo) messages.push({ role: block.role, content: `World Info:\n${worldInfo}` })
        break
      }
      case 'chat_history': {
        messages.push(...buildHistory(floors, userAction, charName, userName))
        historyEmitted = true
        break
      }
      case 'post_history': {
        const ph = expandMacros(card.data.post_history_instructions, charName, userName)
        if (ph) messages.push({ role: block.role, content: ph })
        break
      }
      default: {
        const content = expandMacros(block.content, charName, userName)
        if (content) messages.push({ role: block.role, content })
      }
    }
  }

  // Safety net: a preset with no chat_history marker would otherwise send no
  // conversation at all. Append history + action so generation still works.
  if (!historyEmitted) {
    messages.push(...buildHistory(floors, userAction, charName, userName))
  }

  return messages
}
