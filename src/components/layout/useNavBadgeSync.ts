import { useEffect } from 'react'
import { useAuthStore } from '../../stores/authStore'
import { useAppStore } from '../../stores/appStore'
import { useNotificationInvalidation } from '../../hooks/useNotificationInvalidation'
import { subscribeReadInvalidation } from '../../realtime/readSyncBroadcast'
import type { AnnouncementsState } from '../../hooks/useAnnouncements'

/** Keeps the order and notification badges (shared by top bar and tab bar) in sync with auth and realtime events. */
export function useNavBadgeSync(announcements: AnnouncementsState) {
  const user = useAuthStore((s) => s.user)
  const refreshOrderAttention = useAppStore((s) => s.refreshOrderAttention)
  const refreshOrderAttentionIfStale = useAppStore((s) => s.refreshOrderAttentionIfStale)
  const refreshNotificationUnread = useAppStore((s) => s.refreshNotificationUnread)

  // PR-3：全局角标唯一初始化/清零点（顶栏与底栏共用 store 状态）。
  // 用户变化即初始化两个角标；登出立即归零（store 内作废在途响应）。
  // 首次挂载只会发出一笔订单计数请求——stream ready 的补拉由
  // refreshOrderAttentionIfStale 的 1s 间隔合并。
  useEffect(() => {
    if (!user) return
    void refreshOrderAttention()
    void refreshNotificationUnread()
  }, [user?.id, refreshOrderAttention, refreshNotificationUnread])

  // SPEC-NOTIFY-RT-001：实时失效驱动未读刷新。移除旧独立 30s 轮询 effect
  // （CHK-FE-010）；notifications topic 覆盖实时事件，all.visible 覆盖
  // ready / 回前台 / 降级 30s fallback / healthy 5min 校准。
  useNotificationInvalidation('notifications', () => {
    if (user) void refreshNotificationUnread()
  })
  // PR-3：订单红点接入实时失效总线——buyer.orders 覆盖全部状态迁移
  // （交付/拒单/仲裁/自动开通），角标不再离开 /orders 页后冻结。
  useNotificationInvalidation('buyer.orders', () => {
    if (user) void refreshOrderAttention()
  })
  useNotificationInvalidation('all.visible', () => {
    if (!user) return
    void refreshNotificationUnread()
    void announcements.reload().catch(() => {})
    // 补拉性质（ready/回前台/校准）：走 1s 间隔去重，避免与登录初始化重复。
    void refreshOrderAttentionIfStale()
  })

  // PR-5：实时关闭/降级时同浏览器多 Tab 的已读同步（BroadcastChannel 同源
  // 广播）。只刷未读数，不带任何业务内容；实时在线时 SSE 的
  // notification.read 控制事件已覆盖，这里的订阅是兜底，两者天然幂等。
  useEffect(() => {
    return subscribeReadInvalidation(() => {
      if (user) void refreshNotificationUnread()
    })
  }, [user, refreshNotificationUnread])
}
