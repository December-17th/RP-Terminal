# DuelView "real game" pass — card art + STS board + animations — Design

Status: **Design in progress (2026-06-30).** Make the native `DuelView` (v1 core fight loop, already built —
[2026-06-30-native-duelview-design.md](2026-06-30-native-duelview-design.md)) **look and feel like a real card
game**: a proper TCG-style card with an importable face, a Slay-the-Spire board layout, and a CSS/auto-animate
juice layer. Builds *on* the existing DuelView stack (`duelService`/`duelIpc`/`duelStore`/`DuelView`); the engine,
service, IPC, and store are unchanged — this is a **renderer-visual** redesign.

Plus one small, independent companion task (§7): **expose the `motion` animation lib to card authors** (NOT used by
the native view).

---

## 0. Locked decisions (owner Q&A + visual companion, 2026-06-30)

1. **Card = TCG frame (companion direction "A").** A framed card: cost orb overlapping the top-left, a large **face**
   panel, and a compact text strip at the bottom. Rarity-colored frame + soft glow (theme tokens).
2. **Face 70% / text 30%.** The face dominates the upper ~70% of the card; the bottom ~30% is a condensed strip:
   **name → type·rarity·attr → one stat+effect line → cost / 评级 foot**, with a gradient fade so text reads over
   the face edge.
3. **Face is an importable image, with a glyph fallback.** When the ability resolves a **World Assets `卡面`** image
   (by its `artKey` / name), the face shows that image; otherwise a tinted panel with the **FontAwesome type glyph**
   (⚔ attack / 🛡 defend / ✨ buff / ➕ heal / 🔥 etc.). No painted art is required to ship.
4. **Board = Slay-the-Spire classic (companion direction "A").** Enemies in a row up top with their **telegraphed
   intent** above each; the player party tucked bottom-left (lead **ringed**); a bottom band of **energy orb (left)
   · fanned hand (center) · End Turn (right)**. Round counter top-left.
5. **Animations = auto-animate + CSS** (no animation library in the native view). `@formkit/auto-animate` (~2 KB, MIT)
   handles hand **enter/leave/reorder**; everything else is CSS keyframes/transitions, reusing the existing
   `@keyframes rpt-combat-float` (floating numbers) and the `rpt-pulse`/`rpt-toast-in` patterns.
6. **Card-play motion = approximated fly-to-target.** The played card tweens toward the target enemy's position
   (a measured CSS transform) then fades into the impact — "launches at the enemy" without the `motion` lib.
7. **Screen shake = subtle** (small, quick, heavy-hits only).
8. **Theming preserved.** Every color stays an RPT theme token (`--rpt-*` / `--rpt-duel-*`), legible across
   dark / carbon / light ([[rpt-polished-themeable-ui]]). The face-over-text fade keeps the bottom strip legible
   regardless of the face image.
9. **All key visuals are optional imported assets (World Assets), each with a fallback** (§4): the **card face**
   (卡面, §0.3), the **enemy avatar**, and the **fight background**. Ally avatars reuse the existing World Assets
   portraits. Nothing requires art — every slot falls back (type glyph / tinted foe unit / gradient battlefield),
   so the view ships pretty with zero imported art and "lights up" as a world author adds assets.

---

## 1. The card (`DuelCard`)

Extract the in-hand card into its own renderer component (`DuelView` currently inlines it). Anatomy:

- **Frame:** `border: 2px var(--rpt-duel-card-border)` tinted by **rarity** (`--rpt-duel-rarity-*`, a new derived set
  — see §3), soft outer glow, `--rpt-duel-card-bg` base; rounded; `overflow:hidden`.
- **Cost orb:** circular, overlapping top-left, `--rpt-duel-energy` gradient, the card's `energyCost`.
- **Face (~70%):** an `<img>` when a face URL resolves (§4), else a rarity/type-tinted panel centered on the
  **type glyph**; a bottom gradient fade into the card bg.
