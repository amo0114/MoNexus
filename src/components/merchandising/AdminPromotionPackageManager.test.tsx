// T-MERCH-FE-003 — AdminPromotionPackageManager query + create-contract tests
// (SPEC-MERCH-001 §11 admin lane). Query lifecycle coverage (tests 1-6 below); the
// create dialog contract/validation tests are appended after test 6. Coverage:
//  1. mount issues listPackages(false) exactly once; pending → loading
//     skeleton (no table); resolved → every DTO field renders with the
//     Chinese placement/status labels and created/updated times;
//  2. rejected initial request → server error + 重新加载 retry that re-issues
//     listPackages(false) and recovers into the empty state;
//  3. first resolved [] → empty state directly;
//  4. 包含停用套餐 toggle → exact listPackages(true) then listPackages(false),
//     with the matching hint text;
//  5. stale-response guard → an older false response resolving after the
//     newer true response never overwrites the newer result;
//  6. adapter.createPackage / adapter.updatePackage are complete strongly
//     typed mocks that no query flow ever triggers.
//  7. create success contract: 新建套餐 → fill every field, pick the
//     non-default 分类推广位 placement, submit 确认创建 → createPackage
//     receives ONLY the trimmed frozen create payload (code/label/
//     placement/durationDays/pricePoints/description/sortOrder; never
//     status/id/createdAt/updatedAt); code/label inputs enforce
//     maxLength 64/100; success closes the dialog, reports
//     套餐创建成功。, and refreshes the current query via a controlled
//     list response so the test never hangs.
//
// The deferred list controller keeps a SINGLE pending-request array where
// every entry holds BOTH resolve and reject, and requests are settled BY
// INDEX — a missing index throws instead of silently no-oping, so a stale
// response can be resolved after a newer one without queue mismatches.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi, type Mock } from 'vitest'
import AdminPromotionPackageManager, {
  type AdminPromotionPackageAdapter,
} from './AdminPromotionPackageManager'
import type {
  AdminPromotionPackageCreatePayload,
  AdminPromotionPackageDTO,
  AdminPromotionPackageUpdatePayload,
  SponsoredPlacement,
} from '../../types/merchandising'

// Complete DTO fixtures covering every field (active + inactive, both
// placements, empty description) so the rendered table is fully exercised.
const homePackage: AdminPromotionPackageDTO = {
  id: 11,
  code: 'PKG-STORE-HOME-30',
  label: '首页顶部推广位 30 天',
  placement: 'store_home_sponsored',
  durationDays: 30,
  pricePoints: 1200,
  description: '首页推广位月度套餐',
  sortOrder: 100,
  status: 'active',
  createdAt: '2026-01-05T02:00:00.000Z',
  updatedAt: '2026-01-06T08:30:00.000Z',
}

const categoryPackage: AdminPromotionPackageDTO = {
  id: 22,
  code: 'PKG-CATEGORY-7D',
  label: '分类推广位 7 天',
  placement: 'category_sponsored',
  durationDays: 7,
  pricePoints: 300,
  description: '',
  sortOrder: -5,
  status: 'inactive',
  createdAt: '2025-12-01T09:00:00.000Z',
  updatedAt: '2026-01-02T11:15:00.000Z',
}

interface PendingListRequest {
  resolve: (value: AdminPromotionPackageDTO[]) => void
  reject: (reason?: unknown) => void
}

/**
 * Deferred list controller. A single pending array where each entry carries
 * BOTH resolve and reject, and requests are settled by request index — the
 * stale-response test resolves the newer request (index 1) before the initial
 * one (index 0) without resolve/reject queues drifting apart.
 */
function createListController() {
  const pending: PendingListRequest[] = []

  const listPackages = vi.fn(
    (includeInactive: boolean) =>
      new Promise<AdminPromotionPackageDTO[]>((resolve, reject) => {
        pending.push({ resolve, reject })
      }),
  )

  return {
    listPackages,
    resolve: async (index: number, value: AdminPromotionPackageDTO[]) => {
      const entry = pending[index]
      if (!entry) {
        throw new Error(`No pending listPackages request at index ${index} — cannot resolve`)
      }
      await act(async () => {
        entry.resolve(value)
      })
    },
    reject: async (index: number, reason?: unknown) => {
      const entry = pending[index]
      if (!entry) {
        throw new Error(`No pending listPackages request at index ${index} — cannot reject`)
      }
      await act(async () => {
        entry.reject(reason)
      })
    },
  }
}

function renderManager() {
  const controller = createListController()

  // Complete strongly-typed mutation mocks — same signatures as the real
  // adapter functions (typeof listAdminPromotionPackages family), resolving
  // full DTOs. This query card never triggers them; test 6 asserts that.
  const createPackage = vi.fn<
    (payload: AdminPromotionPackageCreatePayload) => Promise<AdminPromotionPackageDTO>
  >()
  createPackage.mockResolvedValue(homePackage)
  const updatePackage = vi.fn<
    (id: number, payload: AdminPromotionPackageUpdatePayload) => Promise<AdminPromotionPackageDTO>
  >()
  updatePackage.mockResolvedValue(categoryPackage)

  const adapter: AdminPromotionPackageAdapter = {
    listPackages: controller.listPackages,
    createPackage,
    updatePackage,
  }

  render(<AdminPromotionPackageManager adapter={adapter} />)
  return { controller, createPackage, updatePackage }
}

