import { describe, expect, it, vi } from 'vitest'
import {
  AdminPointLogItem,
  isValidAdminPointLogItem,
  isValidPointLogOrder,
  isValidPointLogUser,
  listAdminPointLogs,
  VALID_POINT_LOG_TYPES,
} from './adminPointLogs'
import api from './client'

vi.mock('./client')

const validBaseItem: AdminPointLogItem = {
  id: 1,
  userId: 10,
  type: 'in',
  amount: 100,
  balanceAfter: 100,
  reason: '充值到账',
  orderId: 888,
  createdAt: '2026-09-01T10:00:00.000Z',
  user: { id: 10, email: 'test@example.com', nickname: '测试' },
  order: { id: 888 },
}

describe('adminPointLogs API client (fail-closed contract)', () => {
  it('returns data when response satisfies AdminPointLogsPaged contract', async () => {
    const validEnvelope = {
      items: [validBaseItem],
      total: 1,
      page: 1,
      pageSize: 20,
    }
    vi.mocked(api.get).mockResolvedValueOnce({ data: validEnvelope })

    const res = await listAdminPointLogs({ page: 1, pageSize: 20 })
    expect(res).toEqual(validEnvelope)
  })

  it('fails closed and throws error when API returns a raw array', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ data: [{ id: 1, amount: 100 }] })

    await expect(listAdminPointLogs()).rejects.toThrow(
      /积分流水接口契约异常：预期分页对象格式/,
    )
  })

  it('fails closed and throws error when API returns null or malformed envelope', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ data: null })

    await expect(listAdminPointLogs()).rejects.toThrow(
      /积分流水接口契约异常：预期分页对象格式/,
    )

    vi.mocked(api.get).mockResolvedValueOnce({ data: { count: 0 } })

    await expect(listAdminPointLogs()).rejects.toThrow(
      /积分流水接口契约异常：预期分页对象格式/,
    )
  })

  it('fails closed and throws error when total is a string or negative number', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      data: { items: [], total: 'wrong', page: 1, pageSize: 20 },
    })

    await expect(listAdminPointLogs()).rejects.toThrow(
      /积分流水接口契约异常：预期分页对象格式/,
    )

    vi.mocked(api.get).mockResolvedValueOnce({
      data: { items: [], total: -1, page: 1, pageSize: 20 },
    })

    await expect(listAdminPointLogs()).rejects.toThrow(
      /积分流水接口契约异常：预期分页对象格式/,
    )
  })

  it('fails closed and throws error when page is null, zero, or non-integer', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      data: { items: [], total: 0, page: null, pageSize: 20 },
    })

    await expect(listAdminPointLogs()).rejects.toThrow(
      /积分流水接口契约异常：预期分页对象格式/,
    )

    vi.mocked(api.get).mockResolvedValueOnce({
      data: { items: [], total: 0, page: 0, pageSize: 20 },
    })

    await expect(listAdminPointLogs()).rejects.toThrow(
      /积分流水接口契约异常：预期分页对象格式/,
    )
  })

  it('fails closed and throws error when pageSize is negative, zero, or exceeds 100', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      data: { items: [], total: 0, page: 1, pageSize: -1 },
    })

    await expect(listAdminPointLogs()).rejects.toThrow(
      /积分流水接口契约异常：预期分页对象格式/,
    )

    vi.mocked(api.get).mockResolvedValueOnce({
      data: { items: [], total: 0, page: 1, pageSize: 0 },
    })

    await expect(listAdminPointLogs()).rejects.toThrow(
      /积分流水接口契约异常：预期分页对象格式/,
    )

    vi.mocked(api.get).mockResolvedValueOnce({
      data: { items: [], total: 0, page: 1, pageSize: 101 },
    })

    await expect(listAdminPointLogs()).rejects.toThrow(
      /积分流水接口契约异常：预期分页对象格式/,
    )
  })

  it('fails closed and throws error when items array contains null or non-object element', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      data: { items: [null], total: 1, page: 1, pageSize: 20 },
    })

    await expect(listAdminPointLogs()).rejects.toThrow(
      /积分流水接口契约异常：预期分页对象格式/,
    )

    vi.mocked(api.get).mockResolvedValueOnce({
      data: { items: ['invalid-item'], total: 1, page: 1, pageSize: 20 },
    })

    await expect(listAdminPointLogs()).rejects.toThrow(
      /积分流水接口契约异常：预期分页对象格式/,
    )
  })

  it('fails closed when any item inside items violates schema contracts', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      data: {
        items: [{ ...validBaseItem, reason: {} }],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    })

    await expect(listAdminPointLogs()).rejects.toThrow(
      /积分流水接口契约异常：预期分页对象格式/,
    )
  })
})

