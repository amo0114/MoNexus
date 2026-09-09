import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminFakaTasksPanel from './AdminFakaTasksPanel'
import * as adminApi from '../../api/admin'
import { useAppStore } from '../../stores/appStore'

vi.mock('../../api/admin', () => ({
  listAdminFakaTasks: vi.fn(),
  getAdminFakaTaskStats: vi.fn(),
  retryAdminFakaTask: vi.fn(),
  revokeAdminFakaTask: vi.fn(),
}))

const MOCK_TASKS = [
  {
    id: 101,
    orderId: 1001,
    status: 'succeeded',
    revokeStatus: 'pending',
    retryCount: 0,
    maxRetries: 3,
    nextRetryAt: null,
    errorMessage: null,
    createdAt: '2026-02-10T10:00:00Z',
    updatedAt: '2026-02-10T10:05:00Z',
    order: {
      status: 'paid',
      productNameSnapshot: '测试商品',
    },
  },
]

const MOCK_STATS = {
  byStatus: { succeeded: 1 },
  byRevoke: { pending: 1 },
  configured: true,
}

describe('AdminFakaTasksPanel (R10 - revoke outcome feedback)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [] })
    vi.mocked(adminApi.listAdminFakaTasks).mockResolvedValue({
      items: MOCK_TASKS as any,
      total: 1,
      page: 1,
      pageSize: 20,
    })
    vi.mocked(adminApi.getAdminFakaTaskStats).mockResolvedValue(MOCK_STATS)
  })

  it('shows success toast when outcome is succeeded', async () => {
    vi.mocked(adminApi.revokeAdminFakaTask).mockResolvedValue({
      ok: true,
      taskId: 101,
      outcome: 'succeeded',
    })

    render(<AdminFakaTasksPanel />)
    await screen.findByText('自动开通任务')

    // Click 撤销订阅 button
    const revokeBtn = await screen.findByRole('button', { name: '撤销订阅' })
    fireEvent.click(revokeBtn)

    // Confirm in dialog
    const confirmBtn = await screen.findByRole('button', { name: '确认撤销' })
    fireEvent.click(confirmBtn)

    await waitFor(() => {
      expect(adminApi.revokeAdminFakaTask).toHaveBeenCalledWith(101)
    })

    const toasts = useAppStore.getState().toasts
    expect(toasts.some(t => t.message === '自动开通任务已撤销' && t.type === 'success')).toBe(true)
  })

  it('shows error toast when outcome is failed', async () => {
    vi.mocked(adminApi.revokeAdminFakaTask).mockResolvedValue({
      ok: true,
      taskId: 101,
      outcome: 'failed',
    })

    render(<AdminFakaTasksPanel />)
    await screen.findByText('自动开通任务')

    const revokeBtn = await screen.findByRole('button', { name: '撤销订阅' })
    fireEvent.click(revokeBtn)

    const confirmBtn = await screen.findByRole('button', { name: '确认撤销' })
    fireEvent.click(confirmBtn)

    await waitFor(() => {
      expect(adminApi.revokeAdminFakaTask).toHaveBeenCalledWith(101)
    })

    const toasts = useAppStore.getState().toasts
    expect(toasts.some(t => t.message === '本次撤销未成功，请查看任务详情' && t.type === 'error')).toBe(true)
  })

  it('shows info toast when outcome is skipped', async () => {
    vi.mocked(adminApi.revokeAdminFakaTask).mockResolvedValue({
      ok: true,
      taskId: 101,
      outcome: 'skipped',
    })

    render(<AdminFakaTasksPanel />)
    await screen.findByText('自动开通任务')

    const revokeBtn = await screen.findByRole('button', { name: '撤销订阅' })
    fireEvent.click(revokeBtn)

    const confirmBtn = await screen.findByRole('button', { name: '确认撤销' })
    fireEvent.click(confirmBtn)

    await waitFor(() => {
      expect(adminApi.revokeAdminFakaTask).toHaveBeenCalledWith(101)
    })

    const toasts = useAppStore.getState().toasts
    expect(toasts.some(t => t.message === '本次撤销已跳过，任务状态可能已改变' && t.type === 'info')).toBe(true)
  })

  it('shows error toast when revoke API rejects', async () => {
    vi.mocked(adminApi.revokeAdminFakaTask).mockRejectedValue(new Error('网络超时'))

    render(<AdminFakaTasksPanel />)
    await screen.findByText('自动开通任务')

    const revokeBtn = await screen.findByRole('button', { name: '撤销订阅' })
    fireEvent.click(revokeBtn)

    const confirmBtn = await screen.findByRole('button', { name: '确认撤销' })
    fireEvent.click(confirmBtn)

    await waitFor(() => {
      expect(adminApi.revokeAdminFakaTask).toHaveBeenCalledWith(101)
    })

    const toasts = useAppStore.getState().toasts
    expect(toasts.some(t => t.message.includes('撤销失败') && t.type === 'error')).toBe(true)
  })
})