describe('AdminPromotionPackageManager', () => {
  it('mount issues listPackages(false) exactly once, shows pending loading, then renders the full DTO with Chinese labels and timestamps', async () => {
    const { controller } = renderManager()

    // exact initial query; loading skeleton shown, list not rendered yet
    expect(controller.listPackages).toHaveBeenCalledTimes(1)
    expect(controller.listPackages).toHaveBeenCalledWith(false)
    expect(screen.getByRole('status', { name: '加载中' })).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()

    await controller.resolve(0, [homePackage, categoryPackage])
    const table = await screen.findByRole('table', { name: '推广套餐列表' })
    expect(screen.queryByRole('status', { name: '加载中' })).not.toBeInTheDocument()

    // active package: code / label / Chinese placement / duration / price /
    // description / sortOrder / Chinese status
    expect(within(table).getByText('PKG-STORE-HOME-30')).toBeInTheDocument()
    expect(within(table).getByText('首页顶部推广位 30 天')).toBeInTheDocument()
    expect(within(table).getByText('首页推广位')).toBeInTheDocument()
    expect(within(table).getByText('30 天')).toBeInTheDocument()
    expect(within(table).getByText('1200')).toBeInTheDocument()
    expect(within(table).getByText('首页推广位月度套餐')).toBeInTheDocument()
    expect(within(table).getByText('100')).toBeInTheDocument()
    expect(within(table).getByText('启用')).toBeInTheDocument()

    // inactive package: other placement, empty description → dash, 停用
    expect(within(table).getByText('PKG-CATEGORY-7D')).toBeInTheDocument()
    expect(within(table).getByText('分类推广位 7 天')).toBeInTheDocument()
    expect(within(table).getByText('分类推广位')).toBeInTheDocument()
    expect(within(table).getByText('7 天')).toBeInTheDocument()
    expect(within(table).getByText('300')).toBeInTheDocument()
    expect(within(table).getByText('—')).toBeInTheDocument()
    expect(within(table).getByText('-5')).toBeInTheDocument()
    expect(within(table).getByText('停用')).toBeInTheDocument()

    // created / updated times rendered as <time> with the exact wire datetimes
    expect(table.querySelector('time[datetime="2026-01-05T02:00:00.000Z"]')).not.toBeNull()
    expect(table.querySelector('time[datetime="2026-01-06T08:30:00.000Z"]')).not.toBeNull()
    expect(table.querySelector('time[datetime="2025-12-01T09:00:00.000Z"]')).not.toBeNull()
    expect(table.querySelector('time[datetime="2026-01-02T11:15:00.000Z"]')).not.toBeNull()
  })

  it('shows a server error on reject, then 重新加载 re-issues listPackages(false) and recovers into the empty state', async () => {
    const { controller } = renderManager()

    await controller.reject(0, {
      response: { data: { error: { message: '套餐服务暂时不可用' } } },
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('套餐服务暂时不可用')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('status', { name: '加载中' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    await waitFor(() => expect(controller.listPackages).toHaveBeenCalledTimes(2))
    expect(controller.listPackages).toHaveBeenLastCalledWith(false)

    await controller.resolve(1, [])
    expect(await screen.findByText('暂无套餐记录')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('renders the empty state directly when the first list resolves to []', async () => {
    const { controller } = renderManager()
    expect(controller.listPackages).toHaveBeenCalledTimes(1)

    await controller.resolve(0, [])

    expect(await screen.findByText('暂无套餐记录')).toBeInTheDocument()
    expect(
      screen.getByText('当前条件下没有匹配的推广套餐，可勾选“包含停用套餐”查看全部套餐。'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('status', { name: '加载中' })).not.toBeInTheDocument()
  })

  it('toggles 包含停用套餐 → exact listPackages(true) then listPackages(false), with matching hint text', async () => {
    const { controller } = renderManager()
    expect(controller.listPackages).toHaveBeenLastCalledWith(false)
    expect(screen.getByText('当前仅显示启用中的套餐')).toBeInTheDocument()

    const toggle = screen.getByLabelText('包含停用套餐')
    expect(toggle).not.toBeChecked()

    fireEvent.click(toggle)
    await waitFor(() => expect(controller.listPackages).toHaveBeenCalledTimes(2))
    expect(controller.listPackages).toHaveBeenLastCalledWith(true)
    expect(toggle).toBeChecked()
    expect(screen.getByText('当前显示启用与停用的全部套餐')).toBeInTheDocument()

    await controller.resolve(1, [homePackage])
    const table = await screen.findByRole('table', { name: '推广套餐列表' })
    expect(within(table).getByText('PKG-STORE-HOME-30')).toBeInTheDocument()

    fireEvent.click(toggle)
    await waitFor(() => expect(controller.listPackages).toHaveBeenCalledTimes(3))
    expect(controller.listPackages).toHaveBeenLastCalledWith(false)
    expect(toggle).not.toBeChecked()
    expect(screen.getByText('当前仅显示启用中的套餐')).toBeInTheDocument()

    await controller.resolve(2, [homePackage])
    const tableAfter = await screen.findByRole('table', { name: '推广套餐列表' })
    expect(within(tableAfter).getByText('PKG-STORE-HOME-30')).toBeInTheDocument()
  })

  it('discards a stale false response that resolves after the newer true response', async () => {
    const { controller } = renderManager()
    expect(controller.listPackages).toHaveBeenCalledTimes(1)
    expect(controller.listPackages).toHaveBeenLastCalledWith(false)

    // toggle → true request issued while the initial false request is pending
    fireEvent.click(screen.getByLabelText('包含停用套餐'))
    await waitFor(() => expect(controller.listPackages).toHaveBeenCalledTimes(2))
    expect(controller.listPackages).toHaveBeenLastCalledWith(true)

    // newer true request resolves first → its rows render
    await controller.resolve(1, [categoryPackage])
    const table = await screen.findByRole('table', { name: '推广套餐列表' })
    expect(within(table).getByText('PKG-CATEGORY-7D')).toBeInTheDocument()

    // stale false request resolves afterwards → discarded, newer rows stay
    await controller.resolve(0, [homePackage])
    expect(within(table).getByText('PKG-CATEGORY-7D')).toBeInTheDocument()
    expect(within(table).queryByText('PKG-STORE-HOME-30')).not.toBeInTheDocument()
  })

  it('adapter exposes complete typed create/update mocks that no query flow ever triggers', async () => {
    const { controller, createPackage, updatePackage } = renderManager()

    await controller.resolve(0, [homePackage])
    await screen.findByRole('table', { name: '推广套餐列表' })

    // complete strongly-typed mock instances (not the real API functions)
    expect(vi.isMockFunction(createPackage)).toBe(true)
    expect(vi.isMockFunction(updatePackage)).toBe(true)

    // this query card never drives mutation
    expect(createPackage).not.toHaveBeenCalled()
    expect(updatePackage).not.toHaveBeenCalled()
  })

  it('create success sends only the trimmed frozen create payload (no status/id/timestamps) with a non-default placement, then refreshes via a controlled list response', async () => {
    const { controller, createPackage } = renderManager()

    // initial query resolves so the 新建套餐 entry point is usable
    await controller.resolve(0, [homePackage])
    await screen.findByRole('table', { name: '推广套餐列表' })

    // open the create dialog — code/label inputs enforce maxLength 64 / 100
    fireEvent.click(screen.getByRole('button', { name: '新建套餐' }))
    const codeInput = await screen.findByLabelText('套餐编码')
    const labelInput = screen.getByLabelText('套餐名称')
    expect(codeInput).toHaveAttribute('maxlength', '64')
    expect(labelInput).toHaveAttribute('maxlength', '100')

    // fill every field; code / label / description carry surrounding spaces
    // that the component must trim, and placement switches away from the
    // default store_home_sponsored to prove the select interaction worked.
    fireEvent.change(codeInput, { target: { value: '  PKG-NEW-45  ' } })
    fireEvent.change(labelInput, { target: { value: '  新套餐 45 天  ' } })
    fireEvent.change(screen.getByLabelText('展位'), { target: { value: 'category_sponsored' } })
    fireEvent.change(screen.getByLabelText('时长（天）'), { target: { value: '45' } })
    fireEvent.change(screen.getByLabelText('价格（积分）'), { target: { value: '1500' } })
    fireEvent.change(screen.getByLabelText('排序'), { target: { value: '80' } })
    fireEvent.change(screen.getByLabelText('说明'), { target: { value: '  分类推广位新套餐  ' } })

    fireEvent.click(screen.getByRole('button', { name: '确认创建' }))

    // exact single call with the trimmed frozen payload — no extra keys
    await waitFor(() => expect(createPackage).toHaveBeenCalledTimes(1))
    expect(createPackage).toHaveBeenCalledWith({
      code: 'PKG-NEW-45',
      label: '新套餐 45 天',
      placement: 'category_sponsored',
      durationDays: 45,
      pricePoints: 1500,
      description: '分类推广位新套餐',
      sortOrder: 80,
    })
    const payload = createPackage.mock.calls[0][0]
    expect(payload).toEqual({
      code: 'PKG-NEW-45',
      label: '新套餐 45 天',
      placement: 'category_sponsored',
      durationDays: 45,
      pricePoints: 1500,
      description: '分类推广位新套餐',
      sortOrder: 80,
    })
    // the create payload never carries status / id / server timestamps
    expect(payload).not.toHaveProperty('status')
    expect(payload).not.toHaveProperty('id')
    expect(payload).not.toHaveProperty('createdAt')
    expect(payload).not.toHaveProperty('updatedAt')

    // success closes the dialog and reports it in the page status
    expect(await screen.findByText('套餐创建成功。')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // success refreshes the current query (still includeInactive=false); the
    // deferred controller resolves it so the test never hangs on a dangling promise
    await waitFor(() => expect(controller.listPackages).toHaveBeenCalledTimes(2))
    expect(controller.listPackages).toHaveBeenLastCalledWith(false)
    await controller.resolve(1, [homePackage])
    const refreshedTable = await screen.findByRole('table', { name: '推广套餐列表' })
    expect(within(refreshedTable).getByText('PKG-STORE-HOME-30')).toBeInTheDocument()
  })
  // 8. create TEXT validation (table-driven): empty / whitespace code and
  // label, plus a 1001-character description — each blocks createPackage and
  // surfaces the exact user-visible field error. Every case renders a fresh
  // manager whose initial list request resolves (no dangling promises), and
  // fills every other required field with a legal value first so the
  // fail-fast validator reaches the target field.
  type CreateTextValidationCase = {
    title: string
    field: 'code' | 'label' | 'description'
    value: string
    error: string
  }
  const createTextValidationCases: CreateTextValidationCase[] = [
    { title: 'empty code', field: 'code', value: '', error: '请输入套餐编码' },
    { title: 'whitespace-only code', field: 'code', value: '   ', error: '请输入套餐编码' },
    { title: 'empty label', field: 'label', value: '', error: '请输入套餐名称' },
    { title: 'whitespace-only label', field: 'label', value: '   ', error: '请输入套餐名称' },
    { title: '1001-char description', field: 'description', value: 'x'.repeat(1001), error: '说明不能超过 1000 字' },
  ]

  it.each(createTextValidationCases)(
    'create text validation: $title blocks createPackage and shows "$error"',
    async ({ field, value, error }) => {
      const { controller, createPackage } = renderManager()
      await controller.resolve(0, [homePackage])
      await screen.findByRole('table', { name: '推广套餐列表' })

      fireEvent.click(screen.getByRole('button', { name: '新建套餐' }))

      // Fill every required create field with a legal value first, so the
      // fail-fast validator reaches the target field (and native constraints
      // never swallow the submit).
      fireEvent.change(await screen.findByLabelText('套餐编码'), {
        target: { value: 'PKG-VALID' },
      })
      fireEvent.change(screen.getByLabelText('套餐名称'), { target: { value: '有效套餐' } })
      fireEvent.change(screen.getByLabelText('时长（天）'), { target: { value: '30' } })
      fireEvent.change(screen.getByLabelText('价格（积分）'), { target: { value: '100' } })
      fireEvent.change(screen.getByLabelText('排序'), { target: { value: '10' } })
      fireEvent.change(screen.getByLabelText('说明'), { target: { value: '有效说明' } })

      // Make exactly the target field invalid, then submit.
      const targetInputs = {
        code: screen.getByLabelText('套餐编码'),
        label: screen.getByLabelText('套餐名称'),
        description: screen.getByLabelText('说明'),
      }
      fireEvent.change(targetInputs[field], { target: { value } })
      fireEvent.click(screen.getByRole('button', { name: '确认创建' }))

      // Client-side validation blocks the request — createPackage never fires...
      expect(createPackage).not.toHaveBeenCalled()
      // ...and the exact user-visible field error is shown with the dialog open.
      expect(screen.getByRole('alert')).toHaveTextContent(error)
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    },
  )

  // 9. create NUMERIC validation (table-driven): duration / price / sort
  // each reject empty, decimal, exponent, out-of-range and unsafe-integer
  // values — every case blocks createPackage and surfaces the exact
  // user-visible field error, with the dialog kept open. Each case renders
  // a fresh manager whose initial list request resolves (no dangling
  // promises), fills every other required field with a legal value first so
  // the fail-fast validator reaches the target field, then makes exactly
  // the target field invalid and submits. The numeric inputs are
  // type="text" + inputMode="numeric" (NOT type="number"), so the raw string
  // survives fireEvent unchanged — assertions verify the real component
  // state and rendered error, never a fabricated browser normalization.
  type CreateNumericValidationCase = {
    title: string
    field: 'duration' | 'price' | 'sort'
    value: string
    error: string
  }
  const createNumericValidationCases: CreateNumericValidationCase[] = [
    // duration — positive integer 1..90; sign/zero/decimal/exponent all rejected
    { title: 'empty duration', field: 'duration', value: '', error: '时长必须为 1 到 90 的整数' },
    { title: 'decimal duration 1.5', field: 'duration', value: '1.5', error: '时长必须为 1 到 90 的整数' },
    { title: 'exponent duration 1e2', field: 'duration', value: '1e2', error: '时长必须为 1 到 90 的整数' },
    { title: 'zero duration', field: 'duration', value: '0', error: '时长必须为 1 到 90 的整数' },
    { title: 'duration above max 91', field: 'duration', value: '91', error: '时长必须为 1 到 90 的整数' },
    { title: 'unsafe-integer duration 2^53', field: 'duration', value: '9007199254740992', error: '时长必须为 1 到 90 的整数' },
    // price — positive integer; sign/zero/decimal/exponent all rejected
    { title: 'empty price', field: 'price', value: '', error: '价格必须为正整数' },
    { title: 'decimal price 1.5', field: 'price', value: '1.5', error: '价格必须为正整数' },
    { title: 'exponent price 1e2', field: 'price', value: '1e2', error: '价格必须为正整数' },
    { title: 'zero price', field: 'price', value: '0', error: '价格必须为正整数' },
    { title: 'negative price', field: 'price', value: '-1', error: '价格必须为正整数' },
    { title: 'unsafe-integer price 2^53', field: 'price', value: '9007199254740992', error: '价格必须为正整数' },
    // sort — integer -100000..100000; decimal/exponent rejected, bounds enforced
    { title: 'empty sort', field: 'sort', value: '', error: '排序必须为 -100000 到 100000 的整数' },
    { title: 'decimal sort 1.5', field: 'sort', value: '1.5', error: '排序必须为 -100000 到 100000 的整数' },
    { title: 'exponent sort 1e2', field: 'sort', value: '1e2', error: '排序必须为 -100000 到 100000 的整数' },
    { title: 'sort below min -100001', field: 'sort', value: '-100001', error: '排序必须为 -100000 到 100000 的整数' },
    { title: 'sort above max 100001', field: 'sort', value: '100001', error: '排序必须为 -100000 到 100000 的整数' },
    { title: 'unsafe-integer sort 2^53', field: 'sort', value: '9007199254740992', error: '排序必须为 -100000 到 100000 的整数' },
  ]
  const CREATE_NUMERIC_FIELD_LABEL: Record<CreateNumericValidationCase['field'], string> = {
    duration: '时长（天）',
    price: '价格（积分）',
    sort: '排序',
  }

  it.each(createNumericValidationCases)(
    'create numeric validation: $title blocks createPackage and shows "$error"',
    async ({ field, value, error }) => {
      const { controller, createPackage } = renderManager()
      await controller.resolve(0, [homePackage])
      await screen.findByRole('table', { name: '推广套餐列表' })

      fireEvent.click(screen.getByRole('button', { name: '新建套餐' }))

      // Fill every required create field with a legal value first, so the
      // fail-fast validator reaches the target field (and native constraints
      // never swallow the submit).
      fireEvent.change(await screen.findByLabelText('套餐编码'), {
        target: { value: 'PKG-VALID' },
      })
      fireEvent.change(screen.getByLabelText('套餐名称'), { target: { value: '有效套餐' } })
      fireEvent.change(screen.getByLabelText('时长（天）'), { target: { value: '30' } })
      fireEvent.change(screen.getByLabelText('价格（积分）'), { target: { value: '100' } })
      fireEvent.change(screen.getByLabelText('排序'), { target: { value: '10' } })
      fireEvent.change(screen.getByLabelText('说明'), { target: { value: '有效说明' } })

      // Make exactly the target numeric field invalid, then submit.
      fireEvent.change(screen.getByLabelText(CREATE_NUMERIC_FIELD_LABEL[field]), {
        target: { value },
      })
      fireEvent.click(screen.getByRole('button', { name: '确认创建' }))

      // Client-side validation blocks the request — createPackage never fires...
      expect(createPackage).not.toHaveBeenCalled()
      // ...and the exact user-visible field error is shown with the dialog open.
      expect(screen.getByRole('alert')).toHaveTextContent(error)
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    },
  )

  // 10. create PACKAGE_CODE_TAKEN rejection — the server conflict error
  // arrives in the exact wire shape the api/error helpers read
  // (response.data.error.code), so getApiErrorCode resolves PACKAGE_CODE_TAKEN
  // and the component shows the precise Chinese duplicate-code message, keeps
  // the dialog open, never reports success and never refreshes the list.
  it('create PACKAGE_CODE_TAKEN reject shows the exact conflict message, keeps the dialog open, no success and no refresh', async () => {
    const { controller, createPackage } = renderManager()

    await controller.resolve(0, [homePackage])
    await screen.findByRole('table', { name: '推广套餐列表' })

    fireEvent.click(screen.getByRole('button', { name: '新建套餐' }))
    fireEvent.change(await screen.findByLabelText('套餐编码'), {
      target: { value: 'PKG-DUP-10' },
    })
    fireEvent.change(screen.getByLabelText('套餐名称'), { target: { value: '重复编码套餐' } })
    fireEvent.change(screen.getByLabelText('时长（天）'), { target: { value: '30' } })
    fireEvent.change(screen.getByLabelText('价格（积分）'), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText('排序'), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText('说明'), { target: { value: '冲突测试' } })

    // Server conflict error in the exact shape the current API error handling
    // consumes (response.data.error.code === 'PACKAGE_CODE_TAKEN').
    createPackage.mockRejectedValueOnce({
      response: {
        data: {
          error: { code: 'PACKAGE_CODE_TAKEN', message: 'package code already exists' },
        },
      },
    })
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }))

    // precise Chinese conflict feedback — never the raw wire message
    expect(await screen.findByText('套餐编码已存在，请更换编码。')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('套餐编码已存在，请更换编码。')

    // dialog stays open, no success feedback, and no list refresh was issued
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByText('套餐创建成功。')).not.toBeInTheDocument()
    expect(controller.listPackages).toHaveBeenCalledTimes(1)
  })

  // 11. create generic server failure then retry — a plain Error reject keeps
  // the dialog open with the fallback failure message and preserves the filled
  // form (no success, no refresh); the same test then resubmits, the second
  // createPackage resolves a strongly typed DTO with an identical payload,
  // which closes the dialog, reports success and refreshes the current
  // includeInactive=false query (deferred list response explicitly resolved so
  // the test never hangs).
  it('create generic reject keeps the dialog + form, then retry resolves the identical payload, closes and refreshes', async () => {
    const { controller, createPackage } = renderManager()

    await controller.resolve(0, [homePackage])
    await screen.findByRole('table', { name: '推广套餐列表' })

    fireEvent.click(screen.getByRole('button', { name: '新建套餐' }))
    fireEvent.change(await screen.findByLabelText('套餐编码'), {
      target: { value: 'PKG-RETRY-11' },
    })
    fireEvent.change(screen.getByLabelText('套餐名称'), { target: { value: '重试套餐' } })
    fireEvent.change(screen.getByLabelText('展位'), { target: { value: 'category_sponsored' } })
    fireEvent.change(screen.getByLabelText('时长（天）'), { target: { value: '45' } })
    fireEvent.change(screen.getByLabelText('价格（积分）'), { target: { value: '1200' } })
    fireEvent.change(screen.getByLabelText('排序'), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText('说明'), { target: { value: '重试说明' } })

    // First submit rejects with a plain Error → generic server-failure message.
    createPackage.mockRejectedValueOnce(new Error('create failed'))
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }))

    expect(await screen.findByText('套餐创建失败，请稍后重试。')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('套餐创建失败，请稍后重试。')

    // dialog stays open, every filled form value preserved, no success, no refresh
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('套餐编码')).toHaveValue('PKG-RETRY-11')
    expect(screen.getByLabelText('套餐名称')).toHaveValue('重试套餐')
    expect(screen.getByLabelText('展位')).toHaveValue('category_sponsored')
    expect(screen.getByLabelText('时长（天）')).toHaveValue('45')
    expect(screen.getByLabelText('价格（积分）')).toHaveValue('1200')
    expect(screen.getByLabelText('排序')).toHaveValue('20')
    expect(screen.getByLabelText('说明')).toHaveValue('重试说明')
    expect(screen.queryByText('套餐创建成功。')).not.toBeInTheDocument()
    expect(controller.listPackages).toHaveBeenCalledTimes(1)

    // Second submit resolves a strongly typed DTO; the payload must be identical
    // to the first attempt's payload.
    const retryCreated: AdminPromotionPackageDTO = {
      id: 33,
      code: 'PKG-RETRY-11',
      label: '重试套餐',
      placement: 'category_sponsored',
      durationDays: 45,
      pricePoints: 1200,
      description: '重试说明',
      sortOrder: 20,
      status: 'active',
      createdAt: '2026-02-01T09:00:00.000Z',
      updatedAt: '2026-02-01T09:00:00.000Z',
    }
    createPackage.mockResolvedValueOnce(retryCreated)
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }))

    await waitFor(() => expect(createPackage).toHaveBeenCalledTimes(2))
    // second call carries exactly the same trimmed frozen payload as the first
    expect(createPackage.mock.calls[1][0]).toEqual(createPackage.mock.calls[0][0])
    expect(createPackage.mock.calls[1][0]).toEqual({
      code: 'PKG-RETRY-11',
      label: '重试套餐',
      placement: 'category_sponsored',
      durationDays: 45,
      pricePoints: 1200,
      description: '重试说明',
      sortOrder: 20,
    })

    // success closes the dialog, reports success and refreshes the current
    // query with includeInactive still false; the deferred list response is
    // explicitly resolved so the test never hangs on a dangling promise.
    expect(await screen.findByText('套餐创建成功。')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(controller.listPackages).toHaveBeenCalledTimes(2))
    expect(controller.listPackages).toHaveBeenLastCalledWith(false)
    await controller.resolve(1, [homePackage])
    await screen.findByRole('table', { name: '推广套餐列表' })
  })

  // 12. create pending contract — createPackage backed by a typed deferred
  // Promise<AdminPromotionPackageDTO> that stays pending: after a single submit
  // it is called exactly once, the real spinner renders and the confirm/cancel
  // buttons plus every form control are actually disabled. No second click.
  // Resolving the deferred create closes the dialog, reports success and
  // refreshes the current query via a second listPackages(false) request that
  // the deferred controller resolves so the test ends cleanly.
  it('create pending: typed deferred createPackage stays pending and blocks the dialog, then resolves to close + refresh', async () => {
    const { controller, createPackage } = renderManager()

    // initial query resolves so the 新建套餐 entry point is usable
    await controller.resolve(0, [homePackage])
    await screen.findByRole('table', { name: '推广套餐列表' })

    // open the create dialog and fill every field with a legal value
    fireEvent.click(screen.getByRole('button', { name: '新建套餐' }))
    const codeInput = await screen.findByLabelText('套餐编码')
    const labelInput = screen.getByLabelText('套餐名称')
    const placementSelect = screen.getByLabelText('展位')
    const durationInput = screen.getByLabelText('时长（天）')
    const priceInput = screen.getByLabelText('价格（积分）')
    const sortInput = screen.getByLabelText('排序')
    const descriptionInput = screen.getByLabelText('说明')

    fireEvent.change(codeInput, { target: { value: 'PKG-PENDING-12' } })
    fireEvent.change(labelInput, { target: { value: '挂起套餐 12' } })
    fireEvent.change(placementSelect, { target: { value: 'category_sponsored' } })
    fireEvent.change(durationInput, { target: { value: '45' } })
    fireEvent.change(priceInput, { target: { value: '1200' } })
    fireEvent.change(sortInput, { target: { value: '20' } })
    fireEvent.change(descriptionInput, { target: { value: '挂起中的创建请求' } })

    // typed deferred createPackage — the request stays pending until resolved
    let resolveCreate!: (value: AdminPromotionPackageDTO) => void
    const createPending = new Promise<AdminPromotionPackageDTO>((resolve) => {
      resolveCreate = resolve
    })
    createPackage.mockImplementation(() => createPending)

    const dialog = screen.getByRole('dialog', { name: '新建推广套餐' })
    const confirmButton = within(dialog).getByRole('button', { name: '确认创建' })
    const cancelButton = within(dialog).getByRole('button', { name: '取消' })

    // a single submit — the request must stay pending (no second click)
    fireEvent.click(confirmButton)

    // createPackage called exactly once with the exact trimmed frozen payload
    await waitFor(() => expect(createPackage).toHaveBeenCalledTimes(1))
    expect(createPackage).toHaveBeenCalledWith({
      code: 'PKG-PENDING-12',
      label: '挂起套餐 12',
      placement: 'category_sponsored',
      durationDays: 45,
      pricePoints: 1200,
      description: '挂起中的创建请求',
      sortOrder: 20,
    })

    // while pending: the real spinner renders inside the confirm button and its
    // accessible label is replaced by the spinner (no more 确认创建 text)
    expect(confirmButton.querySelector('svg.animate-spin')).not.toBeNull()
    expect(confirmButton).toBeDisabled()
    expect(within(dialog).queryByRole('button', { name: '确认创建' })).not.toBeInTheDocument()

    // cancel button and every form control are disabled while the create is pending
    expect(cancelButton).toBeDisabled()
    expect(codeInput).toBeDisabled()
    expect(labelInput).toBeDisabled()
    expect(placementSelect).toBeDisabled()
    expect(durationInput).toBeDisabled()
    expect(priceInput).toBeDisabled()
    expect(sortInput).toBeDisabled()
    expect(descriptionInput).toBeDisabled()

    // resolve the pending create with a strongly typed DTO — never a second click
    const created: AdminPromotionPackageDTO = {
      id: 44,
      code: 'PKG-PENDING-12',
      label: '挂起套餐 12',
      placement: 'category_sponsored',
      durationDays: 45,
      pricePoints: 1200,
      description: '挂起中的创建请求',
      sortOrder: 20,
      status: 'active',
      createdAt: '2026-03-01T09:00:00.000Z',
      updatedAt: '2026-03-01T09:00:00.000Z',
    }
    await act(async () => {
      resolveCreate(created)
    })

    // success: dialog closed, success reported, still a single createPackage call
    expect(await screen.findByText('套餐创建成功。')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(createPackage).toHaveBeenCalledTimes(1)

    // success refreshes the current query (includeInactive=false); the deferred
    // controller resolves the 2nd list response so the test never hangs
    await waitFor(() => expect(controller.listPackages).toHaveBeenCalledTimes(2))
    expect(controller.listPackages).toHaveBeenLastCalledWith(false)
    await controller.resolve(1, [homePackage])
    await screen.findByRole('table', { name: '推广套餐列表' })
  })
  // 13. create dialog RESET — the create form is stateless across opens: a
  // cancel never leaks the previous open's field values, field errors, server
  // errors or success feedback into the next open. The test fills EVERY field
  // with a non-default legal value, cancels, reopens, and asserts the
  // component's real initial defaults (code/label/description empty;
  // placement restored to store_home_sponsored; duration/price/sort empty)
  // with no stale alert/success inside the dialog. It then triggers one
  // client-side validation error (empty code), cancels and reopens again, and
  // confirms the error is cleared too. Cancelling never mutates: createPackage
  // stays 0 and the list query is never re-issued.
  it('create dialog reset: cancel + reopen restores pristine defaults, clears stale error/success and never mutates', async () => {
    const { controller, createPackage, updatePackage } = renderManager()

    // initial query resolves so the 新建套餐 entry point is usable
    await controller.resolve(0, [homePackage])
    await screen.findByRole('table', { name: '推广套餐列表' })

    // open the create dialog and change EVERY field to a non-default legal value
    fireEvent.click(screen.getByRole('button', { name: '新建套餐' }))
    const codeInput = await screen.findByLabelText('套餐编码')
    const labelInput = screen.getByLabelText('套餐名称')
    const placementSelect = screen.getByLabelText('展位')
    const durationInput = screen.getByLabelText('时长（天）')
    const priceInput = screen.getByLabelText('价格（积分）')
    const sortInput = screen.getByLabelText('排序')
    const descriptionInput = screen.getByLabelText('说明')

    fireEvent.change(codeInput, { target: { value: 'PKG-RESET-13' } })
    fireEvent.change(labelInput, { target: { value: '重置测试套餐' } })
    fireEvent.change(placementSelect, { target: { value: 'category_sponsored' } })
    fireEvent.change(durationInput, { target: { value: '45' } })
    fireEvent.change(priceInput, { target: { value: '1500' } })
    fireEvent.change(sortInput, { target: { value: '80' } })
    fireEvent.change(descriptionInput, { target: { value: '重置测试说明' } })

    // every field now holds its non-default value before the cancel
    expect(codeInput).toHaveValue('PKG-RESET-13')
    expect(labelInput).toHaveValue('重置测试套餐')
    expect(placementSelect).toHaveValue('category_sponsored')
    expect(durationInput).toHaveValue('45')
    expect(priceInput).toHaveValue('1500')
    expect(sortInput).toHaveValue('80')
    expect(descriptionInput).toHaveValue('重置测试说明')

    // 取消 closes the dialog without submitting anything
    const firstDialog = screen.getByRole('dialog', { name: '新建推广套餐' })
    fireEvent.click(within(firstDialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(createPackage).not.toHaveBeenCalled()

    // reopen — the form is pristine again, with the component's real defaults
    fireEvent.click(screen.getByRole('button', { name: '新建套餐' }))
    const reopenedDialog = await screen.findByRole('dialog', { name: '新建推广套餐' })
    const reopenedCode = within(reopenedDialog).getByLabelText('套餐编码')
    const reopenedLabel = within(reopenedDialog).getByLabelText('套餐名称')
    const reopenedPlacement = within(reopenedDialog).getByLabelText('展位')
    const reopenedDuration = within(reopenedDialog).getByLabelText('时长（天）')
    const reopenedPrice = within(reopenedDialog).getByLabelText('价格（积分）')
    const reopenedSort = within(reopenedDialog).getByLabelText('排序')
    const reopenedDescription = within(reopenedDialog).getByLabelText('说明')

    // code / label / description are empty again...
    expect(reopenedCode).toHaveValue('')
    expect(reopenedLabel).toHaveValue('')
    expect(reopenedDescription).toHaveValue('')
    // ...and placement / duration / price / sort restore the real initial defaults
    expect(reopenedPlacement).toHaveValue('store_home_sponsored')
    expect(reopenedDuration).toHaveValue('')
    expect(reopenedPrice).toHaveValue('')
    expect(reopenedSort).toHaveValue('')

    // no stale error / success feedback appears inside the reopened dialog
    expect(within(reopenedDialog).queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('套餐创建成功。')).not.toBeInTheDocument()

    // trigger one client-side validation error (empty code) on the fresh form
    fireEvent.click(within(reopenedDialog).getByRole('button', { name: '确认创建' }))
    expect(await within(reopenedDialog).findByRole('alert')).toHaveTextContent('请输入套餐编码')
    expect(createPackage).not.toHaveBeenCalled()

    // 取消 + reopen again — the field error is cleared as well
    fireEvent.click(within(reopenedDialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '新建套餐' }))
    const clearedDialog = await screen.findByRole('dialog', { name: '新建推广套餐' })
    expect(within(clearedDialog).queryByRole('alert')).not.toBeInTheDocument()
    expect(within(clearedDialog).getByLabelText('套餐编码')).toHaveValue('')

    // cancelling never mutates and never re-issues the list query
    expect(createPackage).not.toHaveBeenCalled()
    expect(updatePackage).not.toHaveBeenCalled()
    expect(controller.listPackages).toHaveBeenCalledTimes(1)
  })
  // 14. edit SUCCESS contract (SPEC-MERCH-001 §11 admin lane): the per-row 编辑
  // dialog opens from the active homePackage, prefills every DTO field, shows the
  // immutable code read-only per the real UI (a div, never an editable input),
  // and on save calls adapter.updatePackage EXACTLY once with (id, the trimmed
  // 7-field frozen payload) — never code/id/createdAt/updatedAt. Success closes
  // the dialog, reports 套餐更新成功。, and refreshes the current false query
  // (deferred list response explicitly resolved so the test never hangs).
  // createPackage is never called. No validation/error/pending/reset coverage
  // here — this is the pure success path only.
  it('edit success: prefills every DTO field from the active homePackage, shows the immutable code read-only, and sends only the exact update payload before closing, reporting success and refreshing the current false query', async () => {
    const { controller, createPackage, updatePackage } = renderManager()

    // initial query resolves the active homePackage so its row 编辑 is usable
    await controller.resolve(0, [homePackage])
    await screen.findByRole('table', { name: '推广套餐列表' })

    // open the edit dialog from the homePackage row's action
    fireEvent.click(
      screen.getByRole('button', { name: '编辑套餐 PKG-STORE-HOME-30（套餐 ID 11）' }),
    )
    const dialog = await screen.findByRole('dialog', { name: '编辑推广套餐' })

    // code is displayed in full but is NOT an editable control — the real UI
    // renders it as a read-only div (never an input), with the immutable hint
    const codeDisplay = within(dialog).getByText('PKG-STORE-HOME-30')
    expect(codeDisplay).toHaveAttribute('id', 'package-edit-code')
    expect(codeDisplay.tagName).toBe('DIV')
    expect(within(dialog).queryByRole('textbox', { name: '套餐编码' })).not.toBeInTheDocument()
    expect(within(dialog).getByText('创建后不可修改。')).toBeInTheDocument()

    // every editable DTO field is prefilled exactly from the active homePackage
    expect(within(dialog).getByLabelText('套餐名称')).toHaveValue('首页顶部推广位 30 天')
    expect(within(dialog).getByLabelText('展位')).toHaveValue('store_home_sponsored')
    expect(within(dialog).getByLabelText('状态')).toHaveValue('active')
    expect(within(dialog).getByLabelText('时长（天）')).toHaveValue('30')
    expect(within(dialog).getByLabelText('价格（积分）')).toHaveValue('1200')
    expect(within(dialog).getByLabelText('排序')).toHaveValue('100')
    expect(within(dialog).getByLabelText('说明')).toHaveValue('首页推广位月度套餐')

    // modify EVERY editable field — label/description carry surrounding spaces
    // the component must trim, and placement/status switch to the non-default
    // frozen enum values to prove both selects interacted
    fireEvent.change(within(dialog).getByLabelText('套餐名称'), {
      target: { value: '  首页顶部推广位 60 天  ' },
    })
    fireEvent.change(within(dialog).getByLabelText('展位'), {
      target: { value: 'category_sponsored' },
    })
    fireEvent.change(within(dialog).getByLabelText('状态'), {
      target: { value: 'inactive' },
    })
    fireEvent.change(within(dialog).getByLabelText('时长（天）'), {
      target: { value: '60' },
    })
    fireEvent.change(within(dialog).getByLabelText('价格（积分）'), {
      target: { value: '2400' },
    })
    fireEvent.change(within(dialog).getByLabelText('排序'), {
      target: { value: '200' },
    })
    fireEvent.change(within(dialog).getByLabelText('说明'), {
      target: { value: '  分类推广位 60 天套餐  ' },
    })

    fireEvent.click(within(dialog).getByRole('button', { name: '确认保存' }))

    // updatePackage called EXACTLY once with (id, the trimmed 7-field payload)
    await waitFor(() => expect(updatePackage).toHaveBeenCalledTimes(1))
    expect(updatePackage).toHaveBeenCalledWith(11, {
      label: '首页顶部推广位 60 天',
      placement: 'category_sponsored',
      durationDays: 60,
      pricePoints: 2400,
      description: '分类推广位 60 天套餐',
      sortOrder: 200,
      status: 'inactive',
    })
    const updatePayload = updatePackage.mock.calls[0][1]
    expect(updatePayload).toEqual({
      label: '首页顶部推广位 60 天',
      placement: 'category_sponsored',
      durationDays: 60,
      pricePoints: 2400,
      description: '分类推广位 60 天套餐',
      sortOrder: 200,
      status: 'inactive',
    })
    // the update payload never carries code / id / server timestamps
    expect(updatePayload).not.toHaveProperty('code')
    expect(updatePayload).not.toHaveProperty('id')
    expect(updatePayload).not.toHaveProperty('createdAt')
    expect(updatePayload).not.toHaveProperty('updatedAt')

    // success closes the dialog and reports it in the page status
    expect(await screen.findByText('套餐更新成功。')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // success refreshes the current query (still includeInactive=false); the
    // deferred controller resolves it so the test never hangs on a dangling promise
    await waitFor(() => expect(controller.listPackages).toHaveBeenCalledTimes(2))
    expect(controller.listPackages).toHaveBeenLastCalledWith(false)
    await controller.resolve(1, [homePackage])
    await screen.findByRole('table', { name: '推广套餐列表' })

    // the edit flow never drives the create mutation
    expect(createPackage).not.toHaveBeenCalled()
  })

  // 15. edit CLIENT-SIDE validation (table-driven): the per-row 编辑
  // dialog opens from the active homePackage with every DTO field prefilled
  // legally; only the target field is made invalid (all other fields stay at
  // their legal prefill), then 确认保存 must be blocked client-side —
  // updatePackage never fires, the exact user-visible field error is shown,
  // and the dialog stays open for correction. Cases: whitespace-only label,
  // duration above max (91), zero price, sort above max (100001), and a
  // 1001-character description. Each case renders a fresh manager whose
  // initial list request resolves (no dangling promises). No pending / server
  // reject / retry / reset coverage here — pure client-side validation only.
  type EditValidationCase = {
    title: string
    field: 'label' | 'duration' | 'price' | 'sort' | 'description'
    value: string
    error: string
  }
  const editValidationCases: EditValidationCase[] = [
    // label — trim 必填: whitespace-only collapses to empty
    { title: 'whitespace-only label', field: 'label', value: '   ', error: '请输入套餐名称' },
    // duration — strict decimal integer 1..90; 91 exceeds max
    { title: 'duration above max 91', field: 'duration', value: '91', error: '时长必须为 1 到 90 的整数' },
    // price — positive integer; zero is rejected
    { title: 'zero price', field: 'price', value: '0', error: '价格必须为正整数' },
    // sort — integer -100000..100000; 100001 exceeds max
    { title: 'sort above max 100001', field: 'sort', value: '100001', error: '排序必须为 -100000 到 100000 的整数' },
    // description — trimmed length ≤ 1000
    { title: '1001-char description', field: 'description', value: 'x'.repeat(1001), error: '说明不能超过 1000 字' },
  ]

  const EDIT_FIELD_LABEL: Record<EditValidationCase['field'], string> = {
    label: '套餐名称',
    duration: '时长（天）',
    price: '价格（积分）',
    sort: '排序',
    description: '说明',
  }

  // the legal value each editable field is prefilled with from homePackage —
  // only the target field is ever changed away from these values.
  const EDIT_LEGAL_PREFILL: Record<EditValidationCase['field'], string> = {
    label: homePackage.label,
    duration: String(homePackage.durationDays),
    price: String(homePackage.pricePoints),
    sort: String(homePackage.sortOrder),
    description: homePackage.description,
  }
  const EDIT_FIELDS: EditValidationCase['field'][] = [
    'label',
    'duration',
    'price',
    'sort',
    'description',
  ]

  it.each(editValidationCases)(
    'edit validation: $title blocks updatePackage and shows "$error"',
    async ({ field, value, error }) => {
      const { controller, updatePackage } = renderManager()

      // fresh manager — the initial list request resolves so the row 编辑 is usable
      await controller.resolve(0, [homePackage])
      await screen.findByRole('table', { name: '推广套餐列表' })

      // open the edit dialog from the active homePackage row's action
      fireEvent.click(
        screen.getByRole('button', { name: '编辑套餐 PKG-STORE-HOME-30（套餐 ID 11）' }),
      )
      const dialog = await screen.findByRole('dialog', { name: '编辑推广套餐' })

      // make exactly the target field invalid — all other editable fields stay
      // at their legal homePackage prefill (the two selects are never the target)
      fireEvent.change(within(dialog).getByLabelText(EDIT_FIELD_LABEL[field]), {
        target: { value },
      })
      for (const otherField of EDIT_FIELDS) {
        if (otherField === field) continue
        expect(within(dialog).getByLabelText(EDIT_FIELD_LABEL[otherField])).toHaveValue(
          EDIT_LEGAL_PREFILL[otherField],
        )
      }
      expect(within(dialog).getByLabelText('展位')).toHaveValue('store_home_sponsored')
      expect(within(dialog).getByLabelText('状态')).toHaveValue('active')

      fireEvent.click(within(dialog).getByRole('button', { name: '确认保存' }))

      // client-side validation blocks the request — updatePackage never fires...
      expect(updatePackage).not.toHaveBeenCalled()
      // ...and the exact user-visible field error is shown with the dialog open.
      expect(within(dialog).getByRole('alert')).toHaveTextContent(error)
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    },
  )
  // 16. edit GENERIC server failure then retry — a plain Error reject keeps
  // the dialog open with the fallback failure message and preserves the filled
  // form (no success, no refresh); the same test then resubmits, the second
  // updatePackage resolves a strongly typed DTO with an identical id + payload,
  // which closes the dialog, reports success and refreshes the current
  // includeInactive=false query (deferred list response explicitly resolved so
  // the test never hangs). createPackage is never called. No pending/reset
  // coverage here — failure + retry only.
  it('edit generic reject keeps the dialog + form, then retry resolves the identical id/payload, closes and refreshes', async () => {
    const { controller, createPackage, updatePackage } = renderManager()

    // initial query resolves the active homePackage so its row 编辑 is usable
    await controller.resolve(0, [homePackage])
    await screen.findByRole('table', { name: '推广套餐列表' })

    // open the edit dialog from the homePackage row's action
    fireEvent.click(
      screen.getByRole('button', { name: '编辑套餐 PKG-STORE-HOME-30（套餐 ID 11）' }),
    )
    const dialog = await screen.findByRole('dialog', { name: '编辑推广套餐' })

    // modify EVERY editable field — label/description carry surrounding spaces
    // the component must trim, and placement/status switch to the non-default
    // frozen enum values to prove both selects interacted
    fireEvent.change(within(dialog).getByLabelText('套餐名称'), {
      target: { value: '  首页顶部推广位 60 天  ' },
    })
    fireEvent.change(within(dialog).getByLabelText('展位'), {
      target: { value: 'category_sponsored' },
    })
    fireEvent.change(within(dialog).getByLabelText('状态'), {
      target: { value: 'inactive' },
    })
    fireEvent.change(within(dialog).getByLabelText('时长（天）'), {
      target: { value: '60' },
    })
    fireEvent.change(within(dialog).getByLabelText('价格（积分）'), {
      target: { value: '2400' },
    })
    fireEvent.change(within(dialog).getByLabelText('排序'), {
      target: { value: '200' },
    })
    fireEvent.change(within(dialog).getByLabelText('说明'), {
      target: { value: '  分类推广位 60 天套餐  ' },
    })

    // First submit rejects with a plain Error → generic server-failure message.
    updatePackage.mockRejectedValueOnce(new Error('update failed'))
    fireEvent.click(within(dialog).getByRole('button', { name: '确认保存' }))

    expect(await screen.findByText('套餐更新失败，请稍后重试。')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('套餐更新失败，请稍后重试。')

    // dialog stays open, every filled form value preserved (raw, untrimmed —
    // trimming happens only in the payload), no success, no refresh
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('套餐名称')).toHaveValue('  首页顶部推广位 60 天  ')
    expect(within(dialog).getByLabelText('展位')).toHaveValue('category_sponsored')
    expect(within(dialog).getByLabelText('状态')).toHaveValue('inactive')
    expect(within(dialog).getByLabelText('时长（天）')).toHaveValue('60')
    expect(within(dialog).getByLabelText('价格（积分）')).toHaveValue('2400')
    expect(within(dialog).getByLabelText('排序')).toHaveValue('200')
    expect(within(dialog).getByLabelText('说明')).toHaveValue('  分类推广位 60 天套餐  ')
    expect(screen.queryByText('套餐更新成功。')).not.toBeInTheDocument()
    expect(controller.listPackages).toHaveBeenCalledTimes(1)

    // Second submit resolves a strongly typed DTO; id and payload must be
    // identical to the first attempt.
    const retryUpdated: AdminPromotionPackageDTO = {
      id: 11,
      code: 'PKG-STORE-HOME-30',
      label: '首页顶部推广位 60 天',
      placement: 'category_sponsored',
      durationDays: 60,
      pricePoints: 2400,
      description: '分类推广位 60 天套餐',
      sortOrder: 200,
      status: 'inactive',
      createdAt: '2026-01-05T02:00:00.000Z',
      updatedAt: '2026-02-02T10:00:00.000Z',
    }
    updatePackage.mockResolvedValueOnce(retryUpdated)
    fireEvent.click(within(dialog).getByRole('button', { name: '确认保存' }))

    await waitFor(() => expect(updatePackage).toHaveBeenCalledTimes(2))
    // both calls carry the exact same id (the homePackage row's id)...
    expect(updatePackage.mock.calls[0][0]).toBe(11)
    expect(updatePackage.mock.calls[1][0]).toBe(11)
    expect(updatePackage.mock.calls[0][0]).toBe(updatePackage.mock.calls[1][0])
    // ...and the identical trimmed 7-field frozen payload
    expect(updatePackage.mock.calls[0][1]).toEqual(updatePackage.mock.calls[1][1])
    expect(updatePackage.mock.calls[1][1]).toEqual({
      label: '首页顶部推广位 60 天',
      placement: 'category_sponsored',
      durationDays: 60,
      pricePoints: 2400,
      description: '分类推广位 60 天套餐',
      sortOrder: 200,
      status: 'inactive',
    })

    // success closes the dialog, reports success and refreshes the current
    // query with includeInactive still false; the deferred list response is
    // explicitly resolved so the test never hangs on a dangling promise.
    expect(await screen.findByText('套餐更新成功。')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(controller.listPackages).toHaveBeenCalledTimes(2))
    expect(controller.listPackages).toHaveBeenLastCalledWith(false)
    await controller.resolve(1, [homePackage])
    await screen.findByRole('table', { name: '推广套餐列表' })

    // the edit retry flow never drives the create mutation
    expect(createPackage).not.toHaveBeenCalled()
  })

  // 17. edit PENDING + double-submit protection — the mirror of create test
  // 12 on the edit lane: adapter.updatePackage is backed by a typed deferred
  // Promise<AdminPromotionPackageDTO> that stays pending. After a single
  // 确认保存 it is called EXACTLY once with (id, the trimmed 7-field frozen
  // payload); while pending the real spinner renders in the confirm button
  // (its accessible label is replaced by the spinner, no more 确认保存 text),
  // the confirm AND cancel buttons are disabled, and every editable form
  // control (套餐名称/展位/状态/时长（天）/价格（积分）/排序/说明) is
  // disabled — a further click cannot re-enter the submit, so updatePackage
  // stays at exactly one call and createPackage stays at zero. Resolving the
  // deferred with a complete strongly typed AdminPromotionPackageDTO closes
  // the dialog, reports 套餐更新成功。 and refreshes the current
  // includeInactive=false query (deferred list response explicitly resolved so
  // the test never hangs). No failure/retry/reset coverage here — this is the
  // pure pending + double-submit success path only.
  it('edit pending: typed deferred updatePackage stays pending and blocks double submit, then resolves to close + refresh', async () => {
    const { controller, createPackage, updatePackage } = renderManager()

    // initial query resolves the active homePackage so its row 编辑 is usable
    await controller.resolve(0, [homePackage])
    await screen.findByRole('table', { name: '推广套餐列表' })

    // open the edit dialog from the homePackage row's action
    fireEvent.click(
      screen.getByRole('button', { name: '编辑套餐 PKG-STORE-HOME-30（套餐 ID 11）' }),
    )
    const dialog = await screen.findByRole('dialog', { name: '编辑推广套餐' })

    // fill EVERY editable field with a legal modified value — label and
    // description carry surrounding spaces the component must trim, and the
    // placement/status selects switch to the non-default frozen enum values
    const labelInput = within(dialog).getByLabelText('套餐名称')
    const placementSelect = within(dialog).getByLabelText('展位')
    const statusSelect = within(dialog).getByLabelText('状态')
    const durationInput = within(dialog).getByLabelText('时长（天）')
    const priceInput = within(dialog).getByLabelText('价格（积分）')
    const sortInput = within(dialog).getByLabelText('排序')
    const descriptionInput = within(dialog).getByLabelText('说明')

    fireEvent.change(labelInput, { target: { value: '  首页顶部推广位 60 天  ' } })
    fireEvent.change(placementSelect, { target: { value: 'category_sponsored' } })
    fireEvent.change(statusSelect, { target: { value: 'inactive' } })
    fireEvent.change(durationInput, { target: { value: '60' } })
    fireEvent.change(priceInput, { target: { value: '2400' } })
    fireEvent.change(sortInput, { target: { value: '200' } })
    fireEvent.change(descriptionInput, { target: { value: '  分类推广位 60 天套餐  ' } })

    const confirmButton = within(dialog).getByRole('button', { name: '确认保存' })
    const cancelButton = within(dialog).getByRole('button', { name: '取消' })

    // typed deferred updatePackage — the request stays pending until resolved
    let resolveUpdate!: (value: AdminPromotionPackageDTO) => void
    const updatePending = new Promise<AdminPromotionPackageDTO>((resolve) => {
      resolveUpdate = resolve
    })
    updatePackage.mockImplementation(() => updatePending)

    // a single submit — the request must stay pending (no second click)
    fireEvent.click(confirmButton)

    // updatePackage called EXACTLY once with (id, the exact trimmed payload)
    await waitFor(() => expect(updatePackage).toHaveBeenCalledTimes(1))
    expect(updatePackage).toHaveBeenCalledWith(11, {
      label: '首页顶部推广位 60 天',
      placement: 'category_sponsored',
      durationDays: 60,
      pricePoints: 2400,
      description: '分类推广位 60 天套餐',
      sortOrder: 200,
      status: 'inactive',
    })
    const updatePayload = updatePackage.mock.calls[0][1]
    expect(updatePayload).toEqual({
      label: '首页顶部推广位 60 天',
      placement: 'category_sponsored',
      durationDays: 60,
      pricePoints: 2400,
      description: '分类推广位 60 天套餐',
      sortOrder: 200,
      status: 'inactive',
    })
    // the update payload never carries code / id / server timestamps
    expect(updatePayload).not.toHaveProperty('code')
    expect(updatePayload).not.toHaveProperty('id')
    expect(updatePayload).not.toHaveProperty('createdAt')
    expect(updatePayload).not.toHaveProperty('updatedAt')

    // while pending: the real spinner renders inside the confirm button and its
    // accessible label is replaced by the spinner (no more 确认保存 text)
    expect(confirmButton.querySelector('svg.animate-spin')).not.toBeNull()
    expect(confirmButton).toBeDisabled()
    expect(within(dialog).queryByRole('button', { name: '确认保存' })).not.toBeInTheDocument()

    // cancel button and every editable form control are disabled while pending
    expect(cancelButton).toBeDisabled()
    expect(labelInput).toBeDisabled()
    expect(placementSelect).toBeDisabled()
    expect(statusSelect).toBeDisabled()
    expect(durationInput).toBeDisabled()
    expect(priceInput).toBeDisabled()
    expect(sortInput).toBeDisabled()
    expect(descriptionInput).toBeDisabled()

    // attempt a second submit/click while still pending — the double-submit
    // guard holds: updatePackage stays at exactly one call, createPackage 0
    fireEvent.click(confirmButton)
    expect(updatePackage).toHaveBeenCalledTimes(1)
    expect(createPackage).not.toHaveBeenCalled()

    // resolve the pending update with a complete strongly typed DTO — never a
    // second click
    const updated: AdminPromotionPackageDTO = {
      id: 11,
      code: 'PKG-STORE-HOME-30',
      label: '首页顶部推广位 60 天',
      placement: 'category_sponsored',
      durationDays: 60,
      pricePoints: 2400,
      description: '分类推广位 60 天套餐',
      sortOrder: 200,
      status: 'inactive',
      createdAt: '2026-01-05T02:00:00.000Z',
      updatedAt: '2026-02-02T10:00:00.000Z',
    }
    await act(async () => {
      resolveUpdate(updated)
    })

    // success: dialog closed, success reported, still a single updatePackage call
    expect(await screen.findByText('套餐更新成功。')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(updatePackage).toHaveBeenCalledTimes(1)
    expect(createPackage).not.toHaveBeenCalled()

    // success refreshes the current query (includeInactive=false); the deferred
    // controller resolves the 2nd list response so the test never hangs
    await waitFor(() => expect(controller.listPackages).toHaveBeenCalledTimes(2))
    expect(controller.listPackages).toHaveBeenLastCalledWith(false)
    await controller.resolve(1, [homePackage])
    await screen.findByRole('table', { name: '推广套餐列表' })
  })

  // 18. edit CANCEL + REOPEN reset — the per-row 编辑 dialog is stateless across
  // opens: a cancelled (validation-blocked) save must never leak the edited
  // field values, the field error, or a submit error into the next open.
  // From the active homePackage the test opens edit, modifies EVERY editable
  // field (label/placement/status/duration/price/sort/description) to a
  // non-default value AND makes duration invalid (91 > max 90) so the save is
  // blocked client-side: updatePackage never fires and the exact
  // '时长必须为 1 到 90 的整数' error is shown. 取消 closes the dialog; reopening
  // the same row restores EVERY field to the homePackage DTO original value
  // (名称/展位/状态/时长/积分/排序/说明) with code still shown read-only, and
  // the previous validation/error copy is gone. Cancelling never mutates and
  // never refreshes: createPackage and updatePackage both stay at 0 and the
  // list query stays at its single initial call. No pending / server reject /
  // retry / success mutation coverage here — pure validation-error + cancel reset.
  it('edit cancel + reopen reset: a blocked invalid save then cancel restores every homePackage DTO field, clears the error, and never mutates or refreshes', async () => {
    const { controller, createPackage, updatePackage } = renderManager()

    // initial query resolves the active homePackage so its row 编辑 is usable
    await controller.resolve(0, [homePackage])
    await screen.findByRole('table', { name: '推广套餐列表' })

    // open the edit dialog from the homePackage row's action
    fireEvent.click(
      screen.getByRole('button', { name: '编辑套餐 PKG-STORE-HOME-30（套餐 ID 11）' }),
    )
    const dialog = await screen.findByRole('dialog', { name: '编辑推广套餐' })

    // modify EVERY editable field to a non-default value, and make duration
    // invalid (91 > max 90) so 确认保存 is blocked by exact client-side validation
    fireEvent.change(within(dialog).getByLabelText('套餐名称'), {
      target: { value: '首页顶部推广位 60 天' },
    })
    fireEvent.change(within(dialog).getByLabelText('展位'), {
      target: { value: 'category_sponsored' },
    })
    fireEvent.change(within(dialog).getByLabelText('状态'), {
      target: { value: 'inactive' },
    })
    fireEvent.change(within(dialog).getByLabelText('时长（天）'), {
      target: { value: '91' },
    })
    fireEvent.change(within(dialog).getByLabelText('价格（积分）'), {
      target: { value: '2400' },
    })
    fireEvent.change(within(dialog).getByLabelText('排序'), {
      target: { value: '200' },
    })
    fireEvent.change(within(dialog).getByLabelText('说明'), {
      target: { value: '分类推广位 60 天套餐' },
    })

    // submit the invalid form — updatePackage never fires and the exact
    // user-visible field error is shown with the dialog kept open
    fireEvent.click(within(dialog).getByRole('button', { name: '确认保存' }))
    expect(updatePackage).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('alert')).toHaveTextContent('时长必须为 1 到 90 的整数')
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    // 取消 closes the dialog without submitting anything
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // reopen edit from the SAME row — every field must be back to the
    // homePackage DTO original value
    fireEvent.click(
      screen.getByRole('button', { name: '编辑套餐 PKG-STORE-HOME-30（套餐 ID 11）' }),
    )
    const reopenedDialog = await screen.findByRole('dialog', { name: '编辑推广套餐' })

    // name / placement / status / duration / points / sort / description all restore
    expect(within(reopenedDialog).getByLabelText('套餐名称')).toHaveValue('首页顶部推广位 30 天')
    expect(within(reopenedDialog).getByLabelText('展位')).toHaveValue('store_home_sponsored')
    expect(within(reopenedDialog).getByLabelText('状态')).toHaveValue('active')
    expect(within(reopenedDialog).getByLabelText('时长（天）')).toHaveValue('30')
    expect(within(reopenedDialog).getByLabelText('价格（积分）')).toHaveValue('1200')
    expect(within(reopenedDialog).getByLabelText('排序')).toHaveValue('100')
    expect(within(reopenedDialog).getByLabelText('说明')).toHaveValue('首页推广位月度套餐')

    // code stays a read-only display (div, never an editable input)
    const codeDisplay = within(reopenedDialog).getByText('PKG-STORE-HOME-30')
    expect(codeDisplay).toHaveAttribute('id', 'package-edit-code')
    expect(codeDisplay.tagName).toBe('DIV')
    expect(
      within(reopenedDialog).queryByRole('textbox', { name: '套餐编码' }),
    ).not.toBeInTheDocument()
    expect(within(reopenedDialog).getByText('创建后不可修改。')).toBeInTheDocument()

    // the previous validation / error copy no longer exists
    expect(within(reopenedDialog).queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('时长必须为 1 到 90 的整数')).not.toBeInTheDocument()

    // cancel never mutates and never refreshes the list query
    expect(createPackage).not.toHaveBeenCalled()
    expect(updatePackage).not.toHaveBeenCalled()
    expect(controller.listPackages).toHaveBeenCalledTimes(1)
  })
})
