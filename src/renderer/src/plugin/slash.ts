import { useProfileStore } from '../stores/profileStore'
import { useChatStore } from '../stores/chatStore'

/**
 * Minimal slash-command runtime (P4). A registry of built-in commands plus
 * commands registered by plugins/card scripts; runnable from the chat input
 * (`/cmd ...`) or programmatically via `rpt.slash.runCommand(...)`. This is a
 * deliberate *subset* of SillyTavern's STScript — `/name arg1 arg2` with no
 * pipes/closures/macros (a known fidelity gap; see the design doc §8).
 *
 * Clean-room: our own parser/registry, not derived from js-slash-runner.
 */

export interface SlashCommand {
  name: string
  description: string
  builtin: boolean
  run: (args: string[], raw: string) => Promise<string> | string
}

const registry = new Map<string, SlashCommand>()
const builtinNames = new Set<string>()

const profileId = (): string | null => useProfileStore.getState().activeProfile?.id ?? null
const chatId = (): string | null => useChatStore.getState().activeChatId

const parseVal = (s: string): any => {
  const t = s.trim()
  if (t === '') return ''
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}

const setLocalVar = (store: Record<string, any>): void =>
  useChatStore.getState().setLatestFloorVariables(store)

const varOp = async (
  scope: 'local' | 'global',
  op: 'get' | 'set' | 'inc',
  key: string,
  value?: any
): Promise<any> => {
  const pid = profileId()
  if (!pid) return undefined
  const res = await window.api.pluginVars(pid, chatId() || '', { op, scope, key, value })
  if (res && res.scope === 'local') setLocalVar(res.store)
  return res ? res.value : undefined
}

/** Parse a `/name rest` line. Returns null if it isn't a slash line. */
export const parseSlash = (line: string): { name: string; args: string[]; raw: string } | null => {
  const m = line.trim().match(/^\/(\S+)\s*([\s\S]*)$/)
  if (!m) return null
  const raw = m[2]
  return { name: m[1].toLowerCase(), raw, args: raw.length ? raw.split(/\s+/) : [] }
}

export const isSlashLine = (line: string): boolean => line.trim().startsWith('/')

export const listCommands = (): SlashCommand[] =>
  [...registry.values()].sort((a, b) => a.name.localeCompare(b.name))

/** Run a `/command` line; resolves with output text (may be empty). */
export const runSlash = async (line: string): Promise<string> => {
  const parsed = parseSlash(line)
  if (!parsed) return ''
  const cmd = registry.get(parsed.name)
  if (!cmd) return `Unknown command: /${parsed.name}`
  try {
    return (await cmd.run(parsed.args, parsed.raw)) || ''
  } catch (e: any) {
    return `/${parsed.name} failed: ${e?.message || String(e)}`
  }
}

const builtin = (name: string, description: string, run: SlashCommand['run']): void => {
  registry.set(name, { name, description, builtin: true, run })
  builtinNames.add(name)
}

let initialized = false

/** Register the built-in commands (idempotent). */
export const initSlash = (): void => {
  if (initialized) return
  initialized = true

  builtin('echo', 'Echo text back', (_args, raw) => raw)

  builtin('setvar', 'Set a chat variable: /setvar key value', async (args) => {
    const key = args[0]
    if (!key) return 'usage: /setvar key value'
    await varOp('local', 'set', key, parseVal(args.slice(1).join(' ')))
    return `${key} set`
  })

  builtin('getvar', 'Read a chat variable: /getvar key', async (args) => {
    if (!args[0]) return 'usage: /getvar key'
    const v = await varOp('local', 'get', args[0])
    return JSON.stringify(v)
  })

  builtin('incvar', 'Add to a numeric chat variable: /incvar key [n]', async (args) => {
    if (!args[0]) return 'usage: /incvar key [n]'
    const v = await varOp('local', 'inc', args[0], args[1] !== undefined ? Number(args[1]) : 1)
    return JSON.stringify(v)
  })

  builtin('setglobalvar', 'Set a global variable: /setglobalvar key value', async (args) => {
    const key = args[0]
    if (!key) return 'usage: /setglobalvar key value'
    await varOp('global', 'set', key, parseVal(args.slice(1).join(' ')))
    return `${key} set (global)`
  })

  builtin('getglobalvar', 'Read a global variable: /getglobalvar key', async (args) => {
    if (!args[0]) return 'usage: /getglobalvar key'
    return JSON.stringify(await varOp('global', 'get', args[0]))
  })

  builtin('gen', 'Generate a turn from text: /gen <text>', async (_args, raw) => {
    const pid = profileId()
    if (!pid) return 'no profile'
    if (useChatStore.getState().isGenerating) return 'busy'
    if (!chatId()) return 'no active session'
    await useChatStore.getState().sendAction(pid, raw)
    return ''
  })

  builtin('help', 'List available commands', () =>
    listCommands()
      .map((c) => `/${c.name} — ${c.description}`)
      .join('\n')
  )
}

/**
 * Register a command owned by a sandboxed frame (plugin/card script). `invoke`
 * fires the frame's handler (fire-and-forget; plugin commands don't return
 * output in v1). Built-in names can't be overridden. Returns an unregister fn.
 */
export const registerFrameCommand = (
  name: string,
  invoke: (args: string[], raw: string) => void
): (() => void) => {
  const key = name.toLowerCase()
  if (builtinNames.has(key)) return () => {}
  const entry: SlashCommand = {
    name: key,
    description: '(plugin command)',
    builtin: false,
    run: (args, raw) => {
      invoke(args, raw)
      return ''
    }
  }
  registry.set(key, entry)
  // Only remove if still ours — guards against a later registrant of the same
  // name being clobbered when this frame unmounts.
  return () => {
    if (registry.get(key) === entry) registry.delete(key)
  }
}
