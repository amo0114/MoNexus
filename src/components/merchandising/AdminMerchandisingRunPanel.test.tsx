import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AdminMerchandisingRunPanel, {
  type AdminMerchandisingRunAdapter,
} from './AdminMerchandisingRunPanel'
import type {
  AdminMerchandisingRunDTO,
  AdminMerchandisingRunPage,
  AdminRecomputeResult,
} from '../../types/merchandising'

// Complete fixtures covering every time/config/snapshot/failure field of the DTO.
const completedRun: AdminMerchandisingRunDTO = {
  id: 'run-completed-1',
  status: 'completed',
  windowStart: '2025-12-02T00:00:00.000Z',
  windowEnd: '2026-01-01T00:00:00.000Z',
  startedAt: '2026-01-01T08:00:00.000Z',
  completedAt: '2026-01-01T08:06:00.000Z',
  failedAt: null,
  windowDays: 30,
  minSales: 5,
  topPercent: 10,
  snapshotCount: 42,
  failureCode: null,
  createdAt: '2026-01-01T08:00:00.000Z',
}

const failedRun: AdminMerchandisingRunDTO = {
  id: 'run-failed-1',
  status: 'failed',
  windowStart: '2025-12-19T00:00:00.000Z',
  windowEnd: '2026-01-02T00:00:00.000Z',
  startedAt: '2026-01-02T09:00:00.000Z',
  completedAt: null,
  failedAt: '2026-01-02T09:00:45.000Z',
  windowDays: 14,
  minSales: 3,
  topPercent: 5,
  snapshotCount: 0,
  failureCode: 'COMPUTE_FAILED',
  createdAt: '2026-01-02T09:00:00.000Z',
}

function createListController() {
  const pending: Array<{
    resolve: (value: AdminMerchandisingRunPage) => void
    reject: (reason?: unknown) => void
  }> = []
  const listRuns = vi.fn(
    () =>
      new Promise<AdminMerchandisingRunPage>((resolve, reject) => {
        pending.push({ resolve, reject })
      }),
  )
  return {
    listRuns,
    resolve: async (value: AdminMerchandisingRunPage) => {
      await act(async () => {
        pending.shift()?.resolve(value)
      })
    },
    reject: async (reason?: unknown) => {
      await act(async () => {
        pending.shift()?.reject(reason)
      })
    },
  }
}

function renderPanel() {
  const controller = createListController()
  const recompute = vi.fn<() => Promise<AdminRecomputeResult>>()
  const adapter: AdminMerchandisingRunAdapter = {
    listRuns: controller.listRuns,
    recompute,
  }
  render(<AdminMerchandisingRunPanel adapter={adapter} />)
  return { controller, recompute }
}

