import { useEffect, useMemo } from 'react'
import { AlertCircle, Megaphone, ShieldAlert, X } from 'lucide-react'
import type { PublicAnnouncement } from '../types/admin'

interface AnnouncementBannerProps {
  items: PublicAnnouncement[]
  shouldShowNotice: (announcement: PublicAnnouncement) => boolean
  recordNoticeImpression: (announcement: PublicAnnouncement) => void
  dismissNotice: (announcement: PublicAnnouncement) => void
  onOpen: (announcement: PublicAnnouncement) => void
}

const presentationMeta = {
  notice: {
    icon: Megaphone,
    label: '平台通知',
    shell: 'bg-[var(--color-primary)]/8 border-[var(--color-primary)]/25',
    accent: 'text-[var(--color-primary)]',
  },
  important: {
    icon: AlertCircle,
    label: '重要公告',
    shell: 'bg-[var(--color-cta)]/8 border-[var(--color-cta)]/25',
    accent: 'text-[var(--color-cta)]',
  },
  acknowledgement_required: {
    icon: ShieldAlert,
    label: '需确认公告',
    shell: 'bg-[var(--color-danger)]/8 border-[var(--color-danger)]/25',
    accent: 'text-[var(--color-danger)]',
  },
} as const

export default function AnnouncementBanner({
  items,
  shouldShowNotice,
  recordNoticeImpression,
  dismissNotice,
  onOpen,
}: AnnouncementBannerProps) {
  // Delivery severity takes precedence over numerical ordering: a required
  // confirmation must never be hidden behind a high-priority routine notice.
  const top = useMemo(() => {
    const required = items.find((item) => item.presentation === 'acknowledgement_required' && !item.acknowledgedAt)
    if (required) return required
    const important = items.find((item) => item.presentation === 'important' && !item.readAt)
    if (important) return important
    return items.find((item) => item.presentation === 'notice' && shouldShowNotice(item))
  }, [items, shouldShowNotice])

  useEffect(() => {
    if (top?.presentation === 'notice') recordNoticeImpression(top)
  }, [top, recordNoticeImpression])

  if (!top) return null

  const meta = presentationMeta[top.presentation]
  const Icon = meta.icon

  return (
    <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 pt-4" data-testid="announcement-banner">
      <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-[var(--color-text)] fade-in ${meta.shell}`}>
        <Icon className={`w-5 h-5 shrink-0 ${meta.accent}`} />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
            <span className={`font-semibold ${meta.accent}`}>{meta.label}</span>
            <span className="font-semibold text-[var(--color-text)] truncate max-w-full">{top.title}</span>
          </div>
          <p className="mt-0.5 text-xs sm:text-sm leading-relaxed text-[var(--color-text-muted)] line-clamp-2 sm:line-clamp-1">
            {top.content}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onOpen(top)}
          className={`btn-sm shrink-0 rounded-lg px-3 border text-xs font-semibold transition-colors cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 ${meta.accent}`}
          data-testid="announcement-banner-open"
        >
          {top.presentation === 'acknowledgement_required' ? '查看并确认' : '查看详情'}
        </button>
        {top.presentation === 'notice' && (
          <button
            type="button"
            onClick={() => dismissNotice(top)}
            className="icon-btn shrink-0 rounded-md p-1 text-[var(--color-text-muted)] hover:bg-black/5 dark:hover:bg-white/10 hover:text-[var(--color-text)] transition-colors focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
            aria-label="关闭普通通知"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  )
}