- **Text strip (~30%, bottom-aligned):** `name` (bold) · `type·rarity·scalingAttr` (rarity-colored, small) · one
  condensed `power + effectLines` line · a foot row `resourceCost · 评级` (rating optional). All from the existing
  `catalog[abilityId]` ext (品质/威力/关联属性/消耗/effect) — same data the v1 card already reads.
- **States:** hover-lift (`translateY` + glow), **selected** lift-higher + ring (`--rpt-duel-selected`), disabled
  dim when `busy`/over.

## 2. The board (`DuelView` layout — STS classic)

A single `.rpt-duel-board` stage (relative-positioned regions):

- **Stage background** — an optional imported **fight background** image (§4) behind the board; else the gradient
  "battlefield" (a token-driven radial). A subtle dark scrim keeps units/text readable over any background.
- **Enemies** — a centered row near the top; each enemy unit = **avatar** (imported §4, else a tinted foe glyph) +
  name + **HP bar** (token tween) + **block** badge (⛊), with its **intent** bubble above (`⚔`+preview / `🛡` /
  `✨` / `➕`), pulsing.
- **Party** — bottom-left cluster; each ally unit (lead **ringed** with `--rpt-duel-selected`), HP bar + block.
- **Bottom band:** **energy orb** (far left, `current/max`), the **fanned hand** (center; cards arc via per-index
  rotate/translate, lift on hover), **End Turn** button (far right). **Round** counter top-left.
- **Targeting** (unchanged logic from the v1 fix): pick an attack card → enemies become targetable (highlight) →
  click an enemy; 格挡/self cards auto-play. The selected card and the targetable enemies get clear affordance
  states.

## 3. Animations (auto-animate + CSS)

