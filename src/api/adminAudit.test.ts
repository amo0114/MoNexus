import { describe, expect, it } from 'vitest'
import {
  isValidAdminAuditItem,
  parseAdminAuditResponse,
  type AdminAuditItem,
  type AdminAuditPaged,
} from './adminAudit'

const validItem: AdminAuditItem = {
  id: 1,
  adminId: 2,
  adminEmail: 'admin@test.local',
  action: 'ban',
  targetType: 'user',
  targetId: 100,
  createdAt: '2026-09-04T12:00:00.000Z',
}

const validEnvelope: AdminAuditPaged = {
  items: [validItem],
  total: 1,
  page: 1,
  pageSize: 20,
}

describe('isValidAdminAuditItem', () => {
  it('accepts a valid item with targetType and targetId', () => {
    expect(isValidAdminAuditItem(validItem)).toBe(true)
  })

  it('accepts a valid item with null targetType and null targetId', () => {
    expect(isValidAdminAuditItem({ ...validItem, targetType: null, targetId: null })).toBe(true)
  })

  it('rejects null, array or empty object', () => {
    expect(isValidAdminAuditItem(null)).toBe(false)
    expect(isValidAdminAuditItem([])).toBe(false)
    expect(isValidAdminAuditItem({})).toBe(false)
    expect(isValidAdminAuditItem('string')).toBe(false)
    expect(isValidAdminAuditItem(123)).toBe(false)
  })

  it('rejects non-positive safe integer id', () => {
    expect(isValidAdminAuditItem({ ...validItem, id: 0 })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, id: -1 })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, id: 1.5 })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, id: Number.MAX_SAFE_INTEGER + 1 })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, id: '1' as any })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, id: undefined as any })).toBe(false)
  })

  it('rejects non-positive safe integer adminId', () => {
    expect(isValidAdminAuditItem({ ...validItem, adminId: 0 })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, adminId: -5 })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, adminId: 2.2 })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, adminId: '2' as any })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, adminId: undefined as any })).toBe(false)
  })

  it('rejects empty or non-string adminEmail', () => {
    expect(isValidAdminAuditItem({ ...validItem, adminEmail: '' })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, adminEmail: '   ' })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, adminEmail: null as any })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, adminEmail: undefined as any })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, adminEmail: 123 as any })).toBe(false)
  })

  it('rejects empty or non-string action', () => {
    expect(isValidAdminAuditItem({ ...validItem, action: '' })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, action: '   ' })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, action: null as any })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, action: undefined as any })).toBe(false)
  })

  it('rejects missing, undefined or non-string non-null targetType', () => {
    expect(isValidAdminAuditItem({ ...validItem, targetType: undefined as any })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, targetType: 123 as any })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, targetType: '' })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, targetType: '   ' })).toBe(false)
  })

  it('rejects missing, undefined, zero, negative, or decimal targetId', () => {
    expect(isValidAdminAuditItem({ ...validItem, targetId: undefined as any })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, targetId: 0 })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, targetId: -1 })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, targetId: 3.14 })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, targetId: '100' as any })).toBe(false)
  })

  it('rejects invalid, malformed, or out-of-bounds createdAt date', () => {
    expect(isValidAdminAuditItem({ ...validItem, createdAt: '' })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, createdAt: 'not-a-date' })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, createdAt: '2026-09-04' })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, createdAt: '2026-09-04T12:00:00' })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, createdAt: '2026-02-31T12:00:00Z' })).toBe(false)
    expect(isValidAdminAuditItem({ ...validItem, createdAt: '2026-09-04T25:00:00Z' })).toBe(false)
  })
})

