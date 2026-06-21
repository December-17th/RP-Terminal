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

/**
 * Strip the model's chain-of-thought (`<think>` / `<thinking>` blocks) from a response before
 * any parsing or display. Reasoning shouldn't be shown or sent back as history — and, critically,
 * a tag MENTIONED inside the reasoning (e.g. the literal "Output <UpdateVariable> ..." this card
 * writes) would otherwise make the `<UpdateVariable>` / `<rpt-event>` strippers match from that
 * stray mention all the way to the real closing tag, swallowing the whole narrative.
 */
export const stripThinking = (content: string): string =>
  content
    // Closed blocks (the common case) — non-greedy so multiple blocks each match.
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '')
    // A dangling, unclosed trailing block (truncated output) → drop it to the end.
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*$/i, '')
    .trim()

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
        let valueStr = valueMatch[1]
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
