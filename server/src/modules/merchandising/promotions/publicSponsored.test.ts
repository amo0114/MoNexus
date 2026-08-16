// CHK-PUBLIC-002 / CHK-QA-001 — Rotation bucket & rank determinism (pure-unit, no DB)
// (SPEC-MERCH-001 §7.5, D-MERCH-14).
//
// 验证 `computeSponsoredBucket` / `computeRotationRank` 的确定性与公平性：
//   - 同一 10 分钟窗口内 bucket 恒定、排序稳定；
//   - 跨窗口 bucket 递增、排序发生轮换；
//   - hex key 防平局（任意两 campaign 在任意 bucket 下 key 互不相等）；
//   - 不依赖 Date.now()（测试可冻结 nowMs）。
//
// 不覆盖 `listSponsoredItems`（已被 `promotions-billing.test.ts` 的 eligible
// active 集成用例覆盖）；本文件仅测纯函数逻辑。

import { describe, it, expect } from 'vitest'
import {
  computeSponsoredBucket,
  computeRotationRank,
  SPONSORED_ROTATION_BUCKET_MS,
} from './publicSponsored.js'

describe('Rotation determinism (CHK-PUBLIC-002)', () => {
  it('computeSponsoredBucket returns the same bucket within a 10-minute window', () => {
    // 对齐到 bucket 边界:10 分钟 = 600000ms
    const bucketStart = Math.floor(1723456789000 / SPONSORED_ROTATION_BUCKET_MS) * SPONSORED_ROTATION_BUCKET_MS
    const bucket0 = computeSponsoredBucket(bucketStart)
    const bucket1 = computeSponsoredBucket(bucketStart + 1) // +1ms
    const bucket2 = computeSponsoredBucket(bucketStart + 5 * 60 * 1000) // +5min
    const bucket3 = computeSponsoredBucket(bucketStart + SPONSORED_ROTATION_BUCKET_MS - 1) // 边界前 1ms
    expect(bucket1).toBe(bucket0)
    expect(bucket2).toBe(bucket0)
    expect(bucket3).toBe(bucket0)
  })

  it('computeSponsoredBucket increments across 10-minute boundaries', () => {
    const base = 1723456789000
    const bucket0 = computeSponsoredBucket(base)
    const bucket1 = computeSponsoredBucket(base + SPONSORED_ROTATION_BUCKET_MS)
    const bucket2 = computeSponsoredBucket(base + 2 * SPONSORED_ROTATION_BUCKET_MS)
    expect(bucket1).toBe(bucket0 + 1)
    expect(bucket2).toBe(bucket0 + 2)
  })

  it('computeRotationRank is deterministic: same (id, placement, bucket) → same hex key', () => {
    const key1a = computeRotationRank(101, 'top', 12345)
    const key1b = computeRotationRank(101, 'top', 12345)
    expect(key1a).toBe(key1b)
    expect(key1a).toMatch(/^[0-9a-f]{64}$/) // SHA-256 hex
  })

  it('computeRotationRank produces different keys when any input changes', () => {
    const base = computeRotationRank(101, 'top', 12345)
    const diffId = computeRotationRank(102, 'top', 12345)
    const diffPlacement = computeRotationRank(101, 'middle', 12345)
    const diffBucket = computeRotationRank(101, 'top', 12346)
    expect(diffId).not.toBe(base)
    expect(diffPlacement).not.toBe(base)
    expect(diffBucket).not.toBe(base)
  })

  it('rotation rank ordering changes across buckets (fairness)', () => {
    const campaigns = [101, 102, 103]
    const bucket1 = 12345
    const bucket2 = 12346

    const keysB1 = campaigns.map(id => ({ id, key: computeRotationRank(id, 'top', bucket1) }))
    const keysB2 = campaigns.map(id => ({ id, key: computeRotationRank(id, 'top', bucket2) }))

    const orderB1 = keysB1.sort((a, b) => (a.key < b.key ? -1 : 1)).map(x => x.id)
    const orderB2 = keysB2.sort((a, b) => (a.key < b.key ? -1 : 1)).map(x => x.id)

    // 不同 bucket 下排序应不同（SHA-256 散列特性；若恰好相同则说明样本太小，但在实际 10 个以上 campaign 下轮换必发生）
    // 本测试用 3 个 campaign、连续 bucket，D-MERCH-14 承诺的公平性在此概率上可验证
    expect(orderB1).not.toEqual(orderB2)
  })

  it('rotation rank has no ties: any two campaigns produce distinct keys (CHK-QA-001)', () => {
    const ids = [1, 2, 99, 100, 999]
    const bucket = 12345
    const keys = ids.map(id => computeRotationRank(id, 'top', bucket))
    const uniqueKeys = new Set(keys)
    expect(uniqueKeys.size).toBe(ids.length) // 无重复 → 无平局
  })

  it('rejects invalid inputs with stable error messages', () => {
    expect(() => computeSponsoredBucket(-1)).toThrow('non-negative finite nowMs')
    expect(() => computeSponsoredBucket(NaN)).toThrow('non-negative finite nowMs')
    expect(() => computeRotationRank(0, 'top', 123)).toThrow('positive integer campaignId')
    expect(() => computeRotationRank(1.5, 'top', 123)).toThrow('positive integer campaignId')
    expect(() => computeRotationRank(101, 'top', NaN)).toThrow('finite bucket')
  })
})
