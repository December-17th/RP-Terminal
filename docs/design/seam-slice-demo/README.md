# Seam-slice demo (P0 verification)

A throwaway 2-slice test for the P0 seam primitives from
[`../poem-play-area-redesign.md`](../poem-play-area-redesign.md) §7:

1. **Seamless `panel_ui` mode** — `panel_ui.seamless: true` drops the grid gap/padding and each slot's
   chrome, so adjacent WCV surfaces abut with no line. (`StaticWorkspace` / `staticLayout.ts`.)
2. **Panel-geometry host API** — `window.rptHost.getPanelGeometry()` → `{ x, y, width, height,
   viewportWidth, viewportHeight }` plus `onPanelGeometry(cb)` (and a `rpt:panelgeometry` window
   event), so each page can draw a full-viewport background offset by its own window-x. (`wcvManager` →
   `wcvPreload`.)

`slice.html` draws the SAME striped/gridded background at full viewport width, shifted by its own `x`.

## What "pass" looks like

Two `slice.html` panels side by side. The diagonal gold stripes, the grid lines, and the big
`◀ ONE CONTINUOUS STAGE ▶` banner **cross the boundary between the two panels with no visible break,
gap, or jump** — including while you resize the window. If you see a hard vertical line or the stripes
step at the seam, either `seamless` isn't dropping the chrome or the geometry `x`/`viewportWidth` is
wrong for one panel.

## How to run it

The demo needs to load inside two WCV slots, so point a test card's `panel_ui` at the two pages. Host
`slice.html` somewhere the WCV can reach (any `http(s)://` URL, or a card asset), then set the active
card's `rp_terminal.panel_ui` to:

```jsonc
{
  "mode": "static",
  "seamless": true,
  "grid": { "cols": 12, "rows": 12 },
  "slots": [
    { "id": "left",  "view": "wcv",  "entry": "<slice.html url>?label=LEFT",  "rect": [0, 0, 4, 12] },
    { "id": "right", "view": "wcv",  "entry": "<slice.html url>?label=RIGHT", "rect": [4, 0, 8, 12] }
  ]
}
```

Add `#rptdebug` to a URL to log the geometry pushes in that panel's WCV devtools (opened automatically
in dev). Compare against a `"seamless": false` run to see the chrome/gap the mode removes.
