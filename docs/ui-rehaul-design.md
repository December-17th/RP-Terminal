# UI Rehaul — Design

Status: **Design locked 2026-06-24, not yet implemented.** The "UI first" foundation pass. Direction
iterated via in-session interactive mockups; this captures the agreed result. Companion to the audit below.

## Why

RP Terminal's shell is a chat-tool layout: one 52px `TopNav` crams 10 tabs that mix navigation
(World/Sessions) with config (Settings/API/Regex/Scripts/Lorebook/Preset/Persona/Logs), all driving a left
workspace panel; one hard-coded dark theme; no localization. The rehaul moves it toward a **game-launcher
shell** — pick a world, pick a session, play — that is themeable, localizable, and VS Code-like (custom
title bar, popup settings).

## Audit baseline (grounded in code)

- **Theming:** 6 CSS vars in [`assets/index.css`](../src/renderer/src/assets/index.css) (most CSS already
  uses them) + **~57 hard-coded hex** (32 in the CSS, 25 inline in components); missing semantic tokens
  (danger/success/warning, on-accent, `--rpt-bg-tertiary`/`--rpt-bg-elevated` already referenced-but-undefined).
  One dark theme, no switcher.
- **i18n:** none; strings hard-coded (e.g. `TopNav` tab labels).
- **Shell:** [`App.tsx`](../src/renderer/src/App.tsx) = `TopNav` + `Workspace`/`StaticWorkspace`; tabs drive
  `navStore.panel`. [`Modal.tsx`](../src/renderer/src/components/Modal.tsx) exists (760px centered) → reuse
  for popup settings. [`WorldPanel`](../src/renderer/src/components/WorldPanel.tsx) is the card library
  (import/mock/export/delete/select) — **no in-app editor for the card's V3 fields today**. The scope model
  (Global/World/Session) is partially built in the regex + scripts managers (`ScopeSection`).

## Locked decisions

### 1. Information architecture — World → Session → Play

- **Launcher mode** (no active session): pick a world, then a session.
- **Play mode** (session active): the existing resizable workspace, structurally unchanged.
- In play the title bar is a **breadcrumb** (`world ⌄ / session ⌄`) — switch either in one click, no full-menu round-trip.

### 2. Launcher

- **World chooser** = a vertical **scrollable list**; each row = **large PNG avatar (the card art)** +
  **title** (card name) + **description** (`creator_notes`, fallback truncated `description`) + meta
  (session count / last played), plus an "Import a card" row. The PNG is the card's stored avatar (confirm
  the exact path — expected `userData/.../avatars/<id>.png`).
- Select a world → its **session list** (sessions + "New session"). Select a session → **play**.

### 3. Play title bar — one merged custom title bar

- A single ~40px strip replaces the native title bar **and** the old 52px `TopNav`, reclaiming ~50px for the
  chat. Holds: brand · `world ⌄` · `session ⌄` · `Build ▾` | search/command, settings gear, theme switch,
  **native window controls**.
- Electron: `titleBarStyle: 'hidden'` + `titleBarOverlay` (recommended) or `frame: false` (full custom) —
  a `BrowserWindow` change in [`src/main/index.ts`](../src/main/index.ts). Drag region = the strip
  (`-webkit-app-region: drag`); **every button must be `no-drag`** or it's unclickable. Use
  `env(titlebar-area-*)` so the right cluster never slides under the native controls. **Verify** the
  WebContentsView card-overlay bounds under a frameless window before committing to it.

### 4. Settings — popup modal (not a page)

- Reuses `Modal`; VS Code-style search + category rail. Config surfaces (Settings/API/Logs/app prefs) move
  OUT of the nav into the popup. The `Appearance` category holds Theme, Accent, Language, Font size, Density.

### 5. `Build` group — the active world's editable pieces

