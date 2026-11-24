import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { getApiErrorMessage } from '../../api/error'
import type { PublicAnnouncement } from '../../types/admin'
import type { AnnouncementsState } from '../../hooks/useAnnouncements'

interface AnnouncementCenterOptions {
  announcements: AnnouncementsState
  userId: number | undefined
  sessionId: string | null | undefined
  authEpoch: number
}

/** Open state of the announcement center, including the proactive surfacing of required acknowledgements. */
export function useAnnouncementCenter({ announcements, userId, sessionId, authEpoch }: AnnouncementCenterOptions) {
  const showToast = useAppStore((s) => s.showToast)
  const [announcementCenterOpen, setAnnouncementCenterOpen] = useState(false)
  const [forcedAnnouncementTab, setForcedAnnouncementTab] = useState(false)
  const surfacedRequiredAnnouncements = useRef(new Set<string>())
  const hasPendingRequiredAnnouncement = announcements.items.some(
    (announcement) => announcement.presentation === 'acknowledgement_required' && !announcement.acknowledgedAt,
  )

  useEffect(() => {
    surfacedRequiredAnnouncements.current.clear()
  }, [userId, sessionId, authEpoch])

  useEffect(() => {
    if (announcementCenterOpen) void announcements.reload().catch(() => {})
  }, [announcementCenterOpen, announcements.reload])

  // Required acknowledgements are surfaced proactively once per active page
  // session. Closing the dialog never acknowledges it; the banner and red dot
  // remain until the explicit confirmation is stored server-side.
  useEffect(() => {
    const pending = announcements.items.find(
      (announcement) => announcement.presentation === 'acknowledgement_required' && !announcement.acknowledgedAt,
    )
    if (!pending) return
    const key = `${userId ?? 'visitor'}:${sessionId ?? 'unbound'}:${authEpoch}:${pending.id}:${pending.version}`
    if (surfacedRequiredAnnouncements.current.has(key)) return
    surfacedRequiredAnnouncements.current.add(key)
    setAnnouncementCenterOpen(true)
  }, [announcements.items, userId, sessionId, authEpoch])

  const openAnnouncement = useCallback((announcement: PublicAnnouncement) => {
    setForcedAnnouncementTab(true)
    setAnnouncementCenterOpen(true)
    if (announcement.presentation === 'acknowledgement_required' || announcement.readAt) return
    void announcements.markRead(announcement).catch((err) => {
      showToast(getApiErrorMessage(err, '打开公告失败，请稍后重试'), 'error')
    })
  }, [announcements, showToast])

  return {
    open: announcementCenterOpen,
    setOpen: setAnnouncementCenterOpen,
    forceAnnouncementTab: hasPendingRequiredAnnouncement || forcedAnnouncementTab,
    onOpenChange: (open: boolean) => {
      setAnnouncementCenterOpen(open)
      if (!open) setForcedAnnouncementTab(false)
    },
    openAnnouncement,
  }
}
