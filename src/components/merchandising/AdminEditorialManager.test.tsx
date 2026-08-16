// T-MERCH-FE-003 — AdminEditorialManager behavior tests
// (SPEC-MERCH-001 §5.5 admin lane). List coverage includes:
//  1. exact initial query ({ status/placement 'all', page 1, pageSize 10 })
//     issued on mount, with the pending (loading) state visible;
//  2. rejected initial request → server error + 重新加载 retry that
//     re-issues the query and recovers;
//  3. resolved empty page → empty state;
//  4. status/placement filters (separately and combined) → exact page-1
//     queries with the page reset to 1;
//  5. Next/Previous → exact pagination queries with filters preserved;
//  6. placement-only filter → status stays 'all', page still resets to 1;
//  7. stale-response guard → an older resolved response never overwrites
//     a newer filtered result;
//  8. admin table renders the internal-only internalReason;
//  9. sensitive audit actor IDs (createdByUserId / revokedByUserId) never
//     appear anywhere in the DOM.
//
// The deferred list controller keeps a SINGLE pending-request array where every
// entry holds BOTH resolve and reject, and requests are settled BY INDEX.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi, type Mock } from 'vitest'
import AdminEditorialManager, {
  type AdminEditorialAdapter,
} from './AdminEditorialManager'
import type {
  AdminEditorialCreatePayload,
  AdminEditorialFeatureDTO,
  AdminEditorialFeaturePage,
  AdminEditorialUpdatePayload,
  EditorialPlacement,
} from '../../types/merchandising'

// Complete DTO fixtures covering every field of the DTO (sensitive audit
// fields included so the fixtures type-check; they are only asserted to
// never appear in the DOM).
const scheduledFeature: AdminEditorialFeatureDTO = {
  id: 101,
  productId: 1001,
  placement: 'store_editorial',
  status: 'scheduled',
  startsAt: '2026-02-01T00:00:00.000Z',
  endsAt: '2026-03-01T00:00:00.000Z',
  sortWeight: 10,
  publicReason: '新品首发',
  internalReason: '运营每周精选（内部备注）',
  createdByUserId: 90001,
  revokedByUserId: null,
  createdAt: '2026-01-20T00:00:00.000Z',
  updatedAt: '2026-01-20T00:00:00.000Z',
}

const activeFeature: AdminEditorialFeatureDTO = {
  id: 202,
  productId: 1002,
  placement: 'category_editorial',
  status: 'active',
  startsAt: '2026-01-01T00:00:00.000Z',
  endsAt: '2026-02-01T00:00:00.000Z',
  sortWeight: 5,
  publicReason: null,
  internalReason: '品类活动主推（内部备注）',
  createdByUserId: 90002,
  revokedByUserId: null,
  createdAt: '2025-12-20T00:00:00.000Z',
  updatedAt: '2025-12-20T00:00:00.000Z',
}

const revokedFeature: AdminEditorialFeatureDTO = {
  id: 303,
  productId: 1003,
  placement: 'store_editorial',
  status: 'revoked',
  startsAt: '2025-11-01T00:00:00.000Z',
  endsAt: '2025-12-01T00:00:00.000Z',
  sortWeight: 0,
  publicReason: null,
  internalReason: '风险商品已下架（内部备注）',
  createdByUserId: 90001,
  revokedByUserId: 90003,
  createdAt: '2025-10-20T00:00:00.000Z',
  updatedAt: '2025-11-05T00:00:00.000Z',
}

/**
 * Deferred list controller. A single pending array where each entry carries
 * BOTH resolve and reject, and requests are settled by request index.
 */
function createListController() {
  const pending: Array<{
    resolve: (value: AdminEditorialFeaturePage) => void
    reject: (reason?: unknown) => void
  }> = []

  const listFeatures = vi.fn(
    () =>
      new Promise<AdminEditorialFeaturePage>((resolve, reject) => {
        pending.push({ resolve, reject })
      }),
  )

  return {
    listFeatures,
    resolve: async (index: number, value: AdminEditorialFeaturePage) => {
      const entry = pending[index]
      if (!entry) throw new Error(`No pending list request at index ${index} — cannot resolve`)
      await act(async () => {
        entry.resolve(value)
      })
    },
    reject: async (index: number, reason?: unknown) => {
      const entry = pending[index]
      if (!entry) throw new Error(`No pending list request at index ${index} — cannot reject`)
      await act(async () => {
        entry.reject(reason)
      })
    },
  }
}

function renderManager() {
  const controller = createListController()
  const createFeature = vi.fn<
    (payload: AdminEditorialCreatePayload) => Promise<AdminEditorialFeatureDTO>
  >()
  createFeature.mockResolvedValue(scheduledFeature)
  const updateFeature = vi.fn<
    (id: number, payload: AdminEditorialUpdatePayload) => Promise<AdminEditorialFeatureDTO>
  >()
  updateFeature.mockResolvedValue(activeFeature)
  const revokeFeature = vi.fn<
    (id: number, reason: string) => Promise<AdminEditorialFeatureDTO>
  >()
  revokeFeature.mockResolvedValue(scheduledFeature)

  const adapter: AdminEditorialAdapter = {
    listFeatures: controller.listFeatures,
    createFeature,
    updateFeature,
    revokeFeature,
  }
  render(<AdminEditorialManager adapter={adapter} />)
  return { controller, createFeature, updateFeature, revokeFeature }
}

/** createFeature adapter mock — exact typed shape of the real adapter. */
type CreateFeatureMock = Mock<(payload: AdminEditorialCreatePayload) => Promise<AdminEditorialFeatureDTO>>

/**
 * Render with a caller-supplied createFeature mock (deferred, rejecting, or
 * resolved). update/revoke stay complete-DTO resolved mocks; list stays a
 * deferred controller so the create flows never touch edit/revoke.
 */
