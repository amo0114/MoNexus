import { useState } from 'react'
import { Bell, CheckCheck, CircleAlert, Megaphone, ShieldCheck } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/Dialog'
import type { PublicAnnouncement } from '../types/admin'
import { getApiErrorMessage } from '../api/error'
import { useAppStore } from '../stores/appStore'

interface AnnouncementCenterProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: PublicAnnouncement[]
  unreadCount: number
  onMarkRead: (announcement: PublicAnnouncement) => Promise<unknown>
  onAcknowledge: (announcement: PublicAnnouncement) => Promise<unknown>
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
      aria-label={unreadCount > 0 ? `公告中心，有 ${unreadCount} 条未读` : '公告中心'}
      title="公告中心"
      data-testid="announcement-center-desktop-trigger"
    >
      <Bell className="w-5 h-5" />
      {unreadCount > 0 && <span className="absolute right-1 top-1 w-2.5 h-2.5 rounded-full bg-[var(--color-danger)] ring-2 ring-[var(--color-surface)]" aria-hidden="true" />}
    </button>
  )
}

export function MobileAnnouncementFab({ unreadCount, onClick }: { unreadCount: number, onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="md:hidden fixed bottom-5 right-4 z-30 icon-btn w-12 h-12 rounded-full bg-[var(--color-primary)] text-white shadow-lg shadow-[var(--color-primary)]/30 border border-white/20 hover:bg-[var(--color-primary-hover)] transition-colors focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] cursor-pointer"
      aria-label={unreadCount > 0 ? `打开公告中心，有 ${unreadCount} 条未读` : '打开公告中心'}
      data-testid="announcement-center-mobile-trigger"
    >
      <Bell className="w-5 h-5" />
      {unreadCount > 0 && <span className="absolute right-0.5 top-0.5 min-w-4 h-4 px-1 rounded-full bg-[var(--color-danger)] text-[10px] leading-4 font-bold text-white ring-2 ring-[var(--color-background)]" aria-hidden="true">{unreadCount > 9 ? '9+' : unreadCount}</span>}
    </button>
  )
}

export default function AnnouncementCenter({
  open,
  onOpenChange,
  items,
  unreadCount,
  onMarkRead,
  onAcknowledge,
}: AnnouncementCenterProps) {
  const showToast = useAppStore((state) => state.showToast)
  const [workingId, setWorkingId] = useState<number | null>(null)

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col" data-testid="announcement-center">
        <DialogTitle className="pr-10 flex items-center gap-2">
          <Bell className="w-5 h-5 text-[var(--color-primary)]" />
          公告中心
          {unreadCount > 0 && <span className="text-xs font-medium text-[var(--color-danger)]">{unreadCount > 9 ? '9+' : unreadCount} 条待处理</span>}
        </DialogTitle>
        <DialogDescription>重要公告在阅读后归档；必须确认的公告仅会在确认后停止提示。</DialogDescription>

        <div className="mt-4 -mr-2 pr-2 overflow-y-auto space-y-3" aria-live="polite">
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
        </div>
      </DialogContent>
    </Dialog>
  )
}
