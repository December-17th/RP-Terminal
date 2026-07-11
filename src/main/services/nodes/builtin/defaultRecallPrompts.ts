/**
 * PLOT-RECALL (WP4) — PLACEHOLDER default content for the `memory.recall` planner node.
 *
 * Kept in its OWN file, apart from the node logic (`recallNodes.ts`), on purpose: WP5 replaces the
 * CONTENT of this file — adapting the reference preset's stage-3 recall prompts + `finalSystemDirective`
 * (zh) — WITHOUT touching `recallNodes.ts`. So WP5 is a content-file-only diff. These are plain named
 * exports (the same style as `MAINTAINER_SYSTEM_PROMPT` in `defaultMemoryTemplate.ts`) so tests can pin
 * them. This is document DATA, not app-UI chrome — deliberately NOT routed through i18n.
 *
 * SLOT CONTRACT (owned by `recallNodes.ts` — WP5 MUST keep using these exact tokens):
 *   planner messages — {{catalogue}} {{notes_toc}} {{action}} {{plan}}, plus a `{history}` marker
 *     (a row that is EXACTLY `{history}` splices the transcript role-preserving; an inline `{history}`
 *     is substituted with the flattened transcript text — the memory.maintain discipline).
 *   directive       — {{StoryEngine}} {{QuestPlan}} {{recalled}} {{notes}} (empty slots collapse).
 */

/** One role-tagged scaffold row (mirrors the memory.maintain message shape). */
export interface RecallMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** PLACEHOLDER planner scaffold (WP5 replaces with the adapted zh stage-3 prompt). One framing system
 *  row + one user row carrying the slots. */
export const RECALL_PLANNER_MESSAGES: RecallMessage[] = [
  {
    role: 'system',
    content:
      'You are a plot-recall planner. From the catalogue, pick the memory codes relevant to the ' +
      'pending action and emit them comma-separated inside <Recall>…</Recall>. Optionally emit ' +
      '<Query>…</Query> note searches and <QuestPlan>…</QuestPlan> / <StoryEngine>…</StoryEngine>. ' +
      'Never invent a code that is not in the catalogue.'
  },
  {
    role: 'user',
    content:
      '【Catalogue】\n{{catalogue}}\n\n【Notes】\n{{notes_toc}}\n\n【Recent】\n{history}\n\n' +
      '【Previous plan】\n{{plan}}\n\n【Pending action】\n{{action}}'
  }
]

/** PLACEHOLDER composition directive (WP5 replaces with the adapted `finalSystemDirective`). The four
 *  slots collapse to blank lines when empty. */
export const RECALL_DIRECTIVE =
  '<StoryDirective>\n{{StoryEngine}}\n{{QuestPlan}}\n{{recalled}}\n{{notes}}\n</StoryDirective>'
