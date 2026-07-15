/** Minimal Electron stub for vitest — just enough for main-process modules to import. */
export const app = {
  getPath: (): string => '/tmp/rpt-test'
}

export const BrowserWindow = {
  getAllWindows: (): unknown[] => [],
  fromWebContents: (): null => null
}

// Reversible "encryption" so settingsService encrypt/decrypt round-trips in tests.
export const safeStorage = {
  isEncryptionAvailable: (): boolean => true,
  encryptString: (s: string): Buffer => Buffer.from(s, 'utf-8'),
  decryptString: (b: Buffer): string => b.toString('utf-8')
}

// Minimal nativeImage stub: reports an empty image so avatar thumb GENERATION treats the source as
// undecodable and falls through to the bounded-original fallback rule (the pure seam under test).
export const nativeImage = {
  createFromPath: (): {
    isEmpty: () => boolean
    getSize: () => { width: number; height: number }
    resize: () => unknown
    toPNG: () => Buffer
  } => ({
    isEmpty: (): boolean => true,
    getSize: (): { width: number; height: number } => ({ width: 0, height: 0 }),
    resize(): unknown {
      return this
    },
    toPNG: (): Buffer => Buffer.from('')
  })
}

export const ipcMain = { handle: (): void => {} }
export const dialog = {}
export const shell = {}
export const contextBridge = { exposeInMainWorld: (): void => {} }
export const ipcRenderer = {
  invoke: async (): Promise<void> => {},
  on: (): void => {},
  removeListener: (): void => {}
}

export default {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  contextBridge,
  ipcRenderer,
  safeStorage,
  nativeImage
}
