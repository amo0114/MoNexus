import { describe, expect, it } from 'vitest'
import {
  CHAT_BIND_CONFIRM_BUCKETS,
  CHAT_BIND_EMAIL_BUCKETS,
  CHAT_BIND_PLATFORM_BUCKETS,
  consumeChatBindConfirm,
  consumeChatBindRequest,
  platformSubject,
} from '../modules/chatbot/abusePolicy.js'
import {
  buildAbuseLimiterKey,
  createAbuseLimiter,
  type AbuseLimiter,
  type AbuseLimiterBucket,
  type AbuseLimiterResult,
} from '../lib/abuseLimiter.js'

/**
 * SPEC-CHAT-BOT-001 —— 机器人绑定接口的滥用防护回归测试。
 *
 * 这些用例刻意**不依赖 Redis**：`createAbuseLimiter` 接受注入的执行器，
 * 因此形状、键与阈值都能在纯内存里断言。端到端的限流行为（真实 Redis +
 * ABUSE_HASH_KEY）已在开发环境手工验证，这里锁定的是回归面——bucket 形状
 * 被改错、维度用错、或阈值被悄悄放宽时，测试必须失败。
 */

const HASH_KEY = Buffer.alloc(32, 7)

/** 记录每次 consume 的 bucket/subject，并按脚本返回结果。 */
class RecordingLimiter implements AbuseLimiter {
  readonly calls: Array<{ bucket: AbuseLimiterBucket; subject: string | number }> = []

  /** allowCount 次放行之后一律拒绝。 */
  constructor(private readonly allowCount = Number.POSITIVE_INFINITY) {}

  async consume(bucket: AbuseLimiterBucket, subject: string | number): Promise<AbuseLimiterResult> {
    this.calls.push({ bucket, subject })
    return this.calls.length > this.allowCount
      ? { allowed: false, retryAfterSeconds: 42 }
      : { allowed: true, retryAfterSeconds: 0 }
  }
}

