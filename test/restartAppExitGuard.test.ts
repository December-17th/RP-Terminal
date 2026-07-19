import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

/**
 * Classic Narrator plan, Milestone 4 — the `restart-app` exit surface.
 *
 * `app.relaunch()` + `app.exit(0)` terminates the process immediately: electron emits NEITHER
 * `before-quit` NOR `will-quit`, so this channel sailed past the exit guard AND past the shutdown
 * cleanup that `will-quit` runs. This suite drives the REAL storageIpc handler, the REAL appExit
 * singleton guard, and the REAL exitGuard decision logic; only electron and the leaf services
 * (the signal, the DB handles, the runtime shutdown, logging) are mocked.
 */

const mockApp = vi.hoisted(() => ({ relaunch: vi.fn(), exit: vi.fn(), quit: vi.fn() }))
const mockDialog = vi.hoisted(() => ({ showMessageBox: vi.fn(), showOpenDialog: vi.fn() }))
vi.mock('electron', () => ({
  app: mockApp,
  dialog: mockDialog,
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null) }
}))

const mockActiveWork = vi.hoisted(() => ({ hasActiveBackgroundWork: vi.fn(() => false) }))
vi.mock('../src/main/services/activeWork', () => mockActiveWork)

const mockRuntime = vi.hoisted(() => ({ shutdownInvocationRuntime: vi.fn() }))
vi.mock('../src/main/services/agentRuntime/InvocationRuntimeService', () => mockRuntime)

const mockSessionDb = vi.hoisted(() => ({ closeAll: vi.fn() }))
vi.mock('../src/main/services/sessionDbService', () => mockSessionDb)

vi.mock('../src/main/services/logService', () => ({ log: vi.fn() }))
vi.mock('../src/main/services/storageService', () => ({ getAppDir: () => '/data' }))
vi.mock('../src/main/services/locationPointer', () => ({
  readLocationPointer: () => null,
  writeLocationPointer: vi.fn()
}))

const { registerStorageIpc } = await import('../src/main/ipc/storageIpc')
const { appExitGuard } = await import('../src/main/appExit')
const { setGuardMainWindow } = await import('../src/main/ipc/ipcGuards')

// The gate only runs a handler for the app's own top frame, so the suite presents that identity.
const mainFrame = { url: 'app://top' }
const mainWc = { mainFrame } as unknown as IpcMainInvokeEvent['sender']
const topFrameEvent = { sender: mainWc, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent

/** Register storageIpc against a fake ipcMain and hand back the `restart-app` handler. */
const restartHandler = () => {
  const handlers = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>()
  const ipcMain = {
    handle: (channel: string, handler: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  } as unknown as IpcMain
  registerStorageIpc(ipcMain)
  const handler = handlers.get('restart-app')
  if (!handler) throw new Error('restart-app was not registered')
  return (): Promise<unknown> => Promise.resolve(handler(topFrameEvent))
}

describe('restart-app goes through the exit guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setGuardMainWindow({ webContents: mainWc, on: () => {} } as never)
    mockActiveWork.hasActiveBackgroundWork.mockReturnValue(false)
  })

  it('restarts immediately with no active work — unchanged behavior, no dialog', async () => {
    await restartHandler()()

    expect(mockDialog.showMessageBox).not.toHaveBeenCalled()
    expect(mockApp.relaunch).toHaveBeenCalledTimes(1)
    expect(mockApp.exit).toHaveBeenCalledWith(0)
  })

  it('prompts and does NOT restart when the prompt is cancelled', async () => {
    mockActiveWork.hasActiveBackgroundWork.mockReturnValue(true)
    mockDialog.showMessageBox.mockResolvedValue({ response: 1 }) // "Keep working"

    await restartHandler()()

    expect(mockDialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(mockApp.relaunch).not.toHaveBeenCalled()
    expect(mockApp.exit).not.toHaveBeenCalled()
    // Nothing was torn down, so the in-flight work really does keep running.
    expect(mockRuntime.shutdownInvocationRuntime).not.toHaveBeenCalled()
    expect(mockSessionDb.closeAll).not.toHaveBeenCalled()
  })

  it('runs the full will-quit cleanup before relaunching when confirmed', async () => {
    mockActiveWork.hasActiveBackgroundWork.mockReturnValue(true)
    mockDialog.showMessageBox.mockResolvedValue({ response: 0 }) // "Quit anyway"

    const order: string[] = []
    mockRuntime.shutdownInvocationRuntime.mockImplementation(() => order.push('shutdown'))
    mockSessionDb.closeAll.mockImplementation(() => order.push('closeAll'))
    mockApp.relaunch.mockImplementation(() => order.push('relaunch'))
    mockApp.exit.mockImplementation(() => order.push('exit'))

    await restartHandler()()

    // app.exit(0) never fires will-quit, so the cleanup must have run explicitly, and BEFORE the
    // process is torn down — otherwise WAL checkpoints and Windows file locks are lost.
    expect(order).toEqual(['shutdown', 'closeAll', 'relaunch', 'exit'])
  })

  // The only path that can leave the process alive AFTER the guard has latched: if relaunch throws,
  // the app survives with `confirmed` armed and the NEXT quit would skip its prompt entirely.
  it('disarms the confirmation latch when relaunch throws, so the next exit still prompts', async () => {
    mockActiveWork.hasActiveBackgroundWork.mockReturnValue(true)
    mockDialog.showMessageBox.mockResolvedValue({ response: 0 })
    mockApp.relaunch.mockImplementation(() => {
      throw new Error('relaunch unavailable')
    })

    await expect(restartHandler()()).rejects.toThrow('relaunch unavailable')
    expect(mockApp.exit).not.toHaveBeenCalled()

    // Latch disarmed: a following quit re-asks rather than sailing through on the stale yes.
    mockDialog.showMessageBox.mockClear()
    mockDialog.showMessageBox.mockResolvedValue({ response: 1 })
    const event = { prevented: 0, preventDefault: () => (event.prevented += 1) }
    appExitGuard.handleExitRequest(event)
    await vi.waitFor(() => expect(mockDialog.showMessageBox).toHaveBeenCalledTimes(1))
    expect(event.prevented).toBe(1)
  })
})
