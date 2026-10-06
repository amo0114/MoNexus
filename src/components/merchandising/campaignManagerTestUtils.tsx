// R12 split — shared test utilities for the AdminPromotionCampaignManager
// behavior suites. This module holds ONLY pure artifacts:
//   * the frozen DTO fixtures,
//   * the deferred list controller factory,
//   * renderManager() (creates FRESH mutable adapter mocks per call),
//   * assertion/query helpers and the typed server-error envelope factory.
//
// There is no `vi.mock` anywhere in this suite: nothing is module-mocked, no
// module registry is patched, and no global hook (beforeEach/afterEach/fake
// timers) is registered here. Importing this helper therefore cannot reorder
// module loading or leak state between tests. Every mutable adapter/mock is
// built inside renderManager() at call time, so each test owns its own data.
//
// Environment cleanup stays where it already was — the shared
// src/test/setup.ts registers afterEach(cleanup) for every suite file.

import { act, render, within } from '@testing-library/react'
import { expect, vi } from 'vitest'
import AdminPromotionCampaignManager, {
  type AdminPromotionCampaignAdapter,
} from './AdminPromotionCampaignManager'
import type { AdminPromotionCampaignQuery } from '../../api/merchandising'
import type {
  AdminPromotionCampaignCancelPayload,
  AdminPromotionCampaignDTO,
  AdminPromotionCampaignPage,
  AdminPromotionRefundAdjustmentPayload,
} from '../../types/merchandising'

// Complete DTO fixtures covering every field. All audit fields are present so
// the fixtures type-check; the sensitive sentinel ids are only asserted to
// never appear in the DOM.
export const pendingReviewCampaign: AdminPromotionCampaignDTO = {
  id: 501,
  merchantId: 9001,
  productId: 7001,
  packageId: 61,
  packageCodeSnapshot: 'PKG-STORE-HOME-30',
  placementSnapshot: 'store_home_sponsored',
  durationDaysSnapshot: 30,
  pricePointsSnapshot: 1200,
  status: 'pending_review',
  requestedStartAt: '2026-03-01T00:00:00.000Z',
  startsAt: null,
  endsAt: null,
  reviewedByUserId: null,
  reviewedAt: null,
  reviewReason: null,
  cancelledByUserId: null,
  cancellationReason: null,
  chargedPoints: 0,
  refundedPoints: 0,
  createdAt: '2026-02-10T09:00:00.000Z',
  updatedAt: '2026-02-10T09:30:00.000Z',
}

export const activeCampaign: AdminPromotionCampaignDTO = {
  id: 502,
  merchantId: 9002,
  productId: 7002,
  packageId: 62,
  packageCodeSnapshot: 'PKG-CATEGORY-7D',
  placementSnapshot: 'category_sponsored',
  durationDaysSnapshot: 7,
  pricePointsSnapshot: 300,
  status: 'active',
  requestedStartAt: '2026-01-20T00:00:00.000Z',
  startsAt: '2026-02-01T00:00:00.000Z',
  endsAt: '2026-03-01T00:00:00.000Z',
  reviewedByUserId: null,
  reviewedAt: '2026-01-22T00:00:00.000Z',
  reviewReason: null,
  cancelledByUserId: null,
  cancellationReason: null,
  chargedPoints: 600,
  refundedPoints: 120,
  createdAt: '2026-01-18T00:00:00.000Z',
  updatedAt: '2026-01-22T00:00:00.000Z',
}

export const pausedCampaign: AdminPromotionCampaignDTO = {
  ...activeCampaign,
  id: 503,
  merchantId: 9003,
  productId: 7003,
  status: 'paused',
  endsAt: null,
  refundedPoints: 100,
  updatedAt: '2026-02-05T00:00:00.000Z',
}

// Sensitive boundary fixtures: non-null review/cancellation reasons that MUST
// render, paired with unique sentinel actor ids that MUST NOT render.
export const rejectedCampaign: AdminPromotionCampaignDTO = {
  ...pendingReviewCampaign,
  id: 504,
  merchantId: 9004,
  productId: 7004,
  status: 'rejected',
  reviewedByUserId: 9876543210,
  reviewedAt: '2026-02-12T00:00:00.000Z',
  reviewReason: '资质材料不完整，请补充后重新提交。',
  updatedAt: '2026-02-12T00:00:00.000Z',
}

