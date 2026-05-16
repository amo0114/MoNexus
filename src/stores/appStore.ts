import { create } from 'zustand'
import { ConfigRegistry } from '../types/config'
import { getConfigRegistry } from '../api/registry'

export interface Toast {
  id: number
  message: string
  type: 'success' | 'error'
}

interface AppState {
  activeTab: 'store' | 'profile' | 'admin'
  toasts: Toast[]
  registry: ConfigRegistry | null
  setActiveTab: (tab: 'store' | 'profile' | 'admin') => void
  showToast: (message: string, type?: 'success' | 'error') => void
  removeToast: (id: number) => void
  loadRegistry: () => Promise<void>
}

let toastId = 0

export const useAppStore = create<AppState>()((set) => ({
  activeTab: 'store',
  toasts: [],
  registry: null,

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
    
  loadRegistry: async () => {
    try {
      const data = await getConfigRegistry()
      set({ registry: data })
    } catch (err) {
      console.error('Failed to load config registry:', err)
    }
  }
}))
