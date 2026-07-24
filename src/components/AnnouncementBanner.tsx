import { useEffect, useState } from 'react'
import { Megaphone, X } from 'lucide-react'
import api from '../api/client'
import { PublicAnnouncement } from '../types/admin'

// Dismissal persists across sessions for a specific announcement revision.
// Updating an announcement changes updatedAt, so a materially revised notice
// is shown again even to people who dismissed an earlier revision.
const dismissKey = (announcement: PublicAnnouncement) =>
  `announcement-dismissed:${announcement.id}:${announcement.updatedAt}`

export default function AnnouncementBanner() {
  const [items, setItems] = useState<PublicAnnouncement[]>([])

  useEffect(() => {
    let cancelled = false
    api
      .get<PublicAnnouncement[]>('/announcements')
      .then(({ data }) => {
        if (!cancelled) setItems(Array.isArray(data) ? data : [])
      })
      .catch(() => {
        // Soft-fail: keep banner silent on network errors — not worth a toast.
      })
    return () => {
      cancelled = true
    }
  }, [])

  function dismiss(announcement: PublicAnnouncement) {
    localStorage.setItem(dismissKey(announcement), '1')
    setItems((prev) => prev.filter((a) => a.id !== announcement.id))
  }

  const visible = items.filter((a) => localStorage.getItem(dismissKey(a)) !== '1')
  if (visible.length === 0) return null

  const top = visible[0]

  return (
    <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 pt-4">
      <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[var(--color-primary)]/8 border border-[var(--color-primary)]/25 text-[var(--color-text)] fade-in">
        <Megaphone className="w-5 h-5 shrink-0 text-[var(--color-primary)]" />
        <div className="flex-1 min-w-0 text-sm">
          <span className="font-semibold text-[var(--color-primary)]">{top.title}。</span>
          <span className="hidden sm:inline text-[var(--color-text-muted)]">{top.content}</span>
        </div>
        <button
          type="button"
          onClick={() => dismiss(top)}
          className="icon-btn p-1 rounded hover:bg-[var(--color-primary)]/15 transition-colors focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
          aria-label="关闭公告"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