describe('AdminMerchandisingRunPanel', () => {
  it('shows loading, then renders the initial list with the exact query and no order/user details', async () => {
    const { controller } = renderPanel()

    // loading status: initial query issued, no data rendered yet
    expect(controller.listRuns).toHaveBeenCalledWith({ page: 1, pageSize: 10 })
    expect(screen.getByRole('status', { name: '加载中' })).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByText('暂无排名运行记录')).not.toBeInTheDocument()

    await controller.resolve({ runs: [completedRun], total: 25, page: 1, pageSize: 10 })

    const table = await screen.findByRole('table', { name: '排名运行记录' })
    expect(table).toBeInTheDocument()

    // status / time / config / snapshot display
    expect(screen.getByText('已完成')).toBeInTheDocument()
    expect(screen.getByText('窗口 30 天 · 最低 5 单 · Top 10%')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(table.querySelector('time[datetime="2026-01-01T08:00:00.000Z"]')).not.toBeNull()
    expect(table.querySelector('time[datetime="2026-01-01T08:06:00.000Z"]')).not.toBeNull()

    // exactly the five business columns; no order/user detail columns or values
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(['状态', '时间', '配置', '快照数', '失败原因'])
    const cells = screen.getAllByRole('cell').map((c) => c.textContent)
    expect(cells.some((t) => /订单|买家|客户|用户/.test(t ?? ''))).toBe(false)
  })

  it('requests page 2 with the exact query when 下一页 is clicked', async () => {
    const { controller } = renderPanel()
    await controller.resolve({ runs: [completedRun], total: 25, page: 1, pageSize: 10 })
    await screen.findByRole('table', { name: '排名运行记录' })

    const nextButton = screen.getByRole('button', { name: '下一页' })
    expect(nextButton).toBeEnabled()
    fireEvent.click(nextButton)

    await waitFor(() =>
      expect(controller.listRuns).toHaveBeenCalledWith({ page: 2, pageSize: 10 }),
    )
    expect(controller.listRuns).toHaveBeenCalledTimes(2)

    // the distinct page-2 payload renders
    await controller.resolve({ runs: [failedRun], total: 25, page: 2, pageSize: 10 })
    expect(await screen.findByText('计算失败')).toBeInTheDocument()
  })

  it('recomputes on the current page: single call, disabled confirm, success refreshes page 2 without reset', async () => {
    const { controller, recompute } = renderPanel()
    await controller.resolve({ runs: [completedRun], total: 25, page: 1, pageSize: 10 })
    await screen.findByRole('table', { name: '排名运行记录' })

    // move to page 2
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() =>
      expect(controller.listRuns).toHaveBeenCalledWith({ page: 2, pageSize: 10 }),
    )
    await controller.resolve({ runs: [failedRun], total: 25, page: 2, pageSize: 10 })
    await screen.findByText('计算失败')

    // controlled recompute
    type CompletedRecomputeResult = Extract<AdminRecomputeResult, { kind: 'completed' }>
    let resolveRecompute!: (value: CompletedRecomputeResult) => void
    recompute.mockImplementation(
      () =>
        new Promise<CompletedRecomputeResult>((resolve) => {
          resolveRecompute = resolve
        }),
    )

    fireEvent.click(screen.getByRole('button', { name: '重新计算排名' }))
    const confirmButton = await screen.findByRole('button', { name: '开始重算' })
    expect(screen.getByText('确认重新计算排名')).toBeInTheDocument()

    fireEvent.click(confirmButton)
    await waitFor(() => expect(recompute).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(confirmButton).toBeDisabled())

    // double-click attempt: still a single call
    fireEvent.click(confirmButton)
    expect(recompute).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveRecompute({
        kind: 'completed',
        runId: 'run-recomputed-1',
        snapshotCount: 42,
        adminUserId: 1,
      })
    })

    const success = await screen.findByText('排名重算完成，已生成新快照。')
    expect(success.closest('[role="status"]')).not.toBeNull()

    // refresh happens on the current page (2), not reset to page 1
    await waitFor(() =>
      expect(controller.listRuns).toHaveBeenLastCalledWith({ page: 2, pageSize: 10 }),
    )
    await controller.resolve({ runs: [failedRun], total: 25, page: 2, pageSize: 10 })
    expect(await screen.findByText('计算失败')).toBeInTheDocument()
  })

  it('does not fake success when recompute resolves failed: alert plus failed run details', async () => {
    const { controller, recompute } = renderPanel()
    await controller.resolve({ runs: [], total: 0, page: 1, pageSize: 10 })
    await screen.findByText('暂无排名运行记录')

    recompute.mockResolvedValue({
      kind: 'failed',
      runId: 'run-failed-1',
      failureCode: 'COMPUTE_FAILED',
      wrappedUp: true,
      adminUserId: 1,
    })

    fireEvent.click(screen.getByRole('button', { name: '重新计算排名' }))
    fireEvent.click(await screen.findByRole('button', { name: '开始重算' }))

    // The dialog remains modal while the refresh is pending, so settle the
    // authoritative list before asserting the now-accessible page feedback.
    await waitFor(() => expect(controller.listRuns).toHaveBeenCalledTimes(2))
    await controller.resolve({ runs: [failedRun], total: 1, page: 1, pageSize: 10 })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('排名重算失败，请稍后重试。')

    // refreshed list exposes the failed run with its failure details
    const row = (await screen.findByText('计算失败')).closest('tr') as HTMLElement
    const cells = within(row).getAllByRole('cell')
    expect(cells[0]).toHaveTextContent('失败')
    expect(row.querySelector('time[datetime="2026-01-02T09:00:45.000Z"]')).not.toBeNull()
    expect(within(row).getByText('计算失败')).toBeInTheDocument()
  })

  it('surfaces the 429 server message and lets the main trigger be retriggered', async () => {
    const { controller, recompute } = renderPanel()
    await controller.resolve({ runs: [completedRun], total: 1, page: 1, pageSize: 10 })
    await screen.findByRole('table', { name: '排名运行记录' })

    recompute.mockRejectedValue({
      response: { data: { error: { message: '排名刚刚完成，请稍后再重算' } } },
    })

    fireEvent.click(screen.getByRole('button', { name: '重新计算排名' }))
    fireEvent.click(await screen.findByRole('button', { name: '开始重算' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('排名刚刚完成，请稍后再重算')

    // confirm dialog is closed after the operation
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '开始重算' })).not.toBeInTheDocument(),
    )

    // the main trigger is still enabled and can open the dialog again
    const trigger = screen.getByRole('button', { name: '重新计算排名' })
    expect(trigger).toBeEnabled()
    fireEvent.click(trigger)
    expect(await screen.findByRole('button', { name: '开始重算' })).toBeInTheDocument()
  })

  it('shows a load error alert and retries to an empty state', async () => {
    const { controller } = renderPanel()

    await controller.reject(new Error('network down'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('排名运行记录加载失败，请稍后重试。')

    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    await waitFor(() => expect(controller.listRuns).toHaveBeenCalledTimes(2))

    await controller.resolve({ runs: [], total: 0, page: 1, pageSize: 10 })
    expect(await screen.findByText('暂无排名运行记录')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('warns with role=status when recompute reports lock_busy', async () => {
    const { controller, recompute } = renderPanel()
    await controller.resolve({ runs: [completedRun], total: 1, page: 1, pageSize: 10 })
    await screen.findByRole('table', { name: '排名运行记录' })

    recompute.mockResolvedValue({ kind: 'skipped', reason: 'lock_busy', adminUserId: 1 })

    fireEvent.click(screen.getByRole('button', { name: '重新计算排名' }))
    fireEvent.click(await screen.findByRole('button', { name: '开始重算' }))

    const warning = await screen.findByText('当前有重算任务正在执行，请稍后重试。')
    expect(warning.closest('[role="status"]')).not.toBeNull()

    await waitFor(() => expect(controller.listRuns).toHaveBeenCalledTimes(2))
    await controller.resolve({ runs: [completedRun], total: 1, page: 1, pageSize: 10 })
    await screen.findByRole('table', { name: '排名运行记录' })
  })
})