| Moment | Technique |
| --- | --- |
| Hand draw (turn start) | cards deal in staggered — `@keyframes` enter + `animation-delay` per index, or auto-animate on mount |
| Card hover / select | CSS `transition: transform` lift; selected lifts higher + ring |
| Hand enter / leave / reorder | **`@formkit/auto-animate`** on the hand container — drawn cards slide in, played/discarded animate out, hand reflows |
| Card play | the card lifts + glows, then **tweens toward the target** (measured transform to the enemy's rect) and fades |
| Impact | **floating damage/heal/block numbers** over the target (reuse `rpt-combat-float` + the `lastEvents`/`eventSeq` feed already in `duelStore`); target **HP-bar width tween**; a hit **flash** |
| Block ⛊ | shield **pop** on gain, **shatter** keyframe on break; energy orb **pulse** on spend/refill |
| Enemy phase (end turn) | enemies act in sequence — a **lunge + flash** + damage numbers on the party, **paced** (a short delay between each, driven in `duelStore.endTurn` by stepping through the resolved `events`) |
| Heavy hit | **subtle screen shake** keyframe on the board container |
| Lead-swap | a brief transition when the ring moves to a new lead |
| Victory / Defeat | a **flourish overlay** (scale-in + glow) over a dimmed board |

The `events` returned by `endLeadTurn` already describe what happened (damage/heal/miss per target); the renderer
pacing reads them to sequence the enemy-phase animation — **no engine/service change needed**, only the renderer
consumes the existing `events` more richly (today `duelStore` already carries `lastEvents`/`eventSeq`).

## 4. Importable assets (World Assets — all optional, with fallbacks)

Every key visual resolves an image via the **World Assets** layer (the RPT-native asset store / `rptasset://`, the
same layer the party panel + 战斗 tab use). Each slot is optional and falls back, so the view ships fully working
with zero art; a world author "importing" an asset lights up that slot.

| Slot | Source key | Fallback |
| --- | --- | --- |
| **Card face** (`DuelCard`) | the ability's `artKey` / a `卡面` name-convention | tinted panel + FontAwesome **type glyph** |
| **Enemy avatar** (board enemy unit) | the enemy's name/template (哥布林, 头目, …) — a portrait/`头像` lookup | tinted circle + a foe glyph (👺 / the type) |
| **Fight background** (board stage) | a per-world/encounter `战斗背景` key (a sensible default) | the gradient "battlefield" stage (token radial) |
| **Ally avatar** (board party unit) | the existing World Assets portrait (`头像`) — **reused** | initial / glyph chip (as today) |

Implementation note: the card face, enemy avatar, and fight background may need **new asset types/lookups** in the
World Assets layer (`卡面`, an enemy-portrait lookup, `战斗背景`). Each is a small, bounded addition grounded against
the asset store in the plan; the fallbacks de-risk all of them — the view is correct and pretty even before any
import. Resolution is renderer-side (the native DuelView reads the asset store / `rptasset://` directly; it is not a
card page, so it does not use the `assetUrl` host method).

## 5. Theming, boundaries, testing

- **Tokens only.** New derived tokens for rarity frames + the richer card/board go in `assets/index.css :root`
  (`--rpt-duel-rarity-common…mythic`, plus any energy/intent/shake helpers), `color-mix` from base tokens, paired
  per the WCAG-AA contrast rule across dark/carbon/light. The face-over-text **fade** guarantees the bottom strip
  stays legible over any face image. (This also resolves the v1 light-theme rarity-label note — rarity now lives on
  the frame, not small text.)
- **Boundaries unchanged.** Engine/service/IPC/store untouched (the store already exposes state + `lastEvents`);
  this is `DuelView.tsx` (+ a new `DuelCard.tsx`) + `index.css` + the auto-animate dep + the face-asset resolve.
  `npm run check:deps` stays green; `@formkit/auto-animate` is a renderer dep.
- **Testing.** No new headless logic (engine/service unchanged) → no new unit tests required; the gate stays
  `npm run typecheck && npm run check:deps && npm run test`. Verified **manually** via the mock-duel button: the
  full juice (draw, play→fly→impact, HP tween, enemy phase, shake, win/lose) + a **cross-theme legibility pass**
  (dark/carbon/light).

## 6. Non-goals (this pass)

- No new combat/duel rules, rewards, deck-editing, or the from-MVU enemy roster (still deferred from v1).
- No `motion`/physics library in the **native** view (auto-animate + CSS only).
- No requirement that art exists — painted 卡面 images are author-supplied; the glyph fallback is always present.

## 7. Related independent task — expose `motion` to card authors

Separate from the native juice pass (different subsystem): add the **`motion`** animation lib to the **card runtime
environment** so *card-authored* UIs can opt into it, alongside the existing assumed libs (jQuery/-UI, Vue, Pinia,
Tailwind, FontAwesome). The native DuelView does **not** use it — "let the card creator decide."

- **Where:** the card-env lib set (`src/shared/cardEnv.ts` declares the CDN URLs; the per-realm `libTags` is composed
  in each transport — inline `cardBridge` + WCV `wcvPreload`). Add a `MOTION_JS_URL` (jsDelivr `motion` UMD/global
  build) and include it in both transports' `libTags` **at parity** (the shared-runtime discipline), or vendor it if
  the others are vendored. Confirm the global name cards reference.
- **SDK obligation:** a new assumed env lib is a card-facing surface → document it in `docs/sdk/` (the env/lib
  inventory) + `docs/compat-comparison.md` per `CLAUDE.md`'s "touch X → update Y."
- **Scope:** small; gets its **own** short plan (independently shippable). Captured here so it isn't lost.

---

## 8. Decomposition

- **Plan A — DuelView juice pass** (this spec §1–§6): the `DuelCard` extraction + TCG card, STS board layout, the
  auto-animate dep + the CSS animation layer, the face-asset resolve. One renderer-focused plan, manual + cross-theme
  verification.
- **Plan B — `motion` card env lib** (§7): a small card-runtime/SDK plan, independent of Plan A.

---

## 9. Related

- The v1 it builds on: [2026-06-30-native-duelview-design.md](2026-06-30-native-duelview-design.md).
- Polished/themeable expectation: memory `rpt-polished-themeable-ui`.
- World Assets (`卡面`/`artKey`): the World Assets layer; the `DuelPreview.artKey` field.
- Card env libs + the two transports at parity: `src/shared/cardEnv.ts`, the `thRuntime` discipline.