export const cancelledCampaign: AdminPromotionCampaignDTO = {
  ...activeCampaign,
  id: 505,
  merchantId: 9005,
  productId: 7005,
  status: 'cancelled',
  cancelledByUserId: 8765432109,
  cancellationReason: '商家主动撤回推广申请。',
  refundedPoints: 300,
  updatedAt: '2026-02-06T00:00:00.000Z',
}

export const paymentFailedCampaign: AdminPromotionCampaignDTO = {
  ...pendingReviewCampaign,
  id: 506,
  merchantId: 9006,
  productId: 7006,
  status: 'payment_failed',
}

export const scheduledCampaign: AdminPromotionCampaignDTO = {
  ...activeCampaign,
  id: 507,
  merchantId: 9007,
  productId: 7007,
  status: 'scheduled',
}

export const expiredCampaign: AdminPromotionCampaignDTO = {
  ...activeCampaign,
  id: 508,
  merchantId: 9008,
  productId: 7008,
  status: 'expired',
}

interface PendingListRequest {
  resolve: (value: AdminPromotionCampaignPage) => void
  reject: (reason?: unknown) => void
}

/**
 * Deferred list controller for listAdminPromotionCampaigns. A single pending
 * array where each entry carries BOTH resolve and reject, and requests are
 * settled by request index — the stale tests settle the newer request before
 * the older one without resolve/reject queues drifting apart.
 */
function createListController() {
  const pending: PendingListRequest[] = []

  const listCampaigns = vi.fn(
    (_query?: AdminPromotionCampaignQuery) =>
      new Promise<AdminPromotionCampaignPage>((resolve, reject) => {
        pending.push({ resolve, reject })
      }),
  )

  return {
    listCampaigns,
    resolve: async (index: number, value: AdminPromotionCampaignPage) => {
      const entry = pending[index]
      if (!entry) {
        throw new Error(`No pending listCampaigns request at index ${index} — cannot resolve`)
      }
      await act(async () => {
        entry.resolve(value)
      })
    },
    reject: async (index: number, reason?: unknown) => {
      const entry = pending[index]
      if (!entry) {
        throw new Error(`No pending listCampaigns request at index ${index} — cannot reject`)
      }
      await act(async () => {
        entry.reject(reason)
      })
    },
  }
}

export function renderManager() {
  const controller = createListController()

  // Complete strongly-typed mutation mocks — exact signatures of the real
  // adapter functions (typeof approveAdminPromotionCampaign family). They
  // resolve full DTOs, but this query card never triggers them.
  const approveCampaign = vi.fn<(id: number) => Promise<AdminPromotionCampaignDTO>>()
  approveCampaign.mockResolvedValue(activeCampaign)
  const rejectCampaign = vi.fn<(id: number, reason: string) => Promise<AdminPromotionCampaignDTO>>()
  rejectCampaign.mockResolvedValue(rejectedCampaign)
  const pauseCampaign = vi.fn<(id: number) => Promise<AdminPromotionCampaignDTO>>()
  pauseCampaign.mockResolvedValue(pausedCampaign)
  const resumeCampaign = vi.fn<(id: number) => Promise<AdminPromotionCampaignDTO>>()
  resumeCampaign.mockResolvedValue(activeCampaign)
  const cancelCampaign = vi.fn<
    (
      id: number,
      payload?: AdminPromotionCampaignCancelPayload,
      idempotencyKey?: string,
    ) => Promise<AdminPromotionCampaignDTO>
  >()
  cancelCampaign.mockResolvedValue(cancelledCampaign)
  const adjustRefund = vi.fn<
    (
      id: number,
      payload: AdminPromotionRefundAdjustmentPayload,
      idempotencyKey: string,
    ) => Promise<AdminPromotionCampaignDTO>
  >()
  adjustRefund.mockResolvedValue(cancelledCampaign)
  const createIdempotencyKey = vi.fn<() => string>()
  createIdempotencyKey.mockReturnValue('campaign-query-card-key')

  const adapter: AdminPromotionCampaignAdapter = {
    listCampaigns: controller.listCampaigns,
    approveCampaign,
    rejectCampaign,
    pauseCampaign,
    resumeCampaign,
    cancelCampaign,
    adjustRefund,
    createIdempotencyKey,
  }

  render(<AdminPromotionCampaignManager adapter={adapter} />)
  return {
    controller,
    approveCampaign,
    rejectCampaign,
    pauseCampaign,
    resumeCampaign,
    cancelCampaign,
    adjustRefund,
    createIdempotencyKey,
  }
}

