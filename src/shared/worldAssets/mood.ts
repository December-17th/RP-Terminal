/** Minimal synonym table: ascii / loose tokens → the canonical Chinese mood used in filenames.
 *  Unknown moods pass through (trimmed) and simply fall back to base if no file. */
const MOOD_ALIASES: Record<string, string> = {
  smile: '微笑', happy: '喜悦', joy: '喜悦', '笑': '微笑',
  angry: '愤怒', sad: '悲伤', neutral: '平静'
}

export function normalizeMood(s: string): string {
  const t = s.trim().toLowerCase()
  return MOOD_ALIASES[t] ?? s.trim()
}

/** Extract a character's current mood from a message. v1 is message-scoped (the last mood emitted
 *  in the text), reusing the card's existing `mood="..."` attribute and `[情绪]:` / `情绪:` fields.
 *  `name` is accepted for forward-compat (name-scoped lookup is a later refinement). */
export function currentMoodFor(_name: string, text: string): string | undefined {
  const attr = /\bmood\s*=\s*["']([^"']+)["']/g
  const field = /(?:\[\s*情绪\s*\]|情绪)\s*[：:]\s*([^\s，。;；\n]+)/g
  const matches: { index: number; value: string }[] = []
  for (const re of [attr, field]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) matches.push({ index: m.index, value: m[1].trim() })
  }
  matches.sort((a, b) => a.index - b.index)
  const last = matches.length ? matches[matches.length - 1].value : undefined
  return last && last.length ? last : undefined
}