function renderManagerWithCreate(createFeature: CreateFeatureMock) {
  const controller = createListController()
  const updateFeature = vi.fn<
    (id: number, payload: AdminEditorialUpdatePayload) => Promise<AdminEditorialFeatureDTO>
  >()
  updateFeature.mockResolvedValue(activeFeature)
  const revokeFeature = vi.fn<
    (id: number, reason: string) => Promise<AdminEditorialFeatureDTO>
  >()
  revokeFeature.mockResolvedValue(scheduledFeature)

  const adapter: AdminEditorialAdapter = {
    listFeatures: controller.listFeatures,
    createFeature,
    updateFeature,
    revokeFeature,
  }
  render(<AdminEditorialManager adapter={adapter} />)
  return { controller, createFeature, updateFeature, revokeFeature }
}

/**
 * Deferred create controller. Every createFeature call pushes a fresh entry
 * into a single pending array; entries are settled BY INDEX so a reject can be
 * followed by a retry that resolves its own later entry. Resolving/rejecting a
 * missing (already settled / not yet issued) index throws.
 */
function createDeferredCreateFeature() {
  const pending: Array<{
    resolve: (value: AdminEditorialFeatureDTO) => void
    reject: (reason?: unknown) => void
  }> = []

  const createFeature = vi.fn(
    (_payload: AdminEditorialCreatePayload) =>
      new Promise<AdminEditorialFeatureDTO>((resolve, reject) => {
        pending.push({ resolve, reject })
      }),
  )

  return {
    createFeature,
    resolve: async (index: number, value: AdminEditorialFeatureDTO) => {
      const entry = pending[index]
      if (!entry) throw new Error(`No pending create request at index ${index} — cannot resolve`)
      await act(async () => {
        entry.resolve(value)
      })
    },
    reject: async (index: number, reason?: unknown) => {
      const entry = pending[index]
      if (!entry) throw new Error(`No pending create request at index ${index} — cannot reject`)
      await act(async () => {
        entry.reject(reason)
      })
    },
  }
}

/** Open the 新建精选 dialog and return its dialog element. */
async function openCreateDialog(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: '新建精选' }))
  return screen.findByRole('dialog')
}

interface CreateFormOverrides {
  productId?: string
  placement?: EditorialPlacement
  startsAt?: string
  endsAt?: string
  sortWeight?: string
  publicReason?: string
  internalReason?: string
}

/**
 * Fill the create form inside `dialog` with valid defaults, with each
 * field overridable. All queries are scoped to the dialog so the '展位'
 * filter select (same label as the form select) never collides.
 */
function fillCreateForm(dialog: HTMLElement, overrides: CreateFormOverrides = {}) {
  const values: Required<CreateFormOverrides> = {
    productId: '1001',
    placement: 'category_editorial',
    startsAt: '2099-06-01T09:30',
    endsAt: '2099-07-01T18:45',
    sortWeight: '42',
    publicReason: '新品首发',
    internalReason: '运营每周精选（内部备注）',
    ...overrides,
  }
  const scope = within(dialog)
  fireEvent.change(scope.getByLabelText('商品 ID'), { target: { value: values.productId } })
  fireEvent.change(scope.getByLabelText('展位'), { target: { value: values.placement } })
  fireEvent.change(scope.getByLabelText('开始时间'), { target: { value: values.startsAt } })
  fireEvent.change(scope.getByLabelText('结束时间'), { target: { value: values.endsAt } })
  fireEvent.change(scope.getByLabelText('权重'), { target: { value: values.sortWeight } })
  fireEvent.change(scope.getByLabelText('公开理由（对外展示）'), {
    target: { value: values.publicReason },
  })
  fireEvent.change(scope.getByLabelText('内部原因（仅管理员可见）'), {
    target: { value: values.internalReason },
  })
}

