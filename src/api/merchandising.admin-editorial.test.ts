// API contract tests for the admin editorial feature client
// (SPEC-MERCH-001 §5.5 editorial lane, admin API).
// Covers:
//  - GET  /admin/editorial-features               (status/placement/page/pageSize)
//  - GET  /admin/editorial-features               ('all' UI values are omitted)
//  - POST /admin/editorial-features               (direct DTO, no wrapper)
//  - PATCH /admin/editorial-features/:id           (direct DTO, no wrapper)
//  - POST /admin/editorial-features/:id/revoke     (strictly { reason })
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}))

import client from './client'
import {
  createAdminEditorialFeature,
  listAdminEditorialFeatures,
  revokeAdminEditorialFeature,
  updateAdminEditorialFeature,
} from './merchandising'
import type {
  AdminEditorialCreatePayload,
  AdminEditorialFeatureDTO,
  AdminEditorialFeaturePage,
  AdminEditorialUpdatePayload,
} from '../types/merchandising'

const mockGet = client.get as unknown as ReturnType<typeof vi.fn>
const mockPost = client.post as unknown as ReturnType<typeof vi.fn>
const mockPatch = client.patch as unknown as ReturnType<typeof vi.fn>

/** Full AdminEditorialFeatureDTO fixture (server editorial service select). */
const fixture: AdminEditorialFeatureDTO = {
  id: 12,
  productId: 555,
  productName: '云端工具',
  placement: 'store_editorial',
  status: 'active',
  startsAt: '2026-08-01T02:00:00.000Z',
  endsAt: '2026-08-08T02:00:00.000Z',
  sortWeight: 10,
  publicReason: '平台精选推荐',
  internalReason: '运营后台创建',
  createdByUserId: 1001,
  revokedByUserId: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T02:00:00.000Z',
}

beforeEach(() => {
  mockGet.mockReset()
  mockPost.mockReset()
  mockPatch.mockReset()
})

describe('admin editorial feature endpoints', () => {
  it('GET /admin/editorial-features passes status/placement/page/pageSize exactly', async () => {
    const wirePage: AdminEditorialFeaturePage = {
      items: [fixture],
      total: 1,
      page: 2,
      pageSize: 10,
    }
    mockGet.mockResolvedValue({ data: wirePage })

    const result = await listAdminEditorialFeatures({
      status: 'scheduled',
      placement: 'store_editorial',
      page: 2,
      pageSize: 10,
    })
    // Server page is returned as-is (adapter is passthrough).
    expect(result).toEqual(wirePage)
    expect(result.items).toEqual([fixture])
    expect(mockGet).toHaveBeenCalledWith('/admin/editorial-features', {
      params: { status: 'scheduled', placement: 'store_editorial', page: 2, pageSize: 10 },
    })
  })

  it('GET /admin/editorial-features omits "all" status/placement UI values', async () => {
    const wirePage: AdminEditorialFeaturePage = {
      items: [fixture],
      total: 1,
      page: 1,
      pageSize: 20,
    }
    mockGet.mockResolvedValue({ data: wirePage })

    const result = await listAdminEditorialFeatures({
      status: 'all',
      placement: 'all',
      page: 1,
      pageSize: 20,
    })
    expect(result).toEqual(wirePage)
    // 'all' is never sent — the server rejects it.
    expect(mockGet).toHaveBeenCalledWith('/admin/editorial-features', {
      params: { page: 1, pageSize: 20 },
    })
  })

  it('POST /admin/editorial-features sends the exact body and returns the bare DTO', async () => {
    const payload: AdminEditorialCreatePayload = {
      productId: 555,
      placement: 'store_editorial',
      startsAt: '2026-08-01T02:00:00.000Z',
      endsAt: '2026-08-08T02:00:00.000Z',
      sortWeight: 10,
      publicReason: '平台精选推荐',
      internalReason: '运营后台创建',
    }
    mockPost.mockResolvedValue({ data: fixture })

    const result = await createAdminEditorialFeature(payload)
    // 201 body is the bare DTO — no wrapper to unwrap.
    expect(result).toEqual(fixture)
    expect(mockPost).toHaveBeenCalledWith('/admin/editorial-features', payload)
  })

  it('PATCH /admin/editorial-features/:id sends the exact body and returns the bare DTO', async () => {
    const payload: AdminEditorialUpdatePayload = {
      sortWeight: 20,
      publicReason: '更新推荐理由',
    }
    mockPatch.mockResolvedValue({ data: fixture })

    const result = await updateAdminEditorialFeature(12, payload)
    expect(result).toEqual(fixture)
    expect(mockPatch).toHaveBeenCalledWith('/admin/editorial-features/12', payload)
  })

  it('POST /admin/editorial-features/:id/revoke sends strictly { reason }', async () => {
    mockPost.mockResolvedValue({ data: fixture })

    const result = await revokeAdminEditorialFeature(12, '违规下架')
    expect(result).toEqual(fixture)
    expect(mockPost).toHaveBeenCalledWith('/admin/editorial-features/12/revoke', {
      reason: '违规下架',
    })
  })
})
