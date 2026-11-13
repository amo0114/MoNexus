import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { prisma } from '../lib/prisma.js'
import {
  _clearAll,
  _resetForTesting,
  _setMaxEntriesForTesting,
  _setNowForTesting,
  _setTtlSecForTesting,
  getCached,
  setCached,
} from '../lib/userStatusCache.js'

describe('User.status cache', () => {
  beforeEach(() => {
    _resetForTesting()
    _clearAll()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    _resetForTesting()
    _clearAll()
  })

  it('does not authorize a warm cached user after a structured ban written by another instance', async () => {
    _setTtlSecForTesting(60)
    const { user, password } = await createTestUser('status-cache-hit@test.local', 'pass123')
    const { accessToken } = await loginAs(user.email, password)
    setCached(user.id, '正常')
    // Simulate another replica: no local invalidation and no status projection update.
    await prisma.accountBan.create({
      data: {
        userId: user.id,
        reasonCode: 'external_instance_ban',
        startsAt: new Date(),
      },
    })
    expect(getCached(user.id)).toBe('正常')
    const result = await api.get('/api/auth/me').set(authHeader(accessToken)).expect(403)
    expect(result.body.error.message).toBe('账号已被封禁')
  })

  it('expires legacy cache entries without extending their deadline on a read', () => {
    let now = 1_000
    _setNowForTesting(() => now)
    _setTtlSecForTesting(60)
    setCached(1, '正常')
    now += 30_000
    expect(getCached(1)).toBe('正常')
    now += 31_000
    expect(getCached(1)).toBeUndefined()
  })

  it('should invalidate cached active status immediately after ban', async () => {
    await createTestUser('status-cache-admin@test.local', 'admin123', 'admin')
    const { user, password } = await createTestUser('status-cache-ban@test.local', 'pass123')
    const { accessToken } = await loginAs(user.email, password)
    const admin = await loginAs('status-cache-admin@test.local', 'admin123')

    await api.get('/api/auth/me').set(authHeader(accessToken)).expect(200)

    await api
      .put(`/api/admin/users/${user.id}/ban`)
      .set(authHeader(admin.accessToken))
      .send({ reason: 'cache invalidation regression' })
      .expect(200)

    const res = await api.get('/api/auth/me').set(authHeader(accessToken)).expect(403)
    expect(res.body.error.message).toBe('账号已被封禁')
  })

  it('disables legacy cache reads and writes when TTL is zero', () => {
    _setTtlSecForTesting(0)
    setCached(1, '正常')
    expect(getCached(1)).toBeUndefined()
  })

  it('should evict the least recently used status when the cache reaches its cap', () => {
    _setMaxEntriesForTesting(2)

    setCached(1, '正常')
    setCached(2, '正常')
    expect(getCached(1)).toBe('正常')
    setCached(3, '已封禁')

    expect(getCached(1)).toBe('正常')
    expect(getCached(2)).toBeUndefined()
    expect(getCached(3)).toBe('已封禁')
  })
})
