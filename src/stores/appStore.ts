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
  /** 商城搜索/分类（V3 灵动岛）：岛内交互与 StorePage 网格共享同一状态 */
  storeQuery: string
  storeCategory: string
  /** 积分流水 Sheet（V3 角色化 Tab Bar）：Tab Bar「积分」与 Profile 按钮共用 */
  pointsHistoryOpen: boolean
  setActiveTab: (tab: 'store' | 'profile' | 'admin') => void
  setStoreQuery: (q: string) => void
  setStoreCategory: (c: string) => void
  setPointsHistoryOpen: (open: boolean) => void
  showToast: (message: string, type?: ToastType) => void
  removeToast: (id: number) => void
  loadRegistry: () => Promise<void>
}

let toastId = 0

export const useAppStore = create<AppState>()((set) => ({
  activeTab: 'store',
  toasts: [],
  registry: null,
  storeQuery: '',
  storeCategory: '全部',
  pointsHistoryOpen: false,

  setActiveTab: (tab) => set({ activeTab: tab }),
  setStoreQuery: (q) => set({ storeQuery: q }),
  setStoreCategory: (c) => set({ storeCategory: c }),
  setPointsHistoryOpen: (open) => set({ pointsHistoryOpen: open }),

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
