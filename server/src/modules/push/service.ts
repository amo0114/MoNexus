import { notFound } from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'
import type { SubscribeBody } from './schema.js'

/** 同一浏览器换账号登录后重新订阅：endpoint 唯一，改绑到当前用户。 */
export async function subscribe(userId: number, body: SubscribeBody, userAgent: string | undefined) {
  const data = {
    userId,
    p256dh: body.keys.p256dh,
    auth: body.keys.auth,
    userAgent: userAgent?.slice(0, 512) ?? null,
  }
  await prisma.pushSubscription.upsert({
    where: { endpoint: body.endpoint },
    create: { endpoint: body.endpoint, ...data },
    update: data,
  })
}

/** 只能删除自己的订阅；别人的或不存在一律 404（不暴露 endpoint 归属）。 */
export async function unsubscribe(userId: number, endpoint: string) {
  const { count } = await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } })
  if (count === 0) throw notFound('订阅不存在')
}
