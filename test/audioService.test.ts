import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import * as audio from '../src/renderer/src/plugin/audioService'

const instances: MockAudio[] = []

class MockAudio {
  src: string
  loop = false
  volume = 1
  paused = true
  constructor(src: string) {
    this.src = src
    instances.push(this)
  }
  play(): Promise<void> {
    this.paused = false
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
  }
  addEventListener(): void {}
}

describe('audioService (TH-7)', () => {
  beforeAll(() => {
    ;(globalThis as unknown as { Audio: typeof MockAudio }).Audio = MockAudio
  })
  beforeEach(() => {
    instances.length = 0
    audio.stopAll()
  })

  it('plays background music with mode + volume', () => {
    audio.playBgm('bgm.mp3', { mode: 'loop', volume: 0.5 })
    const a = instances[0]
    expect(a.src).toContain('bgm.mp3')
    expect(a.loop).toBe(true)
    expect(a.volume).toBe(0.5)
    expect(a.paused).toBe(false)
  })

  it("mode 'once' disables looping", () => {
    audio.playBgm('x.mp3', { mode: 'once' })
    expect(instances[0].loop).toBe(false)
  })

  it('replaces the previous track when a new one starts', () => {
    audio.playBgm('a.mp3')
    audio.playBgm('b.mp3')
    expect(instances[0].paused).toBe(true) // first stopped
    expect(instances[1].paused).toBe(false) // second playing
  })

  it('clamps the volume into [0,1]', () => {
    audio.playBgm('a.mp3')
    audio.setBgmVolume(5)
    expect(instances[0].volume).toBe(1)
    audio.setBgmVolume(-2)
    expect(instances[0].volume).toBe(0)
  })

  it('pause / stop control the track', () => {
    audio.playBgm('a.mp3')
    audio.pauseBgm()
    expect(instances[0].paused).toBe(true)
    audio.stopBgm()
    expect(instances[0].src).toBe('')
  })

  it('plays one-shot sound effects', () => {
    audio.playSfx('hit.wav', { volume: 0.3 })
    expect(instances[0].volume).toBe(0.3)
    expect(instances[0].paused).toBe(false)
  })
})
