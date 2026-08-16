// API contract tests for the admin promotion package client
// (T-MERCH-FE-003, SPEC-MERCH-001 §11 admin lane).
// Covers:
//  - GET  /admin/promotion-packages            (includeInactive query param)
//  - POST /admin/promotion-packages            (writable create fields only)
//  - PATCH /admin/promotion-packages/:id        (code is immutable)
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}))

import client from './client'
import {
  createAdminPromotionPackage,
  listAdminPromotionPackages,
  updateAdminPromotionPackage,
} from './merchandising'
import type {
  AdminPromotionPackageCreatePayload,
  AdminPromotionPackageDTO,
  AdminPromotionPackageUpdatePayload,
} from '../types/merchandising'

const mockGet = client.get as unknown as ReturnType<typeof vi.fn>
const mockPost = client.post as unknown as ReturnType<typeof vi.fn>
const mockPatch = client.patch as unknown as ReturnType<typeof vi.fn>

/** Full AdminPromotionPackageDTO fixture (server AdminPackageDto mirror). */
const fixture: AdminPromotionPackageDTO = {
  id: 7,
  code: 'store_home_7d',
  label: '首页推广 7 天',
  placement: 'store_home_sponsored',
  durationDays: 7,
  pricePoints: 100,
  description: '首页推广位 7 天套餐',
  sortOrder: 1,
  status: 'active',
  createdAt: '2026-08-01T02:00:00.000Z',
  updatedAt: '2026-08-01T02:00:00.000Z',
}

beforeEach(() => {
  mockGet.mockReset()
  mockPost.mockReset()
  mockPatch.mockReset()
})

describe('admin promotion package endpoints', () => {
  it('GET /admin/promotion-packages passes includeInactive exactly', async () => {
    mockGet.mockResolvedValue({ data: [fixture] })

    const defaults = await listAdminPromotionPackages()
    expect(defaults).toEqual([fixture])
    expect(mockGet).toHaveBeenCalledWith('/admin/promotion-packages', {
      params: { includeInactive: false },
    })

    mockGet.mockClear()
    const withInactive = await listAdminPromotionPackages(true)
    expect(withInactive).toEqual([fixture])
    expect(mockGet).toHaveBeenCalledWith('/admin/promotion-packages', {
      params: { includeInactive: true },
    })
  })

  it('POST /admin/promotion-packages sends only writable create fields', async () => {
    const payload: AdminPromotionPackageCreatePayload = {
      code: 'store_home_7d',
      label: '首页推广 7 天',
      placement: 'store_home_sponsored',
      durationDays: 7,
      pricePoints: 100,
      description: '首页推广位 7 天套餐',
      sortOrder: 1,
    }
    mockPost.mockResolvedValue({ data: { package: fixture } })

    const result = await createAdminPromotionPackage(payload)
    expect(result).toEqual(fixture)
    expect(mockPost).toHaveBeenCalledWith('/admin/promotion-packages', payload)
    // Create payload is exactly the writable field set — no server-managed fields.
    expect(Object.keys(payload).sort()).toEqual([
      'code',
      'description',
      'durationDays',
      'label',
      'placement',
      'pricePoints',
      'sortOrder',
    ])
    expect(payload).not.toHaveProperty('status')
    expect(payload).not.toHaveProperty('createdAt')
    expect(payload).not.toHaveProperty('updatedAt')
  })

  it('PATCH /admin/promotion-packages/:id never sends the immutable code', async () => {
    const payload: AdminPromotionPackageUpdatePayload = {
      label: '首页推广 7 天',
      status: 'inactive',
      pricePoints: 150,
    }
    mockPatch.mockResolvedValue({ data: { package: fixture } })

    const result = await updateAdminPromotionPackage(7, payload)
    expect(result).toEqual(fixture)
    expect(mockPatch).toHaveBeenCalledWith('/admin/promotion-packages/7', payload)
    expect(payload).not.toHaveProperty('code')
  })
})
