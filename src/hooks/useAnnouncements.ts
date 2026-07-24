import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  acknowledgeAnnouncement,
  getPublicAnnouncements,
  markAnnouncementRead,
  type AnnouncementReceiptResult,
} from '../api/announcements'
import type { PublicAnnouncement } from '../types/admin'

type NoticeDisplayState = {
  count: number
  dismissed: boolean
}

const NOTICE_STORAGE_PREFIX = 'monexus:announcement:notice:'

function noticeKey(announcement: PublicAnnouncement) {
  return `${NOTICE_STORAGE_PREFIX}${announcement.id}:${announcement.version}`
}

function readNoticeDisplayState(announcement: PublicAnnouncement): NoticeDisplayState {
  try {
    const raw = localStorage.getItem(noticeKey(announcement))
    if (!raw) return { count: 0, dismissed: false }
    const value = JSON.parse(raw) as Partial<NoticeDisplayState>
    return {
      count: Number.isInteger(value.count) && value.count! >= 0 ? value.count! : 0,
      dismissed: value.dismissed === true,
    }
  } catch {
    // Storage can be unavailable in privacy modes; announcements should still
    // remain usable instead of breaking the surrounding layout.
    return { count: 0, dismissed: false }
  }
}

function writeNoticeDisplayState(announcement: PublicAnnouncement, value: NoticeDisplayState) {
  try {
    localStorage.setItem(noticeKey(announcement), JSON.stringify(value))
  } catch {
    // A failed local write merely means a normal notice can be shown again.
  }
}

function applyReceipt(
  items: PublicAnnouncement[],
  id: number,
  receipt: AnnouncementReceiptResult,
) {
  return items.map((item) => item.id === id && item.version === receipt.version
    ? { ...item, readAt: receipt.readAt, acknowledgedAt: receipt.acknowledgedAt }
    : item)
}

export function useAnnouncements() {
  const [items, setItems] = useState<PublicAnnouncement[]>([])
  const [loading, setLoading] = useState(true)
  const [noticeRevision, setNoticeRevision] = useState(0)
  const shownNoticeKeys = useRef(new Set<string>())

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await getPublicAnnouncements())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload().catch(() => {
      // Announcements are an enhancement, never a reason to interrupt a page.
    })
  }, [reload])

  const shouldShowNotice = useCallback((announcement: PublicAnnouncement) => {
    // noticeRevision intentionally participates so localStorage updates cause
    // callers to render again even though the server list itself is unchanged.
    void noticeRevision
    const state = readNoticeDisplayState(announcement)
    return !state.dismissed && (
      state.count < announcement.maxImpressions || shownNoticeKeys.current.has(noticeKey(announcement))
    )
  }, [noticeRevision])

  const recordNoticeImpression = useCallback((announcement: PublicAnnouncement) => {
    const key = noticeKey(announcement)
    if (shownNoticeKeys.current.has(key)) return

    shownNoticeKeys.current.add(key)
    const state = readNoticeDisplayState(announcement)
    if (!state.dismissed && state.count < announcement.maxImpressions) {
      writeNoticeDisplayState(announcement, { ...state, count: state.count + 1 })
    }
    setNoticeRevision((value) => value + 1)
  }, [])

  const dismissNotice = useCallback((announcement: PublicAnnouncement) => {
    const state = readNoticeDisplayState(announcement)
    writeNoticeDisplayState(announcement, { ...state, dismissed: true })
    setNoticeRevision((value) => value + 1)
  }, [])

  const markRead = useCallback(async (announcement: PublicAnnouncement) => {
    const receipt = await markAnnouncementRead(announcement.id)
    setItems((current) => applyReceipt(current, announcement.id, receipt))
    return receipt
  }, [])

  const acknowledge = useCallback(async (announcement: PublicAnnouncement) => {
    const receipt = await acknowledgeAnnouncement(announcement.id)
    setItems((current) => applyReceipt(current, announcement.id, receipt))
    return receipt
  }, [])

  const unreadCount = useMemo(() => {
    // Keep the local revision dependency explicit: ordinary notices are local
    // by design, while important/required states are server-persisted.
    void noticeRevision
    return items.filter((announcement) => {
      if (announcement.presentation === 'notice') {
        const state = readNoticeDisplayState(announcement)
        return !announcement.readAt && !state.dismissed && state.count < announcement.maxImpressions
      }
      if (announcement.presentation === 'acknowledgement_required') {
        return !announcement.acknowledgedAt
      }
      return !announcement.readAt
    }).length
  }, [items, noticeRevision])

  return {
    items,
    loading,
    unreadCount,
    reload,
    shouldShowNotice,
    recordNoticeImpression,
    dismissNotice,
    markRead,
    acknowledge,
  }
}

export type AnnouncementsState = ReturnType<typeof useAnnouncements>