describe('isValidAdminPointLogItem and child guards (parameterized unit tests)', () => {
  it('accepts fully populated and valid null items', () => {
    expect(isValidAdminPointLogItem(validBaseItem)).toBe(true)

    const nullReasonOrderUser: AdminPointLogItem = {
      ...validBaseItem,
      reason: null,
      orderId: null,
      user: null,
      order: null,
    }
    expect(isValidAdminPointLogItem(nullReasonOrderUser)).toBe(true)
  })

  it('rejects items missing reason or orderId (must exist as string | null or number | null)', () => {
    // Missing reason property
    const itemWithoutReason = { ...validBaseItem }
    delete (itemWithoutReason as any).reason
    expect(isValidAdminPointLogItem(itemWithoutReason)).toBe(false)
    expect(isValidAdminPointLogItem({ ...validBaseItem, reason: undefined })).toBe(false)

    // Missing orderId property
    const itemWithoutOrderId = { ...validBaseItem }
    delete (itemWithoutOrderId as any).orderId
    expect(isValidAdminPointLogItem(itemWithoutOrderId)).toBe(false)
    expect(isValidAdminPointLogItem({ ...validBaseItem, orderId: undefined })).toBe(false)
  })

  it('accepts each of the six supported types and rejects unsupported types', () => {
    const supportedTypes = ['in', 'out', 'hold', 'release', 'refund', 'sandbox_in'] as const
    for (const t of supportedTypes) {
      expect(VALID_POINT_LOG_TYPES.has(t)).toBe(true)
      expect(isValidAdminPointLogItem({ ...validBaseItem, type: t })).toBe(true)
    }

    const unsupported = ['unknown', 'transfer', 'point_exchange', 'system_adjust', '', 'IN', 'OUT']
    for (const bad of unsupported) {
      expect(isValidAdminPointLogItem({ ...validBaseItem, type: bad as any })).toBe(false)
    }
  })

  it('validates id and userId: must be positive safe integers (> 0)', () => {
    const invalidIds = [0, -1, 1.5, NaN, Infinity, -Infinity, '1', null, undefined, {}]
    for (const badId of invalidIds) {
      expect(isValidAdminPointLogItem({ ...validBaseItem, id: badId as any })).toBe(false)
      expect(isValidAdminPointLogItem({ ...validBaseItem, userId: badId as any })).toBe(false)
    }

    expect(isValidAdminPointLogItem({ ...validBaseItem, id: 1, userId: 2 })).toBe(true)
  })

  it('validates amount and balanceAfter: must be safe integers (rejects decimals)', () => {
    const invalidAmounts = [10.5, -3.14, '100', NaN, Infinity, null, undefined, {}]
    for (const badAmount of invalidAmounts) {
      expect(isValidAdminPointLogItem({ ...validBaseItem, amount: badAmount as any })).toBe(false)
      expect(isValidAdminPointLogItem({ ...validBaseItem, balanceAfter: badAmount as any })).toBe(false)
    }

    // Integers are valid (negative, zero, positive for amount; zero/positive for balanceAfter)
    expect(isValidAdminPointLogItem({ ...validBaseItem, amount: 0, balanceAfter: 0 })).toBe(true)
    expect(isValidAdminPointLogItem({ ...validBaseItem, amount: -100, balanceAfter: 500 })).toBe(true)
  })

  it('validates reason: must be string or null (rejects undefined/missing/object/array/number)', () => {
    expect(isValidAdminPointLogItem({ ...validBaseItem, reason: '合法描述' })).toBe(true)
    expect(isValidAdminPointLogItem({ ...validBaseItem, reason: null })).toBe(true)

    // Undefined, omitted, objects, arrays, numbers must be rejected
    expect(isValidAdminPointLogItem({ ...validBaseItem, reason: undefined as any })).toBe(false)
    expect(isValidAdminPointLogItem({ ...validBaseItem, reason: {} as any })).toBe(false)
    expect(isValidAdminPointLogItem({ ...validBaseItem, reason: [] as any })).toBe(false)
    expect(isValidAdminPointLogItem({ ...validBaseItem, reason: 12345 as any })).toBe(false)
    expect(isValidAdminPointLogItem({ ...validBaseItem, reason: true as any })).toBe(false)
  })

  it('validates orderId: must be null or positive safe integer (rejects undefined/missing/non-positive/decimal)', () => {
    expect(isValidAdminPointLogItem({ ...validBaseItem, orderId: null })).toBe(true)
    expect(isValidAdminPointLogItem({ ...validBaseItem, orderId: 1001 })).toBe(true)

    expect(isValidAdminPointLogItem({ ...validBaseItem, orderId: undefined as any })).toBe(false)
    const invalidOrderIds = [0, -1, 3.14, '1001', {}, []]
    for (const badOrderId of invalidOrderIds) {
      expect(isValidAdminPointLogItem({ ...validBaseItem, orderId: badOrderId as any })).toBe(false)
    }
  })

  it('validates createdAt: must be non-empty parseable ISO date string', () => {
    expect(isValidAdminPointLogItem({ ...validBaseItem, createdAt: '2026-09-04T12:00:00.000Z' })).toBe(true)

    const invalidDates = ['', '   ', 'not-a-date', '2026-99-99', 123456789, null, undefined]
    for (const badDate of invalidDates) {
      expect(isValidAdminPointLogItem({ ...validBaseItem, createdAt: badDate as any })).toBe(false)
    }
  })

  it('validates user structure via isValidPointLogUser: requires nickname to be string or null', () => {
    expect(isValidPointLogUser(null)).toBe(true)
    expect(isValidPointLogUser(undefined)).toBe(true)
    expect(isValidPointLogUser({ id: 1, email: 'user@test.com', nickname: '名' })).toBe(true)
    expect(isValidPointLogUser({ id: 1, email: 'user@test.com', nickname: null })).toBe(true)

    // Missing or undefined nickname must be rejected
    expect(isValidPointLogUser({ id: 1, email: 'user@test.com' })).toBe(false)
    expect(isValidPointLogUser({ id: 1, email: 'user@test.com', nickname: undefined })).toBe(false)

    // Invalid user structures
    expect(isValidPointLogUser('string-not-object')).toBe(false)
    expect(isValidPointLogUser([])).toBe(false)
    expect(isValidPointLogUser({ id: 0, email: 'a@b.com', nickname: null })).toBe(false)
    expect(isValidPointLogUser({ id: -1, email: 'a@b.com', nickname: null })).toBe(false)
    expect(isValidPointLogUser({ id: 1.5, email: 'a@b.com', nickname: null })).toBe(false)
    expect(isValidPointLogUser({ id: 1, email: '', nickname: null })).toBe(false)
    expect(isValidPointLogUser({ id: 1, email: '   ', nickname: null })).toBe(false)
    expect(isValidPointLogUser({ id: 1, email: 123, nickname: null })).toBe(false)
    expect(isValidPointLogUser({ id: 1, email: 'a@b.com', nickname: {} })).toBe(false)
  })

  it('validates order structure via isValidPointLogOrder', () => {
    expect(isValidPointLogOrder(null)).toBe(true)
    expect(isValidPointLogOrder(undefined)).toBe(true)
    expect(isValidPointLogOrder({ id: 500 })).toBe(true)

    // Invalid order structures
    expect(isValidPointLogOrder('string-not-object')).toBe(false)
    expect(isValidPointLogOrder([])).toBe(false)
    expect(isValidPointLogOrder({ id: 0 })).toBe(false)
    expect(isValidPointLogOrder({ id: -500 })).toBe(false)
    expect(isValidPointLogOrder({ id: 3.14 })).toBe(false)
    expect(isValidPointLogOrder({ id: '500' })).toBe(false)
    expect(isValidPointLogOrder({})).toBe(false)
  })
})
