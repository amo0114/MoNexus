import type { Prisma } from '@prisma/client'
import webpush, { WebPushError } from 'web-push'
import { config } from '../config/index.js'
import { logger } from './logger.js'
import { prisma } from './prisma.js'

/**
 * SPEC-ENGAGE-001 PW-05/PW-06：浏览器推送只是提示通道。
 * - 事实来源在业务表（CheckinReward / CheckinRecord / Announcement），推送
 *   丢了用户进站仍能看到；因此尽力而为、不重试。
 * - Payload 只含标题、短文案和站内路径，不放订单或身份信息。
 * - 推送服务回 404/410 表示订阅已失效，直接删除。
 */
export type PushPayload = {
  title: string
  body: string
  /** 站内路径，必须以单个 `/` 开头（SW 只会打开同源地址）。 */
  deeplink: string
  tag?: string
}

const PUSH_TTL_SECONDS = 12 * 60 * 60
const BROADCAST_BATCH = 500
const SEND_CONCURRENCY = 20

let vapidConfigured = false

export function isWebPushEnabled(): boolean {
  return config.webPush.enabled
}

export function getWebPushPublicKey(): string | null {
  return config.webPush.enabled ? config.webPush.publicKey : null
}

function ensureVapid(): boolean {
  if (!config.webPush.enabled) return false
  if (!vapidConfigured) {
    webpush.setVapidDetails(config.webPush.subject, config.webPush.publicKey, config.webPush.privateKey)
    vapidConfigured = true
  }
  return true
}

function assertSameOriginPath(deeplink: string) {
  if (!deeplink.startsWith('/') || deeplink.startsWith('//')) {
    throw new Error(`push deeplink must be a same-origin path, got ${deeplink}`)
  }
}

type StoredSubscription = { id: number; endpoint: string; p256dh: string; auth: string }

async function deliver(subscription: StoredSubscription, body: string) {
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      body,
      { TTL: PUSH_TTL_SECONDS },
    )
    await prisma.pushSubscription.updateMany({ where: { id: subscription.id }, data: { lastSuccessAt: new Date() } })
    return true
  } catch (err) {
    if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
      await prisma.pushSubscription.deleteMany({ where: { id: subscription.id } })
    } else {
      logger.warn({ err, subscriptionId: subscription.id }, 'web push delivery failed')
    }
    return false
  }
}

async function deliverAll(subscriptions: StoredSubscription[], body: string) {
  let sent = 0
  for (let i = 0; i < subscriptions.length; i += SEND_CONCURRENCY) {
    const results = await Promise.all(subscriptions.slice(i, i + SEND_CONCURRENCY).map(s => deliver(s, body)))
    sent += results.filter(Boolean).length
  }
  return sent
}

const subscriptionSelect = { id: true, endpoint: true, p256dh: true, auth: true } as const

/** 给单个用户的所有订阅发送。调用方可 fire-and-forget：内部不抛错。 */
export async function sendPushToUser(userId: number, payload: PushPayload): Promise<number> {
  if (!ensureVapid()) return 0
  try {
    assertSameOriginPath(payload.deeplink)
    const subscriptions = await prisma.pushSubscription.findMany({ where: { userId }, select: subscriptionSelect })
    return await deliverAll(subscriptions, JSON.stringify(payload))
  } catch (err) {
    logger.warn({ err, userId }, 'web push to user failed')
    return 0
  }
}

/** 按条件分批广播（公告推送）。 */
export async function broadcastPush(where: Prisma.PushSubscriptionWhereInput, payload: PushPayload): Promise<number> {
  if (!ensureVapid()) return 0
  assertSameOriginPath(payload.deeplink)
  const body = JSON.stringify(payload)
  let sent = 0
  let afterId = 0
  for (;;) {
    const batch = await prisma.pushSubscription.findMany({
      where: { AND: [where, { id: { gt: afterId } }] },
      orderBy: { id: 'asc' },
      take: BROADCAST_BATCH,
      select: subscriptionSelect,
    })
    if (batch.length === 0) return sent
    sent += await deliverAll(batch, body)
    afterId = batch[batch.length - 1].id
  }
}