describe('AdminEditorialManager', () => {
  it('issues the exact initial query on mount, shows loading, then renders resolved rows', async () => {
    const { controller } = renderManager()

    // exact initial query + pending (loading) state, no table yet
    expect(controller.listFeatures).toHaveBeenCalledWith({
      status: 'all',
      placement: 'all',
      page: 1,
      pageSize: 10,
    })
    expect(screen.getByRole('status', { name: '加载中' })).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()

    // resolve the initial request (index 0) with a complete page response
    await controller.resolve(0, {
      items: [scheduledFeature],
      total: 1,
      page: 1,
      pageSize: 10,
    })

    const table = await screen.findByRole('table', { name: '平台精选列表' })
    expect(table).toBeInTheDocument()

    // status / placement / public reason / product id are rendered
    expect(within(table).getByText('1001')).toBeInTheDocument()
    expect(within(table).getByText('待生效')).toBeInTheDocument()
    expect(within(table).getByText('店铺精选')).toBeInTheDocument()
    expect(within(table).getByText('新品首发')).toBeInTheDocument()
  })

  it('shows a server error on reject and recovers via 重新加载 into the empty state', async () => {
    const { controller } = renderManager()

    await controller.reject(0, new Error('network down'))

    expect(await screen.findByRole('alert')).toHaveTextContent('精选列表加载失败，请稍后重试。')

    // retry re-issues the same exact query
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    await waitFor(() => expect(controller.listFeatures).toHaveBeenCalledTimes(2))
    expect(controller.listFeatures).toHaveBeenLastCalledWith({
      status: 'all',
      placement: 'all',
      page: 1,
      pageSize: 10,
    })

    // retry resolves empty → empty state, error gone
    await controller.resolve(1, {
      items: [],
      total: 0,
      page: 1,
      pageSize: 10,
    })

    expect(await screen.findByText('暂无精选记录')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the empty state when the list resolves empty', async () => {
    const { controller } = renderManager()

    await controller.resolve(0, {
      items: [],
      total: 0,
      page: 1,
      pageSize: 10,
    })

    expect(await screen.findByText('暂无精选记录')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('status', { name: '加载中' })).not.toBeInTheDocument()
  })

  it('sends status and placement filters (separately and combined) and resets the page to 1', async () => {
    const { controller } = renderManager()

    // initial page-1 load with a 25-row total so pagination is usable
    await controller.resolve(0, {
      items: [scheduledFeature],
      total: 25,
      page: 1,
      pageSize: 10,
    })
    await screen.findByRole('table', { name: '平台精选列表' })

    // move to page 2 so we can prove a filter change resets the page
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() =>
      expect(controller.listFeatures).toHaveBeenLastCalledWith({
        status: 'all',
        placement: 'all',
        page: 2,
        pageSize: 10,
      }),
    )
    await controller.resolve(1, {
      items: [activeFeature],
      total: 25,
      page: 2,
      pageSize: 10,
    })
    await screen.findByRole('table', { name: '平台精选列表' })

    // status filter alone → exact query, page reset to 1
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'active' } })
    await waitFor(() =>
      expect(controller.listFeatures).toHaveBeenLastCalledWith({
        status: 'active',
        placement: 'all',
        page: 1,
        pageSize: 10,
      }),
    )

    // placement filter combined on top → exact query, page stays 1
    fireEvent.change(screen.getByLabelText('展位'), {
      target: { value: 'category_editorial' },
    })
    await waitFor(() =>
      expect(controller.listFeatures).toHaveBeenLastCalledWith({
        status: 'active',
        placement: 'category_editorial',
        page: 1,
        pageSize: 10,
      }),
    )

    // settle the remaining requests so no deferred work is left in flight
    await controller.resolve(2, {
      items: [activeFeature],
      total: 2,
      page: 1,
      pageSize: 10,
    })
    await controller.resolve(3, {
      items: [activeFeature],
      total: 2,
      page: 1,
      pageSize: 10,
    })
  })

  it('sends exact Next/Previous page queries while preserving the applied filters', async () => {
    const { controller } = renderManager()

    // apply status + placement filters (requests 1 and 2 follow the initial one)
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'active' } })
    fireEvent.change(screen.getByLabelText('展位'), { target: { value: 'store_editorial' } })

    await waitFor(() =>
      expect(controller.listFeatures).toHaveBeenLastCalledWith({
        status: 'active',
        placement: 'store_editorial',
        page: 1,
        pageSize: 10,
      }),
    )
    await controller.resolve(2, {
      items: [activeFeature],
      total: 25,
      page: 1,
      pageSize: 10,
    })
    const table = await screen.findByRole('table', { name: '平台精选列表' })
    expect(table).toBeInTheDocument()

    // next page → filters preserved, page 2
    const nextButton = screen.getByRole('button', { name: '下一页' })
    expect(nextButton).toBeEnabled()
    fireEvent.click(nextButton)
    await waitFor(() =>
      expect(controller.listFeatures).toHaveBeenLastCalledWith({
        status: 'active',
        placement: 'store_editorial',
        page: 2,
        pageSize: 10,
      }),
    )
    await controller.resolve(3, {
      items: [activeFeature],
      total: 25,
      page: 2,
      pageSize: 10,
    })
    await screen.findByRole('table', { name: '平台精选列表' })

    // previous page → filters preserved, page 1
    const prevButton = screen.getByRole('button', { name: '上一页' })
    expect(prevButton).toBeEnabled()
    fireEvent.click(prevButton)
    await waitFor(() =>
      expect(controller.listFeatures).toHaveBeenLastCalledWith({
        status: 'active',
        placement: 'store_editorial',
        page: 1,
        pageSize: 10,
      }),
    )
  })

  it('sends a placement-only filter query (status stays all) and resets the page to 1', async () => {
    const { controller } = renderManager()

    // initial page-1 load with a 25-row total so pagination is usable
    await controller.resolve(0, {
      items: [scheduledFeature],
      total: 25,
      page: 1,
      pageSize: 10,
    })
    await screen.findByRole('table', { name: '平台精选列表' })

    // move to page 2 so we can prove a placement-only change resets the page
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() =>
      expect(controller.listFeatures).toHaveBeenLastCalledWith({
        status: 'all',
        placement: 'all',
        page: 2,
        pageSize: 10,
      }),
    )
    await controller.resolve(1, {
      items: [activeFeature],
      total: 25,
      page: 2,
      pageSize: 10,
    })
    await screen.findByRole('table', { name: '平台精选列表' })

    // placement-only change → exact query with status still 'all'
    fireEvent.change(screen.getByLabelText('展位'), {
      target: { value: 'category_editorial' },
    })
    await waitFor(() =>
      expect(controller.listFeatures).toHaveBeenLastCalledWith({
        status: 'all',
        placement: 'category_editorial',
        page: 1,
        pageSize: 10,
      }),
    )

    // settle the pending request so no deferred work is left in flight
    await controller.resolve(2, {
      items: [activeFeature],
      total: 25,
      page: 1,
      pageSize: 10,
    })
  })

  it('never lets an older list response overwrite a newer filtered result (stale-response guard)', async () => {
    const { controller } = renderManager()

    // the initial request (index 0) stays pending; a placement filter change
    // issues a NEWER request (index 1)
    fireEvent.change(screen.getByLabelText('展位'), {
      target: { value: 'category_editorial' },
    })
    await waitFor(() => expect(controller.listFeatures).toHaveBeenCalledTimes(2))

    // resolve the NEWER request first → the category_editorial result renders
    await controller.resolve(1, {
      items: [activeFeature],
      total: 1,
      page: 1,
      pageSize: 10,
    })
    const table = await screen.findByRole('table', { name: '平台精选列表' })
    expect(within(table).getByText('1002')).toBeInTheDocument()
    expect(within(table).queryByText('1001')).not.toBeInTheDocument()

    // now resolve the OLDER request with its stale store_editorial result
    await controller.resolve(0, {
      items: [scheduledFeature],
      total: 1,
      page: 1,
      pageSize: 10,
    })

    // the stale response must NOT overwrite the newer filtered result
    const tableAfter = screen.getByRole('table', { name: '平台精选列表' })
    expect(within(tableAfter).getByText('1002')).toBeInTheDocument()
    expect(within(tableAfter).queryByText('1001')).not.toBeInTheDocument()
  })

  it('renders the admin-only internalReason inside the list table', async () => {
    const { controller } = renderManager()

    await controller.resolve(0, {
      items: [scheduledFeature, activeFeature],
      total: 2,
      page: 1,
      pageSize: 10,
    })
    const table = await screen.findByRole('table', { name: '平台精选列表' })

    expect(within(table).getByText('运营每周精选（内部备注）')).toBeInTheDocument()
    expect(within(table).getByText('品类活动主推（内部备注）')).toBeInTheDocument()
  })

  it('never leaks the sensitive audit actor/user IDs (createdByUserId / revokedByUserId) into the DOM', async () => {
    const { controller } = renderManager()

    // fixtures carry createdByUserId (90001/90002) and a non-null
    // revokedByUserId (90003); none of them may reach the DOM
    await controller.resolve(0, {
      items: [scheduledFeature, activeFeature, revokedFeature],
      total: 3,
      page: 1,
      pageSize: 10,
    })
    const table = await screen.findByRole('table', { name: '平台精选列表' })

    // sanity: product ids ARE rendered, so the absence checks below are meaningful
    expect(within(table).getByText('1001')).toBeInTheDocument()
    expect(within(table).getByText('1002')).toBeInTheDocument()
    expect(within(table).getByText('1003')).toBeInTheDocument()

    // the audit actor IDs must appear nowhere in the rendered document
    expect(screen.queryByText(/90001/)).not.toBeInTheDocument()
    expect(screen.queryByText(/90002/)).not.toBeInTheDocument()
    expect(screen.queryByText(/90003/)).not.toBeInTheDocument()
  })
})

