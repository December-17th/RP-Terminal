import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import {
  GATED_CHANNELS,
  gate,
  isAppTopFrame,
  setGuardMainWindow,
  guardMainWebContents,
  IpcSenderRejectedError
} from '../src/main/ipc/ipcGuards'

/**
 * Card-trust-boundary issue 02 — main-side sender gating for real-harm IPC channels.
 *
 * The gate runs a handler ONLY when the caller IS the app's main-window top frame. A card iframe
 * (a sub-frame of the same webContents), a WCV page (a different webContents), and a destroyed
 * frame (null senderFrame) must all be rejected — with a typed, logged rejection, never a throw
 * that crashes main. These are table-driven off the exported GATED_CHANNELS source of truth.
 */

// Fakes: the app main window's webContents has a `mainFrame`; a WCV is a *different* webContents.
const mainFrame = { url: 'app://top' }
const mainWc = { mainFrame } as unknown as IpcMainInvokeEvent['sender']
const mainWin = { webContents: mainWc, on: () => {} }

const wcvMainFrame = { url: 'rpt-card://card' }
const wcvWc = { mainFrame: wcvMainFrame } as unknown as IpcMainInvokeEvent['sender']

type FakeEvent = Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>

// The four sender identities the gate must decide on. `allowed` is the expected verdict.
const SENDER_CASES: { name: string; event: FakeEvent; allowed: boolean }[] = [
  {
    name: 'app top frame',
    event: { sender: mainWc, senderFrame: mainFrame as never },
    allowed: true
  },
  {
    name: 'non-main senderFrame (card iframe, same webContents)',
    event: { sender: mainWc, senderFrame: { url: 'about:srcdoc' } as never },
    allowed: false
  },
  {
    name: 'null senderFrame (destroyed frame)',
    event: { sender: mainWc, senderFrame: null as never },
    allowed: false
  },
  {
    name: 'WCV-like sender (different webContents)',
    event: { sender: wcvWc, senderFrame: wcvMainFrame as never },
    allowed: false
  }
]

beforeEach(() => {
  // Wire the guard to the fake main window; silence the reject log so the run stays quiet.
  setGuardMainWindow(mainWin as never)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('isAppTopFrame predicate', () => {
  for (const c of SENDER_CASES) {
    it(`${c.allowed ? 'accepts' : 'rejects'} ${c.name}`, () => {
      expect(isAppTopFrame(c.event, guardMainWebContents())).toBe(c.allowed)
    })
  }

  it('rejects when no main window is registered (null mainWc)', () => {
    const topEvent: FakeEvent = { sender: mainWc, senderFrame: mainFrame as never }
    expect(isAppTopFrame(topEvent, null)).toBe(false)
  })
})

describe('gate() over every GATED_CHANNEL', () => {
  it('exposes a non-empty, unique channel list', () => {
    expect(GATED_CHANNELS.length).toBeGreaterThan(0)
    expect(new Set(GATED_CHANNELS).size).toBe(GATED_CHANNELS.length)
  })

  for (const channel of GATED_CHANNELS) {
    for (const c of SENDER_CASES) {
      it(`${channel}: ${c.allowed ? 'runs for' : 'rejects'} ${c.name}`, async () => {
        const handler = vi.fn((_e: IpcMainInvokeEvent, arg: string) => `ran:${arg}`)
        const wrapped = gate(channel, handler)

        if (c.allowed) {
          const out = wrapped(c.event as IpcMainInvokeEvent, 'payload')
          expect(out).toBe('ran:payload')
          expect(handler).toHaveBeenCalledTimes(1)
        } else {
          const out = wrapped(c.event as IpcMainInvokeEvent, 'payload')
          await expect(out as Promise<unknown>).rejects.toBeInstanceOf(IpcSenderRejectedError)
          await expect(out as Promise<unknown>).rejects.toMatchObject({
            code: 'IPC_SENDER_REJECTED',
            channel
          })
          expect(handler).not.toHaveBeenCalled()
        }
      })
    }
  }
})
