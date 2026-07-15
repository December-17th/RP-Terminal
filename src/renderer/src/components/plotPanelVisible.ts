/**
 * Pure gate for the plot-recall plot panel — kept dependency-free (no React/DOM) so the
 * show/hide matrix is unit-testable under the node test harness.
 */

/** Read the `display.plotBlock` setting: ON by default (a profile predating the flag has no
 *  `display` block, so unset ⇒ shown). Only an explicit `false` hides the panel. */
export const plotPanelSettingEnabled = (display?: { plotBlock?: boolean }): boolean =>
  display?.plotBlock !== false

/** The panel renders only when the setting is ON *and* the floor actually carries a non-empty
 *  plot_block. Whitespace-only blocks count as absent. */
export const plotPanelVisible = (
  plotBlock: string | undefined,
  settingEnabled: boolean
): boolean => settingEnabled && !!plotBlock && plotBlock.trim() !== ''

/**
 * The plot beautifier's whole job is to turn the plot_block into ONE full-document HTML card
 * (a ```html <!doctype html>…</html> block). But that card then flows through MessageContent's
 * general markdown/HTML splitter, which is fragile against the real beautified output (surrounding
 * rule output, a malformed closing fence, …) and can leave the card rendering as a raw code block
 * instead of a live frame. So pull the card document straight out of the beautified string here and
 * hand the splitter a PRISTINE, single ```html card it can't misparse.
 *
 * Lenient by design (more so than the splitter): prefer a ```html fence, else a bare document, taking
 * everything up to the document's LAST `</html>`/`</body>` so a broken/absent closing fence or trailing
 * junk can't truncate it. Returns null when no HTML document is recoverable (e.g. the beautifier didn't
 * run and the block is still raw `<用户本轮输入>` prose) — the caller then renders the raw string as before.
 */
export const extractPlotCard = (s: string): string | null => {
  const fenced = /```html\s*([\s\S]*<\/(?:html|body)>)/i.exec(s)
  if (fenced) return fenced[1]
  const bare =
    /(<!doctype\s+html\b[\s\S]*<\/html>)/i.exec(s) ??
    /(<html\b[\s\S]*<\/html>)/i.exec(s) ??
    /(<body\b[\s\S]*<\/body>)/i.exec(s)
  return bare ? bare[1] : null
}

/** True when the beautified output is an HTML card (not the raw `<用户本轮输入>` prose the panel shows
 *  when the beautifier didn't run). The card ALWAYS carries a `<script>`/`<style>`/`<html>`/`<body>` —
 *  observed even when its document structure is shredded — so this stays true through the failure mode. */
export const plotBlockIsCard = (s: string): boolean =>
  /```html|<script[\s>]|<style[\s>]|<(?:html|body)[\s>]/i.test(s)

/**
 * Turn the beautified plot output into a form MessageContent renders as ONE card frame — never raw code.
 *  1. A clean document survives → re-wrap it in a pristine ```html fence (the ```html→</html> anchor in
 *     MessageContent then keeps any inner ``` from the turn input harmless, so the card is preserved
 *     byte-for-byte).
 *  2. No clean document but the output is still card-ish (its `<script>` etc. survived a shredded
 *     structure — the raw-code failure mode) → strip the stray ``` fences and force the whole thing into
 *     one clean ```html block, so the fragile splitter can't leave it as markdown. A lenient browser
 *     re-parses the shredded HTML in the frame — always better than a raw code dump.
 *  3. Genuinely not a card (raw prose) → pass through so the normal markdown path renders it.
 */
export const plotPanelContent = (beautified: string): string => {
  const card = extractPlotCard(beautified)
  if (card) return '```html\n' + card + '\n```'
  if (plotBlockIsCard(beautified))
    return '```html\n' + beautified.replace(/```html/gi, '').replace(/```/g, '') + '\n```'
  return beautified
}
