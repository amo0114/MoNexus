import { useEffect, useLayoutEffect, useState } from 'react'
import { isActionableActivity, isOrderActivity, useAppStore } from '../../stores/appStore'
import { useIslandQueuePause } from '../../hooks/useIslandQueuePause'
import type { OrderIslandPhase } from '../OrderSuccessIsland'

interface LayoutIslandsOptions {
  isMobileViewport: boolean
  /** The mobile search card is open or animating; islands yield to it. */
  searchBusy: boolean
  modalOpen: boolean
}

/** Routes the current island notice to one of the four mobile navbar islands and tracks their visibility. */
export function useLayoutIslands({ isMobileViewport, searchBusy, modalOpen }: LayoutIslandsOptions) {
  // 灵动岛通知（V4）：移动端简短安静级消息（success/info ≤14 字）由 navbar
  // 胶囊短暂承载——默认内容淡出、通知淡入，几何零重排；2.4s 自动消退，
  // 点击即散；搜索卡片展开时让位（降级回横幅 toast）。iOS 灵动岛思路：
  // 轻确认融入既有 chrome，不打断视线流；重要/长文仍走横幅（Toast.tsx）。
  const islandNotice = useAppStore((s) => s.islandNotice)
  const orderNotice = isOrderActivity(islandNotice?.kind) ? islandNotice : null
  const favoriteNotice = islandNotice?.kind === 'favorite' ? islandNotice : null
  const actionNotice = isActionableActivity(islandNotice?.kind) ? islandNotice : null
  const quietNotice = islandNotice && !orderNotice && !favoriteNotice && !actionNotice ? islandNotice : null
  const [actionIslandOpen, setActionIslandOpen] = useState(false)
  const actionIslandVisible = isMobileViewport && actionIslandOpen && !searchBusy
  const [favoriteIslandOpen, setFavoriteIslandOpen] = useState(false)
  const favoriteIslandVisible = isMobileViewport && favoriteIslandOpen && !searchBusy
  const [orderIslandOpen, setOrderIslandOpen] = useState(false)
  const [orderIslandPhase, setOrderIslandPhase] = useState<OrderIslandPhase>('processing')
  const [orderIslandHeight, setOrderIslandHeight] = useState(132)
  const orderIslandVisible = isMobileViewport && orderIslandOpen && !searchBusy
  const [quietIslandOpen, setQuietIslandOpen] = useState(false)
  const quietIslandVisible = isMobileViewport && quietIslandOpen
  const clearIslandNotice = useAppStore((s) => s.clearIslandNotice)
  const demoteIslandNotice = useAppStore((s) => s.demoteIslandNotice)
  const setIslandNoticeAvailable = useAppStore((s) => s.setIslandNoticeAvailable)
  useEffect(() => {
    if (islandNotice && !isOrderActivity(islandNotice.kind) && !isActionableActivity(islandNotice.kind) && (searchBusy || modalOpen)) {
      demoteIslandNotice()
    }
  }, [islandNotice, searchBusy, modalOpen, demoteIslandNotice])
  useEffect(() => {
    if (!islandNotice || isOrderActivity(islandNotice.kind) || isActionableActivity(islandNotice.kind)) return
    const duration = islandNotice.durationMs ?? 2400
    const t = setTimeout(() => clearIslandNotice(islandNotice.id), duration)
    return () => clearTimeout(t)
  }, [islandNotice, clearIslandNotice])
  // Public/auth routes render Toast without Layout. Only advertise the island
  // while this mobile navbar is actually mounted; leaving it demotes an
  // in-flight quiet notification back to the universally visible banner.
  useEffect(() => {
    setIslandNoticeAvailable(isMobileViewport)
    return () => setIslandNoticeAvailable(false)
  }, [isMobileViewport, setIslandNoticeAvailable])
  useIslandQueuePause(searchBusy || modalOpen, isMobileViewport)

  useLayoutEffect(() => {
    if (orderIslandVisible) {
      document.documentElement.style.setProperty(
        '--order-island-bottom', `calc(var(--safe-top) + ${12 + orderIslandHeight}px)`,
      )
    }
    return () => {
      document.documentElement.style.removeProperty('--order-island-bottom')
    }
  }, [orderIslandVisible, orderIslandHeight])

  return {
    islandNotice,
    orderNotice,
    favoriteNotice,
    actionNotice,
    quietNotice,
    actionIslandVisible,
    favoriteIslandVisible,
    orderIslandVisible,
    quietIslandVisible,
    orderIslandPhase,
    orderIslandHeight,
    setActionIslandOpen,
    setFavoriteIslandOpen,
    setOrderIslandOpen,
    setOrderIslandPhase,
    setOrderIslandHeight,
    setQuietIslandOpen,
    clearIslandNotice,
  }
}