/** Every query test must prove no mutation adapter was ever invoked. */
export function expectNoMutations(mocks: {
  approveCampaign: ReturnType<typeof vi.fn>
  rejectCampaign: ReturnType<typeof vi.fn>
  pauseCampaign: ReturnType<typeof vi.fn>
  resumeCampaign: ReturnType<typeof vi.fn>
  cancelCampaign: ReturnType<typeof vi.fn>
  adjustRefund: ReturnType<typeof vi.fn>
  createIdempotencyKey: ReturnType<typeof vi.fn>
}) {
  expect(mocks.approveCampaign).not.toHaveBeenCalled()
  expect(mocks.rejectCampaign).not.toHaveBeenCalled()
  expect(mocks.pauseCampaign).not.toHaveBeenCalled()
  expect(mocks.resumeCampaign).not.toHaveBeenCalled()
  expect(mocks.cancelCampaign).not.toHaveBeenCalled()
  expect(mocks.adjustRefund).not.toHaveBeenCalled()
  expect(mocks.createIdempotencyKey).not.toHaveBeenCalled()
}

/**
 * The exact frozen per-action aria-labels the component emits; the label
 * always carries the campaign id so the row-scoped button is unambiguous.
 */
const ACTION_ARIA_LABEL = {
  approve: (id: number) => `批准推广活动（活动 ID ${id}）`,
  reject: (id: number) => `拒绝推广活动（活动 ID ${id}）`,
  pause: (id: number) => `暂停推广活动（活动 ID ${id}）`,
  resume: (id: number) => `恢复推广活动（活动 ID ${id}）`,
  cancel: (id: number) => `取消推广活动（活动 ID ${id}）`,
  'refund-adjustment': (id: number) => `退款调整（活动 ID ${id}）`,
} as const

type AdminCampaignActionKind = keyof typeof ACTION_ARIA_LABEL

/** The campaign table row whose 活动 ID cell equals the given id. */
export function rowFor(table: HTMLElement, id: number): HTMLElement {
  const row = within(table).getByText(String(id)).closest('tr')
  if (row == null) throw new Error(`missing table row for campaign id ${id}`)
  return row
}

/** The last (操作) column of a campaign row. */
export function operationCell(row: HTMLElement): HTMLElement {
  const cells = Array.from(row.querySelectorAll('td'))
  const last = cells[cells.length - 1]
  if (last == null) throw new Error('missing operation cell')
  return last
}

/**
 * The operation button for an action kind inside a campaign row, queried by
 * the aria-label that embeds the campaign id. Returns null when the button is
 * not rendered for that status.
 */
export function actionButtonIn(
  row: HTMLElement,
  kind: AdminCampaignActionKind,
  id: number,
): HTMLElement | null {
  return within(row).queryByRole('button', { name: ACTION_ARIA_LABEL[kind](id) })
}

/**
 * Mutation-card invariant: only the driven mutation (approve or reject) is
 * ever called; every other mutation adapter plus createIdempotencyKey stays
 * at zero invocations.
 */
export function expectOnlyMutation(
  mocks: Parameters<typeof expectNoMutations>[0],
  called: 'approve' | 'reject',
) {
  if (called === 'approve') expect(mocks.approveCampaign).toHaveBeenCalled()
  else expect(mocks.approveCampaign).not.toHaveBeenCalled()
  if (called === 'reject') expect(mocks.rejectCampaign).toHaveBeenCalled()
  else expect(mocks.rejectCampaign).not.toHaveBeenCalled()
  expect(mocks.pauseCampaign).not.toHaveBeenCalled()
  expect(mocks.resumeCampaign).not.toHaveBeenCalled()
  expect(mocks.cancelCampaign).not.toHaveBeenCalled()
  expect(mocks.adjustRefund).not.toHaveBeenCalled()
  expect(mocks.createIdempotencyKey).not.toHaveBeenCalled()
}

/** Strongly-typed deferred promise held pending until the test settles it. */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Strongly-typed frozen server error envelope — the exact shape the API error
 * helpers consume (getApiErrorCode / getApiErrorMessage read
 * response.data.error.{code,message}).
 */
interface AdminApiErrorEnvelope {
  response: {
    data: {
      error: {
        code: string
        message: string
      }
    }
  }
}

export function apiError(code: string, message: string): AdminApiErrorEnvelope {
  return { response: { data: { error: { code, message } } } }
}

/** The exact page-1 'all' query the component issues on mount. */
export const ALL_PAGE_1: AdminPromotionCampaignQuery = { status: 'all', page: 1, pageSize: 20 }
