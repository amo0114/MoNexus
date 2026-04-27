import { create } from 'zustand'

export interface Toast {
  id: number
  message: string
  type: 'success' | 'error'
}

interface AppState {
  activeTab: 'store' | 'profile' | 'admin'
  toasts: Toast[]
  setActiveTab: (tab: 'store' | 'profile' | 'admin') => void
  showToast: (message: string, type?: 'success' | 'error') => void
  removeToast: (id: number) => void
}

let toastId = 0

export const useAppStore = create<AppState>()((set) => ({
  activeTab: 'store',
  toasts: [],

  setActiveTab: (tab) => set({ activeTab: tab }),

  showToast: (message, type = 'success') => {
    const id = ++toastId
    set((state) => ({ toasts: [...state.toasts, { id, message, type }] }))
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
    }, 2800)
  },

  removeToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}))
