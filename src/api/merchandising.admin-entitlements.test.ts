// API contract tests for the admin merchant entitlement client
// (T-MERCH-FE-003, SPEC-MERCH-001 §5.6 admin lane).
// Covers:
//  - GET  /admin/merchant-entitlements              (merchantId/status/page/pageSize)
//  - GET  /admin/merchant-entitlements              ('all' status is omitted)
//  - POST /admin/merchant-entitlements              (direct DTO, no wrapper)
//  - POST /admin/merchant-entitlements/:id/revoke   (strictly { reason })
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}))

import client from './client'
import {
  grantAdminMerchantEntitlement,
  listAdminMerchantEntitlements,
  revokeAdminMerchantEntitlement,
} from './merchandising'
import type {
  AdminMerchantEntitlementDTO,
  AdminMerchantEntitlementGrantPayload,
  AdminMerchantEntitlementPage,
} from '../types/merchandising'

const mockGet = client.get as unknown as ReturnType<typeof vi.fn>
const mockPost = client.post as unknown as ReturnType<typeof vi.fn>

/** Full AdminMerchantEntitlementDTO fixture (server entitlement service select). */
const fixture: AdminMerchantEntitlementDTO = {
  id: 12,
  merchantId: 101,
  code: 'partner',
  source: 'admin_grant',
  sourceRef: null,
  status: 'active',
  validFrom: '2026-08-01T02:00:00.000Z',
  validUntil: '2026-08-08T02:00:00.000Z',
  reason: '运营后台授予',
  grantedByUserId: 1001,
  revokedByUserId: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T02:00:00.000Z',
}

beforeEach(() => {
  mockGet.mockReset()
  mockPost.mockReset()
})

describe('admin merchant entitlement endpoints', () => {
  it('GET /admin/merchant-entitlements passes merchantId/status/page/pageSize exactly', async () => {
    const wirePage: AdminMerchantEntitlementPage = {
      items: [fixture],
      total: 1,
      page: 2,
      pageSize: 10,
    }
    mockGet.mockResolvedValue({ data: wirePage })

    const result = await listAdminMerchantEntitlements({
      merchantId: 101,
      status: 'active',
      page: 2,
      pageSize: 10,
    })
    // Server page is returned as-is (adapter is passthrough).
    expect(result).toEqual(wirePage)
    expect(result.items).toEqual([fixture])
    expect(mockGet).toHaveBeenCalledWith('/admin/merchant-entitlements', {
      params: { merchantId: 101, status: 'active', page: 2, pageSize: 10 },
    })

    // 'all' status means "no status filter" — it is omitted, never sent.
    mockGet.mockClear()
    mockGet.mockResolvedValue({ data: wirePage })
    await listAdminMerchantEntitlements({ merchantId: 101, status: 'all', page: 1, pageSize: 20 })
    expect(mockGet).toHaveBeenCalledWith('/admin/merchant-entitlements', {
      params: { merchantId: 101, page: 1, pageSize: 20 },
    })
  })

  it('GET /admin/merchant-entitlements sends only defined params when empty', async () => {
    const wirePage: AdminMerchantEntitlementPage = {
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    }
    mockGet.mockResolvedValue({ data: wirePage })

    await listAdminMerchantEntitlements()
    expect(mockGet).toHaveBeenCalledWith('/admin/merchant-entitlements', {
      params: {},
    })
  })

  it('POST /admin/merchant-entitlements sends the exact body and returns the bare DTO', async () => {
    const payload: AdminMerchantEntitlementGrantPayload = {
      merchantId: 101,
      validUntil: '2026-08-08T02:00:00.000Z',
      reason: '运营后台授予',
    }
    mockPost.mockResolvedValue({ data: fixture })

    const result = await grantAdminMerchantEntitlement(payload)
    // 201 body is the bare DTO — no wrapper to unwrap.
    expect(result).toEqual(fixture)
    expect(mockPost).toHaveBeenCalledWith('/admin/merchant-entitlements', payload)
  })

  it('POST /admin/merchant-entitlements/12/revoke sends strictly { reason }', async () => {
    mockPost.mockResolvedValue({ data: fixture })

    const result = await revokeAdminMerchantEntitlement(12, '违规授予')
    expect(result).toEqual(fixture)
    expect(mockPost).toHaveBeenCalledWith('/admin/merchant-entitlements/12/revoke', {
      reason: '违规授予',
    })
  })
})
