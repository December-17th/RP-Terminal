// Window-chrome constants for the custom merged title bar (Windows).
//
// PAIRED VALUE — keep in sync with the renderer token `--rpt-titlebar-h` in
// src/renderer/src/theme.ts. The main process paints the OS window-control overlay
// (min/max/close) and the renderer paints the top strip (.tstrip / .lc-bar) that sits
// under it; both must be the SAME height so the controls sit flush with the strip.
// They cannot literally share a variable across the process boundary — the test
// `test/titlebarHeight.test.ts` asserts the two definitions still match.
export const TITLEBAR_OVERLAY_HEIGHT = 44
