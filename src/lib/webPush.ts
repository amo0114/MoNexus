import api from '../api/client'

/**
 * SPEC-ENGAGE-001 PW-03：浏览器推送订阅。只在用户点击后请求权限；
 * iOS 只有「添加到主屏幕」后的 Web App 才支持推送。
 */
export function isPushSupported() {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export function needsIosInstall() {
  if (typeof window === 'undefined') return false
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true
  return ios && !standalone
}

export async function getPushConfig() {
  const res = await api.get<{ enabled: boolean; publicKey: string | null }>('/push/public-key')
  return res.data
}

function base64UrlToBytes(value: string) {
  const padded = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  return Uint8Array.from(raw, c => c.charCodeAt(0))
}

export async function getCurrentPushSubscription() {
  const registration = await navigator.serviceWorker.getRegistration('/')
  return (await registration?.pushManager.getSubscription()) ?? null
}

/** 把已有的浏览器订阅同步到当前账号（同一浏览器换账号后改绑）。 */
export async function syncPushSubscription(subscription: PushSubscription) {
  await api.post('/push/subscriptions', subscription.toJSON())
}

export async function enablePush(publicKey: string) {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return false
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
    ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) })
  await syncPushSubscription(subscription)
  return true
}

export async function disablePush() {
  const subscription = await getCurrentPushSubscription()
  if (!subscription) return
  try {
    await api.delete('/push/subscriptions', { data: { endpoint: subscription.endpoint } })
  } finally {
    await subscription.unsubscribe()
  }
}
