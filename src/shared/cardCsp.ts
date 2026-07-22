// Single source of truth for the trusted-card WCV Content-Security-Policy.
//
// This string is applied to every WCV card surface via THREE paths that used to hand-copy it:
//   - main:     wcvManager (jsDelivr onHeadersReceived header + cardServeDeps.cardCsp)
//   - renderer: WcvMessageFrame + CardScriptWcvHost (the inline data:-URL doc's <meta> CSP)
// It lives in `src/shared/` (importing nothing) so all three import the same constant — a policy
// edit lands in one place and can't drift. `shared/*` is process-agnostic (main + renderer + tests),
// so this is boundary-clean per `.dependency-cruiser.cjs` (main/renderer MAY import shared).
//
// Trusted-card policy: allow https code/styles/fonts/media so a card's own assets (Google Fonts, CDN
// audio, images) load; the real boundary is process isolation (separate WCV process, nodeIntegration
// off, no host/Node reach), not this CSP.
//
// Internal asset schemes are listed explicitly in img-src and media-src: CSP `*` does NOT match custom
// schemes, so
// World-Asset portraits (rptasset://) would otherwise be blocked in WCV card surfaces (PARTNER overlay
// / STAGE). Kept in parity with the main-window img-src (renderer/index.html) + csp.ts.
export const CARD_CSP =
  "default-src 'self' https: 'unsafe-inline' 'unsafe-eval' data: blob:; " +
  'img-src * data: blob: rptasset: rptremoteasset:; media-src * data: blob: rptasset: rptremoteasset:; connect-src * data: blob:'
