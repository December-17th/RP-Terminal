#!/usr/bin/env node
/*
 * patch-poem-card.cjs — apply the 命定之诗 combat extension directly to the card PNG.
 *
 * Reads `example .../v4.2.1.png`, writes `v4.2.1+combat.png` (original untouched), patching BOTH the
 * `chara` and `ccv3` tEXt chunks. Idempotent + verifies on write. This is the reproducible record of the
 * lorebook edits (the PNG itself is a binary, untracked artifact). Re-run after editing the inputs.
 *
 * It applies:
 *   1. the combat bundle  → data.extensions.rp_terminal.combat  (from poem-combat-bundle.json)
 *   2. lorebook: a new [战斗启动协议] entry (combat-entry mode choice: emit <rpt-combat-start>+roster,
 *      present 战斗系统 vs AI演绎, pause) — see poem-preset-combat-instructions.md §1/§3
 *   3. lorebook: GATE the existing [战斗协议] (模式门控: AI only resolves the AI-decided path) — §2
 *
 * Run:  node docs/sdk/examples/patch-poem-card.cjs
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '../../..')
const DIR = path.join(ROOT, 'example sillytarvern character card, presets, extensions and scripts')
const SRC = path.join(DIR, 'v4.2.1.png')
const OUT = path.join(DIR, 'v4.2.1+combat.png')
const combat = JSON.parse(fs.readFileSync(path.join(__dirname, 'poem-combat-bundle.json'), 'utf8'))

const KERNEL = '核心指令: 仅当存在明确敌对双方且将会进入战斗时激活，其余非战斗情境禁止触发'
const GATE = `
  模式门控:
    - 本协议仅在玩家选择【AI演绎】模式时激活：即 <战斗启动协议> 给出选择后，玩家以正文继续战斗（回复行动 /“让我继续”/ 直接描写交战）。
    - 若玩家选择/进入【战斗系统】：禁止自行演绎战斗、禁止输出任何战斗面板、禁止结算胜负或伤害——战斗由战斗系统接管。仅在系统交还时继续：收到「战后叙事」请求则依据系统结果叙述结局（不得改写胜负/数值）；收到「临场裁定」请求则只裁定该自定义行动并输出 <rpt-combat-result>。
    - 战斗系统进行期间的普通楼层中，不得主动推进或结算该场战斗。`

const QIDONG = `<战斗启动协议>
当场景进入明确的敌对战斗的临界点（双方将要交手、但尚未开打）时，执行以下流程，且仅执行到第4步为止：
1. 叙述至对峙临界（环境、敌意、起手姿态），不要开打、不要结算任何伤害、不要输出任何战斗面板。
2. 在正文末尾输出一次战斗启动标签，标签体内放置【敌人名册】JSON 数组：
   <rpt-combat-start map="">[ {敌人对象}, … ]</rpt-combat-start>
   每个敌人对象使用与 stat_data 角色相同的字段名：名称(必填)、数量(默认1)、阵营(填“友方”则加入我方，缺省为敌方)、生命层级、等级、属性{力量,敏捷,体质,智力,精神}、装备{部位:{类型,品质,标签[],效果{}}}、技能{名称:{类型,消耗,标签[],效果{}}}、状态效果{}。装备战斗值用「攻击: N」「防御: N」；技能标签用「关联属性」「有效距离: X」「威力: X」「范围: …」；消耗用「攻击/动作: X MP/SP」。敌人数值严格按 <角色生成>/<技能装备道具生成规则>/<品质效果限定规则> 生成；HP/MP/SP 由系统自动派生，名册无需填写。该标签不得出现在玩家可见正文中。
3. 紧接着，明确地向玩家给出二选一（可自然融入叙事，但两个选项都须清晰可辨）：
   · 【进入战斗系统】点击“进入战斗”，由你亲自在战场上指挥这场战斗。
   · 【AI演绎】直接回复你的行动（或“让我继续”），由我（Recorder）按 <战斗协议> 演绎整场战斗。
4. 本回合到此结束：禁止进入 <战斗协议>、禁止输出任何战斗面板、禁止结算胜负或伤害。等待玩家选择。
例外：无需数值结算的纯叙事冲突（碾压性处决、过场、不可逆事件）可不触发本协议，按叙事直接处理。
</战斗启动协议>`

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (b) => {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const makeChunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const tb = Buffer.from(type, 'ascii')
  const cb = Buffer.alloc(4)
  cb.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0)
  return Buffer.concat([len, tb, data, cb])
}

const editCard = (card, log) => {
  const d = card.data || (card.data = {})
  d.extensions = d.extensions || {}
  d.extensions.rp_terminal = Object.assign({}, d.extensions.rp_terminal, { combat })

  const book = d.character_book || (d.character_book = { entries: [] })
  const entries = book.entries || (book.entries = [])
  const find = (re) => entries.find((e) => re.test(e.comment || e.name || (e.keys && e.keys[0]) || ''))

  const zhan = find(/^\[?战斗协议\]?$/)
  if (zhan && typeof zhan.content === 'string') {
    if (zhan.content.includes('模式门控')) log.push('战斗协议: already gated')
    else if (zhan.content.includes(KERNEL)) {
      zhan.content = zhan.content.replace(KERNEL, KERNEL + GATE)
      log.push('战斗协议: gated')
    } else log.push('战斗协议: KERNEL line not found (skipped)')
  } else log.push('战斗协议: entry not found')

  if (find(/战斗启动协议/)) log.push('战斗启动协议: already present')
  else if (zhan) {
    const e = JSON.parse(JSON.stringify(zhan)) // clone for schema-correct fields
    e.id = (zhan.id || 800000) + 1
    e.comment = '[战斗启动协议]'
    e.keys = []
    e.content = QIDONG
    e.insertion_order = (zhan.insertion_order || 1005) + 1
    if (e.extensions) e.extensions.display_index = 9001
    entries.splice(entries.indexOf(zhan), 0, e) // read before 战斗协议
    log.push('战斗启动协议: added (id ' + e.id + ')')
  } else log.push('战斗启动协议: no template entry (skipped)')
}

const buf = fs.readFileSync(SRC)
const out = [buf.slice(0, 8)]
let off = 8
let patched = 0
const log = []
while (off < buf.length) {
  const length = buf.readUInt32BE(off)
  const type = buf.toString('ascii', off + 4, off + 8)
  const total = 12 + length
  if (type === 'tEXt') {
    const data = buf.slice(off + 8, off + 8 + length)
    const z = data.indexOf(0)
    const keyword = data.slice(0, z).toString('latin1')
    if (keyword === 'chara' || keyword === 'ccv3') {
      const card = JSON.parse(Buffer.from(data.slice(z + 1).toString('latin1'), 'base64').toString('utf8'))
      log.push('--- ' + keyword + ' ---')
      editCard(card, log)
      const nb64 = Buffer.from(JSON.stringify(card), 'utf8').toString('base64')
      out.push(makeChunk('tEXt', Buffer.concat([Buffer.from(keyword + '\0', 'latin1'), Buffer.from(nb64, 'latin1')])))
      patched++
      off += total
      continue
    }
  }
  out.push(buf.slice(off, off + total))
  if (type === 'IEND') break
  off += total
}
fs.writeFileSync(OUT, Buffer.concat(out))
console.log('patched ' + patched + ' chunk(s) -> ' + path.relative(ROOT, OUT))
console.log(log.join('\n'))
