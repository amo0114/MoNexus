// T-MERCH-FE-003 — AdminEntitlementManager list tests
// (SPEC-MERCH-001 §5.6 admin lane). Covers the list lifecycle only:
//  1. initial pending → exact query → resolved rows (status / source / two
//     times / admin-only reason; private sourceRef + actor ids never in DOM);
//  2. applied merchantId + status filter → exact page-1 query, preserved
//     filter on page 2, and client-side rejection of an unsafe id
//     (2^53, outside the safe-integer range) with no extra list call;
//  3. stale-response guard: an older request resolving after a newer one is
//     discarded (never overwrites the newer merchant's rows).
//
// The deferred list controller keeps a SINGLE pending-request array where every
// entry holds BOTH resolve and reject, and requests are settled BY INDEX — so a
// stale response can be resolved after a newer one without resolve/reject queue
// mismatches. grant/revoke adapters are complete-DTO resolved mocks (their
// flows are covered by separate tests, not here).

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AdminEntitlementManager, {
  type AdminEntitlementAdapter,
} from './AdminEntitlementManager'
import type {
  AdminMerchantEntitlementDTO,
  AdminMerchantEntitlementGrantPayload,
  AdminMerchantEntitlementPage,
} from '../../types/merchandising'

// Complete DTO fixtures covering every field. sourceRef / actor ids are
// admin-only audit fields that the component must never render.
const merchant101Entitlement: AdminMerchantEntitlementDTO = {
  id: 10101,
  merchantId: 101,
  code: 'partner',
  source: 'admin_grant',
  sourceRef: 'ADMIN-ENT-2026-0001',
  status: 'active',
  validFrom: '2026-01-01T00:00:00.000Z',
  validUntil: '2026-12-31T23:59:59.000Z',
  reason: '平台年度合作伙伴（内部原因：年度商业合作）',
  grantedByUserId: 90001,
  revokedByUserId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T08:00:00.000Z',
}

const merchant202Entitlement: AdminMerchantEntitlementDTO = {
  id: 20202,
  merchantId: 202,
  code: 'partner',
  source: 'promotion_spend',
  sourceRef: 'SPEND-ENT-2026-0002',
  status: 'expired',
  validFrom: '2025-01-01T00:00:00.000Z',
  validUntil: '2025-12-31T23:59:59.000Z',
  reason: '推广消费自动授予（年度营销计划）',
  grantedByUserId: null,
  revokedByUserId: 90002,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
}

/**
 * Deferred list controller. A single pending array where each entry carries
 * BOTH resolve and reject, and requests are settled by request index — so the
 * stale-response test can resolve the newer request (index 1) before the
 * initial one (index 0) without resolve/reject queues drifting apart.
 */
function createListController() {
  const pending: Array<{
    resolve: (value: AdminMerchantEntitlementPage) => void
    reject: (reason?: unknown) => void
  }> = []

  const listEntitlements = vi.fn(
    () =>
      new Promise<AdminMerchantEntitlementPage>((resolve, reject) => {
        pending.push({ resolve, reject })
      }),
  )

  return {
    listEntitlements,
    resolve: async (index: number, value: AdminMerchantEntitlementPage) => {
      await act(async () => {
        pending[index]?.resolve(value)
      })
    },
    reject: async (index: number, reason?: unknown) => {
      await act(async () => {
        pending[index]?.reject(reason)
      })
    },
  }
}

function renderManager() {
  const controller = createListController()
  const grantEntitlement = vi.fn<
    (payload: AdminMerchantEntitlementGrantPayload) => Promise<AdminMerchantEntitlementDTO>
  >()
  grantEntitlement.mockResolvedValue(merchant101Entitlement)
  const revokeEntitlement = vi.fn<
    (id: number, reason: string) => Promise<AdminMerchantEntitlementDTO>
  >()
  revokeEntitlement.mockResolvedValue(merchant202Entitlement)

  const adapter: AdminEntitlementAdapter = {
    listEntitlements: controller.listEntitlements,
    grantEntitlement,
    revokeEntitlement,
  }
  render(<AdminEntitlementManager adapter={adapter} />)
  return { controller, grantEntitlement, revokeEntitlement }
}

function futureLocalDateTime(days = 30): string {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16)
}

