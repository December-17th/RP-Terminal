/**
 * Renderer-side audio runtime for the script/plugin API (TH-7). Background music is a
 * single shared track (starting a new one replaces the old); sound effects are fire-and-
 * forget one-shots. Playback happens in the trusted parent window (not the sandbox), so
 * scripts get audio without the iframe needing network/media permissions.
 *
 * Clean-room: our own API surface (reimplemented from the public Tavern-Helper audio docs).
 */

export type BgmMode = 'loop' | 'once'

let bgm: HTMLAudioElement | null = null
const sfx = new Set<HTMLAudioElement>()

const clampVol = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1
}

/** Start (or replace) the background track. */
export const playBgm = (
  url: string,
  opts: { mode?: BgmMode; volume?: number } = {}
): boolean => {
  stopBgm()
  const a = new Audio(String(url))
  a.loop = opts.mode !== 'once'
  a.volume = clampVol(opts.volume ?? 1)
  bgm = a
  void a.play().catch(() => {
    /* autoplay may be blocked until a user gesture — non-fatal */
  })
  return true
}

export const pauseBgm = (): boolean => {
  bgm?.pause()
  return true
}

export const resumeBgm = (): boolean => {
  void bgm?.play().catch(() => {})
  return true
}

export const stopBgm = (): boolean => {
  if (bgm) {
    bgm.pause()
    bgm.src = ''
    bgm = null
  }
  return true
}

export const setBgmVolume = (volume: number): boolean => {
  if (bgm) bgm.volume = clampVol(volume)
  return true
}

/** Play a one-shot sound effect; self-cleans when it ends. */
export const playSfx = (url: string, opts: { volume?: number } = {}): boolean => {
  const a = new Audio(String(url))
  a.volume = clampVol(opts.volume ?? 1)
  sfx.add(a)
  a.addEventListener('ended', () => sfx.delete(a))
  void a.play().catch(() => sfx.delete(a))
  return true
}

/** Stop everything (used on teardown). */
export const stopAll = (): void => {
  stopBgm()
  for (const a of sfx) a.pause()
  sfx.clear()
}
