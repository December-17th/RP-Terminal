// Renderer copy of the main-side char heuristic (`src/main/services/promptBudget.ts`). The renderer
// cannot import from `src/main`, and the Microscope viewer only ever labels these counts as estimates
// (`~`), so an exact tokenizer is neither available nor needed. Keep this in sync with the main copy.
const CJK = /[\u3000-\u9fff\uff00-\uffef]/

/** Approximate token count of a text block: ~1 token/char for CJK, ~4 chars/token otherwise. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}
