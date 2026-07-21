export type YuzuBlockCommand =
  | { type: 'bg'; location: string }
  | { type: 'actor'; actor: string; expression?: string; position: 'left' | 'center' | 'right' }
  | { type: 'exit'; actor: string }

export interface AnnotatedFloorBlock {
  commands: YuzuBlockCommand[]
  content: string
}

const COMMAND_LINE_RE = /^<\|\s*(.*?)\s*\|>$/
const POSITIONS = new Set(['left', 'center', 'right'])
const UNSUPPORTED_VERBS = new Set([
  'mood',
  'music',
  'ambience',
  'sfx',
  'cg',
  'choice',
  'effect',
  'enter',
  'move'
])

type ParsedLine =
  | { type: 'block' | 'end' }
  | { type: 'command'; command: YuzuBlockCommand }
  | { type: 'unsupported' }
  | null

const parseCommandLine = (line: string): ParsedLine => {
  const match = COMMAND_LINE_RE.exec(line)
  if (!match) return null
  const body = match[1].trim()
  if (body === 'block' || body === 'end') return { type: body }

  const parts = body.split(/\s+/).filter(Boolean)
  if (UNSUPPORTED_VERBS.has(parts[0])) return { type: 'unsupported' }
  if (parts[0] === 'bg' && parts.length > 1) {
    return { type: 'command', command: { type: 'bg', location: parts.slice(1).join(' ') } }
  }
  if (parts.length === 2 && parts[1] === 'exit') {
    return { type: 'command', command: { type: 'exit', actor: parts[0] } }
  }
  const position = parts.at(-1)
  if (parts.length >= 2 && position && POSITIONS.has(position)) {
    return {
      type: 'command',
      command: {
        type: 'actor',
        actor: parts[0],
        ...(parts.length > 2 ? { expression: parts.slice(1, -1).join(' ') } : {}),
        position: position as 'left' | 'center' | 'right'
      }
    }
  }
  return { type: 'unsupported' }
}

/** Parse the deliberately restricted Yuzu POC annotation grammar. Invalid annotations return null. */
export const parseAnnotatedFloor = (text: string): AnnotatedFloorBlock[] | null => {
  const lines = String(text ?? '').split(/\r?\n/)
  const blocks: Array<{ commands: YuzuBlockCommand[]; lines: string[] }> = []
  let current: (typeof blocks)[number] | null = null
  let ended = false

  for (const line of lines) {
    const parsed = parseCommandLine(line)
    if (parsed?.type === 'unsupported') return null
    if (ended) {
      if (line.trim()) return null
      continue
    }
    if (parsed?.type === 'block') {
      current = { commands: [], lines: [] }
      blocks.push(current)
      continue
    }
    if (parsed?.type === 'end') {
      if (!current) return null
      ended = true
      continue
    }
    if (parsed?.type === 'command') {
      if (!current) return null
      current.commands.push(parsed.command)
      continue
    }
    if (!current) return null
    current.lines.push(line)
  }

  if (!ended || blocks.length === 0) return null
  const parsedBlocks = blocks.map((block) => ({
    commands: block.commands,
    content: block.lines.join('\n')
  }))
  return parsedBlocks.some((block) => block.content.trim()) ? parsedBlocks : null
}

/** Remove only standalone command lines recognized by the restricted POC grammar. */
export const stripYuzuDirectives = (text: string): string =>
  String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => {
      const parsed = parseCommandLine(line)
      return parsed === null || parsed.type === 'unsupported'
    })
    .join('\n')
