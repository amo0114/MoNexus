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

function statusLookupCalls(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter(([args]) => {
    const query = args as { select?: Record<string, unknown>; where?: Record<string, unknown> }
    return query.where?.id && query.select?.status === true && Object.keys(query.select).length === 1
  })
}

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

  it('should reuse cached active status on repeated protected requests', async () => {
    const { user, password } = await createTestUser('status-cache-hit@test.local', 'pass123')
    const { accessToken } = await loginAs(user.email, password)
    const findUnique = vi.spyOn(prisma.user, 'findUnique')

    await api.get('/api/auth/me').set(authHeader(accessToken)).expect(200)
    expect(statusLookupCalls(findUnique)).toHaveLength(1)

    await api.get('/api/auth/me').set(authHeader(accessToken)).expect(200)
    expect(statusLookupCalls(findUnique)).toHaveLength(1)
  })

  it('should miss the cache after TTL expiry', async () => {
    let now = 1_000
    _setNowForTesting(() => now)
    _setTtlSecForTesting(60)
    const { user, password } = await createTestUser('status-cache-ttl@test.local', 'pass123')
    const { accessToken } = await loginAs(user.email, password)
    const findUnique = vi.spyOn(prisma.user, 'findUnique')

    await api.get('/api/auth/me').set(authHeader(accessToken)).expect(200)
    expect(statusLookupCalls(findUnique)).toHaveLength(1)

    now += 30_000
    await api.get('/api/auth/me').set(authHeader(accessToken)).expect(200)
    expect(statusLookupCalls(findUnique)).toHaveLength(1)

    now += 31_000
    await api.get('/api/auth/me').set(authHeader(accessToken)).expect(200)
    expect(statusLookupCalls(findUnique)).toHaveLength(2)
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

  it('should disable cache reads and writes when TTL is zero', async () => {
    _setTtlSecForTesting(0)
    const { user, password } = await createTestUser('status-cache-disabled@test.local', 'pass123')
    const { accessToken } = await loginAs(user.email, password)
    const findUnique = vi.spyOn(prisma.user, 'findUnique')

    await api.get('/api/auth/me').set(authHeader(accessToken)).expect(200)
    await api.get('/api/auth/me').set(authHeader(accessToken)).expect(200)

    expect(statusLookupCalls(findUnique)).toHaveLength(2)
    expect(getCached(user.id)).toBeUndefined()
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
