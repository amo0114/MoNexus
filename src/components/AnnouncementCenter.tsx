import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, CheckCheck, CircleAlert, Megaphone, MessageSquare, ShieldCheck } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/Dialog'
import type { PublicAnnouncement } from '../types/admin'
import type { Notification } from '../types/notification'
import { getApiErrorMessage } from '../api/error'
import { getNotifications, markAsRead } from '../api/notifications'
import { useAppStore } from '../stores/appStore'
import { useNotificationInvalidation } from '../hooks/useNotificationInvalidation'

interface AnnouncementCenterProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: PublicAnnouncement[]
  unreadCount: number
  onMarkRead: (announcement: PublicAnnouncement) => Promise<unknown>
  onAcknowledge: (announcement: PublicAnnouncement) => Promise<unknown>
  /** When true (pending acknowledgement_required), force announcements tab (NTF-11). */
  forceAnnouncementTab?: boolean
}

const presentationMeta = {
  notice: {
    label: '普通通知',
    icon: Megaphone,
    badge: 'bg-[var(--color-primary)]/8 text-[var(--color-primary)] border-[var(--color-primary)]/20',
  },
  important: {
    label: '重要通知',
    icon: CircleAlert,
    badge: 'bg-[var(--color-cta)]/10 text-[var(--color-cta)] border-[var(--color-cta)]/25',
  },
  acknowledgement_required: {
    label: '必须确认',
    icon: ShieldCheck,
    badge: 'bg-[var(--color-danger)]/10 text-[var(--color-danger)] border-[var(--color-danger)]/25',
  },
} as const

function formatDate(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function receiptLabel(announcement: PublicAnnouncement) {
  if (announcement.presentation === 'acknowledgement_required') {
    return announcement.acknowledgedAt ? '已确认' : '待确认'
  }
  return announcement.readAt ? '已读' : '未读'
}

export function AnnouncementBellButton({ unreadCount, onClick }: { unreadCount: number, onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hidden md:inline-flex icon-btn relative rounded-full p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-primary)]/10 hover:text-[var(--color-primary)] transition-colors focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] cursor-pointer"
      aria-label={unreadCount > 0 ? `通知中心，有 ${unreadCount} 条未读` : '通知中心'}
      title="通知中心"
      data-testid="announcement-center-desktop-trigger"
    >
      <Bell className="w-5 h-5" />
      {unreadCount > 0 && (
        <span
          className="absolute right-1 top-1 w-2.5 h-2.5 rounded-full bg-[var(--color-danger)] ring-2 ring-[var(--color-surface)]"
          aria-hidden="true"
          data-testid="notification-bell-total-dot"
        />
      )}
    </button>
  )
}

type CenterTab = 'announcements' | 'messages'

