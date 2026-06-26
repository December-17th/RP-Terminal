# 命定之诗 — 战斗进入与模式选择 (preset/lorebook paste-in)

Combat has **two modes**, chosen by the **player at the start of each fight**:

- **【战斗系统】** — the player commands the fight on RP Terminal's grid engine. The AI does **not** narrate
  the fight; it only resumes when the engine hands back (end-of-combat narration / mid-fight adjudication).
- **【AI演绎】** — the AI resolves the whole fight narratively via `<战斗协议>` (the card's classic behavior).

The engine is entered via the **⚔ Enter Combat** button, which the app shows whenever the AI emits the
`<rpt-combat-start>` cue. So the lorebook's job is: at combat onset, **emit the cue + the enemy roster**
(this enables the button), **present the choice, and pause** — then route based on what the player does.
This needs no app changes; it replaces the card's auto-firing combat behavior.

> Paste §1 into the preset (where the old auto-combat trigger / `🚫正文cot@cancannide` action flow sat),
> and apply §2 to the `<战斗协议>` worldbook entry. §3 is the roster format. The item-format rules are in
> [poem-item-combat-compat.md](poem-item-combat-compat.md).

## §1 — `<战斗启动协议>` (replaces auto-firing combat)

```
<战斗启动协议>
当场景进入明确的敌对战斗的临界点（双方将要交手、但尚未开打）时，执行以下流程，且仅执行到第4步为止：
1. 叙述至对峙临界（环境、敌意、起手姿态），不要开打、不要结算任何伤害、不要输出任何战斗面板。
2. 在正文末尾输出一次战斗启动标签，标签体内放置【敌人名册】JSON（见 <名册格式>）：
   <rpt-combat-start map="">[ {敌人对象}, ... ]</rpt-combat-start>
   名册中敌人的 生命层级/属性/装备/技能/状态效果 严格按 <角色生成>/<技能装备道具生成规则>/<品质效果限定规则>
   生成；HP/MP/SP 由系统按资源推演自动计算，名册无需填写。该标签不出现在玩家可见正文中。
3. 紧接着，明确地向玩家给出二选一（可自然融入叙事，但必须让两个选项都清晰可辨）：
   - 【进入战斗系统】点击"进入战斗"，由你亲自在战场上指挥这场战斗。
   - 【AI演绎】直接回复你的行动（或"让我继续"），由我（Recorder）按战斗协议演绎整场战斗。
4. 本回合到此结束：禁止进入 <战斗协议>、禁止输出 {战况总览}/{行动顺序}/{攻击行动} 等任何战斗面板、
   禁止结算胜负或伤害。等待玩家的选择。
例外：无需数值结算的纯叙事冲突（碾压性处决、过场、不可逆事件）可不触发本协议，按叙事直接处理。
</战斗启动协议>
```

## §2 — gate `<战斗协议>` (edit its 核心指令)

Add to `<战斗协议>` 的「核心指令」：

```
- 模式门控：本协议仅在玩家选择【AI演绎】时激活——即在 <战斗启动协议> 给出选择后，玩家以正文继续战斗
  （回复行动 / "让我继续" / 直接描写交战），此时才按本协议完整演绎。
- 若玩家选择/进入【战斗系统】：禁止自行演绎战斗、禁止输出任何战斗面板、禁止结算胜负或伤害——战斗由
  RP Terminal 引擎接管。你只在引擎交还时继续：
    · 收到「战后叙事」请求 → 依据系统给出的结果叙述战斗结局，不得改写引擎裁定的胜负或数值。
    · 收到「临场裁定」请求（玩家的自定义行动）→ 只裁定该行动，按要求输出 <rpt-combat-result>。
- 战斗系统进行期间的普通楼层中，不得主动推进或结算该场战斗。
```

(The card's `<核心数值表>` / `<角色生成>` / item-generation rules are **shared** by both modes — the engine
derives from the same numbers the AI would use — so they don't change.)

## §3 — `<名册格式>` (the enemy roster the cue carries)

Each roster entry uses the card's own stat_data field names (so the engine parses it like a character):
`名称`(req) · `数量`(default 1) · `阵营`(`"友方"`→joins the party; default enemy) · `生命层级` · `等级` ·
`属性{力量,敏捷,体质,智力,精神}` · `装备{部位:{类型,品质,标签[],效果{}}}` · `技能{名称:{类型,消耗,标签[],效果{}}}` ·
`状态效果{}`. 装备标签用「攻击: N」「防御: N」；技能标签用「关联属性」「有效距离: X」「威力: X」「范围: …」；
消耗用「攻击/动作: X MP/SP」。HP/MP/SP/AC 由系统派生。

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

## Verifying
Follow [combat-poem-manual-tests.md](../../combat-poem-manual-tests.md) §2–§3: prompt the scene to the
brink of a fight → the AI emits the cue+roster and **offers the two modes**, without resolving →
**either** click *Enter Combat* (engine runs it) **or** reply to continue (the AI runs `<战斗协议>`).