describe('chatbot bind abuse policy', () => {
  it('keeps every bucket inside the closed dimension + flow contract', () => {
    const all = [
      ...CHAT_BIND_PLATFORM_BUCKETS,
      ...CHAT_BIND_EMAIL_BUCKETS,
      ...CHAT_BIND_CONFIRM_BUCKETS,
    ]

    for (const bucket of all) {
      // buildAbuseLimiterKey 会校验维度、flow 命名与 limit/window 形状，
      // 不合法即抛 AbuseProtectionUnavailableError——这里用它当断言器。
      expect(() =>
        buildAbuseLimiterKey(bucket, bucket.dimension === 'email' ? 'a@b.co' : 'qq:1', {
          cacheKeyPrefix: 'test',
          hashKey: HASH_KEY,
        }),
      ).not.toThrow()
    }
  })

  it('isolates the two counters: platform and email are different dimensions', () => {
    const platformKey = buildAbuseLimiterKey(
      CHAT_BIND_PLATFORM_BUCKETS[0],
      platformSubject('qq', '430386193'),
      { cacheKeyPrefix: 'test', hashKey: HASH_KEY },
    )
    const emailKey = buildAbuseLimiterKey(
      CHAT_BIND_EMAIL_BUCKETS[0],
      'victim@example.com',
      { cacheKeyPrefix: 'test', hashKey: HASH_KEY },
    )

    expect(platformKey).toContain(':platform:')
    expect(emailKey).toContain(':email:')
    // 同一 QQ 的两个不同邮箱必须共享同一个 platform 计数桶，否则「换邮箱刷」
    // 就能绕过——这正是 platform 维度存在的理由。
    const samePlatform = buildAbuseLimiterKey(
      CHAT_BIND_PLATFORM_BUCKETS[0],
      platformSubject('qq', '430386193'),
      { cacheKeyPrefix: 'test', hashKey: HASH_KEY },
    )
    expect(samePlatform).toBe(platformKey)
  })

  it('hashes the platform identifier so raw QQ numbers never appear in Redis keys', () => {
    const key = buildAbuseLimiterKey(
      CHAT_BIND_PLATFORM_BUCKETS[0],
      platformSubject('qq', '430386193'),
      { cacheKeyPrefix: 'test', hashKey: HASH_KEY },
    )
    expect(key).not.toContain('430386193')
    expect(key).not.toContain('qq:')
  })

  it('lets the first request through and blocks once a bucket denies', async () => {
    // 首次请求会消耗 4 个桶，因此放行 4 次才表示"第一次请求成功"。
    const limiter = new RecordingLimiter(4)

    const first = await consumeChatBindRequest(
      { platform: 'qq', platformId: '430386193', email: 'a@example.com' },
      limiter,
    )
    expect(first.allowed).toBe(true)

    const second = await consumeChatBindRequest(
      { platform: 'qq', platformId: '430386193', email: 'b@example.com' },
      limiter,
    )
    expect(second.allowed).toBe(false)
    expect(second.retryAfterSeconds).toBe(42)
  })

  it('stops at the first denial without incrementing later buckets', async () => {
    // 顺序是契约的一部分：platform 桶先于 email 桶。被 platform 拒绝后
    // 不得再消耗 email 桶，否则攻击者能用被拒的请求持续抬高受害邮箱的计数。
    // 放行次数必须覆盖一次完整请求（4 个桶），否则第一次请求会被中途打断，
    // 测不到"第二次请求少碰一个桶"这个差异。
    const limiter = new RecordingLimiter(4)

    await consumeChatBindRequest(
      { platform: 'qq', platformId: '430386193', email: 'victim@example.com' },
      limiter,
    )
    const before = limiter.calls.length

    await consumeChatBindRequest(
      { platform: 'qq', platformId: '430386193', email: 'victim@example.com' },
      limiter,
    )

    // 第一次请求把两条 platform 规则与两条 email 规则全部消耗掉。
    // 第二次被 platform 拒绝后不再触碰 email 桶，因此只再增加 1 次调用。
    expect(before).toBe(
      CHAT_BIND_PLATFORM_BUCKETS.length + CHAT_BIND_EMAIL_BUCKETS.length,
    )
    expect(limiter.calls.length).toBe(before + 1)
  })

  it('scopes confirm limits to the platform subject only', async () => {
    const limiter = new RecordingLimiter()

    await consumeChatBindConfirm({ platform: 'qq', platformId: '430386193' }, limiter)

    expect(limiter.calls).toHaveLength(CHAT_BIND_CONFIRM_BUCKETS.length)
    for (const call of limiter.calls) {
      expect(call.bucket.dimension).toBe('platform')
      expect(call.subject).toBe('qq:430386193')
    }
  })

  it('pins the documented thresholds so a silent loosening fails CI', () => {
    expect(CHAT_BIND_PLATFORM_BUCKETS.map(b => [b.limit, b.windowMs])).toEqual([
      [3, 60_000],
      [10, 86_400_000],
    ])
    expect(CHAT_BIND_EMAIL_BUCKETS.map(b => [b.limit, b.windowMs])).toEqual([
      [1, 60_000],
      [5, 86_400_000],
    ])
  })

  it('reaches the real limiter contract with an injected lua executor', async () => {
    // 覆盖 createAbuseLimiter 与 chat policy 的接缝：不碰 Redis，但走真实的
    // 键构造与固定窗口判定流程。
    const seen: string[] = []
    const limiter = createAbuseLimiter({
      cacheKeyPrefix: 'test',
      hashKey: HASH_KEY,
      executeLua: async (_script, keys) => {
        seen.push(keys[0])
        return [1, 60_000]
      },
    })

    const result = await consumeChatBindRequest(
      { platform: 'qq', platformId: '430386193', email: 'a@example.com' },
      limiter,
    )

    expect(result.allowed).toBe(true)
    // platform 桶 2 条规则 + email 桶 2 条规则 = 4 次固定窗口消费
    expect(seen).toHaveLength(
      CHAT_BIND_PLATFORM_BUCKETS.length + CHAT_BIND_EMAIL_BUCKETS.length,
    )
    expect(seen.filter(k => k.includes(':platform:'))).toHaveLength(
      CHAT_BIND_PLATFORM_BUCKETS.length,
    )
    expect(seen.filter(k => k.includes(':email:'))).toHaveLength(
      CHAT_BIND_EMAIL_BUCKETS.length,
    )
  })
})
