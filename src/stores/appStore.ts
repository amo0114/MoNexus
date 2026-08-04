import { create } from 'zustand'
import { ConfigRegistry } from '../types/config'
import { getConfigRegistry } from '../api/registry'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface Toast {
  id: number
  message: string
  type: ToastType
}

/** 灵动岛通知：仅安静级（success/info），由 navbar 胶囊短暂承载。 */
export interface IslandNotice {
  id: number
  message: string
  type: 'success' | 'info'
}

/** Keep at most this many toasts on screen; oldest is dropped. */
const MAX_TOASTS = 3

/** 灵动岛收纳的短消息上限（CJK 感知字符数）：超出则走横幅 toast。 */
const ISLAND_MAX_CHARS = 14

interface AppState {
  activeTab: 'store' | 'profile' | 'admin'
  toasts: Toast[]
  /** 灵动岛当前承载的通知（同时只一条，新的顶替旧的并重置计时） */
  islandNotice: IslandNotice | null
  /** Layout 在可承载通知的移动 navbar 挂载时打开；公开页必须回退横幅。 */
  islandNoticeAvailable: boolean
  /** 打开中的模态数（DialogOverlay 挂载计数）：>0 时 navbar 淡出、
      灵动岛通知降级为横幅（模态交互期间岛不可见，反馈不能丢）。 */
  modalDepth: number
  registry: ConfigRegistry | null
  /** 商城搜索/分类（V3 灵动岛）：岛内交互与 StorePage 网格共享同一状态 */
  storeQuery: string
  storeCategory: string
  /** 积分流水 Sheet（V3 角色化 Tab Bar）：Tab Bar「积分」与 Profile 按钮共用 */
  pointsHistoryOpen: boolean
  /** BottomTabBar 下滑自动隐藏状态：吸底浮层（如排行榜 MyRankBar）随之联动 */
  tabbarHidden: boolean
  setActiveTab: (tab: 'store' | 'profile' | 'admin') => void
  setStoreQuery: (q: string) => void
  setStoreCategory: (c: string) => void
  setPointsHistoryOpen: (open: boolean) => void
  setTabbarHidden: (hidden: boolean) => void
  showToast: (message: string, type?: ToastType) => void
  removeToast: (id: number) => void
  clearIslandNotice: () => void
  setIslandNoticeAvailable: (available: boolean) => void
  /** 灵动岛不可用（如搜索卡片展开中）时把通知降级回横幅 toast。 */
  demoteIslandNotice: () => void
  modalOpened: () => void
  modalClosed: () => void
  loadRegistry: () => Promise<void>
}

let toastId = 0

export const useAppStore = create<AppState>()((set, get) => ({
  activeTab: 'store',
  toasts: [],
  islandNotice: null,
  islandNoticeAvailable: false,
  modalDepth: 0,
  registry: null,
  storeQuery: '',
  storeCategory: '全部',
  pointsHistoryOpen: false,
  tabbarHidden: false,

  setActiveTab: (tab) => set({ activeTab: tab }),
  setStoreQuery: (q) => set({ storeQuery: q }),
  setStoreCategory: (c) => set({ storeCategory: c }),
  setPointsHistoryOpen: (open) => set({ pointsHistoryOpen: open }),
  setTabbarHidden: (hidden) => set({ tabbarHidden: hidden }),

  // Auto-dismiss lives in the Toast item component (it owns the exit
  // animation timeline); the store only adds/removes.
  // 同文同型去重：连续触发（如重试风暴）只刷新一条，不叠罗汉。
  //
  // 灵动岛路由：移动端 + 简短 + 安静级（success/info）的通知由 navbar
  // 胶囊短暂承载（iOS 灵动岛思路——轻确认不打断视线流）；重要级
  // （error/warning）、长文、桌面端一律走横幅 toast。
  showToast: (message, type = 'success') => {
    const id = ++toastId
    const quiet = type === 'success' || type === 'info'
    const short = [...message].length <= ISLAND_MAX_CHARS
    const mobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
    // 模态打开期间灵动岛随 navbar 淡出，通知必须降级为横幅（z-80 高于
    // 模态 z-50，反馈可见）——如兑换成功弹窗内「复制发货信息」。
    if (quiet && short && mobile && get().modalDepth === 0 && get().islandNoticeAvailable) {
      set({ islandNotice: { id, message, type } })
      return
    }
    set((state) => ({
      // A normal banner must take ownership of the feedback lane. Keeping a
      // prior island notice alive would produce two competing status regions.
      islandNotice: null,
      toasts: [
        ...state.toasts.filter((t) => !(t.message === message && t.type === type)).slice(-(MAX_TOASTS - 1)),
        { id, message, type },
      ],
    }))
  },

  removeToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  clearIslandNotice: () => set({ islandNotice: null }),

  // Layout unmounts on public/auth routes. A notice must never stay in an
  // unrendered island there, so downgrade any in-flight one atomically.
  setIslandNoticeAvailable: (available) =>
    set((state) => {
      if (available || !state.islandNotice) return { islandNoticeAvailable: available }
      const n = state.islandNotice
      return {
        islandNoticeAvailable: false,
        islandNotice: null,
        toasts: [...state.toasts.slice(-(MAX_TOASTS - 1)), { id: n.id, message: n.message, type: n.type }],
      }
    }),

  modalOpened: () => set((state) => ({ modalDepth: state.modalDepth + 1 })),
  modalClosed: () => set((state) => ({ modalDepth: Math.max(0, state.modalDepth - 1) })),

  demoteIslandNotice: () =>
    set((state) => {
      const n = state.islandNotice
      if (!n) return {}
      return {
        islandNotice: null,
        toasts: [...state.toasts.slice(-(MAX_TOASTS - 1)), { id: n.id, message: n.message, type: n.type }],
      }
    }),

  loadRegistry: async () => {
    try {
      const data = await getConfigRegistry()
      set({ registry: data })
    } catch (err) {
      console.error('Failed to load config registry:', err)
    }
  }
}))