describe('AdminEditorialManager create (T-MERCH-FE-003 §create)', () => {
  it('submits the exact create payload with every field filled and the component-defined trimming', async () => {
    const createFeature = vi.fn<
      (payload: AdminEditorialCreatePayload) => Promise<AdminEditorialFeatureDTO>
    >()
    createFeature.mockResolvedValue(scheduledFeature)
    const { controller } = renderManagerWithCreate(createFeature)
    await controller.resolve(0, { items: [], total: 0, page: 1, pageSize: 10 })
    await screen.findByText('暂无精选记录')

    const startsLocal = '2099-06-01T09:30'
    const endsLocal = '2099-07-01T18:45'

    const dialog = await openCreateDialog()
    fillCreateForm(dialog, {
      productId: '1001',
      placement: 'category_editorial',
      startsAt: startsLocal,
      endsAt: endsLocal,
      sortWeight: '42',
      publicReason: '  新品首发  ',
      internalReason: '  运营每周精选（内部备注）  ',
    })

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '确认新建' }))
    })

    expect(createFeature).toHaveBeenCalledTimes(1)
    const payload = createFeature.mock.calls[0][0]
    // every field is sent with the exact typed payload shape
    expect(payload).toEqual({
      productId: 1001,
      placement: 'category_editorial',
      startsAt: new Date(startsLocal).toISOString(),
      endsAt: new Date(endsLocal).toISOString(),
      sortWeight: 42,
      publicReason: '新品首发',
      internalReason: '运营每周精选（内部备注）',
    })
    // startsAt/endsAt are exactly new Date(datetime-local input).toISOString()
    expect(payload.startsAt).toBe(new Date(startsLocal).toISOString())
    expect(payload.endsAt).toBe(new Date(endsLocal).toISOString())
    // optional public reason is trimmed exactly as the component specifies
    expect(payload.publicReason).toBe('新品首发')
    expect(payload.internalReason).toBe('运营每周精选（内部备注）')

    // success closes the dialog and refreshes the list
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(controller.listFeatures).toHaveBeenCalledTimes(2))
    await controller.resolve(1, { items: [scheduledFeature], total: 1, page: 1, pageSize: 10 })
  })

  const INVALID_PRODUCT_IDS: ReadonlyArray<{ label: string; input: string }> = [
    { label: 'a decimal', input: '1001.5' },
    { label: 'nonnumeric', input: 'abc' },
    { label: 'zero', input: '0' },
    { label: 'negative', input: '-5' },
    { label: 'above the safe-integer range', input: String(Number.MAX_SAFE_INTEGER + 1) },
  ]

  it.each(INVALID_PRODUCT_IDS)(
    'rejects product id $input ($label) without calling createFeature and shows the field error',
    async ({ input }) => {
      const createFeature = vi.fn<
        (payload: AdminEditorialCreatePayload) => Promise<AdminEditorialFeatureDTO>
      >()
      const { controller } = renderManagerWithCreate(createFeature)
      await controller.resolve(0, { items: [], total: 0, page: 1, pageSize: 10 })
      await screen.findByText('暂无精选记录')

      const dialog = await openCreateDialog()
      fillCreateForm(dialog, { productId: input })

      await act(async () => {
        fireEvent.click(within(dialog).getByRole('button', { name: '确认新建' }))
      })

      expect(createFeature).not.toHaveBeenCalled()
      expect(within(dialog).getByRole('alert')).toHaveTextContent('商品 ID 必须为正整数')
      // the dialog stays open so the operator can correct the id
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    },
  )

  it('disables submit while create is pending and a rapid duplicate submit calls the adapter only once', async () => {
    const deferredCreate = createDeferredCreateFeature()
    const { controller } = renderManagerWithCreate(deferredCreate.createFeature)
    await controller.resolve(0, { items: [], total: 0, page: 1, pageSize: 10 })
    await screen.findByText('暂无精选记录')

    const dialog = await openCreateDialog()
    fillCreateForm(dialog)
    const submitButton = within(dialog).getByRole('button', { name: '确认新建' })

    // first submit → pending: adapter called exactly once
    await act(async () => {
      fireEvent.click(submitButton)
    })
    expect(deferredCreate.createFeature).toHaveBeenCalledTimes(1)

    // pending state: submit disabled, cancel disabled, spinner visible
    await waitFor(() => expect(submitButton).toBeDisabled())
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled()
    expect(dialog.querySelector('.animate-spin')).not.toBeNull()

    // rapid duplicate submit clicks while pending → still exactly one call
    await act(async () => {
      fireEvent.click(submitButton)
      fireEvent.click(submitButton)
    })
    expect(deferredCreate.createFeature).toHaveBeenCalledTimes(1)

    // resolve the create → success closes the dialog
    await deferredCreate.resolve(0, scheduledFeature)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByText('新建精选成功。')).toBeInTheDocument()
    await controller.resolve(1, { items: [], total: 0, page: 1, pageSize: 10 })
  })

  it('keeps the form open and retryable on a server reject, then on retry success closes, refreshes, and reopens blank', async () => {
    const deferredCreate = createDeferredCreateFeature()
    const { controller } = renderManagerWithCreate(deferredCreate.createFeature)
    await controller.resolve(0, { items: [scheduledFeature], total: 1, page: 1, pageSize: 10 })
    await screen.findByRole('table', { name: '平台精选列表' })

    const dialog = await openCreateDialog()
    fillCreateForm(dialog)
    const submitButton = within(dialog).getByRole('button', { name: '确认新建' })

    // first submit → server reject
    await act(async () => {
      fireEvent.click(submitButton)
    })
    expect(deferredCreate.createFeature).toHaveBeenCalledTimes(1)
    await deferredCreate.reject(0, new Error('server rejected'))

    // reject: no success, no list refresh, dialog stays open, form retryable
    expect(screen.queryByText('新建精选成功。')).not.toBeInTheDocument()
    expect(controller.listFeatures).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await waitFor(() => expect(submitButton).toBeEnabled())
    expect(within(dialog).getByRole('alert')).toHaveTextContent('新建精选失败，请稍后重试。')
    expect(within(dialog).getByLabelText('商品 ID')).toHaveValue('1001')

    // retry → success
    await act(async () => {
      fireEvent.click(submitButton)
    })
    expect(deferredCreate.createFeature).toHaveBeenCalledTimes(2)
    await deferredCreate.resolve(1, scheduledFeature)

    // success: feedback shown, dialog closed, current list query refreshed
    expect(await screen.findByText('新建精选成功。')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(controller.listFeatures).toHaveBeenCalledTimes(2))
    expect(controller.listFeatures).toHaveBeenLastCalledWith({
      status: 'all',
      placement: 'all',
      page: 1,
      pageSize: 10,
    })
    await controller.resolve(1, { items: [scheduledFeature], total: 1, page: 1, pageSize: 10 })

    // reopening New Create shows a fresh blank/default form (no stale values,
    // no field/submit errors)
    const reopened = await openCreateDialog()
    expect(within(reopened).getByLabelText('商品 ID')).toHaveValue('')
    expect(within(reopened).getByLabelText('展位')).toHaveValue('store_editorial')
    expect(within(reopened).getByLabelText('开始时间')).toHaveValue('')
    expect(within(reopened).getByLabelText('结束时间')).toHaveValue('')
    expect(within(reopened).getByLabelText('权重')).toHaveValue(0)
    expect(within(reopened).getByLabelText('公开理由（对外展示）')).toHaveValue('')
    expect(within(reopened).getByLabelText('内部原因（仅管理员可见）')).toHaveValue('')
    expect(within(reopened).queryByRole('alert')).not.toBeInTheDocument()
  })
})

