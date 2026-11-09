import { addCalendarDays, businessDateString } from '../../lib/businessTime.js'
import { config } from '../../config/index.js'
import { acquireCronLeaseWithHeartbeat, type CronLeaseHandle } from '../../lib/cronLease.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { broadcastPush, isWebPushEnabled, sendPushToUser } from '../../lib/webPush.js'

export const PUSH_CRON_INTERVAL_MS = 60_000
const DAY_MS = 24 * 60 * 60 * 1000
/** PW-07：每天 20:00（上海）之后提醒一次「连签快断」。 */
const STREAK_RISK_HOUR = 20
const STREAK_RISK_MIN_STREAK = 3
const ANNOUNCEMENT_BATCH = 5

let timer: NodeJS.Timeout | null = null
let running = false

function shanghaiHour(now: Date) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).format(now))
}

/**
 * PW-08：已生效且勾选了推送的公告广播一次。先用条件更新占位 pushedAt 再发送，
 * 多实例或重启都不会重复广播（代价是发送中途崩溃时少推一部分，可接受）。
 */
export async function pushDueAnnouncements(now = new Date()) {
  const due = await prisma.announcement.findMany({
    where: {
      pushEnabled: true,
      pushedAt: null,
      status: 'published',
      startsAt: { lte: now },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    },
    orderBy: { id: 'asc' },
    take: ANNOUNCEMENT_BATCH,
    select: { id: true, title: true, audience: true },
  })
  let pushed = 0
  for (const announcement of due) {
    const { count } = await prisma.announcement.updateMany({
      where: { id: announcement.id, pushedAt: null },
      data: { pushedAt: now },
    })
    if (count === 0) continue
    const roleFilter = announcement.audience === 'all' ? {} : { role: announcement.audience }
    await broadcastPush(
      { user: { status: { not: '已封禁' }, ...roleFilter } },
      { title: 'MoNexus 公告', body: announcement.title, deeplink: '/notifications', tag: `announcement-${announcement.id}` },
    )
    pushed++
  }
  return pushed
}

/** 昨日已连签 ≥3 天、今天还没签、且开启了推送的正常用户。 */
export async function pushStreakAtRisk(now = new Date()) {
  const today = businessDateString(now)
  const yesterday = addCalendarDays(today, -1)
  const rows = await prisma.$queryRaw<Array<{ userId: number; streak: number }>>`
    SELECT DISTINCT p."userId", y."streak"
    FROM "PushSubscription" p
    JOIN "CheckinRecord" y ON y."userId" = p."userId" AND y."date" = ${yesterday} AND y."streak" >= ${STREAK_RISK_MIN_STREAK}
    JOIN "User" u ON u."id" = p."userId" AND u."status" <> '已封禁'
    WHERE NOT EXISTS (
      SELECT 1 FROM "CheckinRecord" t WHERE t."userId" = p."userId" AND t."date" = ${today}
    )`
  for (const row of rows) {
    await sendPushToUser(row.userId, {
      title: '今天还没签到',
      body: `你已连续签到 ${row.streak} 天，今天签到就不会断哦`,
      deeplink: '/profile#checkin',
      tag: 'checkin-streak-risk',
    })
  }
  return rows.length
}

async function runLeased(name: string, periodMs: number, job: () => Promise<number>) {
  let lease: CronLeaseHandle | null = null
  try {
    lease = await acquireCronLeaseWithHeartbeat(name, periodMs)
    if (!lease) return
    const count = await job()
    if (count > 0) logger.info({ job: name, count }, 'push cron completed')
  } catch (err) {
    logger.error({ err, job: name }, 'push cron failed')
  } finally {
    lease?.release()
  }
}

export async function runPushCronTick(now = new Date()) {
  if (running || !isWebPushEnabled()) return
  running = true
  try {
    await runLeased('pushAnnouncements', PUSH_CRON_INTERVAL_MS, () => pushDueAnnouncements(now))
    // 24h 租约窗口保证每天最多一次；只在 20 点之后尝试领取。
    if (shanghaiHour(now) >= STREAK_RISK_HOUR) {
      await runLeased('pushStreakAtRisk', DAY_MS, () => pushStreakAtRisk(now))
    }
  } finally {
    running = false
  }
}

export function startPushCron() {
  if (config.nodeEnv === 'test' || !isWebPushEnabled()) return
  if (timer) return
  timer = setInterval(() => {
    runPushCronTick().catch(err => logger.error({ err }, 'push cron tick failed'))
  }, PUSH_CRON_INTERVAL_MS)
  timer.unref?.()
  logger.info({ intervalMs: PUSH_CRON_INTERVAL_MS }, 'push cron started')
}

export function stopPushCron() {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
