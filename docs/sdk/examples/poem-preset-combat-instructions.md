# 命定之诗 — preset combat instructions (paste-in)

The RP Terminal combat engine is **triggered by a tag the AI emits**: when a scene turns into a fight,
the model must output

```
<rpt-combat-start enemies="哥布林 x2; 头目" map=""></rpt-combat-start>
```

The app parses this off the reply (it's stripped from the visible prose), stores it as the floor's
`combat_cue`, and shows an **⚔ Enter Combat** button that builds the encounter from the card's
`extensions.rp_terminal.combat` bundle. **Nothing in the engine makes the AI emit the tag** — that's the
card's job, so add the snippet below to the 命定之诗 preset (e.g. into `🚫正文cot@cancannide` or a new
low-priority system prompt). The combat *numbers* on items are already authored by the card's own
`<角色生成>` / `[技能装备道具生成规则]`, so no extra instruction is needed for those.

> The `enemies` refs **must match the keys in the bundle's `enemies`** (see
> [poem-combat-bundle.json](poem-combat-bundle.json) — currently `哥布林`, `头目`). Add a template there
> for every enemy ref you want the AI to be able to field; unknown refs are skipped (→ an empty fight).

## Snippet (Chinese — matches the card's voice)

```
<战斗启动协议>
- 当且仅当场景进入明确的敌对战斗时，在正文末尾输出一次：
  <rpt-combat-start enemies="敌人引用 xN; 敌人引用2" map=""></rpt-combat-start>
- enemies 必须使用<战斗敌人表>中已登记的引用名（如：哥布林、头目），数量用 `xN`，多个敌人用 `;` 或 `、` 分隔。
- 该标签仅用于启动战斗系统，不得出现在叙事可见文本中，且每次战斗只输出一次。
- 非战斗场景禁止输出该标签。
</战斗启动协议>
<战斗敌人表>
可用敌人引用：哥布林、头目
</战斗敌人表>
```

(English equivalent, if authoring a non-Chinese card: "When a scene becomes a hostile battle, emit
exactly one `<rpt-combat-start enemies="ref xN; ref2">` at the end of the reply, using only enemy refs
registered in the bundle's `enemies`; never emit it outside combat or in visible prose.")

## Verifying
After adding the snippet, follow [combat-poem-manual-tests.md](../../combat-poem-manual-tests.md) §2–§3:
prompt the model into a fight → it emits the tag → **Enter Combat** appears → the party imports from MVU
and the bundle enemies spawn.
