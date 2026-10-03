const ANNOUNCEMENT_SYNC_CHANNEL = 'monexus-announcement-receipt-sync-v1'
const ANNOUNCEMENT_SYNC_STORAGE_KEY = 'monexus-announcement-receipt-event'

type AnnouncementInvalidationListener = () => void

const listeners = new Set<AnnouncementInvalidationListener>()
let channel: BroadcastChannel | null = null

function notifyListeners(): void {
  for (const listener of [...listeners]) listener()
}

function ensureChannel(): BroadcastChannel | null {
  if (channel) return channel
  if (typeof BroadcastChannel === 'undefined') return null

  try {
    channel = new BroadcastChannel(ANNOUNCEMENT_SYNC_CHANNEL)
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data as { version?: unknown; kind?: unknown } | null
      if (message?.version !== 1 || message.kind !== 'receipt-invalidated') return
      notifyListeners()
    }
  } catch {
    channel = null
  }

  return channel
}

/** Notify other tabs to reload receipt state; announcement text is never broadcast. */
export function broadcastAnnouncementReceiptInvalidation(): void {
  ensureChannel()?.postMessage({ version: 1, kind: 'receipt-invalidated' })
  if (typeof window === 'undefined') return

  try {
    const eventId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    window.localStorage.setItem(ANNOUNCEMENT_SYNC_STORAGE_KEY, eventId)
    window.localStorage.removeItem(ANNOUNCEMENT_SYNC_STORAGE_KEY)
  } catch {
    // BroadcastChannel remains available when localStorage is blocked.
  }
}

export function subscribeAnnouncementReceiptInvalidation(
  listener: AnnouncementInvalidationListener,
): () => void {
  listeners.add(listener)
  ensureChannel()
  const handleStorage = (event: StorageEvent) => {
    if (event.key === ANNOUNCEMENT_SYNC_STORAGE_KEY && event.newValue) notifyListeners()
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', handleStorage)
  return () => {
    listeners.delete(listener)
    if (typeof window !== 'undefined') window.removeEventListener('storage', handleStorage)
    if (listeners.size === 0) {
      channel?.close()
      channel = null
    }
  }
}

export function __resetAnnouncementSyncBroadcastForTests(): void {
  channel?.close()
  channel = null
  listeners.clear()
}