// ============================================================================
// Edit (update) mutation user-behavior tests (T-MERCH-FE-003 §edit).
//
// The edit dialog is pre-filled from the DTO (productId read-only; ISO timestamps
// converted to browser-local datetime-local), submits an update payload that
// contains ONLY the editable fields (never productId), and its pending / reject /
// retry lifecycle is driven through a typed deferred update adapter.
// ============================================================================

/** Mirror of the component's ISO → browser-local datetime-local conversion. */
function isoToDatetimeLocal(iso: string): string {
  const date = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

type UpdateFeatureFn = (id: number, payload: AdminEditorialUpdatePayload) => Promise<AdminEditorialFeatureDTO>
type RevokeFeatureFn = (id: number, reason: string) => Promise<AdminEditorialFeatureDTO>

interface MutationRenderOptions {
  items?: AdminEditorialFeatureDTO[]
  total?: number
  updateFeature?: Mock<UpdateFeatureFn>
  revokeFeature?: Mock<RevokeFeatureFn>
}

/**
 * Render with a resolved-list controller plus caller-supplied update/revoke
 * mocks (defaults are resolved complete-DTO mocks). createFeature stays a
 * resolved mock; list stays a deferred controller so mutation tests never
 * touch create.
 */
function renderManagerForMutation({
  items = [scheduledFeature],
  total = items.length,
  updateFeature,
  revokeFeature,
}: MutationRenderOptions) {
  const controller = createListController()
  const resolvedUpdate = vi.fn<UpdateFeatureFn>()
  resolvedUpdate.mockResolvedValue(activeFeature)
  const resolvedRevoke = vi.fn<RevokeFeatureFn>()
  resolvedRevoke.mockResolvedValue(scheduledFeature)
  const createFeature = vi.fn<
    (payload: AdminEditorialCreatePayload) => Promise<AdminEditorialFeatureDTO>
  >()
  createFeature.mockResolvedValue(scheduledFeature)

  const adapter: AdminEditorialAdapter = {
    listFeatures: controller.listFeatures,
    createFeature,
    updateFeature: updateFeature ?? resolvedUpdate,
    revokeFeature: revokeFeature ?? resolvedRevoke,
  }
  render(<AdminEditorialManager adapter={adapter} />)
  return {
    controller,
    createFeature,
    updateFeature: updateFeature ?? resolvedUpdate,
    revokeFeature: revokeFeature ?? resolvedRevoke,
  }
}

/** Render, resolve the initial list, and wait for the table. */
async function renderMutatingManager(options: MutationRenderOptions = {}) {
  const result = renderManagerForMutation(options)
  const items = options.items ?? [scheduledFeature]
  await result.controller.resolve(0, {
    items,
    total: options.total ?? items.length,
    page: 1,
    pageSize: 10,
  })
  await screen.findByRole('table', { name: '平台精选列表' })
  return result
}

/**
 * Deferred update controller. Every updateFeature call pushes a fresh entry
 * into a single pending array; entries are settled BY INDEX so a reject can be
 * followed by a retry that resolves its own later entry.
 */
function createDeferredUpdateFeature() {
  const pending: Array<{
    resolve: (value: AdminEditorialFeatureDTO) => void
    reject: (reason?: unknown) => void
  }> = []

  const updateFeature = vi.fn(
    (_id: number, _payload: AdminEditorialUpdatePayload) =>
      new Promise<AdminEditorialFeatureDTO>((resolve, reject) => {
        pending.push({ resolve, reject })
      }),
  )

  return {
    updateFeature,
    resolve: async (index: number, value: AdminEditorialFeatureDTO) => {
      const entry = pending[index]
      if (!entry) throw new Error(`No pending update request at index ${index} — cannot resolve`)
      await act(async () => {
        entry.resolve(value)
      })
    },
    reject: async (index: number, reason?: unknown) => {
      const entry = pending[index]
      if (!entry) throw new Error(`No pending update request at index ${index} — cannot reject`)
      await act(async () => {
        entry.reject(reason)
      })
    },
  }
}

/**
 * Deferred revoke controller. Same by-index settlement as the update harness.
 */
function createDeferredRevokeFeature() {
  const pending: Array<{
    resolve: (value: AdminEditorialFeatureDTO) => void
    reject: (reason?: unknown) => void
  }> = []

  const revokeFeature = vi.fn(
    (_id: number, _reason: string) =>
      new Promise<AdminEditorialFeatureDTO>((resolve, reject) => {
        pending.push({ resolve, reject })
      }),
  )

  return {
    revokeFeature,
    resolve: async (index: number, value: AdminEditorialFeatureDTO) => {
      const entry = pending[index]
      if (!entry) throw new Error(`No pending revoke request at index ${index} — cannot resolve`)
      await act(async () => {
        entry.resolve(value)
      })
    },
    reject: async (index: number, reason?: unknown) => {
      const entry = pending[index]
      if (!entry) throw new Error(`No pending revoke request at index ${index} — cannot reject`)
      await act(async () => {
        entry.reject(reason)
      })
    },
  }
}

/** Open the 编辑精选 dialog for a feature and return its dialog element. */
async function openEditDialog(feature: AdminEditorialFeatureDTO): Promise<HTMLElement> {
  fireEvent.click(
    screen.getByRole('button', { name: `编辑商品 ${feature.productId} 的精选（精选 ID ${feature.id}）` }),
  )
  return screen.findByRole('dialog')
}

interface EditFormOverrides {
  placement?: EditorialPlacement
  startsAt?: string
  endsAt?: string
  sortWeight?: string
  publicReason?: string
  internalReason?: string
}

/**
 * Modify every editable edit-form field with valid future values (all submit
 * tests need endsAt > now — the DTO fixture dates are already in the past).
 */
function fillEditForm(dialog: HTMLElement, overrides: EditFormOverrides = {}) {
  const values: Required<EditFormOverrides> = {
    placement: 'category_editorial',
    startsAt: '2099-06-01T09:30',
    endsAt: '2099-07-01T18:45',
    sortWeight: '42',
    publicReason: '更新公开理由',
    internalReason: '更新内部原因',
    ...overrides,
  }
  const scope = within(dialog)
  fireEvent.change(scope.getByLabelText('展位'), { target: { value: values.placement } })
  fireEvent.change(scope.getByLabelText('开始时间'), { target: { value: values.startsAt } })
  fireEvent.change(scope.getByLabelText('结束时间'), { target: { value: values.endsAt } })
  fireEvent.change(scope.getByLabelText('权重'), { target: { value: values.sortWeight } })
  fireEvent.change(scope.getByLabelText('公开理由（对外展示）'), {
    target: { value: values.publicReason },
  })
  fireEvent.change(scope.getByLabelText('内部原因（仅管理员可见）'), {
    target: { value: values.internalReason },
  })
}

/** Open the 撤销精选 dialog for a feature and return its dialog element. */
async function openRevokeDialog(feature: AdminEditorialFeatureDTO): Promise<HTMLElement> {
  fireEvent.click(
    screen.getByRole('button', { name: `撤销商品 ${feature.productId} 的精选（精选 ID ${feature.id}）` }),
  )
  return screen.findByRole('dialog')
}

/** Fill the revoke reason textarea. */
function fillRevokeReason(dialog: HTMLElement, reason: string) {
  fireEvent.change(within(dialog).getByLabelText('撤销原因'), { target: { value: reason } })
}

describe('AdminEditorialManager edit (T-MERCH-FE-003 §edit)', () => {
  it('prefills the edit form from the DTO with productId read-only and ISO → datetime-local', async () => {
    await renderMutatingManager()

    const dialog = await openEditDialog(scheduledFeature)

    // the dialog targets the right feature
    expect(within(dialog).getByText('编辑精选')).toBeInTheDocument()
    expect(within(dialog).getByText(/正在编辑商品 1001 的平台精选（精选 ID 101）/)).toBeInTheDocument()

    // product id is read-only, pre-filled, and never editable
    const productIdInput = within(dialog).getByLabelText('商品 ID')
    expect(productIdInput).toHaveValue('1001')
    expect(productIdInput).toHaveAttribute('readonly')
    expect(productIdInput).not.toBeDisabled()
    expect(within(dialog).getByText('新建后商品不可变更。')).toBeInTheDocument()

    // every editable field pre-fills from the DTO
    expect(within(dialog).getByLabelText('展位')).toHaveValue(scheduledFeature.placement)
    expect(within(dialog).getByLabelText('开始时间')).toHaveValue(
      isoToDatetimeLocal(scheduledFeature.startsAt),
    )
    expect(within(dialog).getByLabelText('结束时间')).toHaveValue(
      isoToDatetimeLocal(scheduledFeature.endsAt),
    )
    expect(within(dialog).getByLabelText('权重')).toHaveValue(scheduledFeature.sortWeight)
    expect(within(dialog).getByLabelText('公开理由（对外展示）')).toHaveValue(
      scheduledFeature.publicReason,
    )
    expect(within(dialog).getByLabelText('内部原因（仅管理员可见）')).toHaveValue(
      scheduledFeature.internalReason,
    )
    // the DTO timestamps are parseable → no field error on open
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('submits the exact update payload for feature 101 (all editable fields, never productId)', async () => {
    const updateFeature = vi.fn<UpdateFeatureFn>()
    updateFeature.mockResolvedValue(activeFeature)
    const { controller } = await renderMutatingManager({ updateFeature })

    const dialog = await openEditDialog(scheduledFeature)
    const startsLocal = '2099-06-01T09:30'
    const endsLocal = '2099-07-01T18:45'
    fillEditForm(dialog, {
      placement: 'category_editorial',
      startsAt: startsLocal,
      endsAt: endsLocal,
      sortWeight: '42',
      publicReason: '  更新公开理由  ',
      internalReason: '  更新内部原因  ',
    })

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '确认保存' }))
    })

    expect(updateFeature).toHaveBeenCalledTimes(1)
    const [id, payload] = updateFeature.mock.calls[0]
    expect(id).toBe(101)
    // exact typed payload shape — every editable field, no productId
    expect(payload).toEqual({
      placement: 'category_editorial',
      startsAt: new Date(startsLocal).toISOString(),
      endsAt: new Date(endsLocal).toISOString(),
      sortWeight: 42,
      publicReason: '更新公开理由',
      internalReason: '更新内部原因',
    })
    // times are exactly new Date(datetime-local).toISOString()
    expect(payload.startsAt).toBe(new Date(startsLocal).toISOString())
    expect(payload.endsAt).toBe(new Date(endsLocal).toISOString())
    // the read-only product id must never leak into the update payload
    expect(payload).not.toHaveProperty('productId')

    // success: feedback, dialog closed, current list query refreshed
    expect(await screen.findByText('更新精选成功。')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(controller.listFeatures).toHaveBeenCalledTimes(2))
    expect(controller.listFeatures).toHaveBeenLastCalledWith({
      status: 'all',
      placement: 'all',
      page: 1,
      pageSize: 10,
    })
    await controller.resolve(1, { items: [scheduledFeature], total: 1, page: 1, pageSize: 10 })
  })

  it('disables save/cancel while the update is pending and a rapid duplicate submit calls once', async () => {
    const deferredUpdate = createDeferredUpdateFeature()
    const { controller } = await renderMutatingManager({ updateFeature: deferredUpdate.updateFeature })

    const dialog = await openEditDialog(scheduledFeature)
    fillEditForm(dialog)
    const saveButton = within(dialog).getByRole('button', { name: '确认保存' })

    await act(async () => {
      fireEvent.click(saveButton)
    })
    expect(deferredUpdate.updateFeature).toHaveBeenCalledTimes(1)

    // pending: save disabled, cancel disabled, spinner visible
    await waitFor(() => expect(saveButton).toBeDisabled())
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled()
    expect(dialog.querySelector('.animate-spin')).not.toBeNull()

    // rapid duplicate submits while pending → still exactly one call
    await act(async () => {
      fireEvent.click(saveButton)
      fireEvent.click(saveButton)
    })
    expect(deferredUpdate.updateFeature).toHaveBeenCalledTimes(1)

    // resolve → success closes the dialog
    await deferredUpdate.resolve(0, activeFeature)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByText('更新精选成功。')).toBeInTheDocument()
    await controller.resolve(1, { items: [scheduledFeature], total: 1, page: 1, pageSize: 10 })
  })

  it('keeps the edit dialog retryable on a server reject, then on retry success closes, refreshes, and reopening re-prefills', async () => {
    const deferredUpdate = createDeferredUpdateFeature()
    const { controller } = await renderMutatingManager({ updateFeature: deferredUpdate.updateFeature })

    const dialog = await openEditDialog(scheduledFeature)
    fillEditForm(dialog)
    const saveButton = within(dialog).getByRole('button', { name: '确认保存' })

    // first submit → server reject
    await act(async () => {
      fireEvent.click(saveButton)
    })
    expect(deferredUpdate.updateFeature).toHaveBeenCalledTimes(1)
    await deferredUpdate.reject(0, new Error('server rejected'))

    // reject: no success, no list refresh, dialog stays open, form retryable
    expect(screen.queryByText('更新精选成功。')).not.toBeInTheDocument()
    expect(controller.listFeatures).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await waitFor(() => expect(saveButton).toBeEnabled())
    expect(within(dialog).getByRole('alert')).toHaveTextContent('更新精选失败，请稍后重试。')
    // edits are retained so the operator can fix and retry
    expect(within(dialog).getByLabelText('开始时间')).toHaveValue('2099-06-01T09:30')
    expect(within(dialog).getByLabelText('展位')).toHaveValue('category_editorial')

    // retry → success
    await act(async () => {
      fireEvent.click(saveButton)
    })
    expect(deferredUpdate.updateFeature).toHaveBeenCalledTimes(2)
    await deferredUpdate.resolve(1, activeFeature)

    // success: feedback, dialog closed, current list query refreshed
    expect(await screen.findByText('更新精选成功。')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(controller.listFeatures).toHaveBeenCalledTimes(2))
    expect(controller.listFeatures).toHaveBeenLastCalledWith({
      status: 'all',
      placement: 'all',
      page: 1,
      pageSize: 10,
    })
    await controller.resolve(1, { items: [scheduledFeature], total: 1, page: 1, pageSize: 10 })

    // reopening edit clears the old submit error and re-prefills per the DTO
    const reopened = await openEditDialog(scheduledFeature)
    expect(within(reopened).queryByRole('alert')).not.toBeInTheDocument()
    expect(within(reopened).getByLabelText('商品 ID')).toHaveValue('1001')
    expect(within(reopened).getByLabelText('展位')).toHaveValue(scheduledFeature.placement)
    expect(within(reopened).getByLabelText('开始时间')).toHaveValue(
      isoToDatetimeLocal(scheduledFeature.startsAt),
    )
    expect(within(reopened).getByLabelText('结束时间')).toHaveValue(
      isoToDatetimeLocal(scheduledFeature.endsAt),
    )
    expect(within(reopened).getByLabelText('权重')).toHaveValue(scheduledFeature.sortWeight)
    expect(within(reopened).getByLabelText('公开理由（对外展示）')).toHaveValue(
      scheduledFeature.publicReason,
    )
    expect(within(reopened).getByLabelText('内部原因（仅管理员可见）')).toHaveValue(
      scheduledFeature.internalReason,
    )
  })
})

