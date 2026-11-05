import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// v1 bot signatures carry no nonce; a repeated signature inside the time
// window is a replay. config.chatBot must be on or /api/bot/* returns 503.
const { BOT_SECRET } = vi.hoisted(() => ({
  BOT_SECRET: 'bot-replay-test-secret-at-least-32-chars!!',
}))

vi.mock('../../config/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../config/index.js')>()
  return {
    ...actual,
    config: {
      ...actual.config,
      chatBot: { enabled: true as const, secret: BOT_SECRET, reminderEnabled: false },
    },
  }
})

import { createHmac } from 'node:crypto'
import { __resetRedisForTests, __setRedisForTests, type RedisLike } from '../../lib/redis.js'
import { api } from '../../__tests__/helpers.js'
import { buildBotSignPayload } from './service.js'

class AtomicRedis implements RedisLike {
  values = new Set<string>()
  async get() { return null }
  async set(key: string) { if (this.values.has(key)) return null; this.values.add(key); return 'OK' }
  async del() { return 0 }
  async incr() { return 1 }
  async eval() { return null }
  async ping() { return 'PONG' }
}

function signedSearch(timestamp: number) {
  const path = '/products/search'
  const body = { keyword: 'x' }
  const sign = createHmac('sha256', BOT_SECRET)
    .update(buildBotSignPayload({ ...body, timestamp, _path: path }), 'utf8')
    .digest('hex')
  return () => api.post(`/api/bot${path}`).set('X-Bot-Sign', sign).set('X-Bot-Timestamp', String(timestamp)).send(body)
}

describe('bot v1 signature replay', () => {
  beforeEach(() => __setRedisForTests(new AtomicRedis()))
  afterEach(() => __resetRedisForTests())

  it('rejects the same signature twice and accepts a freshly signed request', async () => {
    const now = Date.now()
    const replayed = signedSearch(now)
    await replayed().expect(200)
    const second = await replayed().expect(409)
    expect(second.body.error.code).toBe('BOT_REQUEST_REPLAYED')
    await signedSearch(now + 1)().expect(200)
  })

  it('fails closed when Redis errors', async () => {
    __setRedisForTests(new class extends AtomicRedis { async set(): Promise<never> { throw new Error('down') } }())
    const res = await signedSearch(Date.now())().expect(503)
    expect(res.body.error.code).toBe('ABUSE_PROTECTION_UNAVAILABLE')
  })
})
