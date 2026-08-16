// API contract tests for the admin merchandising ranking runs/recompute client
// (T-MERCH-FE-003, SPEC-MERCH-001 §5.1 admin lane).
// Covers:
//  - GET  /admin/merchandising/runs          (page/pageSize params + empty params)
//  - POST /admin/merchandising/recompute     (strictly {} body, bare union result)
//  - completed / failed / skipped (lock_busy|running_exists) union passthrough
//  - HTTP 429 (cadence) / HTTP 503 (compute-unavailable) rejections propagate as-is
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}))

import client from './client'
import {
  listAdminMerchandisingRuns,
  recomputeAdminMerchandising,
} from './merchandising'
import type {
  AdminMerchandisingRunDTO,
  AdminMerchandisingRunPage,
  AdminRecomputeResult,
} from '../types/merchandising'

const mockGet = client.get as unknown as ReturnType<typeof vi.fn>
const mockPost = client.post as unknown as ReturnType<typeof vi.fn>

/** Full AdminMerchandisingRunDTO fixture (server AdminRunRow, ISO-string dates). */
const runFixture: AdminMerchandisingRunDTO = {
  id: 'run_20260801_001',
  status: 'completed',
  windowStart: '2026-07-25T00:00:00.000Z',
  windowEnd: '2026-08-01T00:00:00.000Z',
  windowDays: 7,
  minSales: 3,
  topPercent: 10,
  startedAt: '2026-08-01T02:00:00.000Z',
  completedAt: '2026-08-01T02:05:00.000Z',
  failedAt: null,
  failureCode: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  snapshotCount: 120,
}

/** Axios-like rejection carrying an HTTP status (cadence / compute-unavailable). */
interface MockHttpRejection {
  message: string
  response: { status: number }
}

beforeEach(() => {
  mockGet.mockReset()
  mockPost.mockReset()
})

describe('admin merchandising ranking runs/recompute endpoints', () => {
  it('GET /admin/merchandising/runs passes page/pageSize exactly and returns the page as-is', async () => {
    const wirePage: AdminMerchandisingRunPage = {
      runs: [runFixture],
      total: 1,
      page: 2,
      pageSize: 10,
    }
    mockGet.mockResolvedValue({ data: wirePage })

    const result = await listAdminMerchandisingRuns({ page: 2, pageSize: 10 })
    // Server page is returned as-is (passthrough adapter); dates stay ISO strings.
    expect(result).toEqual(wirePage)
    expect(result.runs).toEqual([runFixture])
    expect(result.runs[0].startedAt).toBe('2026-08-01T02:00:00.000Z')
    expect(mockGet).toHaveBeenCalledWith('/admin/merchandising/runs', {
      params: { page: 2, pageSize: 10 },
    })
  })

  it('GET /admin/merchandising/runs sends only defined params when empty', async () => {
    const wirePage: AdminMerchandisingRunPage = {
      runs: [],
      total: 0,
      page: 1,
      pageSize: 20,
    }
    mockGet.mockResolvedValue({ data: wirePage })

    await listAdminMerchandisingRuns()
    expect(mockGet).toHaveBeenCalledWith('/admin/merchandising/runs', {
      params: {},
    })
  })

  it('POST /admin/merchandising/recompute sends strictly {} and returns the completed union as-is', async () => {
    const completed: AdminRecomputeResult = {
      kind: 'completed',
      runId: 'run_20260801_002',
      snapshotCount: 120,
      adminUserId: 1001,
    }
    mockPost.mockResolvedValue({ data: completed })

    const result = await recomputeAdminMerchandising()
    expect(result).toEqual(completed)
    expect(mockPost).toHaveBeenCalledWith('/admin/merchandising/recompute', {})
  })

  it('POST /admin/merchandising/recompute returns the failed union as-is', async () => {
    const failed: AdminRecomputeResult = {
      kind: 'failed',
      runId: null,
      failureCode: 'COMPUTE_FAILED',
      wrappedUp: true,
      adminUserId: 1001,
    }
    mockPost.mockResolvedValue({ data: failed })

    const result = await recomputeAdminMerchandising()
    expect(result).toEqual(failed)
    expect(mockPost).toHaveBeenCalledWith('/admin/merchandising/recompute', {})
  })

  it('POST /admin/merchandising/recompute returns the skipped union as-is (lock_busy / running_exists)', async () => {
    const skippedLockBusy: AdminRecomputeResult = {
      kind: 'skipped',
      reason: 'lock_busy',
      adminUserId: 1001,
    }
    mockPost.mockResolvedValue({ data: skippedLockBusy })
    const resultLockBusy = await recomputeAdminMerchandising()
    expect(resultLockBusy).toEqual(skippedLockBusy)

    const skippedRunningExists: AdminRecomputeResult = {
      kind: 'skipped',
      reason: 'running_exists',
      adminUserId: 1001,
    }
    mockPost.mockResolvedValue({ data: skippedRunningExists })
    const resultRunningExists = await recomputeAdminMerchandising()
    expect(resultRunningExists).toEqual(skippedRunningExists)
    expect(mockPost).toHaveBeenCalledTimes(2)
  })

  it('POST /admin/merchandising/recompute propagates an HTTP 429 (cadence) rejection as-is', async () => {
    const rejection: MockHttpRejection = {
      message: 'Request failed with status code 429',
      response: { status: 429 },
    }
    mockPost.mockRejectedValue(rejection)

    await expect(recomputeAdminMerchandising()).rejects.toBe(rejection)
    expect(mockPost).toHaveBeenCalledWith('/admin/merchandising/recompute', {})
  })

  it('POST /admin/merchandising/recompute propagates an HTTP 503 (compute-unavailable) rejection as-is', async () => {
    const rejection: MockHttpRejection = {
      message: 'Request failed with status code 503',
      response: { status: 503 },
    }
    mockPost.mockRejectedValue(rejection)

    await expect(recomputeAdminMerchandising()).rejects.toBe(rejection)
    expect(mockPost).toHaveBeenCalledWith('/admin/merchandising/recompute', {})
  })
})
