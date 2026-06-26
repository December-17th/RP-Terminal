# 命定之诗 combat extension + debug — manual test checklist

Living checklist of things that need **in-app** verification (the unit/integration suite can't drive the
Electron UI, live AI, or the filesystem-wipe). Per [[rpt-manual-testing-workflow]], each item gives
explicit steps, the expected result, and what to capture if it fails. Branch: `feat/poem-combat-extension`.

## Prerequisites
- `npm run build` then launch the app (or `npm run dev`).
- A working API connection configured (Settings → API).
- The 命定之诗 card **with the combat bundle embedded**:
  `example sillytarvern character card, presets, extensions and scripts/v4.2.1+combat.png`
  (regenerate any time the bundle JSON changes by re-running the scratchpad `embed-combat.cjs`).
  Import it as a card/world.

---

## 1. Profile wipe (debug) — `feat(debug)` commit
Steps:
1. In a profile with some content, open **Settings → Debug → Wipe profile**.
2. Confirm the dialog.

Expected:
- The app reloads. Characters, chats, presets, lorebooks, regex, scripts are **gone**.
- **API connections survive** (Settings → API still lists your presets + active connection; you can
  generate without re-entering keys).
- Non-API settings (theme/locale/etc.) are back at defaults.
- The profile itself (and its avatar) still exists.

Capture on failure: main-process log (Settings → … / `logService`), and whether `api_presets` survived.

---

## 2. Combat: config loads + party imported from MVU
Steps:
1. Import `v4.2.1+combat.png`; start a chat in that world; play a few turns so the MVU `stat_data`
   has a 主角 with real 属性/生命值 (and ideally a companion with `在场: true`).
2. Get the AI to emit a combat-start cue with an enemy **roster**: its reply must contain
   `<rpt-combat-start>…JSON roster…</rpt-combat-start>` (the body is a JSON array of enemy objects —
   名称/数量/属性/装备/技能/生命层级). Add the paste-in `<战斗启动协议>` from
   [sdk/examples/poem-preset-combat-instructions.md](sdk/examples/poem-preset-combat-instructions.md)
   to the preset so the model emits it, then prompt the scene into a fight.
3. When the **⚔ Enter Combat** banner appears, click it.

Expected:
- Combat mode opens on a grid. The **party** (主角 + present companions) is on the **left**, with HP
  equal to their MVU `生命值上限`, and an ability bar listing `普攻` + each character's active 技能
  (e.g. `火球术`). The **enemies** (哥布林 ×2, 头目) are on the **right**.
- No enemies and an instant "victory" ⇒ the roster JSON was empty or didn't parse (check the tag body).

Capture on failure: the renderer console, the main log around `combat-start-from-card`, and the floor's
`combat_cue` variable.

## 3. Combat: a fight resolves with the card's 战斗协议 numbers
Steps: play it out — move a party member adjacent, attack; end turns so enemies act.

Expected:
- Damage is **card-scale** (hundreds–thousands), not D&D-scale. The log shows 评级-style outcomes
  (a `评级 ×K` factor) and HP dropping by the 战斗协议 formula (`构成 → 装备减免 → 属性减免 → ×评级 → DR`).
- Enemies **close distance** when out of range, then attack (native weighted policy + the poemD20
  resolver).
- The fight ends when one side is down; end-of-combat narration runs and HP/【consequences】 fold back
  into `stat_data` via `<UpdateVariable>` (verify the character sheet reflects post-fight HP).

Capture on failure: the full combat log, console errors, main log.

---

## Known gaps / deferred (so a tester isn't surprised)
- **Preset cue instruction** — shipped as a paste-in snippet
  ([poem-preset-combat-instructions.md](sdk/examples/poem-preset-combat-instructions.md)); the card author
  adds it (the app does not auto-inject prompt text). Without it the AI won't emit the cue → no combat. *(BP6)*
- **Per-encounter mode chooser** (Classic / Combat-system Narrate / Deterministic) — not built; combat
  always runs through the engine. *(BP4)*
- **AI dynamic enemy generation** — **built** (channel A1): enemies come from the JSON roster in the
  `<rpt-combat-start>` body. The bundle's static `enemies` templates remain as a fallback. *(BP4)*
- **Status MVU-UI regex** (the combat sheet showing attrs/derived/abilities) — not built. *(BP5)*
