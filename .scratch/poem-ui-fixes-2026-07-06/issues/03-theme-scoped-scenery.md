# PF-03 — Palette switch reskins chrome but not scenery (dusk-locked gradients)

Status: ready-for-agent
Priority: P1

## Problem

The fallback scene gradients hardcode dusk hues in BOTH band surfaces —
`poem-self-surface.html:73-77` and `poem-stage-surface.html:42-46`:

```css
radial-gradient(70% 90% at 22% 42%, #33436a 0%, transparent 55%),
radial-gradient(70% 90% at 88% 30%, #4a3350 0%, transparent 55%),
radial-gradient(60% 80% at 40% 128%, rgba(200, 104, 63, .18), transparent 60%),
linear-gradient(180deg, #1b1626, #160f1f);
```

— and the WORLD avatar placeholder hardcodes `#5a3a52`/`#201622`
(`poem-world-surface.html:51`). Switching to ember/verdant reskins the chrome (`--night` etc.) but
the scene stays cold indigo, and the band's bottom fade (`transparent → var(--night)`) fades a COLD
scene into a WARM night — a visible hue break mid-band (verified in-browser on ember).

## Change

### 1. `poem-themes.css` — four scene vars per palette (+ avatar pair)

Add to the shared `:root` block (dusk defaults) and to each `data-poem-theme` block:

| var | dusk (current values) | frost | ember | verdant |
|---|---|---|---|---|
| `--scene-a` | `#33436a` | `#2c4763` | `#5a3524` | `#27493a` |
| `--scene-b` | `#4a3350` | `#334666` | `#6b3a2a` | `#2f5a44` |
| `--scene-glow` | `rgba(200,104,63,.18)` | `rgba(140,200,216,.12)` | `rgba(209,80,58,.22)` | `rgba(201,138,74,.14)` |
| `--scene-base-a` / `--scene-base-b` | `#1b1626` / `#160f1f` | `#131c2a` / `#0e141f` | `#221510` / `#170e0a` | `#14211a` / `#0e1712` |
| `--av-a` / `--av-b` (avatar) | `#5a3a52` / `#201622` | `#33506a` / `#131c28` | `#6b4028` / `#1d120c` | `#2f5a44` / `#101a14` |

These are starting values in each palette's family (frost moonlit blues, ember forge warmth,
verdant jade twilight) — **eyeball-tune in the preview** so each scene reads as the palette's mood
and the bottom fade into `--night` is seamless (that's the acceptance bar, not the exact hex).
Document the final hexes in `## Comments`.

### 2. Both band surfaces

Replace the hardcoded gradient stops in `.scene` with the vars (same shapes/positions):
`--scene-a`, `--scene-b`, `--scene-glow`, and `linear-gradient(180deg, var(--scene-base-a), var(--scene-base-b))`.
Keep everything else (scanline overlay, `::after` fade, `has-img` path) untouched. The SELF and
STAGE `.scene` rules must stay IDENTICAL in stops/geometry — they form one continuous background.

### 3. WORLD avatar placeholder

`.npc-av` background → `radial-gradient(120% 100% at 35% 25%, var(--av-a), var(--av-b) 70%)`.

## Verification

Preview all three surfaces (SELF 400×856, STAGE 1200×285, WORLD 400×571) in each of the four
palettes (`?theme=`): the scene mood follows the palette; the band→stats fade shows no hue break;
dusk is pixel-identical to before (its vars are the old literals). Screenshots of STAGE in all four
themes. Gate green.

## NON-GOALS

- No change when a real 背景 image is set (`has-img` bypasses the gradient — untouched).
- No shell/app-theme sync (status-doc known limitation, out of scope).
- No `--apply`.

## Size budget

≤ 70 lines across 4 files.