- `Card` (definition editor — **new**; fills the gap that `WorldPanel` is library-only), `Lorebook`,
  `Regex`, `Scripts`, `Preset`. Naming: the ambiguous "Character" → **`Card`**. `World` = launcher/library;
  `Persona` (the user's identity) unchanged.

### 6. Theming — token-driven

- Grow ~6 → ~18 **semantic tokens**: bg-0/1/2/elevated, text primary/secondary/tertiary, accent +
  **on-accent**, border, and **danger/success/warning + their `on-` pairs**. Fold in the ~57 hard-coded
  colors; add a **theme registry + switcher**; persist `settings.ui.theme`. Starter themes: Midnight
  (current), Carbon (OLED), Daylight; swappable accent.
- **Card content opts into the app theme** via a shared token vocabulary (align with the card `theme`/`css`
  fields + `FRAGMENT_BASE`/card frames). Default: cards keep their own look.

### 6a. Card-bundled themes (a world reskins the shell)

A world can ship its own look so the shell reskins to match its aesthetic in play. Builds on the token
system (it overrides the same named tokens), so it lands as a later slice of the theming track. The schema
slot already exists (`RPTerminalExtSchema.theme` + `css`) — this defines its shape and behavior.

- **Format** (`data.extensions.rp_terminal.theme`): a **partial token-override map** —
  `{ base?: 'midnight' | 'daylight' | …, tokens: { accent, bg-1, … }, css?: '…' }`: an optional base theme to
  start from, a `tokens` map of overrides keyed by the app's semantic token names, and an optional `css`
  escape hatch.
- **Card supplies FILLS; the app DERIVES the `on-*` text tokens** by luminance (black/white or a tinted
  shade). A card theme is untrusted design input, so we never trust card-supplied text colors — we compute
  readable ones and enforce WCAG AA (§7). An illegible/failing theme falls back to the user's app theme.
- **Scope:** reskins **play mode for that world only**. The **launcher and the settings popup stay on the
  user's app theme** — the chrome is always consistent, you can reach settings (to toggle it) in a known
  look, and a broken card theme can't lock you out.
- **Opt-out:** gated by `settings.ui.allow_card_themes` (default on) + a per-world toggle. Off ⇒ the world
  plays in the user's chosen theme. Precedence: user base theme → card token overrides → (optional) user accent.
- **`css` escape hatch** is **scoped** to the play-workspace container and sanitized (reuse the inline-card
  CSS scoping in `messageHtmlScope`; drop `@import`, bar layout-escaping rules). The token map is the safe,
  primary path.
- **Portability:** rides in the World Card bundle — exports/imports with the card (pure text).

### 7. Contrast safety — hard constraint (owner feedback 2026-06-24)

- **Every fill token has a paired `on-<fill>` text token, and buttons/badges/pills/menu items MUST use the
  pair — never a hard-coded color that only works in one theme.** No black-on-black / low-contrast text (a
  real defect seen in the prototype). Validate **WCAG AA** contrast for every text/fill pair in **every**
  theme — especially the light theme, where a dark-on-dark assumption flips. This is the #1 regression risk
  when adding a light theme to an app built for a single dark theme. It also governs **untrusted
  card-bundled themes** (§6a): derive `on-*` tokens from the card's fills rather than trusting card-supplied
  text colors, and fall back to the user's theme on a failing contrast check.

### 8. i18n — greenfield, plumb early

- Drop in the `t()` mechanism + locale files early so new screens are translation-ready; wire the Language
  picker (app-UI only — **separate from card content**, which has its own `staticLocale`). Defer the full
  string-extraction sweep until the rehauled components settle (don't extract strings from components about
  to be rewritten).

## Build order (the foundation pass)

1. **Token system** — cosmetic, no structural risk; makes the theme switcher real; re-colors the message box
   + panels via token swap. **First PR.**
2. **Launcher + breadcrumb shell + custom title bar** — the structural nav rework (`App.tsx` entry mode, the
   breadcrumb, window controls). Bigger change; built on the tokens.
3. **i18n plumbing** — early, alongside; full extraction sweep later.
4. **Card-bundled themes** (§6a) — a follow-on slice of the theming track, once the base token system + the
   `on-*` derivation are in.

Deferred (separate tracks): the structural manager redesign + the rest of the scope model (partially built
for regex/scripts); the card-theming opt-in layer.

## Grounding refs

`App.tsx`, `components/TopNav.tsx`, `components/WorldPanel.tsx`, `components/Modal.tsx`,
`assets/index.css`, `stores/navStore.ts`, `types/character.ts`, `main/index.ts`. Prototype iterations were
in-session interactive mockups.
