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
2. Get the AI to emit a combat-start cue: its reply must contain
   `<rpt-combat-start enemies="哥布林 x2; 头目"></rpt-combat-start>` (the enemy refs must match the
   bundle's `enemies` keys — `哥布林` / `头目`). See the **Known gap** below; for now prompt it into a
   fight or hand-add a preset line instructing it.
3. When the **⚔ Enter Combat** banner appears, click it.

Expected:
- Combat mode opens on a grid. The **party** (主角 + present companions) is on the **left**, with HP
  equal to their MVU `生命值上限`, and an ability bar listing `普攻` + each character's active 技能
  (e.g. `火球术`). The **enemies** (哥布林 ×2, 头目) are on the **right**.
- No enemies and an instant "victory" ⇒ the cue's refs didn't match `combat.enemies` (check spelling).

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
- **Preset instruction not yet added** — nothing tells the AI to emit `<rpt-combat-start>` with refs
  matching `combat.enemies`. Until that lands, trigger combat by prompting/instructing manually. *(BP6)*
- **Per-encounter mode chooser** (Classic / Combat-system Narrate / Deterministic) — not built; combat
  always runs through the engine. *(BP4)*
- **AI dynamic enemy generation** (`char_info` → combatants) — not built; enemies come from the bundle's
  **static** `enemies` templates resolved against the cue refs. *(BP4)*
- **Status MVU-UI regex** (the combat sheet showing attrs/derived/abilities) — not built. *(BP5)*
