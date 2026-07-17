# 0007 — Yuzu Scene Script (YSS) v0: the scene wire-format grammar

- **Status:** Accepted 2026-07-16 (scene wire-format A/B). Companion to **ADR 0002** (which adopts a lenient incremental parse); this ADR fixes the concrete grammar. Version tag: **YSS v0**.
- **Evidence:** `scene-format-ab-2026-07-16.md` — validated on real model output (§3 side-by-side; 0 format failures over two runs).

## Context
ADR 0002 makes the scene a line-oriented command stream. This ADR specifies the grammar the model emits and the parser accepts, so WP-B's `sceneValidate.ts` and the scene-generation prompt (WP-C) share one definition.

## Decision
A scene is a sequence of **lines**; each non-blank line is exactly one of:

1. **Command** — `<| verb args… |>`
2. **Dialogue** — `speaker: text` (speaker = a known actor id or `narration`; separator is a colon-space `": "`)
3. **Narration** — any other non-empty line (spoken by nobody)

**Commands (v0):**

| Command | Meaning |
|---|---|
| `<\| bg <location> \|>` | background; the FIRST `bg` fixes `header.location` |
| `<\| mood <word…> \|>` | scene mood (last one wins; free text, not vocab-checked) |
| `<\| <actor> [tokens…] \|>` | sprite op; tokens after the actor auto-classify by vocabulary as expression / position (`left\|center\|right`) / action (`enter\|exit\|move`), in any order |
| `<\| music <id> \|>` · `<\| ambience <id> \|>` · `<\| sfx <id> \|>` | audio (`<\| music stop \|>` allowed) |
| `<\| cg <id> \|>` · `<\| cg clear \|>` | CG overlay |
| `<\| effect <mvu-command> \|>` | change a story variable on the current beat; payload is ONE raw MVU command in the classic call dialect (`_.set` / `_.add` / `_.delta` / …), e.g. `<\| effect _.set('好感度.kaede', 4, 5) //她笑了 \|>`. A trailing `//reason` is part of the command. NOT allow-listed (ADR 0008 §4–5); opaque to the parser and validated main-side by `mvuParser` |
| `<\| choice <text> :: <intent> \|>` | one player choice (repeatable); ` :: ` splits shown text from intent tag; omit ` :: <intent>` to reuse the text as intent |
| `<\| end \|>` | REQUIRED final line; its ABSENCE is a truncation signal |

**Asymmetric leniency (the core rule):** prose never errors (an unrecognized non-command line → narration). A `<| … |>` line that opens but does not validate (unknown verb/id, empty effect payload, unclassifiable sprite token) is **recorded as an observation and skipped — the scene survives.** Asset ids stay strict at the *scene-validate* stage; only the *parse* is lenient. Effects are NOT gated at all: an `effect`'s MVU-command payload is captured verbatim (opaque to the shared parser) and applied/validated main-side (ADR 0008 §5 — no effect allow-list).

**Interaction:** any `<| choice |>` lines ⇒ present those choices; none ⇒ the player types a free action (the default). No `free`/`continue` verbs. Choices carry **text + intent only** — never mechanics (those go in a beat `effect` as an MVU command).

**Header** is derived from the stream: first `bg` → `location`; actors that speak or `enter` → `present`; last `mood` → `mood`.

## v1 polish (from the A/B — fold into WP-B)
- **Strip a matched surrounding quote pair** on choice text: the model reliably emits `<| choice "…" :: … |>`.
- `<| end |>` was emitted reliably → keep it as the truncation guard (absence = `TRUNCATED` observation, non-fatal).
- Sprite-token auto-classification worked on every real output → keep the any-order classifier.

## Consequences
- The grammar is **versioned (YSS v0)**; new verbs are additive. The parser lives in WP-B `sceneValidate.ts` (the `normalize` step of ADR 0002's ladder); the prompt that teaches it lives in WP-C.
- Escaping is a non-issue (dialogue is raw text). Streaming to the stage is natural (line-incremental).
- One shared grammar definition feeds both the parser (WP-B) and the generation prompt (WP-C) — keep them in sync via this ADR.
