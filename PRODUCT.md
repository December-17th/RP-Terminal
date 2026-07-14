# Product

## Register

product

## Platform

web

## Users

AI-roleplay players and card authors, Chinese-first with English fully supported, running long
(often multi-hour, hundreds-of-floors) sessions on desktop. Players are mid-game when they touch
RPT's own UI — configuring a session, fixing memory tables, importing a card — and want to get
back to playing. Card authors additionally use RPT as a target platform: they bring their own
in-game UI (panels, status bars, beautifications) that RPT hosts.

## Product Purpose

RP Terminal evolves the SillyTavern-style chat experience into a full game platform: a standalone
Electron app that stays format-compatible with the ST card ecosystem (chara_card_v3, lorebooks,
regex, presets, MVU) while adding what a chat tool can't — card-authored game UI, native combat,
SQL-table memory, and an agentic workflow engine. Success looks like a dominant-stack ST card
running well out of the box, and a player managing a long campaign without the session's memory,
state, or pacing degrading.

## Positioning

The ST-compatible runtime that turns chat roleplay into a real game platform — the card brings the
game, RPT brings the engine.

## Brand Personality

Premium-neutral, quiet, dependable. RPT's own chrome is a calm pro-tool that recedes behind the
card's aesthetics: the card performs, the chrome serves. Confidence comes from precision and
consistency, not ornament.

## Anti-references

- **Shujuku-plugin admin clutter** — the reference plugin's dense jQuery-era settings walls, nested
  collapsibles, and long button rows. RPT matches its capability, never its look.
- **Generic SaaS dashboard** — hero metrics, identical card grids, gradient accents; the
  admin-template look.
- **Native-OS dialog feel** — no `window.confirm`-style abrupt modals; destructive flows get
  themed, informative dialogs that state consequences.

## Design Principles

1. **Chrome recedes, card performs.** The play surface belongs to the card; RPT's UI stays quiet,
   consistent, and out of the way.
2. **Every color through tokens.** All UI color rides the `--rpt-*` token set and must hold WCAG AA
   in all three themes (dark / carbon / light) — the contrast rule in docs/ui-rehaul-design.md §7.
3. **Both languages are first-class.** Every user-facing string is designed in zh and en at the
   same time (`t()` + both locale files, ST-ecosystem zh terminology).
4. **Consistency is the trust signal.** One component vocabulary across surfaces — same buttons,
   same chips, same dialogs. Familiar beats novel everywhere the user is in a task.
5. **Destructive actions explain themselves.** Anything that deletes or rewrites state says exactly
   what will be lost before it happens, in the app's own dialog language.

## Accessibility & Inclusion

WCAG AA contrast across all three themes (an established repo constraint, enforced by the token
pairing rule). No color-only signaling — status dots/chips always pair color with a text label.
Reduced-motion alternatives for any animation. Keyboard: Esc closes overlays; focus states on all
interactive controls.