describe('AdminEditorialManager revoke (T-MERCH-FE-003 §revoke)', () => {
  it('does not call revokeFeature with a blank reason and shows 请输入撤销原因', async () => {
    const { revokeFeature } = await renderMutatingManager()

    const dialog = await openRevokeDialog(scheduledFeature)
    expect(within(dialog).getByText('撤销精选')).toBeInTheDocument()
    expect(
      within(dialog).getByText(/确认撤销商品 1001 的平台精选（精选 ID 101）/),
    ).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '确认撤销' }))
    })

    expect(revokeFeature).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('alert')).toHaveTextContent('请输入撤销原因')
    // the dialog stays open so the operator can provide a reason
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('trims the reason and calls revokeFeature(101, trimmed)', async () => {
    const revokeFeature = vi.fn<RevokeFeatureFn>()
    revokeFeature.mockResolvedValue(scheduledFeature)
    const { controller } = await renderMutatingManager({ revokeFeature })

    const dialog = await openRevokeDialog(scheduledFeature)
    fillRevokeReason(dialog, '  运营下架  ')

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '确认撤销' }))
    })

    expect(revokeFeature).toHaveBeenCalledTimes(1)
    expect(revokeFeature).toHaveBeenCalledWith(101, '运营下架')

    // success: feedback, dialog closed, current list query refreshed
    expect(await screen.findByText('已撤销商品 1001 的精选。')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(controller.listFeatures).toHaveBeenCalledTimes(2))
    expect(controller.listFeatures).toHaveBeenLastCalledWith({
      status: 'all',
      placement: 'all',
      page: 1,
      pageSize: 10,
    })
    await controller.resolve(1, { items: [scheduledFeature], total: 1, page: 1, pageSize: 10 })
  })

  it('disables confirm/cancel while the revoke is pending and a rapid duplicate click calls once', async () => {
    const deferredRevoke = createDeferredRevokeFeature()
    const { controller } = await renderMutatingManager({ revokeFeature: deferredRevoke.revokeFeature })

    const dialog = await openRevokeDialog(scheduledFeature)
    fillRevokeReason(dialog, '运营下架')
    const confirmButton = within(dialog).getByRole('button', { name: '确认撤销' })

    await act(async () => {
      fireEvent.click(confirmButton)
    })
    expect(deferredRevoke.revokeFeature).toHaveBeenCalledTimes(1)

    // pending: confirm disabled, cancel disabled, spinner visible
    await waitFor(() => expect(confirmButton).toBeDisabled())
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled()
    expect(dialog.querySelector('.animate-spin')).not.toBeNull()

    // rapid duplicate clicks while pending → still exactly one call
    await act(async () => {
      fireEvent.click(confirmButton)
      fireEvent.click(confirmButton)
    })
    expect(deferredRevoke.revokeFeature).toHaveBeenCalledTimes(1)

    // resolve → success closes the dialog
    await deferredRevoke.resolve(0, scheduledFeature)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByText('已撤销商品 1001 的精选。')).toBeInTheDocument()
    await controller.resolve(1, { items: [scheduledFeature], total: 1, page: 1, pageSize: 10 })
  })

  it('keeps the revoke dialog retryable on a server reject, then on retry success closes, refreshes, and reopening resets reason/errors', async () => {
    const deferredRevoke = createDeferredRevokeFeature()
    const { controller } = await renderMutatingManager({ revokeFeature: deferredRevoke.revokeFeature })

    const dialog = await openRevokeDialog(scheduledFeature)
    fillRevokeReason(dialog, '运营下架')
    const confirmButton = within(dialog).getByRole('button', { name: '确认撤销' })

    // first submit → server reject
    await act(async () => {
      fireEvent.click(confirmButton)
    })
    expect(deferredRevoke.revokeFeature).toHaveBeenCalledTimes(1)
    await deferredRevoke.reject(0, new Error('server rejected'))

    // reject: no success, no list refresh, dialog stays open, retryable
    expect(screen.queryByText('已撤销商品 1001 的精选。')).not.toBeInTheDocument()
    expect(controller.listFeatures).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await waitFor(() => expect(confirmButton).toBeEnabled())
    expect(within(dialog).getByRole('alert')).toHaveTextContent('撤销失败，请稍后重试。')
    // the reason is retained so the operator can retry
    expect(within(dialog).getByLabelText('撤销原因')).toHaveValue('运营下架')

    // retry → success
    await act(async () => {
      fireEvent.click(confirmButton)
    })
    expect(deferredRevoke.revokeFeature).toHaveBeenCalledTimes(2)
    await deferredRevoke.resolve(1, scheduledFeature)

    // success: feedback, dialog closed, current list query refreshed
    expect(await screen.findByText('已撤销商品 1001 的精选。')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(controller.listFeatures).toHaveBeenCalledTimes(2))
    expect(controller.listFeatures).toHaveBeenLastCalledWith({
      status: 'all',
      placement: 'all',
      page: 1,
      pageSize: 10,
    })
    await controller.resolve(1, { items: [scheduledFeature], total: 1, page: 1, pageSize: 10 })

    // reopening revoke resets the reason and clears errors
    const reopened = await openRevokeDialog(scheduledFeature)
    expect(within(reopened).getByLabelText('撤销原因')).toHaveValue('')
    expect(within(reopened).queryByRole('alert')).not.toBeInTheDocument()
  })
})