describe('AdminEntitlementManager', () => {
  it('shows pending status, issues the exact initial query, then renders status/source/times/reason without private fields', async () => {
    const { controller } = renderManager()

    // pending state: role=status named 加载中, no table yet
    expect(controller.listEntitlements).toHaveBeenCalledWith({
      status: 'all',
      page: 1,
      pageSize: 10,
    })
    expect(screen.getByRole('status', { name: '加载中' })).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()

    // resolve the initial request (index 0) with a complete page response
    await controller.resolve(0, {
      items: [merchant101Entitlement],
      total: 1,
      page: 1,
      pageSize: 10,
    })

    const table = await screen.findByRole('table', { name: '商家权益列表' })
    expect(table).toBeInTheDocument()

    // status / source / two times / admin-only reason
    expect(within(table).getByText('有效')).toBeInTheDocument()
    expect(within(table).getByText('管理员手工授予')).toBeInTheDocument()
    expect(
      table.querySelector('time[datetime="2026-01-01T00:00:00.000Z"]'),
    ).not.toBeNull()
    expect(
      table.querySelector('time[datetime="2026-12-31T23:59:59.000Z"]'),
    ).not.toBeNull()
    expect(
      within(table).getByText('平台年度合作伙伴（内部原因：年度商业合作）'),
    ).toBeInTheDocument()

    // private audit fields are never rendered: sourceRef and actor ids absent
    expect(screen.queryByText('ADMIN-ENT-2026-0001')).not.toBeInTheDocument()
    expect(screen.queryByText('90001')).not.toBeInTheDocument()
  })

  it('applies merchantId=101 + active filter, pages with the filter preserved, and rejects an unsafe id without a list call', async () => {
    const { controller } = renderManager()

    // apply merchantId=101 + status=active → exact page-1 query
    fireEvent.change(screen.getByLabelText('商家 ID'), { target: { value: '101' } })
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'active' } })
    fireEvent.click(screen.getByRole('button', { name: '查询' }))

    await waitFor(() =>
      expect(controller.listEntitlements).toHaveBeenCalledWith({
        status: 'active',
        page: 1,
        pageSize: 10,
        merchantId: 101,
      }),
    )

    // settle the filtered page-1 request (index 1) with total=25
    await controller.resolve(1, {
      items: [merchant101Entitlement],
      total: 25,
      page: 1,
      pageSize: 10,
    })

    const table = await screen.findByRole('table', { name: '商家权益列表' })
    expect(within(table).getByText('101')).toBeInTheDocument()

    // next page → exact page-2 query, filter preserved
    const nextButton = screen.getByRole('button', { name: '下一页' })
    expect(nextButton).toBeEnabled()
    fireEvent.click(nextButton)

    await waitFor(() =>
      expect(controller.listEntitlements).toHaveBeenCalledWith({
        status: 'active',
        page: 2,
        pageSize: 10,
        merchantId: 101,
      }),
    )
    await controller.resolve(2, {
      items: [merchant202Entitlement],
      total: 25,
      page: 2,
      pageSize: 10,
    })

    // 2^53 (not a safe integer): client-side rejection → alert, no list call
    const callsBefore = controller.listEntitlements.mock.calls.length
    fireEvent.change(screen.getByLabelText('商家 ID'), {
      target: { value: '9007199254740992' },
    })
    fireEvent.click(screen.getByRole('button', { name: '查询' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('商家 ID 必须为空或正整数')
    expect(controller.listEntitlements.mock.calls.length).toBe(callsBefore)
  })

  it('discards a stale initial response when a newer filtered request resolves first', async () => {
    const { controller } = renderManager()

    // initial request (index 0) is still pending
    expect(controller.listEntitlements).toHaveBeenCalledTimes(1)

    // apply merchantId=202 while the initial request is in flight → second request
    fireEvent.change(screen.getByLabelText('商家 ID'), { target: { value: '202' } })
    fireEvent.click(screen.getByRole('button', { name: '查询' }))

    await waitFor(() => expect(controller.listEntitlements).toHaveBeenCalledTimes(2))
    expect(controller.listEntitlements).toHaveBeenLastCalledWith({
      status: 'all',
      page: 1,
      pageSize: 10,
      merchantId: 202,
    })

    // resolve the NEWER request (index 1) first → merchant 202 renders
    await controller.resolve(1, {
      items: [merchant202Entitlement],
      total: 1,
      page: 1,
      pageSize: 10,
    })
    const table = await screen.findByRole('table', { name: '商家权益列表' })
    expect(within(table).getByText('202')).toBeInTheDocument()

    // now the stale initial response (index 0, merchant 101) resolves → discarded
    await controller.resolve(0, {
      items: [merchant101Entitlement],
      total: 1,
      page: 1,
      pageSize: 10,
    })

    expect(within(table).getByText('202')).toBeInTheDocument()
    expect(within(table).queryByText('101')).not.toBeInTheDocument()
  })

  it('grants once with a normalized payload, closes only on success, and refreshes the current query', async () => {
    const { controller, grantEntitlement } = renderManager()
    await controller.resolve(0, {
      items: [merchant101Entitlement],
      total: 1,
      page: 1,
      pageSize: 10,
    })
    await screen.findByRole('table', { name: '商家权益列表' })

    let resolveGrant!: (value: AdminMerchantEntitlementDTO) => void
    grantEntitlement.mockImplementation(
      () =>
        new Promise<AdminMerchantEntitlementDTO>((resolve) => {
          resolveGrant = resolve
        }),
    )

    fireEvent.click(screen.getByRole('button', { name: '手工授予' }))
    const dialog = await screen.findByRole('dialog')
    const localValue = futureLocalDateTime()
    fireEvent.change(within(dialog).getByLabelText('商家 ID'), { target: { value: '303' } })
    fireEvent.change(within(dialog).getByLabelText('到期时间'), {
      target: { value: localValue },
    })
    fireEvent.change(within(dialog).getByLabelText('授权原因'), {
      target: { value: '  线下商业合作  ' },
    })

    const confirm = within(dialog).getByRole('button', { name: '确认授予' })
    fireEvent.click(confirm)
    expect(grantEntitlement).toHaveBeenCalledWith({
      merchantId: 303,
      validUntil: new Date(localValue).toISOString(),
      reason: '线下商业合作',
    })
    await waitFor(() => expect(confirm).toBeDisabled())
    fireEvent.click(confirm)
    expect(grantEntitlement).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveGrant({
        ...merchant101Entitlement,
        id: 30303,
        merchantId: 303,
        validUntil: new Date(localValue).toISOString(),
        reason: '线下商业合作',
      })
    })

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const success = await screen.findByText('手工授予成功。')
    expect(success.closest('[role="status"]')).not.toBeNull()
    await waitFor(() => expect(controller.listEntitlements).toHaveBeenCalledTimes(2))
    expect(controller.listEntitlements).toHaveBeenLastCalledWith({
      status: 'all',
      page: 1,
      pageSize: 10,
    })
    await controller.resolve(1, {
      items: [merchant101Entitlement],
      total: 1,
      page: 1,
      pageSize: 10,
    })
  })

  it('keeps the grant dialog open and exposes the server message when grant fails', async () => {
    const { controller, grantEntitlement } = renderManager()
    await controller.resolve(0, {
      items: [],
      total: 0,
      page: 1,
      pageSize: 10,
    })
    await screen.findByText('暂无权益记录')

    grantEntitlement.mockRejectedValue({
      response: { data: { error: { message: '该商家已有有效合作权益' } } },
    })
    fireEvent.click(screen.getByRole('button', { name: '手工授予' }))
    const dialog = await screen.findByRole('dialog')
    const localValue = futureLocalDateTime()
    fireEvent.change(within(dialog).getByLabelText('商家 ID'), { target: { value: '303' } })
    fireEvent.change(within(dialog).getByLabelText('到期时间'), {
      target: { value: localValue },
    })
    fireEvent.change(within(dialog).getByLabelText('授权原因'), {
      target: { value: '线下商业合作' },
    })
    const confirm = within(dialog).getByRole('button', { name: '确认授予' })
    fireEvent.click(confirm)

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('该商家已有有效合作权益')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(confirm).toBeEnabled()
    expect(screen.queryByText('手工授予成功。')).not.toBeInTheDocument()
  })

  it('requires a revoke reason, prevents duplicate revokes, and refreshes after success', async () => {
    const { controller, revokeEntitlement } = renderManager()
    await controller.resolve(0, {
      items: [merchant101Entitlement],
      total: 1,
      page: 1,
      pageSize: 10,
    })
    await screen.findByRole('table', { name: '商家权益列表' })

    let resolveRevoke!: (value: AdminMerchantEntitlementDTO) => void
    revokeEntitlement.mockImplementation(
      () =>
        new Promise<AdminMerchantEntitlementDTO>((resolve) => {
          resolveRevoke = resolve
        }),
    )

    fireEvent.click(screen.getByRole('button', { name: '撤销商家 101 的权益' }))
    const dialog = await screen.findByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: '确认撤销' })
    fireEvent.click(confirm)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('请输入撤销原因')
    expect(revokeEntitlement).not.toHaveBeenCalled()

    fireEvent.change(within(dialog).getByLabelText('撤销原因'), {
      target: { value: '  合作计划结束  ' },
    })
    fireEvent.click(confirm)
    expect(revokeEntitlement).toHaveBeenCalledWith(10101, '合作计划结束')
    await waitFor(() => expect(confirm).toBeDisabled())
    fireEvent.click(confirm)
    expect(revokeEntitlement).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveRevoke({
        ...merchant101Entitlement,
        status: 'revoked',
        revokedByUserId: 90003,
      })
    })

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const success = await screen.findByText('已撤销商家 101 的权益。')
    expect(success.closest('[role="status"]')).not.toBeNull()
    await waitFor(() => expect(controller.listEntitlements).toHaveBeenCalledTimes(2))
    await controller.resolve(1, {
      items: [{ ...merchant101Entitlement, status: 'revoked', revokedByUserId: 90003 }],
      total: 1,
      page: 1,
      pageSize: 10,
    })
  })

  it('shows a load error and retries into the empty state', async () => {
    const { controller } = renderManager()
    await controller.reject(0, new Error('network down'))

    expect(await screen.findByRole('alert')).toHaveTextContent('权益列表加载失败，请稍后重试。')
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    await waitFor(() => expect(controller.listEntitlements).toHaveBeenCalledTimes(2))
    await controller.resolve(1, {
      items: [],
      total: 0,
      page: 1,
      pageSize: 10,
    })

    expect(await screen.findByText('暂无权益记录')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
