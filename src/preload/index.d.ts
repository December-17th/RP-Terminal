import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: any & {
      backfillUsageMetrics: (profileId: string, chatId: string) => Promise<unknown[]>
    }
  }
}
