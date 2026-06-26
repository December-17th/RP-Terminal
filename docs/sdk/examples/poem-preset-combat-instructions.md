# 命定之诗 — preset combat instructions (paste-in)

The RP Terminal combat engine is **triggered by a tag the AI emits**, and the **enemy combat data is
carried in that tag's JSON body** (channel A1). When a scene turns into a fight, the model outputs:

```
<rpt-combat-start map="">
[
  { "名称": "哥布林", "数量": 3, "生命层级": "第一层级", "等级": 4,
    "属性": { "力量": 3, "敏捷": 4, "体质": 3, "智力": 1, "精神": 1 },
    "装备": { "利爪": { "类型": "天生武器", "品质": "普通", "标签": ["攻击: 20"], "效果": {} } },
    "技能": {}, "状态效果": {} },
  { "名称": "头目", "数量": 1, "生命层级": "第二层级", "等级": 8,
    "属性": { "力量": 6, "敏捷": 4, "体质": 6, "智力": 2, "精神": 3 },
    "装备": { "巨斧": { "类型": "巨斧", "品质": "优良", "标签": ["攻击: 70", "命中: +1"], "效果": {} } },
    "技能": { "横扫": { "类型": "主动", "消耗": "攻击: 60 SP",
      "标签": ["力量", "范围: 锥形", "威力: 150", "有效距离: 2"], "效果": { "流血": "20+2回合" } } },
    "状态效果": {} }
]
</rpt-combat-start>
```

The app parses this off the reply (the tag is stripped from visible prose), shows an **⚔ Enter Combat**
button, and builds the encounter: the **party** comes from MVU `stat_data` (主角 + 在场 companions); the
**enemies** are built from this roster. **The engine derives HP/MP/SP/AC** from 属性 + 生命层级, so the
roster only needs the fields below. Each entry uses the card's own stat_data field names + the standard
`标签`/`效果`/`消耗` item format (so it parses exactly like a character).

Roster entry fields: `名称` (req) · `数量` (default 1) · `阵营` (`"友方"` → joins the party; default enemy)
· `生命层级` · `等级` · `属性{力量,敏捷,体质,智力,精神}` · `装备{slot:{类型,品质,标签[],效果{}}}` ·
`技能{name:{类型,消耗,标签[],效果{}}}` · `状态效果{}`.

> **Nothing in the engine makes the AI emit this** — it's the card's job. Add the snippet below to the
> 命定之诗 preset (e.g. into `🚫正文cot@cancannide` or a new low-priority system prompt). The combat
> *numbers* on the roster follow the card's own `<角色生成>` / `[技能装备道具生成规则]` / `[品质效果限定]`.

## Snippet (paste into the preset)

```
<战斗启动协议>
- 当且仅当场景进入明确的敌对战斗时，在正文末尾输出一次 <rpt-combat-start>…</rpt-combat-start>。
- 标签体内放置【敌人名册】：一个 JSON 数组，每个敌人一个对象，字段：
  名称(必填)、数量(默认1)、阵营("友方"则加入我方，缺省为敌方)、生命层级、等级、
  属性{力量,敏捷,体质,智力,精神}、装备{部位:{类型,品质,标签[],效果{}}}、技能{名称:{类型,消耗,标签[],效果{}}}、状态效果{}。
- 敌人的属性/装备/技能数值严格按 <角色生成>、<技能装备道具生成规则>、<品质效果限定规则> 生成；
  装备标签用「攻击: N」「防御: N」，技能标签用「关联属性」「有效距离: X」「威力: X」「范围: …」，消耗用「攻击/动作: X MP/SP」。
- HP/MP/SP/AC 由系统按资源推演自动计算，名册无需填写。
- 该标签只用于启动战斗系统，不得出现在叙事可见文本中；非战斗场景禁止输出；每场战斗只输出一次。
</战斗启动协议>
```

(English gist, if authoring a non-Chinese card: "When a scene becomes a hostile battle, emit exactly one
`<rpt-combat-start>` whose body is a JSON array of enemy objects — `名称/数量/阵营/生命层级/等级/属性/装备/
技能/状态效果`, stats per the card's generation rules; HP/MP/SP are derived; never emit it outside combat
or in visible prose.")

## Verifying
After adding the snippet, follow [combat-poem-manual-tests.md](../../combat-poem-manual-tests.md) §2–§3:
prompt the model into a fight → it emits the tag + roster → **Enter Combat** → the party imports from MVU,
the roster enemies spawn, and the 战斗协议 resolves the fight.
