# Vendored card libraries

Assets injected into card iframes/WCV pages for ST/JS-Slash-Runner rendering-env parity (SP2). Vendored
(not loaded from a CDN) because the upstream CDN is unsuitable for app runtime.

## `tailwind.min.js`

- **What:** the Tailwind CSS **Play CDN runtime** (in-browser JIT — scans the DOM and generates utility CSS
  at runtime). Cards authored for SillyTavern/Tavern-Helper assume Tailwind utility classes work without a
  build step.
- **Source:** `https://cdn.tailwindcss.com/3.4.16` (pinned). v3 to match the utilities ST/JSR cards are
  authored against (v4 renames/drops some).
- **Why vendored:** the Tailwind Play CDN is explicitly "not for production," is rate-limited, and may be
  blocked offline. Pinning it locally makes inline cards deterministic and offline-capable.
- **License:** MIT (Tailwind Labs Inc.). Redistribution is permitted; this is the unmodified upstream build.

The jsDelivr-hosted libs (FontAwesome, jQuery-UI + theme, touch-punch) are loaded from the CDN instead — see
`src/shared/cardEnv.ts` — matching JSR, which CDN-loads them; only Tailwind is vendored.
