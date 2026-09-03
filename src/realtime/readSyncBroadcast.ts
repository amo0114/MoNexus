/**
 * PR-5 — 已读跨窗口同步（BroadcastChannel 同源广播）。
 *
 * 实时能力关闭（或 SSE 降级）时，SSE 的 notification.read 控制事件不存在的
 * 场景下，同一浏览器的多个 Tab 仍需同步铃铛未读数。只广播失效**信号**，
 * 不携带任何通知内容 / 用户信息 / 业务 payload——接收方一律走 REST 重取。
 *
 * BroadcastChannel 不投递给发送者自身：本 Tab 的未读数由已读动作的调用点
 * 自己刷新，恰好不会重复。
 */

const CHANNEL_NAME = 'monexus-notification-read-sync-v1'

type ReadInvalidationListener = () => void

const listeners = new Set<ReadInvalidationListener>()
let channel: BroadcastChannel | null = null

function ensureChannel(): BroadcastChannel | null {
  if (channel) return channel
  if (typeof BroadcastChannel === 'undefined') return null
  try {
    channel = new BroadcastChannel(CHANNEL_NAME)
    channel.onmessage = () => {
      for (const listener of [...listeners]) listener()
    }
  } catch {
    // 隐私模式 / 不支持的同源环境：静默降级为无跨 Tab 同步。
    channel = null
  }
  return channel
}

/** 本 Tab 已读动作成功后调用：提示**其他** Tab 刷新未读数。 */
export function broadcastReadInvalidation(): void {
  ensureChannel()?.postMessage({ v: 1 })
}

/** 订阅其他 Tab 的已读失效信号；返回退订函数。 */
export function subscribeReadInvalidation(listener: ReadInvalidationListener): () => void {
  listeners.add(listener)
  ensureChannel()
  return () => {
    listeners.delete(listener)
  }
}

/** 测试专用：关闭通道并清空订阅者。 */
export function __resetReadSyncBroadcastForTests(): void {
  channel?.close()
  channel = null
  listeners.clear()
}
