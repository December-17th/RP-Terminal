/**
 * Build the document a card runs inside, from the regex-injected block.
 *
 * The block is EITHER a full `<!doctype html>` document — whose `<style>`/font `<link>` live in
 * `<head>` (the static beautification cards) — OR a bare `<body>`/fragment whose script loads its
 * UI (the loader cards). We must keep the `<head>` for the former: stripping it drops ALL the card's
 * CSS (including its `html,body{background:transparent}`), so the card paints as an oversized white
 * box of unstyled text. `headInject` is placed at the very START of `<head>` so the host's additions
 * (CSP meta for WCV; the bootstrap + library globals for the inline iframe) run before the card's own
 * head content.
 */
export function buildCardDoc(html: string, opts: { headInject?: string } = {}): string {
  const inject = opts.headInject ?? ''
  // Full document: keep it intact (doctype/head/styles/body/script); inject at head start.
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, (_m, attrs) => `<head${attrs}>${inject}`)
  }
  // Bare fragment: take the <body> inner if present, else the whole string, and wrap it.
  const inner = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html
  return `<!doctype html><html><head>${inject}</head><body>${inner}</body></html>`
}
