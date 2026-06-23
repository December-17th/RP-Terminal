import { create } from 'zustand'

/** Transient toasts from the sandboxed runtime (card scripts + plugins), shown
 * by a single <ToastStack/> at the app root so the two runtimes don't render
 * overlapping stacks. */
interface Toast {
  id: number
  msg: string
}

interface ToastState {
  toasts: Toast[]
  push: (msg: string) => void
}

let seq = 0

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (msg) => {
    const id = ++seq
    set((s) => ({ toasts: [...s.toasts, { id, msg }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3200)
  }
}))
