import { create } from 'zustand'
import { ConfigRegistry } from '../types/config'
import { getConfigRegistry } from '../api/registry'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface Toast {
  id: number
  message: string
  type: ToastType
}

/** Keep at most this many toasts on screen; oldest is dropped. */
const MAX_TOASTS = 3

interface AppState {
  activeTab: 'store' | 'profile' | 'admin'
  toasts: Toast[]
  registry: ConfigRegistry | null
  setActiveTab: (tab: 'store' | 'profile' | 'admin') => void
  showToast: (message: string, type?: ToastType) => void
  removeToast: (id: number) => void
  loadRegistry: () => Promise<void>
}

let toastId = 0

export const useAppStore = create<AppState>()((set) => ({
  activeTab: 'store',
  toasts: [],
  registry: null,

  setActiveTab: (tab) => set({ activeTab: tab }),

  // Auto-dismiss lives in the Toast item component (it owns the exit
  // animation timeline); the store only adds/removes.
  showToast: (message, type = 'success') => {
    const id = ++toastId
    set((state) => ({
      toasts: [...state.toasts.slice(-(MAX_TOASTS - 1)), { id, message, type }],
    }))
  },

  removeToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  loadRegistry: async () => {
    try {
      const data = await getConfigRegistry()
      set({ registry: data })
    } catch (err) {
      console.error('Failed to load config registry:', err)
    }
  }
}))