describe('parseAdminAuditResponse', () => {
  it('parses a valid response envelope correctly', () => {
    const result = parseAdminAuditResponse(validEnvelope)
    expect(result).toEqual(validEnvelope)
  })

  it('rejects raw array response', () => {
    expect(() => parseAdminAuditResponse([validItem])).toThrowError(
      '操作审计接口契约异常：预期分页对象格式 { items, total, page, pageSize }'
    )
  })

  it('rejects null or non-object response', () => {
    expect(() => parseAdminAuditResponse(null)).toThrowError(
      '操作审计接口契约异常：预期分页对象格式 { items, total, page, pageSize }'
    )
    expect(() => parseAdminAuditResponse(undefined)).toThrowError(
      '操作审计接口契约异常：预期分页对象格式 { items, total, page, pageSize }'
    )
    expect(() => parseAdminAuditResponse('invalid')).toThrowError(
      '操作审计接口契约异常：预期分页对象格式 { items, total, page, pageSize }'
    )
  })

  it('rejects missing or non-array items', () => {
    expect(() => parseAdminAuditResponse({ total: 1, page: 1, pageSize: 20 })).toThrowError(
      '操作审计接口契约异常：预期分页对象格式 { items, total, page, pageSize }'
    )
    expect(() =>
      parseAdminAuditResponse({ items: 'not-array', total: 1, page: 1, pageSize: 20 })
    ).toThrowError('操作审计接口契约异常：预期分页对象格式 { items, total, page, pageSize }')
  })

  it('rejects total with string, negative, decimal, or overflow values', () => {
    expect(() => parseAdminAuditResponse({ ...validEnvelope, total: '1' as any })).toThrowError(
      /操作审计接口契约异常/
    )
    expect(() => parseAdminAuditResponse({ ...validEnvelope, total: -1 })).toThrowError(
      /操作审计接口契约异常/
    )
    expect(() => parseAdminAuditResponse({ ...validEnvelope, total: 1.5 })).toThrowError(
      /操作审计接口契约异常/
    )
    expect(() =>
      parseAdminAuditResponse({ ...validEnvelope, total: Number.MAX_SAFE_INTEGER + 1 })
    ).toThrowError(/操作审计接口契约异常/)
  })

  it('rejects page with string, non-positive, decimal, or overflow values', () => {
    expect(() => parseAdminAuditResponse({ ...validEnvelope, page: 0 })).toThrowError(
      /操作审计接口契约异常/
    )
    expect(() => parseAdminAuditResponse({ ...validEnvelope, page: -1 })).toThrowError(
      /操作审计接口契约异常/
    )
    expect(() => parseAdminAuditResponse({ ...validEnvelope, page: 1.5 })).toThrowError(
      /操作审计接口契约异常/
    )
    expect(() => parseAdminAuditResponse({ ...validEnvelope, page: '1' as any })).toThrowError(
      /操作审计接口契约异常/
    )
  })

  it('rejects pageSize with string, zero, negative, decimal, or >100 values', () => {
    expect(() => parseAdminAuditResponse({ ...validEnvelope, pageSize: 0 })).toThrowError(
      /操作审计接口契约异常/
    )
    expect(() => parseAdminAuditResponse({ ...validEnvelope, pageSize: -5 })).toThrowError(
      /操作审计接口契约异常/
    )
    expect(() => parseAdminAuditResponse({ ...validEnvelope, pageSize: 101 })).toThrowError(
      /操作审计接口契约异常/
    )
    expect(() => parseAdminAuditResponse({ ...validEnvelope, pageSize: 20.5 })).toThrowError(
      /操作审计接口契约异常/
    )
    expect(() =>
      parseAdminAuditResponse({ ...validEnvelope, pageSize: '20' as any })
    ).toThrowError(/操作审计接口契约异常/)
  })

  it('rejects entire response if any single item is corrupted', () => {
    const corruptedEnvelope = {
      ...validEnvelope,
      items: [validItem, { ...validItem, id: -99 }],
    }
    expect(() => parseAdminAuditResponse(corruptedEnvelope)).toThrowError(
      '操作审计接口契约异常：预期分页对象格式 { items, total, page, pageSize }'
    )
  })
})
