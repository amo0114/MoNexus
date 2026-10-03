import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  acknowledgeAnnouncement,
  getPublicAnnouncements,
  markAnnouncementRead,
  type AnnouncementReceiptResult,
} from '../api/announcements'
import type { PublicAnnouncement } from '../types/admin'
import { getAuthSessionContext } from '../auth/sessionContext'
import { useAuthStore } from '../stores/authStore'
import {
  broadcastAnnouncementReceiptInvalidation,
  subscribeAnnouncementReceiptInvalidation,
} from '../realtime/announcementSyncBroadcast'

type NoticeDisplayState = {
  count: number
  dismissed: boolean
}

const NOTICE_STORAGE_PREFIX = 'monexus:announcement:notice:'
const MAX_BROWSER_TIMEOUT_MS = 2_147_000_000

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
  const userId = useAuthStore((state) => state.user?.id ?? null)
  const userRole = useAuthStore((state) => state.user?.role ?? null)
  const accessToken = useAuthStore((state) => state.accessToken)
  const authEpoch = useAuthStore((state) => state.authEpoch)
  const sessionContext = getAuthSessionContext({ userId, accessToken, authEpoch })
  const sessionOwnerKey = [
    userId ?? 'visitor',
    sessionContext?.sessionId ?? 'unbound',
    authEpoch,
    userRole ?? 'visitor',
  ].join(':')
  const [snapshot, setSnapshot] = useState<{ ownerKey: string; items: PublicAnnouncement[] } | null>(null)
  const [loadingOwnerKey, setLoadingOwnerKey] = useState(sessionOwnerKey)
  const [noticeRevision, setNoticeRevision] = useState(0)
  const shownNoticeKeys = useRef(new Set<string>())
  const ownerKeyRef = useRef(sessionOwnerKey)
  const requestGenerationRef = useRef(0)
  const receiptMutationEpochRef = useRef(0)
  const receiptMutationsInFlightRef = useRef(0)
  const reloadInFlightRef = useRef(false)
  const reloadDirtyRef = useRef(false)
  const reloadRef = useRef<() => Promise<void>>(() => Promise.resolve())
  const mountedRef = useRef(true)
  ownerKeyRef.current = sessionOwnerKey

  const reload = useCallback(async () => {
    if (receiptMutationsInFlightRef.current > 0) {
      reloadDirtyRef.current = true
      return
    }
    if (reloadInFlightRef.current) {
      reloadDirtyRef.current = true
      return
    }

    reloadInFlightRef.current = true
    const requestOwnerKey = sessionOwnerKey
    const requestGeneration = ++requestGenerationRef.current
    const requestMutationEpoch = receiptMutationEpochRef.current
    setLoadingOwnerKey(requestOwnerKey)
    try {
      const nextItems = await getPublicAnnouncements()
      if (
        mountedRef.current
        && ownerKeyRef.current === requestOwnerKey
        && requestGenerationRef.current === requestGeneration
        && receiptMutationEpochRef.current === requestMutationEpoch
      ) {
        setSnapshot({ ownerKey: requestOwnerKey, items: nextItems })
      }
    } finally {
      reloadInFlightRef.current = false
      if (
        mountedRef.current
        && ownerKeyRef.current === requestOwnerKey
        && requestGenerationRef.current === requestGeneration
      ) {
        setLoadingOwnerKey('')
      }
      if (reloadDirtyRef.current) {
        reloadDirtyRef.current = false
        if (mountedRef.current) void reloadRef.current().catch(() => {})
      }
    }
  }, [sessionOwnerKey])
  reloadRef.current = reload

  const items = snapshot?.ownerKey === sessionOwnerKey ? snapshot.items : []
  const loading = loadingOwnerKey === sessionOwnerKey

  useEffect(() => {
    void reload().catch(() => {
      // Announcements are an enhancement, never a reason to interrupt a page.
    })
  }, [reload])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestGenerationRef.current++
    }
  }, [])

  useEffect(() => subscribeAnnouncementReceiptInvalidation(() => {
    void reload().catch(() => {})
  }), [reload])

  useEffect(() => {
    const reloadWhenVisible = () => {
      if (document.visibilityState === 'visible') void reload().catch(() => {})
    }
    document.addEventListener('visibilitychange', reloadWhenVisible)
    const calibrationTimer = window.setInterval(reloadWhenVisible, 5 * 60_000)
    return () => {
      document.removeEventListener('visibilitychange', reloadWhenVisible)
      window.clearInterval(calibrationTimer)
    }
  }, [reload])

  useEffect(() => {
    const now = Date.now()
    const nextExpiry = items.reduce<number | null>((nearestExpiry, announcement) => {
      if (!announcement.endsAt) return nearestExpiry
      const expiry = new Date(announcement.endsAt).getTime()
      if (!Number.isFinite(expiry) || expiry <= now) return nearestExpiry
      return nearestExpiry === null ? expiry : Math.min(nearestExpiry, expiry)
    }, null)
    if (nextExpiry === null) return

    const expiryTimer = window.setTimeout(() => {
      void reload().catch(() => {})
    }, Math.min(MAX_BROWSER_TIMEOUT_MS, Math.max(0, nextExpiry - now + 50)))
    return () => window.clearTimeout(expiryTimer)
  }, [items, reload])

  const beginReceiptMutation = useCallback(() => {
    receiptMutationEpochRef.current++
    requestGenerationRef.current++
    receiptMutationsInFlightRef.current++
    reloadDirtyRef.current = true
  }, [])

  const finishReceiptMutation = useCallback(() => {
    receiptMutationsInFlightRef.current = Math.max(0, receiptMutationsInFlightRef.current - 1)
    if (receiptMutationsInFlightRef.current > 0) return

    reloadDirtyRef.current = true
    if (reloadInFlightRef.current || !mountedRef.current) return
    reloadDirtyRef.current = false
    void reloadRef.current().catch(() => {})
  }, [])

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
    const requestOwnerKey = sessionOwnerKey
    beginReceiptMutation()
    try {
      const receipt = await markAnnouncementRead(announcement.id, announcement.version)
      if (
        ownerKeyRef.current === requestOwnerKey
        && receipt.version === announcement.version
      ) {
        setSnapshot((current) => current?.ownerKey === requestOwnerKey
          ? { ...current, items: applyReceipt(current.items, announcement.id, receipt) }
          : current)
        broadcastAnnouncementReceiptInvalidation()
      }
      return receipt
    } finally {
      finishReceiptMutation()
    }
  }, [beginReceiptMutation, finishReceiptMutation, sessionOwnerKey])

  const acknowledge = useCallback(async (announcement: PublicAnnouncement) => {
    const requestOwnerKey = sessionOwnerKey
    beginReceiptMutation()
    try {
      const receipt = await acknowledgeAnnouncement(announcement.id, announcement.version)
      if (
        ownerKeyRef.current === requestOwnerKey
        && receipt.version === announcement.version
      ) {
        setSnapshot((current) => current?.ownerKey === requestOwnerKey
          ? { ...current, items: applyReceipt(current.items, announcement.id, receipt) }
          : current)
        broadcastAnnouncementReceiptInvalidation()
      }
      return receipt
    } finally {
      finishReceiptMutation()
    }
  }, [beginReceiptMutation, finishReceiptMutation, sessionOwnerKey])

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