export default function AnnouncementCenter({
  open,
  onOpenChange,
  items,
  unreadCount,
  onMarkRead,
  onAcknowledge,
  forceAnnouncementTab = false,
}: AnnouncementCenterProps) {
  const showToast = useAppStore((state) => state.showToast)
  const notificationUnreadCount = useAppStore((state) => state.notificationUnreadCount)
  const refreshNotificationUnread = useAppStore((state) => state.refreshNotificationUnread)
  const navigate = useNavigate()
  const [workingId, setWorkingId] = useState<number | null>(null)
  const [tab, setTab] = useState<CenterTab>('announcements')
  const [messages, setMessages] = useState<Notification[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)

  const defaultTab = useMemo<CenterTab>(() => {
    if (forceAnnouncementTab) return 'announcements'
    if (notificationUnreadCount > 0) return 'messages'
    return 'announcements'
  }, [forceAnnouncementTab, notificationUnreadCount])

  useEffect(() => {
    if (!open) return
    setTab(defaultTab)
  }, [open, defaultTab])

  useEffect(() => {
    if (!open || tab !== 'messages') return
    let active = true
    setMessagesLoading(true)
    getNotifications({ limit: 5 })
      .then((data) => {
        if (active) setMessages(data.notifications)
      })
      .catch((err) => {
        if (active) {
          const status = (err as { response?: { status?: number } })?.response?.status
          if (status !== 404) {
            showToast(getApiErrorMessage(err, '加载消息失败'), 'error')
          }
          setMessages([])
        }
      })
      .finally(() => {
        if (active) setMessagesLoading(false)
      })
    return () => {
      active = false
    }
  }, [open, tab, showToast])

  // SPEC-NOTIFY-RT-001 (T-FE-003): reload the latest 5 messages when the messages
  // tab is open and a notifications invalidation arrives (no skeleton swap).
  useNotificationInvalidation('notifications', () => {
    if (!open || tab !== 'messages') return
    void getNotifications({ limit: 5 })
      .then((data) => setMessages(data.notifications))
      .catch((err) => {
        const status = (err as { response?: { status?: number } })?.response?.status
        if (status !== 404) setMessages([])
      })
  })

  async function markRead(announcement: PublicAnnouncement) {
    setWorkingId(announcement.id)
    try {
      await onMarkRead(announcement)
    } catch (err) {
      showToast(getApiErrorMessage(err, '标记已读失败，请稍后重试'), 'error')
    } finally {
      setWorkingId(null)
    }
  }

  async function acknowledge(announcement: PublicAnnouncement) {
    setWorkingId(announcement.id)
    try {
      await onAcknowledge(announcement)
      showToast('已确认公告')
    } catch (err) {
      showToast(getApiErrorMessage(err, '确认失败，请稍后重试'), 'error')
    } finally {
      setWorkingId(null)
    }
  }

  async function openMessage(item: Notification) {
    setWorkingId(item.id)
    try {
      if (item.status === 'unread') {
        await markAsRead(item.id)
        void refreshNotificationUnread()
        setMessages((prev) => prev.map((n) => (
          n.id === item.id ? { ...n, status: 'read', readAt: new Date().toISOString() } : n
        )))
      }
      onOpenChange(false)
      navigate(item.deeplink)
    } catch (err) {
      showToast(getApiErrorMessage(err, '打开消息失败'), 'error')
    } finally {
      setWorkingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85dvh] flex flex-col" data-testid="announcement-center">
        <DialogTitle className="pr-10 flex items-center gap-2">
          <Bell className="w-5 h-5 text-[var(--color-primary)]" />
          通知中心
          {(unreadCount + notificationUnreadCount) > 0 && (
            <span className="text-xs font-medium text-[var(--color-danger)]" data-testid="notification-center-total-unread">
              {(unreadCount + notificationUnreadCount) > 9 ? '9+' : (unreadCount + notificationUnreadCount)} 条待处理
            </span>
          )}
        </DialogTitle>
        <DialogDescription>
          公告为运营广播；消息为订单事务通知。待确认公告需确认后才停止提示。
        </DialogDescription>

        <div className="mt-3 flex gap-2" role="tablist" aria-label="通知分区">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'announcements'}
            onClick={() => setTab('announcements')}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              tab === 'announcements'
                ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)] border-[var(--color-primary)]/30'
                : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)]'
            }`}
            data-testid="notification-center-tab-announcements"
          >
            公告{unreadCount > 0 ? ` ${unreadCount > 9 ? '9+' : unreadCount}` : ''}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'messages'}
            onClick={() => setTab('messages')}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              tab === 'messages'
                ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)] border-[var(--color-primary)]/30'
                : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)]'
            }`}
            data-testid="notification-center-tab-messages"
          >
            消息{notificationUnreadCount > 0 ? ` ${notificationUnreadCount > 9 ? '9+' : notificationUnreadCount}` : ''}
          </button>
        </div>

        <div className="mt-4 -mr-2 pr-2 flex-1 min-h-0 overflow-y-auto space-y-3" aria-live="polite">
          {tab === 'announcements' && (
            <>
              {items.length === 0 && (
                <div className="py-12 text-center text-sm text-[var(--color-text-muted)]">目前没有生效中的公告</div>
              )}
              {items.map((announcement) => {
                const meta = presentationMeta[announcement.presentation]
                const Icon = meta.icon
                const pendingAcknowledgement = announcement.presentation === 'acknowledgement_required' && !announcement.acknowledgedAt
                const unread = announcement.presentation === 'acknowledgement_required'
                  ? !announcement.acknowledgedAt
                  : !announcement.readAt

                return (
                  <article
                    key={`${announcement.id}:${announcement.version}`}
                    className={`rounded-xl border p-4 transition-colors ${unread ? 'border-[var(--color-primary)]/30 bg-[var(--color-primary)]/[0.035]' : 'border-[var(--color-border)] bg-[var(--color-surface)]/50'}`}
                    data-testid={`announcement-item-${announcement.id}`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 p-2 rounded-lg bg-[var(--color-primary)]/8 text-[var(--color-primary)] shrink-0">
                        <Icon className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-semibold text-sm text-[var(--color-text)] break-words">{announcement.title}</h3>
                          <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border ${meta.badge}`}>{meta.label}</span>
                          <span className={`text-[11px] font-medium ${unread ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}>{receiptLabel(announcement)}</span>
                        </div>
                        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--color-text-muted)]">{announcement.content}</p>
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                          <span className="text-[11px] text-[var(--color-text-muted)]">生效于 {formatDate(announcement.startsAt)} · v{announcement.version}</span>
                          {pendingAcknowledgement ? (
                            <button
                              type="button"
                              onClick={() => acknowledge(announcement)}
                              disabled={workingId === announcement.id}
                              className="btn-primary btn-sm px-3 text-xs disabled:opacity-60 disabled:cursor-not-allowed"
                              data-testid={`announcement-acknowledge-${announcement.id}`}
                            >
                              {workingId === announcement.id ? '确认中…' : '我已阅读并确认'}
                            </button>
                          ) : unread ? (
                            <button
                              type="button"
                              onClick={() => markRead(announcement)}
                              disabled={workingId === announcement.id}
                              className="btn-secondary btn-sm px-3 text-xs inline-flex items-center gap-1 disabled:opacity-60 disabled:cursor-not-allowed"
                              data-testid={`announcement-read-${announcement.id}`}
                            >
                              <CheckCheck className="w-3.5 h-3.5" />
                              {workingId === announcement.id ? '处理中…' : '标记已读'}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </article>
                )
              })}
            </>
          )}

          {tab === 'messages' && (
            <>
              {messagesLoading && (
                <div className="py-12 text-center text-sm text-[var(--color-text-muted)]">加载中…</div>
              )}
              {!messagesLoading && messages.length === 0 && (
                <div className="py-12 text-center text-sm text-[var(--color-text-muted)]" data-testid="notification-center-messages-empty">
                  暂无消息
                </div>
              )}
              {!messagesLoading && messages.map((item) => {
                const unread = item.status === 'unread'
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => void openMessage(item)}
                    disabled={workingId === item.id}
                    className={`w-full text-left rounded-xl border p-4 transition-colors ${
                      unread
                        ? 'border-[var(--color-primary)]/30 bg-[var(--color-primary)]/[0.035]'
                        : 'border-[var(--color-border)] bg-[var(--color-surface)]/50'
                    }`}
                    data-testid={`notification-center-message-${item.id}`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 p-2 rounded-lg bg-[var(--color-primary)]/8 text-[var(--color-primary)] shrink-0">
                        <MessageSquare className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-semibold text-sm text-[var(--color-text)] break-words">{item.title}</h3>
                          <span className={`text-[11px] font-medium ${unread ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}>
                            {unread ? '未读' : '已读'}
                          </span>
                        </div>
                        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--color-text-muted)]">{item.body}</p>
                        <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">{formatDate(item.createdAt)}</div>
                      </div>
                    </div>
                  </button>
                )
              })}
              {!messagesLoading && (
                <div className="pt-1 pb-2 flex justify-center">
                  <button
                    type="button"
                    className="text-xs font-medium text-[var(--color-primary)] hover:underline"
                    data-testid="notification-center-view-all"
                    onClick={() => {
                      onOpenChange(false)
                      navigate('/notifications')
                    }}
                  >
                    查看全部
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
