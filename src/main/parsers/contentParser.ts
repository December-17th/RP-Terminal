export interface RPEvent {
  type: string
  path: string
  value: any
  action: 'set' | 'add' | 'remove'
}

export interface ParsedContent {
  text: string
  events: RPEvent[]
}

// Reasoning-strip lives in the shared view-time module (used by storage extraction, the renderer,
// and history assembly alike). Re-exported here for the parser's existing callers.
export { stripThinking } from '../../shared/responseView'

/**
 * Parses <rpt-event> tags from AI output.
 * Example: <rpt-event type="state" action="set" path="stats.hp" value="50" />
 * Returns the narrative text with the tags stripped out, and an array of extracted events.
 */
export const parseContent = (content: string): ParsedContent => {
  const events: RPEvent[] = []

  // Regex to match <rpt-event ... /> tags
  const regex = /<rpt-event\s+([^>]+?)\s*\/?>/gi

  const text = content.replace(regex, (match, attrsString) => {
    try {
      const typeMatch = attrsString.match(/type="([^"]+)"/i)
      const pathMatch = attrsString.match(/path="([^"]+)"/i)
      const valueMatch = attrsString.match(/value="([^"]+)"/i)
      const actionMatch = attrsString.match(/action="([^"]+)"/i)

      if (typeMatch && pathMatch && valueMatch) {
        const valueStr = valueMatch[1]
        let value: any = valueStr

        // Try to parse as JSON if it's a number, boolean, or object
        try {
          value = JSON.parse(valueStr)
        } catch {
          // keep as string
        }

        events.push({
          type: typeMatch[1].toLowerCase(),
          path: pathMatch[1],
          value,
          action: (actionMatch?.[1]?.toLowerCase() as 'set' | 'add' | 'remove') || 'set'
        })
      }
    } catch (e) {
      console.error('Failed to parse rpt-event tag:', match, e)
    }

    // Remove the tag from the text
    return ''
  })

  return { text: text.trim(), events }
}

/** A combat-initiation cue the AI emits when a scene turns to a fight (Track Combat / P6):
 *  `<rpt-combat-start enemies="哥布林 x3 (弱); 头目" map="forest"></rpt-combat-start>`. The tag BODY may
 *  carry an A1 JSON enemy **roster** (character-shaped objects + 名称/数量/阵营) the combat system builds
 *  combatants from — see docs/combat-poem-of-destiny-expansion.md "A1 design". */
export interface CombatStartCue {
  enemies: string
  map: string
  roster?: Array<Record<string, unknown>>
}

/** Parse the tag body as a JSON roster (array, or a single object → 1-element array). Tolerant of a
 *  ```json fence and surrounding prose; returns undefined when there's no parseable JSON. */
const parseRoster = (body: string): Array<Record<string, unknown>> | undefined => {
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i)
  let s = (fenced ? fenced[1] : body).trim()
  const start = s.search(/[[{]/)
  if (start < 0) return undefined
  s = s.slice(start)
  try {
    const parsed = JSON.parse(s)
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    const out = arr.filter((e) => e && typeof e === 'object') as Array<Record<string, unknown>>
    return out.length ? out : undefined
  } catch {
    return undefined
  }
}

/**
 * Extract an `<rpt-combat-start>` cue (if any) and the narrative with the tag stripped.
 * The renderer surfaces an "Enter Combat" affordance when `cue` is non-null. Tolerant of
 * self-closing, paired, or unclosed tags and attribute order; missing attributes default to ''.
 * A JSON body (between paired tags) is parsed into `cue.roster`.
 */
export const parseCombatStart = (content: string): { text: string; cue: CombatStartCue | null } => {
  const open = content.match(/<rpt-combat-start\b([^>]*?)\/?>/i)
  if (open?.index === undefined) return { text: content, cue: null }

  const attrs = open[1] ?? ''
  const afterOpen = open.index + open[0].length
  const rest = content.slice(afterOpen)
  const close = rest.match(/<\/rpt-combat-start>/i)
  const body = close?.index !== undefined ? rest.slice(0, close.index) : ''
  const end = close?.index !== undefined ? afterOpen + close.index + close[0].length : afterOpen

  const enemies = attrs.match(/enemies="([^"]*)"/i)?.[1] ?? ''
  const map = attrs.match(/map="([^"]*)"/i)?.[1] ?? ''
  const roster = body ? parseRoster(body) : undefined
  const cue: CombatStartCue = { enemies, map, ...(roster ? { roster } : {}) }
  const text = (content.slice(0, open.index) + content.slice(end)).trim()
  return { text, cue }
}
