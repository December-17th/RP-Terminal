// Single source for the char-based token heuristic shared by the main-side prompt budget and the
// renderer-side Microscope viewer. Pure — no imports, so both sides may depend on it.
//
// CJK ranges (Chinese/Japanese/Korean + fullwidth) tokenize denser than Latin,
// so estimate them ~1 token/char and other text ~4 chars/token. Callers only ever label these counts
// as estimates (`~`), so an exact tokenizer is neither available nor needed.
const CJK = /[\u3000-\u9fff\uff00-\uffef]/

export const estimateTokens = (text: string): number => {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}
