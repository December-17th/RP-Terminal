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
 *  `<rpt-combat-start enemies="哥布林 x3 (弱); 头目" map="forest"></rpt-combat-start>`. */
export interface CombatStartCue {
  enemies: string
  map: string
}

/**
 * Extract an `<rpt-combat-start>` cue (if any) and the narrative with the tag stripped.
 * The renderer surfaces an "Enter Combat" affordance when `cue` is non-null. Tolerant of
 * self-closing or paired tags and attribute order; missing attributes default to ''.
 */
export const parseCombatStart = (content: string): { text: string; cue: CombatStartCue | null } => {
  let cue: CombatStartCue | null = null
  const text = content.replace(
    /<rpt-combat-start\b([^>]*?)\/?>(?:[\s\S]*?<\/rpt-combat-start>)?/i,
    (_m, attrs: string) => {
      const enemies = attrs.match(/enemies="([^"]*)"/i)?.[1] ?? ''
      const map = attrs.match(/map="([^"]*)"/i)?.[1] ?? ''
      cue = { enemies, map }
      return ''
    }
  )
  return { text: cue ? text.trim() : content, cue }
}
