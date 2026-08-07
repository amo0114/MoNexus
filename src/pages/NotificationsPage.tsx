import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, CheckCheck, Loader2 } from 'lucide-react'
import {
  getNotifications,
  markAllAsRead,
  markAsRead,
} from '../api/notifications'
import { getApiErrorMessage } from '../api/error'
import { useAppStore } from '../stores/appStore'
import type { Notification, NotificationCategory } from '../types/notification'

type FilterTab = 'all' | 'order' | 'system'

function formatDate(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function NotificationsPage() {
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)
  const refreshNotificationUnread = useAppStore((s) => s.refreshNotificationUnread)

  const [filter, setFilter] = useState<FilterTab>('all')
  const [items, setItems] = useState<Notification[]>([])
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [workingId, setWorkingId] = useState<number | null>(null)
  const [markingAll, setMarkingAll] = useState(false)

  const load = useCallback(async (opts?: { append?: boolean; cursor?: number | null }) => {
    const append = opts?.append === true
    if (append) setLoadingMore(true)
    else setLoading(true)
    try {
      const category: NotificationCategory | undefined =
        filter === 'all' ? undefined : filter
      const data = await getNotifications({
        limit: 20,
        cursor: opts?.cursor ?? undefined,
        category,
      })
      setItems((prev) => (append ? [...prev, ...data.notifications] : data.notifications))
      setNextCursor(data.nextCursor)
      setHasMore(data.hasMore)
    } catch (err) {
      showToast(getApiErrorMessage(err, '加载消息失败'), 'error')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [filter, showToast])

  useEffect(() => {
    void load()
  }, [load])

  async function handleMarkRead(item: Notification) {
    if (item.status === 'read') {
      navigate(item.deeplink)
      return
    }
    setWorkingId(item.id)
    try {
      await markAsRead(item.id)
      setItems((prev) => prev.map((n) => (
        n.id === item.id
          ? { ...n, status: 'read', readAt: new Date().toISOString() }
          : n
      )))
      void refreshNotificationUnread()
      navigate(item.deeplink)
    } catch (err) {
      showToast(getApiErrorMessage(err, '标记已读失败'), 'error')
    } finally {
      setWorkingId(null)
    }
  }

  async function handleMarkAll() {
    setMarkingAll(true)
    try {
      await markAllAsRead()
      setItems((prev) => prev.map((n) => (
        n.status === 'unread'
          ? { ...n, status: 'read', readAt: new Date().toISOString() }
          : n
      )))
      void refreshNotificationUnread()
      showToast('已全部标为已读')
    } catch (err) {
      showToast(getApiErrorMessage(err, '操作失败'), 'error')
    } finally {
      setMarkingAll(false)
    }
  }

  const tabs: { id: FilterTab; label: string }[] = [
    { id: 'all', label: '全部' },
    { id: 'order', label: '订单' },
    { id: 'system', label: '系统' },
  ]

  return (
    <div className="max-w-2xl mx-auto px-4 py-6" data-testid="notifications-page">
      <div className="flex items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2">
          <Bell className="w-5 h-5 text-[var(--color-primary)]" />
          <h1 className="text-lg font-semibold text-[var(--color-text)]">消息中心</h1>
        </div>
        <button
          type="button"
          onClick={() => void handleMarkAll()}
          disabled={markingAll || items.every((n) => n.status !== 'unread')}
          className="btn-secondary btn-sm text-xs inline-flex items-center gap-1 disabled:opacity-50"
          data-testid="notifications-mark-all"
        >
          <CheckCheck className="w-3.5 h-3.5" />
          {markingAll ? '处理中…' : '全部已读'}
        </button>
      </div>

      <div className="flex gap-2 mb-4" role="tablist" aria-label="消息分类">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={filter === tab.id}
            onClick={() => setFilter(tab.id)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              filter === tab.id
                ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)] border-[var(--color-primary)]/30'
                : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)]'
            }`}
            data-testid={`notifications-tab-${tab.id}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="py-16 flex justify-center text-[var(--color-text-muted)]">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <div className="py-16 text-center text-sm text-[var(--color-text-muted)]" data-testid="notifications-empty">
          暂无消息
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => {
            const unread = item.status === 'unread'
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => void handleMarkRead(item)}
                  disabled={workingId === item.id}
                  className={`w-full text-left rounded-xl border p-4 transition-colors ${
                    unread
                      ? 'border-[var(--color-primary)]/30 bg-[var(--color-primary)]/[0.035]'
                      : 'border-[var(--color-border)] bg-[var(--color-surface)]/50'
                  }`}
                  data-testid={`notification-item-${item.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="text-sm font-semibold text-[var(--color-text)] break-words">
                      {item.title}
                    </h2>
                    <span className={`shrink-0 text-[11px] font-medium ${unread ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}>
                      {unread ? '未读' : '已读'}
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm text-[var(--color-text-muted)] whitespace-pre-wrap break-words">
                    {item.body}
                  </p>
                  <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">
                    {formatDate(item.createdAt)}
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {hasMore && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => void load({ append: true, cursor: nextCursor })}
            disabled={loadingMore}
            className="btn-secondary btn-sm"
            data-testid="notifications-load-more"
          >
            {loadingMore ? '加载中…' : '加载更多'}
          </button>
        </div>
      )}
    </div>
  )
}
