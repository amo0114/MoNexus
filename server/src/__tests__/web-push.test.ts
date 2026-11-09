import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendNotification = vi.fn()

vi.mock('web-push', () => {
  class WebPushError extends Error {
    constructor(message: string, public statusCode: number) {
      super(message)
    }
  }
  return {
    default: { setVapidDetails: vi.fn(), sendNotification },
    WebPushError,
  }
})

vi.mock('../config/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../config/index.js')>()
  return {
    ...actual,
    config: {
      ...actual.config,
      webPush: { enabled: true, publicKey: 'test-public-key', privateKey: 'test-private-key', subject: 'mailto:ops@test.local' },
    },
  }
})

const { api, authHeader, createTestUser, loginAs } = await import('./helpers.js')
const { prisma } = await import('../lib/prisma.js')
const { sendPushToUser } = await import('../lib/webPush.js')
const { WebPushError } = await import('web-push')
const { pushDueAnnouncements, pushStreakAtRisk } = await import('../modules/push/cron.js')
const { addCalendarDays, businessDateString } = await import('../lib/businessTime.js')

const PASSWORD = 'Reg1ster#Flow-2026'
const subscription = (endpoint: string) => ({ endpoint, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } })

async function signedIn(email: string) {
  const { user } = await createTestUser(email, PASSWORD)
  const { accessToken } = await loginAs(user.email, PASSWORD)
  return { user, headers: authHeader(accessToken) }
}

describe('SPEC-ENGAGE-001 web push', () => {
  beforeEach(() => {
    sendNotification.mockReset()
  })

  it('exposes the public key and rebinds an endpoint to the latest user', async () => {
    const a = await signedIn('push-a@test.local')
    const b = await signedIn('push-b@test.local')

    const key = await api.get('/api/push/public-key').set(a.headers).expect(200)
    expect(key.body).toEqual({ enabled: true, publicKey: 'test-public-key' })

    await api.post('/api/push/subscriptions').set(a.headers).send(subscription('https://push.example/1')).expect(204)
    await api.post('/api/push/subscriptions').set(b.headers).send(subscription('https://push.example/1')).expect(204)
    const row = await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: 'https://push.example/1' } })
    expect(row.userId).toBe(b.user.id)

    await api.delete('/api/push/subscriptions').set(a.headers).send({ endpoint: 'https://push.example/1' }).expect(404)
    await api.delete('/api/push/subscriptions').set(b.headers).send({ endpoint: 'https://push.example/1' }).expect(204)
    await api.post('/api/push/subscriptions').set(a.headers).send(subscription('http://push.example/2')).expect(400)
  })

  it('removes gone subscriptions and keeps others on transient failures', async () => {
    const { user } = await createTestUser('push-gone@test.local', PASSWORD)
    await prisma.pushSubscription.createMany({
      data: [
        { userId: user.id, endpoint: 'https://push.example/gone', p256dh: 'k', auth: 'a' },
        { userId: user.id, endpoint: 'https://push.example/flaky', p256dh: 'k', auth: 'a' },
      ],
    })
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      throw new WebPushError('failed', sub.endpoint.endsWith('gone') ? 410 : 500, {}, '', sub.endpoint)
    })

    const sent = await sendPushToUser(user.id, { title: 't', body: 'b', deeplink: '/profile' })
    expect(sent).toBe(0)
    const left = await prisma.pushSubscription.findMany({ where: { userId: user.id } })
    expect(left.map(s => s.endpoint)).toEqual(['https://push.example/flaky'])
  })

  it('reminds only subscribed users whose streak of 3+ would break today', async () => {
    sendNotification.mockResolvedValue({})
    const today = businessDateString()
    const yesterday = addCalendarDays(today, -1)
    const { user: atRisk } = await createTestUser('push-risk@test.local', PASSWORD)
    const { user: short } = await createTestUser('push-short@test.local', PASSWORD)
    const { user: done } = await createTestUser('push-done@test.local', PASSWORD)
    await prisma.checkinRecord.createMany({
      data: [
        { userId: atRisk.id, date: yesterday, streak: 3 },
        { userId: short.id, date: yesterday, streak: 2 },
        { userId: done.id, date: yesterday, streak: 5 },
        { userId: done.id, date: today, streak: 6 },
      ],
    })
    await prisma.pushSubscription.createMany({
      data: [atRisk, short, done].map(u => ({ userId: u.id, endpoint: `https://push.example/${u.id}`, p256dh: 'k', auth: 'a' })),
    })

    expect(await pushStreakAtRisk()).toBe(1)
    expect(sendNotification).toHaveBeenCalledTimes(1)
    expect(sendNotification.mock.calls[0][0].endpoint).toBe(`https://push.example/${atRisk.id}`)
  })

  it('broadcasts a due announcement exactly once', async () => {
    sendNotification.mockResolvedValue({})
    const { user } = await createTestUser('push-broadcast@test.local', PASSWORD)
    await prisma.pushSubscription.create({ data: { userId: user.id, endpoint: 'https://push.example/b', p256dh: 'k', auth: 'a' } })
    await prisma.announcement.create({
      data: { title: '双十一活动开始', content: '活动内容', status: 'published', startsAt: new Date(Date.now() - 1000), pushEnabled: true },
    })

    expect(await pushDueAnnouncements()).toBe(1)
    expect(await pushDueAnnouncements()).toBe(0)
    expect(sendNotification).toHaveBeenCalledTimes(1)
    expect(JSON.parse(sendNotification.mock.calls[0][1])).toMatchObject({ body: '双十一活动开始' })
  })
})
